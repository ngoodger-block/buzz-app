// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MentionCompletion } from "./MentionCompletion";
import { MentionPicker } from "./MentionPicker";
import { mentionQuery } from "./mention-query";
import { createAgentLibrary } from "../../features/agents/library";
import { createAgentChoices } from "../../features/agents/choices";
import { ComposerCompletions } from "../../features/conversation/ComposerCompletions";
import type {
  ComposerCompletion,
  CompletionResult,
} from "../../features/conversation/contracts";
import type { CompletionEditor } from "../../features/conversation/useCompletionEditor";
import type { ComposerInputElement } from "../../features/messages/composer-dom";
import type { RelaySession } from "../../features/relay/session";
import type { Contribution } from "../../plugins/contributions";

// jsdom lacks scrollIntoView; the search highlight keeps its row in view.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  vi.restoreAllMocks();
});

function fixture({
  count = 1,
  loading = false,
  failure = false,
  dm = false,
} = {}) {
  const people = Array.from({ length: count }, (_, i) => ({
    pubkey: (i + 1).toString(16).padStart(64, "0"),
    name: `Person ${String(i).padStart(2, "0")}`,
  }));
  const agent = people[0];
  if (!agent) throw new Error("Fixture needs at least one person");
  const read = vi.fn(async () => ({ definitions: [], identities: [agent] }));
  if (failure) read.mockRejectedValueOnce(new Error("temporary read failure"));
  const library = createAgentLibrary(read);
  const choices = createAgentChoices({
    scope: "test",
    library: library.queries,
    signal: new AbortController().signal,
  });
  const profiles = new Map(people.map((p) => [p.pubkey, { name: p.name }]));
  let list: ReturnType<RelaySession["channels"]["list"]> = {
    status: "ready",
    channels: [
      {
        id: "parent",
        name: "Parent",
        channelType: dm ? "dm" : "stream",
        members: failure ? [] : people.map((p) => p.pubkey),
      },
    ],
  };
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const archives = { status: "ready" as const, archived: [] };
  const entries: ReturnType<
    NonNullable<RelaySession["channelKit"]>["snapshot"]
  >["entries"] = [
    {
      eventId: "head",
      createdAt: 1,
      record: {
        version: 1,
        community: "fixture",
        deleted: false,
        value: {
          type: "team",
          id: "team",
          name: "Team",
          agents: [agent.pubkey],
        },
      },
    },
  ];
  let catalog: ReturnType<NonNullable<RelaySession["channelKit"]>["snapshot"]> =
    { status: loading ? "loading" : "ready", entries: loading ? [] : entries };
  const none = () => () => {};
  const session = {
    directMessages: {
      people: vi.fn(async () => ({ people: [], hasMore: false })),
    },
    archives: {
      snapshot: () => archives,
      subscribe: none,
      ensure: async () => {},
      refresh: async () => {},
      state: () => "not-archived",
    },
    channels: {
      list: () => list,
      subscribeList: subscribe,
      ensureList: () => {},
    },
    profiles: {
      snapshot: () => profiles,
      subscribe: none,
      ensure: async () => {},
    },
    names: { subscribe: none, snapshot: () => 0, scope: () => () => undefined },
    agentLibrary: library.queries,
    agentChoices: choices,
    media: () => undefined,
    channelKit: {
      available: true,
      snapshot: () => catalog,
      subscribe,
      ensure() {},
      async refresh() {},
      async save() {
        return "head";
      },
    },
  } as unknown as RelaySession;
  return {
    session,
    people,
    agent,
    read,
    library,
    loaded() {
      act(() => {
        catalog = { status: "ready", entries };
        listeners.forEach((f) => {
          f();
        });
      });
    },
    remove(notify = true) {
      act(() => {
        list = {
          ...list,
          channels: list.channels.map((c) => ({ ...c, members: [] })),
        };
        if (notify)
          listeners.forEach((f) => {
            f();
          });
      });
    },
    notify() {
      act(() => {
        listeners.forEach((f) => {
          f();
        });
      });
    },
  };
}

function inline(session: RelaySession, inviteAgents = false) {
  const publish = vi.fn();
  const props = {
    session,
    scope: "test",
    channelId: "parent",
    inviteAgents,
    publish,
    observation: { revision: 1, text: "@", start: 1, end: 1 },
    query: { start: 0, end: 1, query: "" },
  };
  const view = render(<MentionCompletion {...props} />);
  const result = () => publish.mock.lastCall?.[0] as CompletionResult;
  return {
    view,
    props,
    result,
    team: () => result()?.items.find((i) => i.id === "team:team"),
  };
}

it("late teams preserve the highlighted recipient and all 50 installed people", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const h = fixture({ count: 50, loading: true });
  const replace = vi.fn(
    (_edit: CompletionResult["items"][number]["edit"]) => true,
  );
  const provider: Contribution<ComposerCompletion> = {
    id: "typeahead",
    key: "buzz.mentions/typeahead",
    pluginId: "buzz.mentions",
    revision: "1",
    title: "Mention",
    match: ({ text, start }) => mentionQuery(text, start),
    component: MentionCompletion,
  };
  const providers = [provider];
  const input = document.createElement(
    "div",
  ) as unknown as ComposerInputElement;
  document.body.append(input);
  const editor = {
    observation: { revision: 1, text: "@", start: 1, end: 1 },
    valid: () => true,
    observe() {},
    invalidate() {},
    keys: { current: undefined },
    composing: { current: false },
  } as unknown as CompletionEditor;
  const view = render(
    <ComposerCompletions
      registry={{ snapshot: () => providers, subscribe: () => () => {} }}
      editor={editor}
      input={{ current: input }}
      replace={replace}
      resolved={{ text: "@", recipients: [] }}
      session={h.session}
      scope="test"
      channelId="parent"
    />,
  );
  const press = (key: string) =>
    act(() =>
      editor.keys.current?.({
        key,
        nativeEvent: {},
        preventDefault() {},
        stopPropagation() {},
      } as Parameters<NonNullable<CompletionEditor["keys"]["current"]>>[0]),
    );
  try {
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(50));
    const initial = screen.getAllByRole("option").map((row) => row.textContent);
    press("ArrowUp");
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent(
      "Person 49",
    );
    h.loaded();
    await waitFor(() => expect(h.read).toHaveBeenCalledOnce());
    expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual(
      initial,
    );
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent(
      "Person 49",
    );
    press("Enter");
    expect(replace.mock.lastCall?.[0]).toEqual({ mention: h.people[49] });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Narrow your search",
      ),
    );
  } finally {
    view.unmount();
    input.remove();
    h.library.dispose();
  }
});

it("late directory people do not displace a team already filling the shared budget", async () => {
  const h = fixture({ count: 49 });
  let resolve!: (value: {
    people: { pubkey: string; name: string }[];
    hasMore: boolean;
  }) => void;
  const people = vi.fn(
    () =>
      new Promise<{
        people: { pubkey: string; name: string }[];
        hasMore: boolean;
      }>((done) => {
        resolve = done;
      }),
  );
  const session = {
    ...h.session,
    directMessages: { ...h.session.directMessages, people },
  };
  const menu = inline(session);
  try {
    await waitFor(() => expect(menu.team()?.canSelect?.("Enter")).toBe(true));
    expect(menu.result().items).toHaveLength(50);
    const ids = menu.result().items.map((item) => item.id);
    await waitFor(() => expect(people).toHaveBeenCalledOnce());
    await act(async () =>
      resolve({
        people: [{ pubkey: "f".repeat(64), name: "Zed" }],
        hasMore: false,
      }),
    );
    expect(menu.result().items.map((item) => item.id)).toEqual(ids);
    expect(menu.team()?.canSelect?.("Enter")).toBe(true);
  } finally {
    menu.view.unmount();
    h.library.dispose();
  }
});

it("teams retain installed membership through rerenders and stale acceptance until a new query", async () => {
  const h = fixture();
  const menu = inline(h.session, true);
  try {
    await waitFor(() => expect(menu.team()?.canSelect?.("Enter")).toBe(true));
    const stale = menu.team();
    if (!stale) throw new Error("Expected team choice");
    // Revoke membership before React sees the new roster: acceptance must reread it.
    h.remove(false);
    expect(stale.canSelect?.("Enter")).toBe(false);
    h.notify();
    expect(menu.team()?.disabled).toContain("membership changed");
    expect(menu.team()?.canSelect?.("Enter")).toBe(false);
    expect(menu.team()?.edit.mentions).toBeUndefined();
    expect(
      menu.result().items.find((i) => i.id === h.agent.pubkey)?.disabled,
    ).toContain("membership changed");
    menu.view.rerender(
      <MentionCompletion
        {...menu.props}
        query={{ start: 0, end: 3, query: "Te" }}
      />,
    );
    await waitFor(() => expect(menu.team()?.canSelect?.("Enter")).toBe(true));
    expect(menu.team()?.detail).toContain("Adds 1");
  } finally {
    menu.view.unmount();
    h.library.dispose();
  }
});

it("the team picker disables a removed member until reopened", async () => {
  const h = fixture(),
    user = userEvent.setup(),
    selectTeam = vi.fn(() => true);
  const view = render(
    <MentionPicker
      session={h.session}
      scope="test"
      channelId="parent"
      disabled={false}
      inviteAgents
      select={() => true}
      selectTeam={selectTeam}
    />,
  );
  try {
    const trigger = screen.getByRole("button", { name: "Mention a member" });
    await user.click(trigger);
    const team = await screen.findByRole("button", {
      name: /Team.*Saved team/,
    });
    await waitFor(() => expect(team).toBeEnabled());
    h.remove();
    expect(team).toBeDisabled();
    expect(team).toHaveTextContent("membership changed");
    await user.click(team);
    expect(selectTeam).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    await user.click(trigger);
    const reopened = await screen.findByRole("button", {
      name: /Team.*Saved team/,
    });
    expect(reopened).toBeEnabled();
    await user.click(reopened);
    expect(selectTeam).toHaveBeenCalledWith([h.agent]);
  } finally {
    view.unmount();
    h.library.dispose();
  }
});

it.each([false, true])(
  "inline Retry recovers the team inventory (DM: %s)",
  async (dm) => {
    const h = fixture({ failure: true, dm });
    const menu = inline(h.session);
    try {
      await waitFor(() =>
        expect(menu.result()?.status).toBe(
          "Could not load agents. Retry to refresh.",
        ),
      );
      expect(menu.team()?.disabled).toContain("unavailable");
      act(() => menu.result().retry?.());
      await waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(menu.team()?.canSelect?.("Enter")).toBe(true));
      expect(menu.team()?.edit.mentions).toEqual([h.agent]);
    } finally {
      menu.view.unmount();
      h.library.dispose();
    }
  },
);

it.each([false, true])(
  "picker Retry recovers a selectable team (DM: %s)",
  async (dm) => {
    const h = fixture({ failure: true, dm }),
      user = userEvent.setup(),
      selectTeam = vi.fn(() => true);
    const view = render(
      <MentionPicker
        session={h.session}
        scope="test"
        channelId="parent"
        disabled={false}
        select={() => true}
        selectTeam={selectTeam}
      />,
    );
    try {
      await user.click(
        screen.getByRole("button", { name: "Mention a member" }),
      );
      const retry = await screen.findByRole("button", {
        name: "Retry agent list",
      });
      expect(
        screen.getByRole("button", { name: /Team.*unavailable/ }),
      ).toBeDisabled();
      await user.click(retry);
      await waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
      const team = await screen.findByRole("button", {
        name: /Team.*Saved team/,
      });
      expect(team).toBeEnabled();
      await user.click(team);
      expect(selectTeam).toHaveBeenCalledWith([h.agent]);
    } finally {
      view.unmount();
      h.library.dispose();
    }
  },
);

it("reserves room for teams ready when the first 50-choice budget installs", async () => {
  const h = fixture({ count: 50 });
  const menu = inline(h.session);
  try {
    await waitFor(() => expect(menu.team()?.canSelect?.("Enter")).toBe(true));
    expect(menu.result().items).toHaveLength(50);
    expect(
      menu
        .result()
        .items.slice(0, 49)
        .map((item) => item.id),
    ).toEqual(h.people.slice(0, 49).map((person) => person.pubkey));
    expect(menu.result().items[49]?.id).toBe("team:team");
  } finally {
    menu.view.unmount();
    h.library.dispose();
  }
});

it("waits for the initial roster before installing team membership facts", async () => {
  const h = fixture();
  let pending = true;
  const loading: ReturnType<RelaySession["channels"]["list"]> = {
    status: "loading",
    channels: [],
  };
  const session = {
    ...h.session,
    channels: {
      ...h.session.channels,
      list: () => (pending ? loading : h.session.channels.list()),
    },
  };
  const menu = inline(session, true);
  try {
    await waitFor(() =>
      expect(h.session.agentChoices.snapshot().status).toBe("ready"),
    );
    expect(menu.team()).toBeUndefined();
    pending = false;
    h.notify();
    await waitFor(() => expect(menu.team()?.canSelect?.("Enter")).toBe(true));
    const stale = menu.team();
    h.remove();
    expect(menu.team()?.disabled).toContain("membership changed");
    expect(stale?.canSelect?.("Enter")).toBe(false);
  } finally {
    menu.view.unmount();
    h.library.dispose();
  }
});
