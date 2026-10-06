import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ historyCounts: { alpha: 3, beta: 0 } });

// Engines copy Selection.toString(): button labels, hover-only clocks and
// visually hidden text all count unless user-select excludes them. jsdom has
// no layout, so only a real engine proves the row chrome stays out.
test("a selection spanning rows copies only the visible conversation", async ({
  page,
  app,
}) => {
  await open(page, app);
  const history = page.getByRole("region", {
    name: "Channel message history",
  });
  const rows = history.locator("[data-message-id]");
  await expect(rows).toHaveCount(3);
  // A drag across rows mounts each row's deferred action bar on the way.
  for (const row of await rows.all()) await row.hover();
  await expect(
    history
      .getByRole("group", { name: "Message actions", includeHidden: true })
      .locator("button"),
  ).toHaveCount(9);
  const { text, author, time } = await history.evaluate((element) => {
    const rows = [...element.querySelectorAll("[data-message-id]")];
    const author = rows[0].querySelector("strong");
    const range = document.createRange();
    range.setStartBefore(author);
    range.setEndAfter(rows.at(-1).querySelector("p:last-of-type"));
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return {
      text: selection.toString(),
      author: author.textContent,
      time: rows[0].querySelector("time [aria-hidden]").textContent,
    };
  });
  const body = (count) => "Mixed height message content. ".repeat(count).trim();
  // The visible byline stays; its hidden full date, each continuation's
  // hover-only clock and screen-reader byline, and the action bars do not.
  expect(text.split("\n").filter(Boolean)).toEqual([
    author,
    time,
    "primary alpha message 0",
    body(1),
    "primary alpha message 1",
    body(4),
    "primary alpha message 2",
    body(7),
  ]);
});
