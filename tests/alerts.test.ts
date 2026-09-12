import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeHtml, formatAlert } from "../src/alerts.ts";

test("escapeHtml encodes markup", () => {
  assert.equal(escapeHtml("<b>&"), "&lt;b&gt;&amp;");
});

test("formatAlert includes keywords, kyiv time, link, and full text", () => {
  const html = formatAlert({
    text: "На Бучу зайшов борт",
    keywords: ["Буча"],
    messageId: 42,
    date: new Date("2026-09-10T14:09:00.000Z"),
    channelUsername: "chyste_nebo",
  });
  assert.doesNotMatch(html, /Збіг у каналі/);
  assert.match(html, /Буча/);
  assert.match(html, /На Бучу зайшов борт/);
  assert.match(html, /https:\/\/t\.me\/chyste_nebo\/42/);
  assert.match(html, /Київ/);
  assert.match(html, /Оригінал поста/);
});

test("formatAlert clips overlong text", () => {
  const html = formatAlert({
    text: "x".repeat(5000),
    keywords: ["ракета"],
    messageId: 7,
    date: new Date("2026-09-10T14:09:00.000Z"),
    channelUsername: "@chyste_nebo",
  });
  assert.doesNotMatch(html, /Оновлення поста/);
  assert.match(html, /текст обрізано/);
  assert.ok(html.length <= 4096);
});
