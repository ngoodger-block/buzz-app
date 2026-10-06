import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

const channel = "f12918e7-88d0-4ddd-aa6b-d4888ff6d3bd";
test.use({
  productionBroker: true,
  readState: true,
  inboxThreadWindow: true,
  pluginFixtures: true,
  channelIds: ["alpha", channel],
  channelNames: { [channel]: "Archive room" },
  historyCounts: { alpha: 1, [channel]: 0 },
  screenshot: "off",
});

test("Inbox archive survives reload, restores, and reopens on a new mention", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const rows = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem");
  await expect(rows).toHaveCount(1);
  await rows.getByRole("button", { name: /^Open / }).click();
  await inbox.getByRole("button", { name: "Archive conversation" }).click();
  await expect(rows).toHaveCount(0);
  await expect(inbox.getByRole("region", { name: "Inbox detail" })).toHaveCount(
    0,
  );
  await page.reload();
  await openPage(page, "Inbox");
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  await expect(rows).toHaveCount(0);
  await inbox.getByRole("button", { name: "Archived", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await rows.getByRole("button", { name: /^Open / }).focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Restore conversation" }).click();
  await expect(rows).toHaveCount(0);
  await inbox.getByRole("button", { name: "Back to Inbox" }).click();
  await expect(rows).toHaveCount(1);
  await rows.getByRole("button", { name: /^Open / }).focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Archive conversation" }).click();
  await expect(rows).toHaveCount(0);
  const { root } = app.inboxWindow;
  const seed = app.sign({
    kind: 9,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["h", channel],
      ["e", root.id, "", "reply"],
    ],
    content: "Our current context",
  });
  app.histories.get(`primary/${channel}`).push(seed);
  app.relay.publish("primary", seed);
  app.append("primary", channel, "Agent progress", true, false, root.id);
  await inbox.getByRole("button", { name: "Archived", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Archive room");
  await inbox.getByRole("button", { name: "Back to Inbox" }).click();
  await expect(rows).toHaveCount(0);
  app.append(
    "primary",
    channel,
    "John, please decide",
    true,
    false,
    root.id,
    undefined,
    [["p", app.viewer]],
  );
  await expect(rows).toHaveCount(1);
  // Retirement persists even after the newer evidence is reloaded.
  await page.reload();
  await openPage(page, "Inbox");
  await expect(rows).toHaveCount(1);
});
