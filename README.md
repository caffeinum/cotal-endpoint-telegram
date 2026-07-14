# @cotal-ai/endpoint-telegram

A standalone bridge between a [cotal](https://cotal.ai) mesh and a Telegram bot. It joins the mesh as
its **own named peer** (`telegram` by default), so it binds its **own** durable DM consumer and
receives agent DMs in real time — no polling, no cursor contention. Zero paw coupling: it imports only
`@cotal-ai/core`.

## What it does

- **mesh → Telegram** — an agent DMs the `telegram` peer (or posts on the default channel the bridge
  subscribes to) → the bridge sends `"<agent>: <text>"` to every allowlisted Telegram chat, and
  remembers the bot message so a swipe-reply threads back. The agent's **markdown is rendered**
  (`**bold**`, `` `code` ``, links, …) via HTML `parse_mode` by default (`--no-markdown` to disable; a
  formatting 400 auto-retries as plain text). The bridge filters out its OWN echoed broadcasts so the
  human never gets their own outbound line back.
- **Telegram → mesh** — a message to the bot is routed by precedence. Every resolved tag (and a reply)
  **latches** as the chat's **sticky** target, persisted across restarts:
  1. **reply** to a bot message → DM that agent
  2. leading tag — **`@name …`** → DM that agent · **`@all …`** → every present agent · **`#channel …`** →
     broadcast to that channel · **`?role …`** → **anycast** to ONE agent of that role (a single answer,
     not N — the fix for duplicate answers)
  3. **sticky** target (the chat's last destination — dm / all / channel / anycast)
  4. **no sticky yet → `@all`** — a first/forgotten message broadcasts to everyone present, so a fresh
     chat "just works" (never silently pinned to one agent, never dropped)

  **Send signal** (no confirmation step, no chat noise — you always see where it went): a single-recipient
  route (**DM / anycast**) reacts **👀** on your message; a **broadcast** (**@all / #channel**) reacts
  **⚡**. That's the whole receipt — no text echo. (Telegram's `setMessageReaction` only accepts a fixed
  standard-emoji set — 👀 and ⚡ are in it; 📢/📣 and keycap digits are **not**, so a broadcast's recipient
  count simply isn't shown rather than mirrored as a message. Reactions are best-effort: a failure logs,
  never breaks routing.)

  A **voice** message follows the exact same path — its transcript is routed and reacted like a typed
  message, with no `🎙 heard:` text mirror (only a transcription *failure* replies text).

`@all` unicasts to each present non-endpoint peer (a bare endpoint has no guaranteed everyone-channel),
so the count = how many present agents it reached. It **cannot spawn** agents (a bare endpoint has no
manager authority) — an unknown/offline `@name`, or a `?role` nobody present serves, fails loud back to
the Telegram chat, listing who's present.

## Slash commands

A message that starts with `/` (Telegram's bot-command convention, `/cmd@botname` also accepted) is a
**command** — handled by the bridge and **never** routed onto the mesh as a peer message. The commands
are **mesh-generic** (anything a bare endpoint can serve from the roster/presence/dm/broadcast surface);
there is deliberately **no** `/ps`/`/status`/`/runtime` — those are paw *manager* ops and this endpoint
is manager-less. On startup the bridge registers this set with Telegram (`setMyCommands`) so you get the
native `/` autocomplete menu.

| Command | What it does |
| --- | --- |
| `/who` | The roster — present peers + status (idle/working/waiting). The mesh-generic stand-in for `/ps`. |
| `/help` | List the commands + explain addressing. |
| `/to <name>` | Set the sticky DM target for this chat (validated against the roster). |
| `/dm <name> <msg>` | One-off DM **without** changing the sticky target. |
| `/say [#channel] <msg>` | Broadcast to a channel (a leading `#channel` is explicit; otherwise the default channel). |
| `/here` (alias `/whoami`) | The bridge's own identity (peer/space/server) + this chat's current sticky target KIND (`@name` / `#channel` / `📢 all` / `?role`, or "none yet — defaults to 📢 all"). |

An unknown `/command` replies a short "try /help" (never silent).

## Who's allowed to talk to the bot

A bot's `@username` is enumerable, so a stranger could find it and text it first. To stop that stranger
being auto-trusted, the bridge does **not** learn a chat by default:

- Seed the operator's chat explicitly with `--chat <id>` (the recommended path — nothing is trusted
  until you name it).
- Or pass `--learn-first-chat` to opt into "first sender wins" bootstrap (learn the first inbound chat
  **only while the allowlist is empty**). Use this only when you'll be the one to text the bot first.
- With neither, an inbound from an unknown chat is **dropped and logged** — never silently trusted.

The learned/seeded allowlist persists to `<state>/<space>/chats.json`.

## Install

```bash
npm install
```

This package depends on [`@cotal-ai/endpoint-core`](https://github.com/caffeinum/cotal-endpoint-core),
pulled in as a git dependency (`"@cotal-ai/endpoint-core": "github:caffeinum/cotal-endpoint-core"`), plus
`@cotal-ai/core` from npm — `npm install` resolves both. No workspace or monorepo checkout is required.

## Run

```bash
# open localhost mesh (default)
TELEGRAM_BOT_TOKEN=123:ABC npx tsx bin/cotal-telegram.ts --space demo --name telegram
# authed mesh
TELEGRAM_BOT_TOKEN=… npx tsx bin/cotal-telegram.ts --space demo --creds ./telegram.creds
```

Flags: `--server <nats-url>` · `--space <s>` · `--name <peer>` · `--channel <c>` · `--token <file|value>`
· `--creds <file>` · `--groq-key <file|value>` · `--chat <id>` · `--learn-first-chat` · `--no-markdown`
(alias `--plain`). The token may also come from `$TELEGRAM_BOT_TOKEN`, the Groq key from `$GROQ_API_KEY`.

**Markdown formatting (default ON):** agent output is rendered to Telegram so `**bold**`/`*bold*`,
`_italic_`, `` `code` ``, ```` ``` ```` code blocks and `[text](url)` links actually format instead of
showing raw asterisks. The bridge converts the agent's markdown → **HTML** and sends with
`parse_mode=HTML` — chosen over MarkdownV2 (which requires escaping ~18 special chars and 400s on a stray
`.`/`-`/`(`) and legacy Markdown (which can't parse `**bold**`). Only `< > &` are escaped; all other
punctuation is literal, so a message can't be corrupted by an agent's prose. The `<from>:` prefix and the
agent name are escaped as neutral text (never markdown-parsed), so a peer named `a_b` or `*x*` can't break
the markup. If Telegram ever rejects a formatted message with a 400, the bridge **auto-retries it as plain
text** (parse_mode omitted) — a formatting edge can never lose a message. Slash-command replies and the
`🎙 heard:` voice notice stay plain. Pass `--no-markdown` / `--plain` to disable formatting entirely.

**Voice messages:** a Telegram voice note / audio / video-note is transcribed via Groq Whisper
(`whisper-large-v3-turbo`) and the transcript is routed onto the mesh EXACTLY like a typed message — so
`@name`, reply-threading, the sticky target and `/slash-commands` all apply to what you said. The bridge
replies `🎙 heard: <transcript>` so you see what it understood. Enable it with `--groq-key <file|value>`
or `$GROQ_API_KEY`; with no key a voice message is skipped gracefully (logged, not fatal). A real Groq
error is surfaced to the chat (`🎙 transcription failed: …`) and dropped — never a redelivery loop.

**Bootstrap:** a bot cannot initiate a chat, so a chat must be bound before mesh→Telegram delivery can
begin. Either seed it with `--chat <id>`, or pass `--learn-first-chat` and text the bot once (the first
inbound is learned into `<state>/<space>/chats.json`). Until a chat is bound, a mesh DM is held (unacked,
redelivered by JetStream) so nothing is lost; a channel post is dropped.

## Test

```bash
npm run check:telegram   # hermetic: pure routing/format/allowlist + a fake transport & fake endpoint
npm run typecheck
```

State (peer id pin, getUpdates offset, chat allowlist) lives under `$COTAL_TG_HOME` or
`~/.cotal-telegram/<space>/`.
