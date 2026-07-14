/**
 * Hermetic checks for the PURE markdown -> Telegram-safe HTML converter (src/format.ts) and the
 * outbound render seam. No network, no mesh. `tsx --test test/*.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { escapeHtml, mdToHtml, renderLabel, renderOutbound, telegramFormatter } from "../src/format.js";
import { chunkMessage } from "@cotal-ai/endpoint-core";

const count = (s: string, needle: string) => s.split(needle).length - 1;

// ── bold / italic ────────────────────────────────────────────────────────────────────────────────
test("both **bold** and *bold* render as a bold entity", () => {
  assert.equal(mdToHtml("**hi**"), "<b>hi</b>");
  assert.equal(mdToHtml("*hi*"), "<i>hi</i>"); // single-asterisk is italic in markdown…
  assert.equal(mdToHtml("__hi__"), "<b>hi</b>");
  assert.equal(mdToHtml("_hi_"), "<i>hi</i>");
  // a full sentence with both forms
  assert.equal(mdToHtml("say **loud** and *soft*"), "say <b>loud</b> and <i>soft</i>");
});

test("markdown-that-most-agents-emit: **bold** double asterisk becomes bold (legacy Markdown would not)", () => {
  assert.equal(mdToHtml("ship **now** please"), "ship <b>now</b> please");
});

test("emphasis does NOT trigger on intra-word underscores or arithmetic asterisks", () => {
  assert.equal(mdToHtml("agent a_b_c pinged"), "agent a_b_c pinged"); // a_b_c is not italic
  assert.equal(mdToHtml("2 * 3 * 4"), "2 * 3 * 4"); // spaced asterisks are not italic
});

// ── code ───────────────────────────────────────────────────────────────────────────────────────
test("`code` becomes <code> and its contents are NOT markdown-interpreted or unescaped", () => {
  assert.equal(mdToHtml("run `npm test`"), "run <code>npm test</code>");
  assert.equal(mdToHtml("`a < b && c > d`"), "<code>a &lt; b &amp;&amp; c &gt; d</code>");
  assert.equal(mdToHtml("`**not bold**`"), "<code>**not bold**</code>"); // markdown inside code is literal
});

test("a triple-backtick fenced block becomes <pre> (language label preserved, contents escaped)", () => {
  assert.equal(mdToHtml("```\nplain\n```"), "<pre>plain</pre>");
  assert.equal(
    mdToHtml("```python\nprint(1 < 2)\n```"),
    '<pre><code class="language-python">print(1 &lt; 2)</code></pre>',
  );
  // fenced content is never treated as markup
  assert.equal(mdToHtml("```\n**x** and `y`\n```"), "<pre>**x** and `y`</pre>");
});

// ── HTML-escape + MarkdownV2-hostile punctuation ──────────────────────────────────────────────────
test("the three HTML-significant chars are escaped everywhere", () => {
  assert.equal(mdToHtml("a < b & c > d"), "a &lt; b &amp; c &gt; d");
  assert.equal(escapeHtml("<b>&</b>"), "&lt;b&gt;&amp;&lt;/b&gt;");
});

test("MarkdownV2-hostile punctuation (. - ( ) ! = |) renders verbatim (HTML never 400s on it)", () => {
  // Under MarkdownV2 each of these would need a backslash-escape or the send is a 400. Under HTML they
  // are plain literal text — exactly the robustness win.
  const hostile = "Done. Rolled back 2-3 items (see note!). a=b | c";
  assert.equal(mdToHtml(hostile), hostile);
});

test("a would-be script injection is neutralized by escaping", () => {
  assert.equal(mdToHtml("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
});

// ── links / headings / bullets ────────────────────────────────────────────────────────────────
test("[text](url) becomes an anchor for http(s)/tg schemes only; other schemes stay literal", () => {
  assert.equal(mdToHtml("[docs](https://x.io/a)"), '<a href="https://x.io/a">docs</a>');
  assert.equal(mdToHtml("[x](javascript:alert(1))"), "[x](javascript:alert(1))"); // unsafe scheme → literal
  // an ampersand in the query is escaped for the attribute value
  assert.equal(mdToHtml("[q](https://x.io?a=1&b=2)"), '<a href="https://x.io?a=1&amp;b=2">q</a>');
});

test("headings -> bold line; list bullets -> a bullet dot", () => {
  assert.equal(mdToHtml("## Summary"), "<b>Summary</b>");
  assert.equal(mdToHtml("- one\n- two"), "• one\n• two");
  assert.equal(mdToHtml("* item"), "• item"); // a single-asterisk bullet is a bullet, not italic
});

// ── label neutrality (the <from>: prefix) ─────────────────────────────────────────────────────────
test("renderLabel escapes the sender name and never markdown-parses it (hostile names stay safe)", () => {
  assert.equal(renderLabel("a_b: "), "a_b: "); // underscores are literal, not italic
  assert.equal(renderLabel("*star*: "), "*star*: "); // asterisks are literal, not bold
  assert.equal(renderLabel("<script: "), "&lt;script: ");
  assert.equal(renderLabel("[#eng] a_b: "), "[#eng] a_b: ");
});

test("renderOutbound: first chunk keeps a neutral label while the BODY is markdown-converted", () => {
  const r = renderOutbound("a_b: shipped **it**", "a_b: ", true);
  assert.equal(r.text, "a_b: shipped <b>it</b>"); // name literal, body bold
  assert.equal(r.parseMode, "HTML");
});

test("renderOutbound with markdown off is the raw chunk, parse_mode omitted", () => {
  const r = renderOutbound("alice: **bold**", "alice: ", false);
  assert.equal(r.text, "alice: **bold**");
  assert.equal(r.parseMode, undefined);
});

test("renderOutbound: a plain-text (no-markup) message renders byte-identically to the raw label+body", () => {
  const r = renderOutbound("alice: PR is up", "alice: ", true);
  assert.equal(r.text, "alice: PR is up");
});

// ── chunk boundary never splits an entity ─────────────────────────────────────────────────────────
test("a markdown span split across a chunk boundary yields balanced tags on BOTH chunks (no half-open tag)", () => {
  // A **bold** that straddles the 4096 hard-cut. No whitespace anywhere, so chunkMessage hard-cuts at
  // exactly 4096 — INSIDE the bold — proving format-after-chunk never emits a cross-chunk tag.
  const body = "a".repeat(4090) + "**bold**";
  const chunks = chunkMessage(body);
  assert.ok(chunks.length >= 2, "expected the spaceless body to hard-split");
  const rendered = chunks.map((c) => renderOutbound(c, undefined, true).text);
  for (const r of rendered) {
    assert.equal(count(r, "<b>"), count(r, "</b>"), "balanced bold tags per chunk");
    assert.equal(count(r, "<i>"), count(r, "</i>"), "balanced italic tags per chunk");
    assert.equal(count(r, "<pre>"), count(r, "</pre>"), "balanced pre tags per chunk");
  }
  // The straddling ** never formed a bold at all (each half is literal) — proving no cross-chunk tag.
  assert.equal(rendered.reduce((n, r) => n + count(r, "<b>"), 0), 0);
});

// ── telegramFormatter (the endpoint-core Formatter seam) ──────────────────────────────────────────
test("telegramFormatter(markdown=true) renders HTML with a 'HTML' mode; the label stays neutral", () => {
  const f = telegramFormatter(true);
  const r = f.render("a_b: shipped **it**", "a_b: ");
  assert.equal(r.text, "a_b: shipped <b>it</b>"); // name literal, body bold
  assert.equal(r.mode, "HTML");
});

test("telegramFormatter(markdown=false) is the raw chunk with NO mode (plain)", () => {
  const f = telegramFormatter(false);
  const r = f.render("alice: **bold**", "alice: ");
  assert.equal(r.text, "alice: **bold**");
  assert.equal(r.mode, undefined);
});
