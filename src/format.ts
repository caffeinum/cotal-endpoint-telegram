/**
 * PURE markdown -> Telegram-safe HTML conversion. No network, no mesh, no I/O — unit-tested.
 *
 * WHY HTML parse_mode (not MarkdownV2 / legacy Markdown):
 *   - MarkdownV2 parses `*bold*` but REQUIRES escaping ~18 special chars (`_ * [ ] ( ) ~ \` > # + - = | { } . !`)
 *     in EVERY non-entity run. A single unescaped `.` / `-` / `(` in an agent's message -> HTTP 400
 *     "can't parse entities" -> with this endpoint's nak handling a redelivery loop or a dropped message.
 *     Bulletproof escaping is a known footgun and was explicitly flagged.
 *   - Legacy Markdown is lenient but does NOT parse `**bold**` (double asterisk — exactly what most
 *     agents emit) and is deprecated by Telegram.
 *   - HTML escapes only THREE chars (`< > &`); everything else is literal. Stray punctuation can never
 *     400. Bold/italic/code/links map to well-defined tags. So an agent's `.`, `-`, `(` are just text.
 *
 * Supported agent-markdown syntax (converted to Telegram HTML):
 *   **x** / __x__            -> <b>x</b>
 *   *x* / _x_ (word-bounded) -> <i>x</i>
 *   `x`                      -> <code>x</code>
 *   ```lang\n…\n```          -> <pre><code class="language-lang">…</code></pre>  (lang preserved; optional)
 *   [text](http(s)://url)    -> <a href="url">text</a>  (only http/https/tg schemes; else left literal)
 *   # heading … ###### h     -> <b>heading</b>  (leading #'s stripped)
 *   - / * / + bullet         -> • bullet  (leading marker normalized to a bullet dot)
 *
 * Everything else — including MarkdownV2-hostile `.`/`-`/`(`/`!` — is HTML-escaped literal text and
 * renders verbatim. Code spans/blocks are extracted FIRST so their contents are never re-interpreted.
 */
import type { Formatter, RenderedMessage } from "@cotal-ai/endpoint-core";

/** Escape the three HTML-significant characters. Applied to ALL literal (non-entity) text. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Private-use placeholder sentinels for extracted code (kept out of the escape/inline passes). PUA
// chars never appear in normal text, survive HTML-escaping untouched, are NON-space (so `**` stays
// adjacent to an extracted span) and NON-word (so they read as emphasis boundaries); the distinct
// closing sentinel makes the digit run unambiguous.
const OPEN_BLOCK = "\uE000";
const OPEN_SPAN = "\uE001";
const CLOSE = "\uE002";

/**
 * Convert one chunk of agent markdown into Telegram-safe HTML. Pure + total: any input yields
 * balanced, escaped HTML — a partial/broken markdown span degrades to literal text, never a dangling
 * tag. Because callers convert each ALREADY-CHUNKED piece independently, a markdown span split across a
 * chunk boundary simply renders as literal text on each side; a chunk can never emit a half-open tag.
 */
export function mdToHtml(src: string): string {
  const blocks: string[] = [];
  const spans: string[] = [];

  // 1. Fenced code blocks FIRST (so nothing inside them is treated as markup). Language label kept.
  let text = src.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_m, lang: string, body: string) => {
    const l = lang.trim();
    const code = escapeHtml(body.replace(/\n$/, ""));
    const html = l
      ? `<pre><code class="language-${escapeHtml(l)}">${code}</code></pre>`
      : `<pre>${code}</pre>`;
    blocks.push(html);
    return `${OPEN_BLOCK}${blocks.length - 1}${CLOSE}`;
  });

  // 2. Inline code spans next (single backtick, no newline).
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    spans.push(`<code>${escapeHtml(code)}</code>`);
    return `${OPEN_SPAN}${spans.length - 1}${CLOSE}`;
  });

  // 3. Escape all remaining literal text. After this, `<` `>` `&` are inert; markdown sigils survive.
  text = escapeHtml(text);

  // 4. Links [text](url) — only safe schemes become anchors; anything else stays literal.
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label: string, url: string) => {
    if (!/^(https?:\/\/|tg:\/\/)/i.test(url)) return m; // unsafe/relative scheme -> leave as text
    // `label` is already HTML-escaped (it rode through step 3); `url` too — safe for an attribute value.
    return `<a href="${url}">${label}</a>`;
  });

  // 5. Bold before italic (so `**x**` isn't half-eaten by the single-`*` rule).
  text = text.replace(/\*\*(?=\S)([^\n]+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__(?=\S)([^\n]+?)__/g, "<b>$1</b>");

  // 6. Italic — single `*`/`_` bounded by a non-word/non-sigil char, so `a_b` or `2 * 3` don't italicize.
  text = text.replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)\*(?![*\w])/g, "$1<i>$2</i>");
  text = text.replace(/(^|[^_\w])_(?=\S)([^_\n]+?)_(?![_\w])/g, "$1<i>$2</i>");

  // 7. Per-line block normalization: ATX headings -> bold line; list bullets -> a bullet dot.
  text = text
    .split("\n")
    .map((line) => {
      const h = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (h) return `<b>${h[2]}</b>`;
      const b = line.match(/^(\s*)[-*+]\s+(.*)$/);
      if (b) return `${b[1]}• ${b[2]}`;
      return line;
    })
    .join("\n");

  // 8. Re-insert the extracted code (already-built, already-escaped HTML).
  text = text.replace(new RegExp(`${OPEN_SPAN}(\\d+)${CLOSE}`, "g"), (_m, i: string) => spans[Number(i)]);
  text = text.replace(new RegExp(`${OPEN_BLOCK}(\\d+)${CLOSE}`, "g"), (_m, i: string) => blocks[Number(i)]);
  return text;
}

/**
 * Render the raw `<from>: ` / `[#channel] <from>: ` label to HTML. The sender NAME and channel are
 * ESCAPED and NEVER markdown-parsed — an agent literally named `a_b`, `*x*`, or `<script` can't corrupt
 * the markup. (No emphasis is added, so a plain-text message renders byte-identically to the raw label.)
 */
export function renderLabel(label: string): string {
  return escapeHtml(label);
}

/** A rendered outbound send: the wire `text` plus the `parseMode` to pass (undefined -> plain text). */
export interface Rendered {
  text: string;
  parseMode?: "HTML";
}

/**
 * Render one already-chunked outbound piece for sending.
 *   - `markdown` false -> plain text, parse_mode omitted (the raw chunk, unchanged).
 *   - `markdown` true  -> the label (if this is the first chunk and the chunk starts with it) is escaped
 *     as neutral text and the BODY remainder is markdown->HTML converted; parse_mode "HTML".
 * `label` is passed only for the first chunk (which carries the `<from>: ` prefix); undefined otherwise.
 */
export function renderOutbound(chunk: string, label: string | undefined, markdown: boolean): Rendered {
  if (!markdown) return { text: chunk };
  if (label !== undefined && chunk.startsWith(label)) {
    return { text: renderLabel(label) + mdToHtml(chunk.slice(label.length)), parseMode: "HTML" };
  }
  return { text: mdToHtml(chunk), parseMode: "HTML" };
}

/**
 * The Telegram {@link Formatter} for endpoint-core: adapts {@link renderOutbound} to the core seam. The
 * HTML parse_mode is surfaced as the generic `mode` string; with markdown off it's plain (no mode).
 */
export function telegramFormatter(markdown: boolean): Formatter {
  return {
    render(chunk: string, label: string | undefined): RenderedMessage {
      const r = renderOutbound(chunk, label, markdown);
      return r.parseMode ? { text: r.text, mode: r.parseMode } : { text: r.text };
    },
  };
}
