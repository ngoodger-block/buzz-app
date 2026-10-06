// @vitest-environment jsdom
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import "@testing-library/jest-dom/vitest";
import { npubEncode } from "nostr-tools/nip19";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import type { ClientSnapshot } from "../../features/communities/service";
import * as communityApi from "../../features/communities/api";
import * as destinations from "../../features/communities/destination";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { createRelaySession } from "../../features/relay/session";
import { archiveRelay, keypair, signed } from "../../features/relay/testing";
import type { ReadTransport } from "../../features/relay/transport";
import type { RelaySnapshot } from "../../features/relay/service";
import { bindNames } from "../../features/identity-names/service";
import { createAgentDirectory } from "../../features/identity-names/testing";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { UnifiedInventory } from "./UnifiedInventory";
const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const dispose of disposals.splice(0)) dispose();
});
function setup(
  mode: string,
  configure: (f: ReturnType<typeof controlFixture>) => void,
  identities = ["cd".repeat(32)],
  definitions: { id: string; name: string }[] = [],
  client?: ClientSnapshot,
  transport: Partial<ReadTransport> = {},
  naming = false,
  viewer = "de".repeat(32),
) {
  const f = controlFixture();
  configure(f);
  if (!vi.isMockFunction(communityApi.communityRequest))
    vi.spyOn(communityApi, "communityRequest").mockImplementation(
      async (_id, route, body, signal) =>
        route === "query"
          ? (transport.query?.(
              body as Parameters<ReadTransport["query"]>[0],
              signal ?? new AbortController().signal,
            ) ?? [])
          : { identities },
    );
  const owned = createRelaySession(
    {
      viewer,
      relayAuthor: "ef".repeat(32),
      scope: "wss://relay.example.test",
      readAgentLibrary: async () => ({
        definitions,
        identities: [
          {
            pubkey: "cd".repeat(32),
            name: "Not imported",
            definitionId: "linked",
          },
        ],
      }),
      query: async () => [],
      media: () => undefined,
      ...transport,
    },
    { outboxStorage: { load: () => [], save: () => {} } },
  );
  const control = createAgentControl(f.host);
  disposals.push(() => {
    owned.dispose();
    control.dispose();
  });
  const boundNames = naming
    ? bindNames(owned.session, {
        snapshot: () => [createAgentDirectory(control)],
        subscribe: () => () => {},
      })
    : undefined;
  if (boundNames) disposals.push(() => boundNames.dispose());
  const session = {
    ...owned.session,
    names: boundNames ?? owned.session.names,
  };
  let connection: RelaySnapshot = {
    status: mode === "disconnected" ? "disconnected" : "ready",
    viewer,
    ...(mode === "disconnected"
      ? {}
      : { scope: `wss://relay.example.test:${viewer}` }),
    generation: 1,
    session:
      mode === "archived"
        ? {
            ...session,
            archives: {
              ...owned.session.archives,
              state: () => "archived" as const,
            },
          }
        : session,
  };
  const view = () => (
    <UnifiedInventory
      state={{ ...control.snapshot(), status: "ready", data: f.data }}
      control={control}
      connection={connection}
      client={client}
      edit={() => {}}
      importedId={null}
      onUseHere={() => {}}
      onImport={() => {}}
    />
  );
  const mounted = render(view(), { wrapper: ToastProvider });
  return {
    f,
    library: owned.session.agentLibrary,
    changeClient(next: ClientSnapshot) {
      client = next;
      mounted.rerender(view());
    },
    changeScope(scope: string, generation: number) {
      connection = { ...connection, scope, generation };
      mounted.rerender(view());
    },
    /** Leaves the view while the app's notice host stays. */
    leave() {
      mounted.rerender(null);
    },
  };
}
it("does not let late inventory from the previous community expose Use here", async () => {
  let finish!: (value: { identities: string[] }) => void;
  const pending = new Promise<{ identities: string[] }>((resolve) => {
    finish = resolve;
  });
  const request = vi
    .spyOn(communityApi, "communityRequest")
    .mockImplementation(async (destination) => {
      if (destination === "https://relay.example.test") return pending;
      return { identities: [] };
    });
  const { changeScope } = setup("connected", (fixture) => {
    fixture.data.parked = [
      { pubkey: "cd".repeat(32), name: "Source", sources: ["installed"] },
    ];
    fixture.host.cloneSettings = async () => ({
      name: "Source",
      systemPrompt: "Instructions",
    });
  });
  await waitFor(() => expect(request).toHaveBeenCalled());
  act(() => changeScope(`wss://second.example:${"de".repeat(32)}`, 2));
  try {
    await waitFor(() =>
      expect(
        request.mock.calls.some((call) => call[0] === "https://second.example"),
      ).toBe(true),
    );
  } finally {
    await act(async () => {
      finish({ identities: ["cd".repeat(32)] });
      await pending;
    });
  }
  const card = await screen.findByRole("article", {
    name: "Agent Source",
  });
  expect(within(card).queryByRole("button", { name: "Use here" })).toBeNull();
  expect(within(card).getByRole("button", { name: "Import" })).toBeEnabled();
});

it("retries failed inventory without offering import for relay-only identities", async () => {
  const request = vi
    .spyOn(communityApi, "communityRequest")
    .mockRejectedValueOnce(Error("unavailable"))
    .mockResolvedValue({ identities: ["cd".repeat(32)] });
  setup("connected", (fixture) => {
    fixture.data.parked = [];
  });
  await screen.findByText(/Community inventory could not be checked/);
  expect(screen.queryByRole("button", { name: "Use here" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Refresh agents" }));
  const group = await screen.findByRole("region", {
    name: "Relay-only agents",
  });
  expect(
    within(group).getByRole("article", { name: "Agent Not imported" }),
  ).toBeVisible();
  await waitFor(() =>
    expect(
      request.mock.calls.filter(([, route]) => route === "agent-inventory"),
    ).toHaveLength(2),
  );
  expect(within(group).queryByRole("button", { name: "Import" })).toBeNull();
  expect(within(group).queryByText(/No import source confirmed/)).toBeNull();
});

it("preserves placement and independent setup and Clone after a read failure", async () => {
  const request = vi
    .spyOn(communityApi, "communityRequest")
    .mockResolvedValue({ identities: ["cd".repeat(32)] });
  setup("connected", (fixture) => {
    fixture.data.agents.push({
      ...fixture.agent,
      id: "retained",
      pubkey: "cd".repeat(32),
      configured: false,
      enabled: false,
      status: "stopped",
    });
  });
  await screen.findByRole("button", { name: "Use here" });
  request.mockRejectedValue(Error("Access denied"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh agents" }));
  await screen.findByText(/Community inventory could not be checked/);
  expect(
    screen.getByRole("region", { name: "Local agents in this community" }),
  ).toBeVisible();
  expect(screen.getAllByRole("button", { name: "Clone" })).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Use here" })).toBeEnabled();
});
it("retains multiple verified associations and renders inventory keys absent from profiles", async () => {
  const key = "fe".repeat(32);
  const request = vi
    .spyOn(communityApi, "communityRequest")
    .mockResolvedValue({ identities: [key] });
  const { changeScope } = setup("connected", () => {});
  await screen.findByRole("region", { name: "Relay-only agents" });
  act(() => changeScope(`wss://second.example:${"de".repeat(32)}`, 2));
  await waitFor(() =>
    expect(
      request.mock.calls.filter(([, route]) => route === "agent-inventory"),
    ).toHaveLength(2),
  );
  await screen.findByRole("region", { name: "Relay-only agents" });
  request.mockResolvedValue({ identities: [] });
  act(() => changeScope(`wss://third.example:${"de".repeat(32)}`, 3));
  await waitFor(() =>
    expect(
      request.mock.calls.filter(([, route]) => route === "agent-inventory"),
    ).toHaveLength(3),
  );
  for (const community of ["relay.example.test", "second.example"]) {
    const group = await screen.findByRole("region", {
      name: "Relay-only agents",
    });
    const card = within(group).getByRole("article", {
      name: `Agent ${key.slice(0, 12)}`,
    });
    expect(
      within(group).getByRole("region", { name: "https://relay.example.test" }),
    ).toContainElement(card);
    expect(
      within(group).queryByRole("region", { name: "https://second.example" }),
    ).toBeNull();
    const details = card.querySelector("details");
    if (!details?.open)
      fireEvent.click(
        within(card).queryByText("Identity & sources") ??
          within(card).getByLabelText(/^Details for /),
      );
    expect(within(card).getByText(`https://${community}`)).toBeVisible();
    expect(
      screen.getAllByRole("article", { name: `Agent ${key.slice(0, 12)}` }),
    ).toHaveLength(1);
    expect(within(card).queryByRole("button", { name: "Import" })).toBeNull();
    expect(within(group).queryByText(/No import source confirmed/)).toBeNull();
  }
});

it("lists archived identities after all discovery joins in an Archived section with local controls", async () => {
  setup("archived", (f) => {
    f.data.parked = [
      { pubkey: "cd".repeat(32), name: "Hidden", sources: ["installed"] },
    ];
  });
  await waitFor(() => expect(communityApi.communityRequest).toHaveBeenCalled());
  await screen.findByRole("button", { name: "Stop" });
  // Every agent is archived: the section opens instead of first-run text.
  expect(
    screen.getByText("All your agents are archived in this community."),
  ).toBeVisible();
  const section = screen.getByRole("region", { name: "Archived agents" });
  expect(
    within(section).getByRole("button", { name: "Archived (2)" }),
  ).toHaveAttribute("aria-expanded", "true");
  const local = within(section).getByRole("article", {
    name: "Agent Fixture agent",
  });
  expect(within(local).getByText("Archived")).toBeVisible();
  expect(within(local).getByRole("button", { name: "Stop" })).toBeVisible();
  expect(
    within(section).getByRole("article", { name: "Agent Hidden" }),
  ).toBeVisible();
});
it("omits redundant profile text and uses configured names for native WSS setups in an HTTPS session", async () => {
  const { changeScope } = setup(
    "connected",
    (f) => {
      f.agent.pubkey = "cd".repeat(32);
      f.agent.name = "Raw local fallback";
    },
    ["cd".repeat(32)],
    [{ id: "linked", name: "Reusable profile" }],
  );
  act(() => changeScope(`https://relay.example.test:${"de".repeat(32)}`, 1));
  const card = await screen.findByRole("article", {
    name: "Agent Raw local fallback",
  });
  expect(within(card).queryByText(/^Profile:/)).toBeNull();
  expect(within(card).getByText(npubEncode("cd".repeat(32)))).not.toBeVisible();
  fireEvent.click(
    within(card).queryByText("Identity & sources") ??
      within(card).getByLabelText(/^Details for /),
  );
  expect(within(card).getByText(npubEncode("cd".repeat(32)))).toBeVisible();
  expect(within(card).getByRole("button", { name: "Stop" })).toBeEnabled();
  expect(
    screen.queryByRole("article", { name: "Agent Not imported" }),
  ).toBeNull();
});
it("keeps exact local controls while disconnected and after switching to another community", async () => {
  const { changeScope } = setup("disconnected", (f) => {
    f.data.parked = [];
  });
  const card = await screen.findByRole("article", {
    name: "Agent Fixture agent",
  });
  expect(within(card).getByRole("button", { name: "Stop" })).toBeVisible();
  expect(
    within(card).getByRole("button", { name: "Actions for Fixture agent" }),
  ).toBeVisible();
  act(() => changeScope(`wss://other.example.test:${"de".repeat(32)}`, 2));
  const switched = await screen.findByRole("article", {
    name: "Agent Fixture agent",
  });
  expect(within(switched).getByRole("button", { name: "Stop" })).toBeVisible();
  expect(
    within(switched).getByRole("button", { name: "Actions for Fixture agent" }),
  ).toBeVisible();
});

it("shows source failures without claiming a missing import source was proved", async () => {
  setup("connected", (f) => {
    f.data.parked = [];
    f.data.inventoryWarnings = ["Development Buzz could not be read."];
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Development Buzz could not be read.",
  );
  const card = await screen.findByRole("article", {
    name: "Agent Not imported",
  });
  expect(screen.queryByText(/No import source confirmed/)).toBeNull();
  expect(within(card).queryByRole("button", { name: "Import" })).toBeNull();
});

const joined = (ids: string[], viewer = "de".repeat(32)): ClientSnapshot => ({
  status: "ready",
  relayAvailable: true,
  viewer,
  profile: { name: "", picture: "" },
  sync: { known: {}, outbox: [] },
  selected: null,
  memberships: ids.map((id) => ({ id, name: id })),
});
it("discovers an unselected configured membership alias by its origin", async () => {
  const resolve = destinations.communityDestination;
  vi.spyOn(destinations, "communityDestination").mockImplementation((id) =>
    resolve(id, { primary: "https://unvisited.example" }),
  );
  const key = "fa".repeat(32);
  const request = vi
    .spyOn(communityApi, "communityRequest")
    .mockImplementation(async (_id, route) =>
      route === "query" ? [] : { identities: [key] },
    );
  const client = joined(["primary", "wss://unvisited.example"]);
  setup(
    "connected",
    (f) => {
      f.data.agents = [];
      f.data.parked = [];
    },
    [],
    [],
    client,
  );
  expect(
    await screen.findByRole("article", { name: `Agent ${key.slice(0, 12)}` }),
  ).toBeVisible();
  expect(
    request.mock.calls
      .filter(([, route]) => route === "agent-inventory")
      .map(([id]) => id),
  ).toEqual(["https://unvisited.example"]);
  expect(client.memberships[0]?.id).toBe("primary");
  expect(client.selected).toBeNull();
});
it("reads unvisited joined communities, deduplicates identities, and retries only discovery after partial failure", async () => {
  const key = "fa".repeat(32);
  const request = vi
    .spyOn(communityApi, "communityRequest")
    .mockImplementation(async (id, route) => {
      if (route === "query") return [];
      if (id === "https://failed.example") throw Error("unavailable");
      return { identities: [key] };
    });
  const { f } = setup(
    "connected",
    (f) => {
      f.data.agents = [];
      f.data.parked = [];
    },
    [],
    [],
    joined([
      "https://relay.example.test",
      "wss://unvisited.example",
      "https://failed.example",
    ]),
  );
  await screen.findByText(/could not be checked for https:\/\/failed.example/);
  const card = await screen.findByRole("article", {
    name: `Agent ${key.slice(0, 12)}`,
  });
  expect(
    screen.getAllByRole("article", { name: `Agent ${key.slice(0, 12)}` }),
  ).toHaveLength(1);
  fireEvent.click(within(card).getByLabelText(/^Details for /));
  expect(within(card).getByText("https://unvisited.example")).toBeVisible();
  expect(within(card).getByText("https://relay.example.test")).toBeVisible();
  expect(within(card).queryByRole("button", { name: "Import" })).toBeNull();
  expect(within(card).queryByRole("button", { name: "Use here" })).toBeNull();
  expect(
    request.mock.calls
      .filter(([, route]) => route === "agent-inventory")
      .map(([id]) => id)
      .sort(),
  ).toEqual([
    "https://failed.example",
    "https://relay.example.test",
    "https://unvisited.example",
  ]);
  request.mockImplementation(async (_id, route) =>
    route === "query" ? [] : { identities: [key] },
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh agents" }));
  await waitFor(() =>
    expect(screen.queryByText(/could not be checked/)).toBeNull(),
  );
  const refreshed = await screen.findByRole("region", {
    name: "https://failed.example",
  });
  expect(
    within(refreshed).getByRole("article", {
      name: `Agent ${key.slice(0, 12)}`,
    }),
  ).toBeVisible();
  expect(
    f.calls.some(({ action }) => action === "preview" || action === "import"),
  ).toBe(false);
});
it("discards late results across viewers and removes departed communities without opening a selected session", async () => {
  const oldKey = "fa".repeat(32),
    newKey = "fb".repeat(32);
  let finish!: (value: { identities: string[] }) => void;
  const late = new Promise<{ identities: string[] }>((resolve) => {
    finish = resolve;
  });
  const request = vi
    .spyOn(communityApi, "communityRequest")
    .mockImplementation(async (id, route) =>
      route === "query"
        ? []
        : id === "https://old.example"
          ? late
          : { identities: [newKey] },
    );
  const { changeClient } = setup(
    "disconnected",
    (f) => {
      f.data.agents = [];
      f.data.parked = [];
    },
    [],
    [],
    joined(["https://old.example"]),
  );
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  act(() => changeClient(joined(["https://new.example"], "ee".repeat(32))));
  await screen.findByRole("article", { name: `Agent ${newKey.slice(0, 12)}` });
  await act(async () => {
    finish({ identities: [oldKey] });
    await late;
  });
  expect(
    screen.queryByRole("article", { name: `Agent ${oldKey.slice(0, 12)}` }),
  ).toBeNull();
  expect(request.mock.calls[0]?.[3]?.aborted).toBe(true);
  act(() => changeClient(joined([], "ee".repeat(32))));
  expect(
    screen.queryByRole("article", { name: `Agent ${newKey.slice(0, 12)}` }),
  ).toBeNull();
});

it("keeps the last public name for a retained identity when its community read fails", async () => {
  const agent = keypair();
  const profile = signed(agent, {
    kind: 0,
    tags: [],
    content: JSON.stringify({ name: "Docs writer" }),
  });
  const request = vi
    .spyOn(communityApi, "communityRequest")
    .mockImplementation(async (_id, route) =>
      route === "query" ? [profile] : { identities: [agent.pubkey] },
    );
  setup(
    "ready",
    (f) => {
      f.data.agents = [];
      f.data.parked = [];
    },
    [],
    [],
    joined(["https://other.example"]),
  );
  expect(
    await screen.findByRole("article", { name: "Agent Docs writer" }),
  ).toBeVisible();
  request.mockImplementation(async () => {
    throw Error("unavailable");
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh agents" }));
  await screen.findByText(/could not be checked for https:\/\/other.example/);
  expect(
    screen.getByRole("article", { name: "Agent Docs writer" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("article", {
      name: `Agent ${agent.pubkey.slice(0, 12)}`,
    }),
  ).toBeNull();
});

it("loads public names and pictures for discovered and importable identities without replacing saved artwork", async () => {
  const relayOnly = keypair(),
    importable = keypair();
  const artwork = "https://images.example/saved.png";
  const events = [relayOnly, importable].map((key, index) =>
    signed(key, {
      kind: 0,
      tags: [],
      content: JSON.stringify({
        name: index ? "Public importable" : "Public relay agent",
        picture: `https://images.example/${index}.png`,
      }),
    }),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const query = vi.fn<ReadTransport["query"]>(async (filters) => {
    if (!filters.some((filter) => filter.kinds?.includes(0))) return [];
    await gate;
    return events.filter((event) =>
      filters.some((filter) => filter.authors?.includes(event.pubkey)),
    );
  });
  setup(
    "ready",
    (fixture) => {
      fixture.data.agents = [];
      fixture.data.parked = [
        {
          pubkey: importable.pubkey,
          name: "Saved importable",
          sources: ["installed"],
        },
      ];
    },
    [relayOnly.pubkey],
    [],
    undefined,
    {
      query,
      media: (url) => url,
      readAgentLibrary: async () => ({
        definitions: [],
        identities: [
          {
            pubkey: "ab".repeat(32),
            name: "Saved artwork",
            avatar: artwork,
          },
        ],
      }),
    },
  );
  try {
    await screen.findByRole("article", {
      name: `Agent ${relayOnly.pubkey.slice(0, 12)}`,
    });
    await waitFor(() =>
      expect(
        query.mock.calls.some(([filters]) =>
          filters.some((filter) => filter.kinds?.includes(0)),
        ),
      ).toBe(true),
    );
    await act(async () => {
      release();
    });
    const relayCard = await screen.findByRole("article", {
      name: "Agent Public relay agent",
    });
    expect(relayCard.querySelector("img")).toHaveAttribute(
      "src",
      "https://images.example/0.png",
    );
    expect(
      within(relayCard).queryByRole("button", { name: "Import" }),
    ).toBeNull();
    const importCard = await screen.findByRole("article", {
      name: "Agent Public importable",
    });
    expect(importCard.querySelector("img")).toHaveAttribute(
      "src",
      "https://images.example/1.png",
    );
    expect(
      within(importCard).getByRole("button", { name: "Import" }),
    ).toBeEnabled();
    expect(
      (
        await screen.findByRole("article", { name: "Agent Saved artwork" })
      ).querySelector("img"),
    ).toHaveAttribute("src", artwork);
  } finally {
    release();
  }
});

it("keeps discovery visible when public profiles fail and retries from Refresh agents", async () => {
  const agent = keypair();
  const profile = signed(agent, {
    kind: 0,
    tags: [],
    content: '{"name":"Recovered profile"}',
  });
  let failed = true;
  const query = vi.fn<ReadTransport["query"]>(async (filters) => {
    if (!filters.some((filter) => filter.kinds?.includes(0))) return [];
    if (failed) throw new Error("Profile unavailable");
    return [profile];
  });
  setup(
    "ready",
    (fixture) => {
      fixture.data.agents = [];
      fixture.data.parked = [];
    },
    [agent.pubkey],
    [],
    undefined,
    { query },
  );
  await screen.findByRole("article", {
    name: `Agent ${agent.pubkey.slice(0, 12)}`,
  });
  await waitFor(() =>
    expect(
      query.mock.calls.some(([filters]) =>
        filters.some((filter) => filter.authors?.includes(agent.pubkey)),
      ),
    ).toBe(true),
  );
  failed = false;
  fireEvent.click(screen.getByRole("button", { name: "Refresh agents" }));
  await screen.findByRole("article", { name: "Agent Recovered profile" });
});

it.each(["connected", "disconnected"])(
  "loads source metadata and authenticated pictures with selected connection %s",
  async (mode) => {
    const key = keypair();
    const source = "https://source.example";
    const picture = `${source}/media/${"ab".repeat(32)}.png`;
    const event = signed(key, {
      kind: 0,
      tags: [],
      content: JSON.stringify({ display_name: "Source agent", picture }),
    });
    const request = vi
      .spyOn(communityApi, "communityRequest")
      .mockImplementation(async (id, route) => {
        expect(id).toBe(source);
        return route === "query" ? [event] : { identities: [key.pubkey] };
      });
    const { f } = setup(
      mode,
      (f) => {
        f.data.agents = [];
        f.data.parked = [
          {
            pubkey: key.pubkey,
            name: "Old source agent",
            sources: ["installed"],
          },
        ];
      },
      [],
      [],
      joined([source]),
    );
    const card = await screen.findByRole("article", {
      name: "Agent Source agent",
    });
    expect(card.querySelector("img")).toHaveAttribute(
      "src",
      `/api/relay/${encodeURIComponent(source)}/media?url=${encodeURIComponent(picture.replace(/\.png$/, ".thumb.jpg"))}`,
    );
    expect(within(card).getByRole("button", { name: "Import" })).toBeEnabled();
    expect(request.mock.calls.map(([, route]) => route)).toEqual([
      "agent-inventory",
      "query",
    ]);
    expect(
      f.calls.some(({ action }) => action === "preview" || action === "import"),
    ).toBe(false);
  },
);

it("keeps source discovery after profile failure, retries enrichment, and fences late profiles after viewer change", async () => {
  const key = keypair();
  const source = "https://source.example";
  const event = signed(key, {
    kind: 0,
    tags: [],
    content: '{"name":"Source agent"}',
  });
  let resolve!: (value: unknown) => void;
  const pending = new Promise<unknown>((r) => {
    resolve = r;
  });
  let fail = true;
  const request = vi
    .spyOn(communityApi, "communityRequest")
    .mockImplementation(async (_id, route) => {
      if (route === "agent-inventory") return { identities: [key.pubkey] };
      if (fail) throw Error("Profiles unavailable");
      return pending;
    });
  const { changeClient } = setup(
    "disconnected",
    (f) => {
      f.data.agents = [];
      f.data.parked = [];
    },
    [],
    [],
    joined([source]),
  );
  await screen.findByText(/Agent names and pictures could not be checked/);
  expect(
    screen.getByRole("article", { name: `Agent ${key.pubkey.slice(0, 12)}` }),
  ).toBeVisible();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Refresh agents" }));
  await waitFor(() =>
    expect(
      request.mock.calls.filter(([, route]) => route === "query"),
    ).toHaveLength(2),
  );
  act(() => changeClient(joined([], "aa".repeat(32))));
  await act(async () => {
    resolve([event]);
    await pending;
  });
  expect(
    screen.queryByRole("article", { name: "Agent Source agent" }),
  ).toBeNull();
});

for (const duplicate of [false, true]) {
  it(`uses visible exact-key naming for ${duplicate ? "duplicate" : "lone"} cross-community agents`, async () => {
    setup(
      "connected",
      (f) => {
        f.agent.name = "Local name";
        f.agent.relayUrl = "wss://other.example";
        if (duplicate)
          f.data.agents.push({
            ...f.agent,
            id: "second",
            pubkey: "bc".repeat(32),
          });
      },
      [],
      [],
      undefined,
      {},
      true,
    );
    for (const key of duplicate ? ["ab", "bc"] : ["ab"]) {
      const label = duplicate
        ? `Local name · ${npubEncode(key.repeat(32)).slice(-4)}`
        : "Local name";
      expect(
        await screen.findByRole("article", { name: `Agent ${label}` }),
      ).toBeVisible();
    }
  });
}

it("removes a relay-only agent after confirmation and keeps it on Cancel or failure", async () => {
  const published: { kind: number; tags: string[][] }[] = [];
  let refuse: Error | undefined = Error("restricted: not authorized");
  const signer = keypair();
  setup(
    "connected",
    (fixture) => {
      fixture.data.parked = [];
    },
    ["cd".repeat(32)],
    [],
    undefined,
    {
      writer: {
        kinds: [9001, 5],
        sign: async (template) => signed(signer, { ...template }),
        async publish(event) {
          if (refuse) throw refuse;
          published.push(event);
        },
      },
    },
    false,
    signer.pubkey,
  );
  const group = await screen.findByRole("region", {
    name: "Relay-only agents",
  });
  const card = within(group).getByRole("article", {
    name: "Agent Not imported",
  });
  fireEvent.click(within(card).getByRole("button", { name: "Remove" }));
  let dialog = await screen.findByRole("alertdialog", {
    name: "Remove Not imported?",
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(published).toEqual([]);

  fireEvent.click(within(card).getByRole("button", { name: "Remove" }));
  dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove agent" }));
  expect(await within(card).findByRole("alert")).toHaveTextContent(
    "restricted: not authorized",
  );
  expect(card).toBeInTheDocument();

  refuse = undefined;
  const inventoryReads = () =>
    vi
      .mocked(communityApi.communityRequest)
      .mock.calls.filter(([, route]) => route === "agent-inventory").length;
  const reads = inventoryReads();
  fireEvent.click(within(card).getByRole("button", { name: "Remove" }));
  dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove agent" }));
  await waitFor(() => expect(card).not.toBeInTheDocument());
  // The confirmed removal hides the card by itself. A community recheck would
  // add status lines above the list and shift it while the user watches.
  expect(inventoryReads()).toBe(reads);
  expect(screen.queryByText("Checking community inventory…")).toBeNull();
  expect(published.map(({ kind, tags }) => [kind, tags[0]])).toEqual([
    [5, ["a", `30177:${signer.pubkey}:${"cd".repeat(32)}`]],
  ]);
});

it("keeps an archived card until its record deletion succeeds", async () => {
  const viewer = keypair();
  const agent = "cd".repeat(32);
  // Admin consent archives an agent with no live profile.
  const relay = archiveRelay(viewer, keypair(), [], {
    [viewer.pubkey]: "admin",
  });
  relay.removal.fail = Error("restricted: not authorized");
  relay.removal.failKind = 5;
  setup(
    "connected",
    (fixture) => {
      fixture.data.parked = [];
    },
    [agent],
    [],
    undefined,
    relay.transport,
    false,
    viewer.pubkey,
  );
  const group = await screen.findByRole("region", {
    name: "Relay-only agents",
  });
  const card = within(group).getByRole("article", {
    name: "Agent Not imported",
  });
  fireEvent.click(within(card).getByRole("button", { name: "Remove" }));
  let dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove agent" }));
  expect(await within(card).findByRole("alert")).toHaveTextContent(
    "restricted: not authorized",
  );
  expect(relay.archived.has(agent)).toBe(true);
  expect(card).toBeInTheDocument();

  delete relay.removal.fail;
  fireEvent.click(within(card).getByRole("button", { name: "Remove" }));
  dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove agent" }));
  await waitFor(() => expect(card).not.toBeInTheDocument());
  expect(relay.published.map((event) => event.kind)).toEqual([9035, 5]);
  expect(relay.deleted).toEqual(new Set([`30177:${viewer.pubkey}:${agent}`]));
});

it("keeps already archived agents out of the active list while Remove re-reads archives", async () => {
  const viewer = keypair();
  const agent = "cd".repeat(32);
  const other = "a1".repeat(32);
  const relay = archiveRelay(viewer, keypair(), [], {
    [viewer.pubkey]: "admin",
  });
  relay.archived.add(other);
  let release: (() => void) | undefined;
  let reads = 0;
  const query = relay.transport.query;
  setup(
    "connected",
    (fixture) => {
      fixture.data.parked = [];
    },
    [agent, other],
    [],
    undefined,
    {
      ...relay.transport,
      readAgentLibrary: async () => ({
        definitions: [],
        identities: [
          { pubkey: agent, name: "Not imported" },
          { pubkey: other, name: "Archived earlier" },
        ],
      }),
      async query(filters, signal) {
        // Hold every archive read after the first, so the re-read is visible.
        if (filters.some((filter) => filter.kinds?.includes(13535)) && reads++)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return query(filters, signal);
      },
    },
    false,
    viewer.pubkey,
  );
  const group = await screen.findByRole("region", {
    name: "Relay-only agents",
  });
  await waitFor(() =>
    expect(within(group).getAllByRole("article")).toHaveLength(1),
  );
  expect(
    screen.getByRole("button", { name: "Archived (1)" }),
  ).toBeInTheDocument();
  const card = within(group).getByRole("article", {
    name: "Agent Not imported",
  });
  fireEvent.click(within(card).getByRole("button", { name: "Remove" }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove agent" }));
  await waitFor(() => expect(release).toBeDefined());
  expect(within(group).getAllByRole("article")).toEqual([card]);
  release?.();
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Relay-only agents" }),
    ).toBeNull(),
  );
  expect(relay.deleted).toEqual(new Set([`30177:${viewer.pubkey}:${agent}`]));
});

function archiveSetup(
  fail?: Error,
  archived = false,
  wrap: (transport: ReadTransport) => Partial<ReadTransport> = (t) => t,
) {
  const viewer = keypair();
  const agent = "cd".repeat(32);
  // Admin consent lets the viewer archive both the local and relay-only agent.
  const relay = archiveRelay(viewer, keypair(), [], {
    [viewer.pubkey]: "admin",
  });
  if (fail) relay.script.fail = fail;
  if (archived) relay.archived.add(agent);
  const mounted = setup(
    "connected",
    (fixture) => {
      fixture.data.parked = [];
    },
    [agent],
    [],
    {
      status: "ready",
      relayAvailable: true,
      viewer: viewer.pubkey,
      profile: { name: "", picture: "", about: "" },
      sync: { known: {}, outbox: [] },
      selected: "wss://relay.example.test",
      memberships: [{ id: "wss://relay.example.test", name: "Example" }],
    },
    wrap(relay.transport),
    false,
    viewer.pubkey,
  );
  return { ...mounted, relay, agent, viewer, local: "ab".repeat(32) };
}
async function openMenuItem(card: HTMLElement, name: string, item: string) {
  fireEvent.click(
    await within(card).findByRole("button", { name: `Actions for ${name}` }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}

it("archives a running local agent, moves it to Archived, and Undo restores it", async () => {
  const { relay, local } = archiveSetup();
  const card = await screen.findByRole("article", {
    name: "Agent Fixture agent",
  });
  await openMenuItem(card, "Fixture agent", "Archive agent");
  const dialog = await screen.findByRole("alertdialog", {
    name: "Archive Fixture agent?",
  });
  expect(dialog).toHaveTextContent(
    "This hides Fixture agent from search, mentions, and Add member in Example. It won’t remove the agent from its channels or delete its saved setup.",
  );
  expect(dialog).toHaveTextContent(
    "This agent is running. Archiving won’t stop it.",
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Archive agent" }),
  );
  const section = await screen.findByRole("region", {
    name: "Archived agents",
  });
  expect(relay.archived.has(local)).toBe(true);
  const trigger = within(section).getByRole("button", { name: "Archived (1)" });
  // The card left the active list; focus follows it to the collapsed section.
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(
    screen.getByText("Fixture agent archived in Example"),
  ).toBeInTheDocument();
  // Archive changes visibility only: the agent keeps running.
  expect(relay.published.map((event) => event.kind)).toEqual([9035]);

  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(relay.archived.has(local)).toBe(false));
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Archived agents" }),
    ).toBeNull(),
  );
  const restored = screen.getByRole("article", { name: "Agent Fixture agent" });
  expect(within(restored).getByRole("button", { name: "Stop" })).toBeVisible();
  await waitFor(() =>
    expect(
      within(restored).getByRole("button", {
        name: "Actions for Fixture agent",
      }),
    ).toHaveFocus(),
  );
});

it("reopens Archived each time the last active agent is archived", async () => {
  const { relay, local } = archiveSetup(undefined, true);
  async function archiveLast() {
    const card = await screen.findByRole("article", {
      name: "Agent Fixture agent",
    });
    await openMenuItem(card, "Fixture agent", "Archive agent");
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Archive agent",
      }),
    );
    await waitFor(() => expect(relay.archived.has(local)).toBe(true));
    return within(
      screen.getByRole("region", { name: "Archived agents" }),
    ).getByRole("button", { name: "Archived (2)" });
  }
  const trigger = await archiveLast();
  await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "true"));
  // A deliberate collapse holds while every agent stays archived.
  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(relay.archived.has(local)).toBe(false));
  const again = await archiveLast();
  expect(
    screen.getByText("All your agents are archived in this community."),
  ).toBeVisible();
  await waitFor(() => expect(again).toHaveAttribute("aria-expanded", "true"));
});

it("archives a relay-only agent from its menu and unarchives it without confirmation", async () => {
  const { relay, agent } = archiveSetup();
  const group = await screen.findByRole("region", {
    name: "Relay-only agents",
  });
  const card = within(group).getByRole("article", {
    name: "Agent Not imported",
  });
  await openMenuItem(card, "Not imported", "Archive agent");
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Archive agent",
    }),
  );
  const section = await screen.findByRole("region", {
    name: "Archived agents",
  });
  fireEvent.click(
    within(section).getByRole("button", { name: "Archived (1)" }),
  );
  const archived = await within(section).findByRole("article", {
    name: "Agent Not imported",
  });
  expect(within(archived).getByText("Archived")).toBeVisible();
  // Groups sit one heading level below the section's own h2 title.
  expect(
    within(section).getByRole("heading", {
      level: 3,
      name: "Relay-only agents",
    }),
  ).toBeVisible();
  expect(
    within(archived).getByRole("heading", { name: "Not imported" }).tagName,
  ).toBe("H5");
  // Remove stays available for the extra cleanup it does.
  expect(
    within(archived).getByRole("button", { name: "Remove" }),
  ).toBeVisible();
  await openMenuItem(archived, "Not imported", "Unarchive agent");
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await waitFor(() => expect(relay.archived.has(agent)).toBe(false));
  await waitFor(() =>
    expect(
      within(
        screen.getByRole("region", { name: "Relay-only agents" }),
      ).getByRole("article", { name: "Agent Not imported" }),
    ).toBeVisible(),
  );
  expect(relay.published.map((event) => event.kind)).toEqual([9035, 9036]);
});

it("keeps a card in place with a retryable error when Archive fails", async () => {
  const { relay, local } = archiveSetup(Error("restricted: not authorized"));
  const card = await screen.findByRole("article", {
    name: "Agent Fixture agent",
  });
  await openMenuItem(card, "Fixture agent", "Archive agent");
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Archive agent",
    }),
  );
  expect(await within(card).findByRole("alert")).toHaveTextContent(
    "Archive failed: restricted: not authorized",
  );
  expect(screen.queryByRole("region", { name: "Archived agents" })).toBeNull();
  delete relay.script.fail;
  fireEvent.click(within(card).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(relay.archived.has(local)).toBe(true));
  expect(
    await screen.findByRole("region", { name: "Archived agents" }),
  ).toBeInTheDocument();
});

it("keeps a card in Archived with a retryable error when Unarchive fails", async () => {
  const { relay, agent } = archiveSetup(undefined, true);
  const section = await screen.findByRole("region", {
    name: "Archived agents",
  });
  fireEvent.click(
    within(section).getByRole("button", { name: "Archived (1)" }),
  );
  const card = await within(section).findByRole("article", {
    name: "Agent Not imported",
  });
  relay.script.fail = Error("restricted: not authorized");
  await openMenuItem(card, "Not imported", "Unarchive agent");
  const alert = await within(section).findByRole("alert");
  expect(alert).toHaveTextContent(
    "Unarchive failed: restricted: not authorized",
  );
  // The failed card stays in its starting section with its badge.
  const failed = within(section).getByRole("article", {
    name: "Agent Not imported",
  });
  expect(within(failed).getByText("Archived")).toBeVisible();
  expect(
    screen.getAllByRole("article", { name: "Agent Not imported" }),
  ).toEqual([failed]);
  delete relay.script.fail;
  fireEvent.click(within(failed).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(relay.archived.has(agent)).toBe(false));
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Archived agents" }),
    ).toBeNull(),
  );
});

it("keeps an archived card in Archived while Remove runs and after it fails", async () => {
  const { relay, agent } = archiveSetup(undefined, true);
  let release!: () => void;
  relay.removal.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  relay.removal.fail = Error("restricted: not authorized");
  relay.removal.failKind = 5;
  const section = await screen.findByRole("region", {
    name: "Archived agents",
  });
  fireEvent.click(
    within(section).getByRole("button", { name: "Archived (1)" }),
  );
  const card = await within(section).findByRole("article", {
    name: "Agent Not imported",
  });
  fireEvent.click(within(card).getByRole("button", { name: "Remove" }));
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Remove agent",
    }),
  );
  // Moving the card to the active list would unmount Remove and cancel it.
  await waitFor(() =>
    expect(
      within(card).getByRole("button", { name: "Remove" }),
    ).toHaveAttribute("aria-busy", "true"),
  );
  expect(section).toContainElement(card);
  expect(
    screen.getAllByRole("article", { name: "Agent Not imported" }),
  ).toEqual([card]);
  release();
  expect(await within(card).findByRole("alert")).toHaveTextContent(
    "restricted: not authorized",
  );
  expect(card).toBeInTheDocument();
  expect(section).toContainElement(card);
  expect(
    screen.getAllByRole("article", { name: "Agent Not imported" }),
  ).toEqual([card]);
  delete relay.removal.hold;
  delete relay.removal.fail;
  fireEvent.click(within(card).getByRole("button", { name: "Remove" }));
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Remove agent",
    }),
  );
  await waitFor(() => expect(card).not.toBeInTheDocument());
  expect(relay.archived.has(agent)).toBe(true);
});

it("moves an archived card to the active list when Unarchive succeeds after a failed Remove", async () => {
  const { relay, agent } = archiveSetup(undefined, true);
  relay.removal.fail = Error("restricted: not authorized");
  relay.removal.failKind = 5;
  const section = await screen.findByRole("region", {
    name: "Archived agents",
  });
  fireEvent.click(
    within(section).getByRole("button", { name: "Archived (1)" }),
  );
  const card = await within(section).findByRole("article", {
    name: "Agent Not imported",
  });
  fireEvent.click(within(card).getByRole("button", { name: "Remove" }));
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Remove agent",
    }),
  );
  await within(card).findByRole("alert");
  await openMenuItem(card, "Not imported", "Unarchive agent");
  await waitFor(() => expect(relay.archived.has(agent)).toBe(false));
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Archived agents" }),
    ).toBeNull(),
  );
  const active = within(
    screen.getByRole("region", { name: "Relay-only agents" }),
  ).getByRole("article", { name: "Agent Not imported" });
  expect(within(active).queryByText("Archived")).toBeNull();
  await openMenuItem(active, "Not imported", "Archive agent");
  expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
});

it("asks for archive permission again on Refresh agents after a failed read", async () => {
  let refuse = true;
  archiveSetup(undefined, false, (transport) => ({
    ...transport,
    async query(filters, signal) {
      if (refuse && filters.some((filter) => filter.kinds?.includes(13534)))
        throw Error("relay unavailable");
      return transport.query(filters, signal);
    },
  }));
  const card = await screen.findByRole("article", {
    name: "Agent Fixture agent",
  });
  fireEvent.click(
    await within(card).findByRole("button", {
      name: "Actions for Fixture agent",
    }),
  );
  await screen.findByRole("menu");
  expect(screen.queryByRole("menuitem", { name: "Archive agent" })).toBeNull();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  refuse = false;
  fireEvent.click(screen.getByRole("button", { name: "Refresh agents" }));
  // The same mounted card offers Archive once the new read succeeds.
  await openMenuItem(card, "Fixture agent", "Archive agent");
  expect(
    await screen.findByRole("alertdialog", { name: "Archive Fixture agent?" }),
  ).toBeInTheDocument();
});

it("keeps keyboard focus on the card when Retry fails again", async () => {
  const { relay } = archiveSetup(Error("restricted: not authorized"));
  const card = await screen.findByRole("article", {
    name: "Agent Fixture agent",
  });
  await openMenuItem(card, "Fixture agent", "Archive agent");
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Archive agent",
    }),
  );
  await within(card).findByRole("alert");
  let release!: () => void;
  relay.script.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const retry = within(card).getByRole("button", { name: "Retry" });
  retry.focus();
  fireEvent.click(retry);
  const menu = within(card).getByRole("button", {
    name: "Actions for Fixture agent",
  });
  expect(await within(card).findByText("Archiving…")).toBeInTheDocument();
  expect(menu).toHaveFocus();
  release();
  expect(await within(card).findByRole("alert")).toHaveTextContent(
    "Archive failed: restricted: not authorized",
  );
  expect(menu).toHaveFocus();
});

for (const end of ["community change", "leaving the page"] as const)
  it(`closes the Undo notice on ${end}`, async () => {
    const { relay, local, viewer, changeScope, leave } = archiveSetup();
    const card = await screen.findByRole("article", {
      name: "Agent Fixture agent",
    });
    await openMenuItem(card, "Fixture agent", "Archive agent");
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Archive agent",
      }),
    );
    expect(
      await screen.findByRole("button", { name: "Undo" }),
    ).toBeInTheDocument();
    if (end === "leaving the page") leave();
    else changeScope(`wss://other.example.test:${viewer.pubkey}`, 2);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull(),
    );
    expect(relay.archived.has(local)).toBe(true);
  });
