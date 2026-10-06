import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { openPage } from "./navigation.mjs";

// Browser-only contract: actual sidebar/plugin routing -> exact thread target,
// browser history, and responsive/light-dark CSS. Matrices stay in RTL/unread tests.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  inboxDm: true,
  historyCounts: { alpha: 2, beta: 1 },
});

test("Inbox opens the exact thread, shares read state, and fits the workspace", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  const inboxButton = page.getByRole("button", { name: "Inbox", exact: true });
  await inboxButton.click();
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(
    inbox.getByText("Unread reply 1", { exact: true }),
  ).toBeVisible();
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  const rows = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem");
  const chooseFilter = async (label, control = "Activity type") => {
    await inbox.getByRole("combobox", { name: control }).click();
    await page.getByRole("option", { name: label, exact: true }).click();
  };
  await expect(inbox.getByRole("tab")).toHaveCount(0);
  await expect(
    inbox.getByRole("combobox", { name: "Activity type" }),
  ).toHaveText("All activity");
  await expect(inbox.getByRole("combobox", { name: "Sender" })).toHaveText(
    "Everyone",
  );
  await expect(inbox.getByText("Activity type")).toHaveClass(/sr-only/);
  await expect(inbox.getByText("Sender", { exact: true })).toHaveClass(
    /sr-only/,
  );
  await expect(
    inbox.getByText(
      /Verified recent conversations|Results are bounded|Feed history reached its result limit/,
    ),
  ).toHaveCount(0);
  await expect(
    inbox.getByRole("button", { name: "Mark shown as read" }),
  ).toHaveCount(0);
  await expect(inbox.getByRole("button", { name: "Refresh" })).toHaveCount(0);
  await chooseFilter("DMs");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Inbox DM fixture reply");
  const dmSource = rows.first().locator("[data-inbox-source]");
  await expect(dmSource).toHaveText("DM · Alice Fixture");
  await expect(dmSource.locator("svg")).toHaveCount(0);
  const dmStyle = await dmSource.evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    radius: getComputedStyle(element).borderRadius,
    inset: getComputedStyle(element).paddingInlineStart,
  }));
  await chooseFilter("Mentions");
  await expect(page.getByText("Activity", { exact: true })).toHaveCount(0);
  await chooseFilter("Humans", "Sender");
  await expect(rows).toHaveCount(2);
  await chooseFilter("Agents", "Sender");
  await expect(rows).toHaveCount(0);
  await chooseFilter("Everyone", "Sender");
  await expect(rows).toHaveCount(2);
  // Main's fixture now also mentions the viewer in the other thread's nested
  // reply. Keep both groups and select this exact preview, not a namesake row.
  const mentionRow = rows.filter({ hasText: "Unread reply 1" });
  await expect(rows.filter({ hasText: "Broadcast reply" })).toHaveCount(1);
  const source = mentionRow.locator("[data-inbox-source]");
  await expect(source).toHaveText("#Alpha");
  expect(
    await source.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      radius: getComputedStyle(element).borderRadius,
      inset: getComputedStyle(element).paddingInlineStart,
    })),
  ).toEqual(dmStyle);
  await expect(mentionRow).not.toContainText(/ · (Mention|Thread|Agent)/);
  const hierarchy = await mentionRow.evaluate((row) => {
    const sender = row.querySelector("strong");
    const source = row.querySelector("[data-inbox-source]");
    if (!sender || !source) return undefined;
    return {
      senderWeight: Number(getComputedStyle(sender).fontWeight),
      sourceSize: Number.parseFloat(getComputedStyle(source).fontSize),
      senderSize: Number.parseFloat(getComputedStyle(sender).fontSize),
      sourceFill: getComputedStyle(source).backgroundColor,
      rowFill: getComputedStyle(row).backgroundColor,
    };
  });
  expect(hierarchy?.senderWeight).toBeGreaterThanOrEqual(500);
  expect(hierarchy?.sourceSize).toBeLessThan(hierarchy?.senderSize);
  expect(hierarchy?.sourceFill).not.toBe(hierarchy?.rowFill);
  expect(
    await source.evaluate((element) => {
      const preview =
        element.parentElement.parentElement.querySelector("[class*='preview']");
      return (
        preview &&
        element.getBoundingClientRect().top <
          preview.getBoundingClientRect().top
      );
    }),
  ).toBe(true);
  await chooseFilter("Threads");
  await expect(
    inbox.getByText("Unread reply 1", { exact: true }),
  ).toBeVisible();
  await chooseFilter("Mentions");
  for (const [mode, width] of [
    ["light", 1280],
    ["dark", 760],
    ["dark", 390],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    await expect(
      inbox.getByRole("combobox", { name: "Activity type" }),
    ).toBeVisible();
    await expect(inbox.getByRole("combobox", { name: "Sender" })).toBeVisible();
    const toolbar = inbox.locator('[class*="toolbar"]').first();
    const layout = await toolbar.evaluate((element) => {
      const [activity, sender] = element.querySelectorAll('[role="combobox"]');
      const unread = element.querySelector('[role="checkbox"]');
      if (!activity || !sender || !unread) return;
      const a = activity.getBoundingClientRect();
      const s = sender.getBoundingClientRect();
      const u = unread.getBoundingClientRect();
      const t = element.getBoundingClientRect();
      return {
        pairGap: s.left - a.right,
        pairY: s.top - a.top,
        unreadY: u.top - a.top,
        left: t.left,
        right: t.right,
        bottom: t.bottom,
        unreadRight: u.right,
        unreadBottom: u.bottom,
      };
    });
    expect(layout?.pairY).toBe(0);
    expect(layout?.pairGap).toBeCloseTo(8, 0);
    expect(layout?.unreadRight).toBeLessThanOrEqual(layout.right);
    expect(layout?.unreadBottom).toBeLessThanOrEqual(layout.bottom);
    expect(layout?.unreadY).toBeGreaterThanOrEqual(0);
    if (width === 390) expect(layout?.unreadY).toBeGreaterThan(0);
    await expect(
      inbox.getByText("Unread reply 1", { exact: true }),
    ).toBeVisible();
    expect(
      await inbox.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`inbox-${mode}-${width}.png`),
    });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  const expected = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 1");
  await mentionRow.getByRole("button", { name: /^Open / }).focus();
  await page.keyboard.press("Enter");
  const detail = inbox.getByRole("region", { name: "Inbox detail" });
  await expect(detail).toBeVisible();
  const thread = detail.getByRole("region", {
    name: "Thread messages",
    exact: true,
  });
  await expect(
    thread.getByText("Unread reply 1", { exact: true }),
  ).toBeVisible();
  // Main owns the floating message actions/grouping. Hover must not reserve a
  // new row or displace content in this embedded consumer.
  const firstMessage = thread.locator("[data-message-id]").first();
  const beforeHover = await firstMessage.boundingBox();
  await firstMessage.hover();
  await expect
    .poll(async () => (await firstMessage.boundingBox())?.height)
    .toBe(beforeHover?.height);
  const filter = inbox.getByRole("combobox", { name: "Activity type" });
  const heading = detail.getByRole("heading", { name: /^#/ });
  const filterBox = await filter.boundingBox();
  const headingBox = await heading.boundingBox();
  const listBox = await rows.first().boundingBox();
  const threadBox = await detail
    .locator('aside[aria-label="Thread"]')
    .boundingBox();
  expect(
    filterBox && headingBox && Math.abs(filterBox.y - headingBox.y),
  ).toBeLessThan(24);
  expect(
    listBox && threadBox && Math.abs(listBox.y - threadBox.y),
  ).toBeLessThan(3);
  const inset = await detail.evaluate((element) => ({
    bottom: element.getBoundingClientRect().bottom,
    threadBottom: element
      .querySelector('aside[aria-label="Thread"]')
      .getBoundingClientRect().bottom,
    padding: Number.parseFloat(getComputedStyle(element).paddingBottom),
  }));
  expect(inset.bottom - inset.threadBottom).toBeCloseTo(inset.padding, 0);
  await expect(inbox.getByText("Back to list")).toHaveCount(0);
  await expect(inbox.getByText("Open in channel")).toHaveCount(0);
  await expect(mentionRow.getByRole("img", { name: "Unread" })).toHaveCount(0);
  // Available Inbox width, not the viewport, must collapse the selected panes:
  // the persistent sidebar leaves too little room at both 720px and 900px.
  for (const [mode, width] of [
    ["light", 720],
    ["dark", 900],
    ["dark", 390],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    await expect(
      inbox.getByRole("list", { name: "Inbox conversations" }),
    ).not.toBeVisible();
    await expect(filter).not.toBeVisible();
    const editor = detail.getByRole("textbox", { name: "Reply to thread" });
    const close = detail.getByRole("button", { name: "Close thread" });
    const send = detail.getByRole("button", { name: "Send message" });
    const available = await inbox.boundingBox();
    for (const control of [detail, thread, editor, close, send]) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(available.x);
      expect(box.x + box.width).toBeLessThanOrEqual(
        available.x + available.width,
      );
      expect(box.y + box.height).toBeLessThanOrEqual(
        available.y + available.height,
      );
    }
    expect(
      await inbox.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`inbox-selected-${mode}-${width}.png`),
    });
    await close.click();
    await expect(detail).toHaveCount(0);
    await expect(
      mentionRow.getByRole("button", { name: /^Open / }),
    ).toBeFocused();
    for (const control of [
      filter,
      inbox.getByRole("combobox", { name: "Sender" }),
    ]) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(available.x);
      expect(box.x + box.width).toBeLessThanOrEqual(
        available.x + available.width,
      );
    }
    await page.keyboard.press("Enter");
    await expect(detail).toBeVisible();
    await expect(
      thread.getByText("Unread reply 1", { exact: true }),
    ).toBeVisible();
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(filter).toBeVisible();
  await detail.getByRole("button", { name: "Open in channel" }).click();
  const target = await page.evaluate(
    () => history.state.buzzNavigationV1.entry.target,
  );
  expect(target.threadRootId).toBe(expected.id);
  expect(target.messageId).toMatch(/^[a-f0-9]{64}$/);
  await page.getByRole("button", { name: "Go back", exact: true }).click();
  await expect(inbox).toBeVisible();
  await chooseFilter("Mentions");
  // Opening reads; right-click and keyboard still expose local unread.
  const row = mentionRow;
  await expect(row.getByRole("button", { name: /^Actions for / })).toHaveCount(
    0,
  );
  await expect(
    row.getByRole("button", { name: /Mark as read|Mark unread/ }),
  ).toHaveCount(0);
  await row.getByRole("button", { name: /^Open / }).click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Mark as read" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await row.getByRole("button", { name: /^Open / }).focus();
  await page.keyboard.press("Shift+F10");
  let action = page.getByRole("menuitem", { name: "Mark unread" });
  await expect(action).toBeVisible();
  await expect(page.getByText("Mark unread on this device only.")).toHaveCount(
    0,
  );
  await action.click();
  await expect(row.getByRole("img", { name: "Unread" })).toBeVisible();
  await row.getByRole("button", { name: /^Open / }).click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Mark unread" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await inbox.getByRole("checkbox", { name: "Unread only" }).check();
  await expect(rows).toHaveCount(2);
  await row.getByRole("button", { name: /^Open / }).click();
  await expect(row.getByRole("img", { name: "Unread" })).toHaveCount(0);
  await row.getByRole("button", { name: /^Open / }).click({ button: "right" });
  action = page.getByRole("menuitem", { name: "Mark unread" });
  await action.click();
  await expect(row.getByRole("img", { name: "Unread" })).toBeVisible();
  // A re-click does not undo the user's mark; a new visit after closing does.
  await row.getByRole("button", { name: /^Open / }).click();
  await expect(row.getByRole("img", { name: "Unread" })).toBeVisible();
  await detail.getByRole("button", { name: "Close thread" }).click();
  await expect(row.getByRole("button", { name: /^Open / })).toBeFocused();
  await row.getByRole("button", { name: /^Open / }).click();
  await expect(row.getByRole("img", { name: "Unread" })).toHaveCount(0);
  // The DM timeline and composer must occupy one vertical detail column.
  await chooseFilter("DMs");
  await rows
    .first()
    .getByRole("button", { name: /^Open / })
    .click();
  const direct = detail.getByRole("region", { name: "Conversation preview" });
  await expect(
    direct.getByRole("form", { name: /Send a message/ }),
  ).toBeVisible();
  const geometry = await direct.evaluate((element) => {
    const history = element.querySelector(
      '[aria-label="Channel message history"]',
    );
    const composer = element.querySelector("form");
    if (!history || !composer) return;
    return {
      direction: getComputedStyle(element).flexDirection,
      history: history.getBoundingClientRect().toJSON(),
      composer: composer.getBoundingClientRect().toJSON(),
    };
  });
  expect(geometry?.direction).toBe("column");
  expect(geometry?.composer.top).toBeGreaterThanOrEqual(
    geometry.history.bottom,
  );
  expect(geometry?.composer.left).toBeGreaterThanOrEqual(geometry.history.left);
  expect(geometry?.composer.right).toBeLessThanOrEqual(geometry.history.right);
  // Unread-only now filters the read DM away. Closing leaves the pane clean;
  // a separate keyboard case verifies fallback focus with another visible row.
  await direct.getByRole("button", { name: "Close detail" }).click();
  await expect(detail).toHaveCount(0);
});

// Newest-first integration: exact Inbox selection must not be replaced by the
// newest ten replies; the saved draft context is exercised by PR5.
test.describe("signed newest-first Inbox windows", () => {
  const channel = "00000000-0000-0000-0000-000000000123";
  test.use({
    threadUnread: false,
    threadUnreadMentions: false,
    inboxDm: false,
    inboxThreadWindow: true,
    channelIds: ["alpha", channel],
    channelNames: { [channel]: "Window room" },
    historyCounts: { alpha: 1, [channel]: 0 },
  });
  test("reveals an older exact unread anchor in newest-first context", async ({
    page,
    app,
  }) => {
    const { root, replies } = app.inboxWindow;
    const oldest = replies[0],
      newest = replies.at(-1);
    await page.goto(app.origin);
    await openPage(page, "Inbox");

    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
    const row = inbox
      .getByRole("list", { name: "Inbox conversations" })
      .getByRole("listitem")
      .filter({ hasText: "Inbox strict reply 0" });
    await row.getByRole("button", { name: /^Open / }).click();
    const detail = inbox.getByRole("region", { name: "Inbox detail" });
    const target = detail.locator(`[data-message-id="${oldest.id}"]`);
    await expect(target).toBeInViewport();
    await expect(target).toBeFocused();
    await expect(
      detail.getByRole("textbox", { name: "Reply to thread" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        app.report.queries.some(
          ({ filter }) =>
            filter.thread_window &&
            filter.limit === 10 &&
            filter["#h"]?.includes(channel),
        ),
      )
      .toBe(true);
    await expect(
      detail.locator(`[data-message-id="${newest.id}"]`),
    ).toBeAttached();
    // The selected anchor survives a later arrival; no fresh click/reveal was requested.
    const arrival = app.reply(root.id);
    await expect(
      detail.getByText("New peer reply", { exact: true }),
    ).toBeAttached();
    await expect(target).toBeInViewport();
    await detail.getByRole("button", { name: "Close thread" }).click();
    const readRow = inbox
      .getByRole("list", { name: "Inbox conversations" })
      .getByRole("listitem")
      .filter({ hasText: "Window room" });
    await readRow.getByRole("button", { name: /^Open / }).click();
    await expect(
      detail.getByRole("textbox", { name: "Reply to thread" }),
    ).toBeVisible();
    await detail.getByRole("button", { name: "Open in channel" }).click();
    const origin = await page.evaluate(
      () => history.state.buzzNavigationV1.entry.target,
    );
    expect(origin.channelId).toBe(channel);
    expect(origin.threadRootId).toBe(root.id);
    await page.getByRole("button", { name: "Go back", exact: true }).click();
    await expect(inbox).toBeVisible();
    const again = inbox
      .getByRole("list", { name: "Inbox conversations" })
      .getByRole("listitem")
      .filter({ hasText: "Window room" });
    await again.getByRole("button", { name: /^Open / }).click();
    const current = detail
      .locator("[data-message-id]")
      .filter({ hasText: "New peer reply" });
    await expect(current).toBeFocused();
    // This removal is signed by the synthetic author and arrives through the
    // actual shared relay stream. It cannot turn a vanished target into a tail reveal.
    app.deleteInboxAnchor(arrival);
    await expect(current).toHaveCount(0);
    // The unread owner retires this selected target; other participating
    // replies can still keep the same conversation in the list.
    await expect(detail).toHaveCount(0);
    await expect(again).toHaveCount(1);
    await expect(again).not.toContainText("New peer reply");
  });
});

// Browser boundary: shared top-level head cannot reveal a row it does not contain.
// The exact thread fallback must own focus/scroll and canonical origin, not a mock DOM.
test.describe("DM exact opening outside the head", () => {
  test.use({ inboxDmOldAnchor: true });
  test("retains and focuses the selected old DM instead of silently substituting the newest head", async ({
    page,
    app,
  }) => {
    await open(page, app);
    await openPage(page, "Inbox");
    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
    const row = inbox
      .getByRole("list", { name: "Inbox conversations" })
      .getByRole("listitem")
      .filter({ hasText: "Inbox old DM anchor" });
    await row.getByRole("button", { name: /^Open / }).click();
    const detail = inbox.getByRole("region", { name: "Inbox detail" });
    const target = detail.locator(
      `[data-message-id="${app.inboxDmAnchor.id}"]`,
    );
    await expect(target).toBeInViewport();
    await expect(target).toBeFocused();
    await expect(
      detail.getByRole("complementary", { name: "Thread" }),
    ).toBeVisible();
    await expect(detail.getByRole("form")).toHaveCount(1);
    await expect(detail.getByRole("button", { name: /^Close / })).toHaveCount(
      1,
    );
    await expect
      .poll(() =>
        app.report.queries.some(
          ({ filter }) => filter.top_level && filter["#h"]?.includes("dm-peer"),
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        app.report.queries.some(({ filter }) =>
          filter.ids?.includes(app.inboxDmAnchor.id),
        ),
      )
      .toBe(true);
    // The row now describes the newest read message, but clicking the already
    // selected conversation must retain this exact reader and captured origin.
    const selectedRow = inbox
      .getByRole("list", { name: "Inbox conversations" })
      .getByRole("listitem")
      .filter({ has: page.locator('[aria-current="page"]') });
    await expect(selectedRow).toContainText("Inbox DM fixture reply");
    const retainedTarget = await target.elementHandle();
    if (!retainedTarget) throw new Error("Missing exact DM target");
    await selectedRow.getByRole("button", { name: /^Open / }).click();
    expect(
      await retainedTarget.evaluate((element) => element.isConnected),
    ).toBe(true);
    await expect(target).toBeInViewport();
    await expect(
      detail.getByRole("complementary", { name: "Thread" }),
    ).toBeVisible();
    await retainedTarget.dispose();
    await detail.getByRole("button", { name: "Open in channel" }).click();
    const origin = await page.evaluate(
      () => history.state.buzzNavigationV1.entry.target,
    );
    expect(origin.channelId).toBe("dm-peer");
    expect(origin.messageId).toBe(app.inboxDmAnchor.id);
  });
});

// Session policy must survive bundled Inbox -> shared thread composer -> broker
// publication, including the inferred exact recipient and signed roster preflight.
test.describe("Inbox session reply admission", () => {
  test.use({
    sessionChannels: ["alpha"],
    agentPeers: true,
    inboxSessionAgent: true,
  });
  test("plain session reply notifies the sole member agent through the shared composer", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await openPage(page, "Inbox");
    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
    const row = inbox
      .getByRole("list", { name: "Inbox conversations" })
      .getByRole("listitem")
      .filter({ hasText: "Unread reply 1" });
    await row.getByRole("button", { name: /^Open / }).click();
    const detail = inbox.getByRole("region", { name: "Inbox detail" });
    const editor = detail.getByRole("textbox", { name: "Reply to thread" });
    await expect(editor).toBeVisible();
    await expect(
      detail.getByRole("button", {
        name: "Change selected agent",
        exact: true,
      }),
    ).toBeVisible();
    const root = app.histories
      .get("primary/alpha")
      .find((event) => event.content === "Thread root 1");
    if (!root) throw new Error("Missing session root fixture");
    const roster = app
      .startupCache()
      .discovery.find(
        (event) =>
          event.kind === 39002 &&
          event.tags.some(([name, value]) => name === "d" && value === "alpha"),
      );
    if (!roster) throw new Error("Missing verified session roster");
    const agents = roster.tags
      .filter(([name, key]) => name === "p" && key !== app.viewer)
      .map(([, key]) => key);
    expect(agents).toHaveLength(1);
    await editor.fill("Inbox session reply without a typed mention");
    await detail.getByRole("button", { name: "Send message" }).click();
    await expect
      .poll(() =>
        app.report.publications.filter(({ event }) => event?.kind === 9),
      )
      .toHaveLength(1);
    const sent = app.report.publications.find(
      ({ event }) => event?.kind === 9,
    )?.event;
    if (!sent) throw new Error("Missing signed session reply");
    expect(sent.tags).toContainEqual(["h", "alpha"]);
    expect(sent.tags).toContainEqual(["e", root.id, "", "reply"]);
    expect(sent.tags.filter(([name]) => name === "p")).toEqual([
      ["p", agents[0]],
    ]);
  });
});

// Browser-only: CSS hides the list at this width. Real IndexedDB rejection must
// remain visible/retryable while the selected detail is mounted, not just in DOM.
test("narrow selected detail keeps a rejected read save and its captured Retry visible", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    window.inboxReadFailure = { armed: false, failures: 0, saves: 0 };
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (
        this.name === "partitions" &&
        this.transaction.db.name === "buzz-read-state-v1"
      ) {
        if (
          window.inboxReadFailure.armed &&
          Object.keys(value?.state?.frontiers ?? {}).length
        ) {
          window.inboxReadFailure.failures++;
          throw new Error("Synthetic read storage failure");
        }
        this.transaction.addEventListener(
          "complete",
          () => {
            window.inboxReadFailure.saves++;
          },
          { once: true },
        );
      }
      return put.call(this, value, ...args);
    };
  });
  await open(page, app);
  await page
    .getByRole("button", { name: "Show navigation", exact: true })
    .click();
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  await inbox.getByRole("combobox", { name: "Activity type" }).click();
  await page.getByRole("option", { name: "Mentions", exact: true }).click();
  const row = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem")
    .filter({ hasText: "Unread reply 1" });
  await expect(row.getByRole("img", { name: "Unread" })).toBeVisible();
  await page.evaluate(() => {
    window.inboxReadFailure.armed = true;
    window.inboxRevealComplete = false;
    document.addEventListener(
      "reading-positioned",
      (event) => {
        const active = document.activeElement;
        if (
          event.detail?.reason === "exact-reveal" &&
          event.target instanceof HTMLElement &&
          event.target.getAttribute("aria-label") === "Thread messages" &&
          active instanceof HTMLElement &&
          active.matches("[data-message-id]") &&
          active.textContent.includes("Unread reply 1") &&
          event.target.contains(active)
        )
          window.inboxRevealComplete = true;
      },
      { capture: true },
    );
  });
  try {
    await row.getByRole("button", { name: /^Open / }).click();
    const detail = inbox.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    await expect(detail).toBeVisible();
    const alert = inbox
      .getByRole("alert")
      .filter({ hasText: "Synthetic read storage failure" });
    await expect(alert).toBeVisible();
    await expect(
      alert.getByRole("button", { name: "Retry inbox" }),
    ).toBeInViewport();
    await expect(
      inbox.getByRole("list", { name: "Inbox conversations" }),
    ).not.toBeVisible();
    const saves = await page.evaluate(() => {
      window.inboxReadFailure.armed = false;
      return window.inboxReadFailure.saves;
    });
    // Establish the already-spent exact reveal before moving to Retry.
    const target = detail
      .locator("[data-message-id]")
      .filter({ hasText: "Unread reply 1" });
    await expect(target).toBeFocused();
    // Focus happens one frame before the reveal owner marks navigation done.
    // Moving focus early leaves that owner able to steal it back after Retry.
    await expect
      .poll(() => page.evaluate(() => window.inboxRevealComplete))
      .toBe(true);
    const retry = alert.getByRole("button", { name: "Retry inbox" });
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect(alert).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => window.inboxReadFailure.saves))
      .toBeGreaterThan(saves);
    await expect(detail).toBeVisible();
    await expect(
      detail.getByRole("button", { name: "Close thread", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(detail).toHaveCount(0);
    await expect(row.getByRole("button", { name: /^Open / })).toBeFocused();
    await expect(row.getByRole("img", { name: "Unread" })).toHaveCount(0);
  } finally {
    await page.evaluate(() => {
      window.inboxReadFailure.armed = false;
    });
  }
});

// Browser-only: the invoking row is display:none at 390px. Native Enter must
// reach a visible placeholder control so real keyboard Escape can dismiss it.
test("narrow incomplete preview receives keyboard focus once and Escape returns to its row", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route("**/api/relay/**/query", async (route) => {
    if (
      !route
        .request()
        .postDataJSON()
        .some((filter) => filter["#e"] && filter.kinds?.includes(40003))
    )
      return route.continue();
    requested = true;
    await held;
    // Malformed evidence fails the reader without a browser HTTP-error log.
    await route.fulfill({ json: { error: "Synthetic auxiliary failure" } });
  });
  try {
    await open(page, app);
    await openPage(page, "Inbox");
    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    await expect.poll(() => requested).toBe(true);
    const list = inbox.getByRole("list", { name: "Inbox conversations" });
    // Both mentioned groups are pending; either exact mounted row exercises
    // the same placeholder focus contract, and neither changes order on error.
    const row = list
      .getByRole("listitem")
      .filter({ hasText: "#Alpha" })
      .first();
    await expect(row).toContainText("Preview updating…");
    const invoking = row.getByRole("button", { name: /^Open / });
    await invoking.focus();
    await page.keyboard.press("Enter");
    const detail = inbox.getByRole("region", { name: "Inbox detail" });
    await expect(detail).toContainText("Preview updating…");
    await expect(list).not.toBeVisible();
    await expect(
      detail.getByRole("button", { name: "Close detail" }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(detail).toHaveCount(0);
    await expect(invoking).toBeFocused();
    // Reopening a failed placeholder is also a keyboard-accessible visit.
    release();
    await expect(row).toContainText("Preview unavailable. Retry inbox.");
    await page.keyboard.press("Enter");
    const close = detail.getByRole("button", { name: "Close detail" });
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    const other = detail.getByRole("button", { name: "Open in channel" });
    await expect(other).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(detail).toHaveCount(0);
    await expect(invoking).toBeFocused();
  } finally {
    release();
  }
});

// Browser-only: a selected top-level DM already in the real channel head must
// focus its exact row, not merely scroll or rely on jsdom's synthetic geometry.
test("an in-head DM keeps exact focus and Escape returns from an empty narrow list", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, app);
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  // Real portalled video dismissal must stay with its document-level owner.
  const videoUrl = "https://primary.example/media/inbox-review.mp4";
  await page.route("**/api/relay/primary/media?**", (route) =>
    route.fulfill({
      path: "tests/fixtures/message-gallery/assets/sample.mp4",
      contentType: "video/mp4",
    }),
  );
  app.append(
    "primary",
    "dm-peer",
    "Inbox video",
    false,
    false,
    undefined,
    undefined,
    [["imeta", `url ${videoUrl}`, "m video/mp4"]],
  );
  await inbox.getByRole("combobox", { name: "Activity type" }).click();
  await page.getByRole("option", { name: "DMs", exact: true }).click();
  await inbox.getByRole("checkbox", { name: "Unread only" }).check();
  const list = inbox.getByRole("list", { name: "Inbox conversations" });
  const row = list.getByRole("listitem").first();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await row.getByRole("button", { name: /^Open / }).click();
  const detail = inbox.getByRole("region", { name: "Inbox detail" });
  const target = detail
    .locator("[data-message-id]")
    .filter({ hasText: "Inbox DM fixture reply" });
  await expect(target).toBeInViewport();
  await expect(target).toBeFocused();
  await expect(detail.getByRole("form")).toHaveCount(1);
  const mediaOpener = detail.getByRole("button", {
    name: "Open video fullscreen",
  });
  await detail.locator("[data-video-preview]").hover();
  await expect(mediaOpener).toHaveCSS("pointer-events", "auto");
  await mediaOpener.click();
  const media = page.getByRole("dialog", { name: "Video attachment" });
  await expect(media).toBeVisible();
  await media.getByRole("button", { name: "Close fullscreen viewer" }).focus();
  await page.keyboard.press("Escape");
  await expect(media).toHaveCount(0);
  await expect(detail).toBeVisible();
  await expect(mediaOpener).toBeFocused();
  await expect(row.getByRole("img", { name: "Unread" })).toHaveCount(0);
  await expect(list).not.toBeVisible();
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  await expect(list).toBeVisible();
  await expect(list.getByRole("listitem")).toHaveCount(0);
  await expect(
    inbox.getByRole("combobox", { name: "Activity type", exact: true }),
  ).toBeFocused();
});

// Browser-only: native keyboard focus transfer after Escape; jsdom cannot
// establish document focus or the responsive list/detail transition.
test("Escape from an unread detail restores its invoking row", async ({
  page,
  app,
}) => {
  await open(page, app);
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  await inbox.getByRole("checkbox", { name: "Unread only" }).check();
  const list = inbox.getByRole("list", { name: "Inbox conversations" });
  const first = list
    .getByRole("listitem")
    .filter({ hasText: "Unread reply 1" });
  const invoking = first.getByRole("button", { name: /^Open / });
  const invokedElement = await invoking.elementHandle();
  if (!invokedElement) throw new Error("Missing invoking thread row");
  await invoking.focus();
  await page.keyboard.press("Enter");
  const detail = inbox.getByRole("region", { name: "Inbox detail" });
  await expect(detail).toBeVisible();
  await expect(first.getByRole("img", { name: "Unread" })).toHaveCount(0);
  await detail.getByRole("button", { name: "Close thread" }).focus();
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  await expect(
    list
      .getByRole("listitem")
      .first()
      .getByRole("button", { name: /^Open / }),
  ).toBeFocused();
  // The remaining group can have the identical sender/channel label.
  expect(await invokedElement.evaluate((element) => element.isConnected)).toBe(
    false,
  );
  await invokedElement.dispose();
});
