// @vitest-environment jsdom
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
stubAvatarBrowserApis();
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { ConversationPresentation } from "../conversation/ConversationPresentation";
import type {
  ComposerTool,
  ContributionReader,
  InlineRenderer,
} from "../conversation/contracts";
import type { LiveCallbacks } from "../relay/live";
import { createRelaySession } from "../relay/session";
import type { RelaySession } from "../relay/session";
import {
  keypair,
  message,
  roster,
  scriptedTransport,
  signed,
} from "../relay/testing";
import { MessageRow } from "./MessageRow";

const viewer = keypair(),
  other = keypair(),
  relay = keypair();
const nothing: readonly never[] = [];
const registry = <T,>(): ContributionReader<T> => ({
  snapshot: () => nothing,
  subscribe: () => () => {},
});
const extensions = {
  tools: registry<ComposerTool>(),
  inline: registry<InlineRenderer>(),
};
const owners: { dispose(): void }[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
});

function Rows({ session }: { session: RelaySession }) {
  const state = useSyncExternalStore(
    (listener) => session.channels.subscribeWindow("c", listener),
    () => session.channels.window("c"),
  );
  return state.rows.map((row) => (
    <MessageRow
      key={row.id}
      row={row}
      session={session}
      scope="test"
      extensions={extensions}
      profile={undefined}
      media={() => undefined}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />
  ));
}

// jsdom's Selection.toString() is DOM text, so this covers the glyphs' DOM
// shape; Playwright covers the engines' user-select handling of row chrome.
it("keeps quick-reaction glyphs out of a selection that spans rows", () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: {
        sign: async (template) => signed(viewer, template),
        publish: async () => {},
      },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  owner.session.channels.ensure("c");
  live.receive([
    roster(relay, "c", [viewer.pubkey, other.pubkey], 1),
    message(other, "c", "First body", 2),
    message(other, "c", "Second body", 3),
  ]);
  render(
    <ConversationPresentation value={true}>
      <Rows session={owner.session} />
    </ConversationPresentation>,
  );
  // Both rows mount their quick reactions, so the second row's sit between the bodies.
  expect(screen.getAllByRole("button", { name: /^React with/ })).toHaveLength(
    6,
  );
  const [first, second] = screen.getAllByText(/body$/);
  const range = document.createRange();
  range.setStartBefore(first as Node);
  range.setEndAfter(second as Node);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  const text = selection?.toString() ?? "";
  expect(text).toContain("First body");
  expect(text).toContain("Second body");
  expect(text).not.toMatch(/👍|❤️|😂/u);
});
