# @cotal-ai/endpoint-telegram

A standalone bridge between a [cotal](https://cotal.ai) mesh and a Telegram bot. It joins the mesh as
its **own named peer** (`telegram` by default), so it binds its **own** durable DM consumer and
receives agent DMs in real time — no polling, no cursor contention. Zero paw coupling: it imports only
`@cotal-ai/core`.

## What it does

- **mesh → Telegram** — an agent DMs the `telegram` peer (or posts on the default channel the bridge
  subscribes to) → the bridge sends `"<agent>: <text>"` to every allowlisted Telegram chat, and
  remembers the bot message so a swipe-reply threads back. An agent can also **send a file back** by
  emitting a `[[file:<abs-path>]]` directive (see [Sending files](#sending-files)). The agent's **markdown is rendered**
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

  A **document or photo** also follows the same path: the bridge downloads it, saves it to the per-space
  downloads dir under a safe (basename-only, collision-suffixed) name, and routes a text reference
  `📎 <filename> saved to <absolute-path>` (prefixed by any caption) onto the mesh — so a **local agent can
  just read that path** (no binary crosses the mesh). A photo uses its **largest** size; the same
  👀/⚡ send-signal reaction applies.

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

## Run

```bash
# open localhost mesh (default)
TELEGRAM_BOT_TOKEN=123:ABC npx tsx bin/cotal-telegram.ts --space demo --name telegram
# authed mesh
TELEGRAM_BOT_TOKEN=… npx tsx bin/cotal-telegram.ts --space demo --creds ./telegram.creds
```

Flags: `--server <nats-url>` · `--space <s>` · `--name <peer>` · `--channel <c>` · `--token <file|value>`
· `--creds <file>` · `--groq-key <file|value>` · `--chat <id>` · `--files-dir <dir>` · `--learn-first-chat`
· `--topics <chat-id>` · `--no-markdown` (alias `--plain`). The token may also come from `$TELEGRAM_BOT_TOKEN`, the Groq key from
`$GROQ_API_KEY`.

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

<a name="sending-files"></a>
**Files (both directions):**

- **Telegram → mesh (receive):** a message carrying a **document** or **photo** is downloaded and saved
  to `<state>/<space>/files/` (override with `--files-dir <dir>`) under a sanitized, collision-suffixed
  filename, then routed onto the mesh as the text `📎 <filename> saved to <absolute-path>` (with any
  caption on its own line above it). A **local agent** can act on the saved path directly (`read`, run it,
  etc.) — the binary itself never crosses the mesh. A photo's **largest** size is chosen; the routed
  message gets the usual 👀 (single target) / ⚡ (broadcast) reaction, exactly like a typed message.
- **mesh → Telegram (send):** an agent sends a file back by embedding a directive in its outgoing text:

  ```
  [[file:/absolute/path/to/report.pdf]]
  [[file:/absolute/path/to/report.pdf|here is the report]]   # with a caption
  ```

  When the directive is present, the bridge **strips it** and uploads the local file via Telegram's
  `sendDocument` (any leftover text — or the inline `|<caption>` — becomes the caption, prefixed with the
  agent's `<from>:` label). The path must be readable by the bridge process. If the channel had no file
  upload support the bridge would instead send the text **as-is** (graceful) — for Telegram, uploads are
  always supported.

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


<a name="topics"></a>
## The organizer group — one topic per agent (`--topics <chat-id>`)

Purely a **way to organize**: the same stream the endpoint already carries, sorted into **one Telegram
forum topic per agent** instead of every agent interleaved into one scroll. Nothing about who may talk to
whom changes.

```
agent joins the mesh   → its topic is created (before it has said anything)
agent sends a message  → the message lands in that agent's topic
you type in a topic    → it goes to that agent — the topic IS the address, no @name needed
```

Your 1:1 DM with the bot is untouched and keeps receiving everything, so the group **mirrors** rather than
moves. Same bot, same mesh peer, one long-poll — the group is a second view, not a second bridge.

**Setup (one-time, and it has to be you — a bot can't):** a bot can neither create a supergroup nor turn
Topics on (`toggleForum` is owner-only). So: create the supergroup, enable **Topics** in its settings, add
the bot, promote it to admin with **`can_manage_topics`**, then start with `--topics <group-id>`.

Do **not** also pass the group to `--chat`: `--topics` is deliberately separate from the chat allowlist.
The group is owned end to end by `src/group.ts` — if the bridge knew it too, every line would arrive twice
(once threaded, once not).

| | |
| --- | --- |
| **When a topic appears** | When the agent **joins the mesh** — the topic list is the agent list, not a log of who happened to speak. Agents already present at startup are seeded from the roster (no join event fires for those). |
| **What it's keyed on** | The agent **name** — what `@name` addresses, and what survives a respawn, so a restarted agent returns to its own topic instead of stranding its history. |
| **Who gets one** | Agents. Endpoints (this bridge, dashboards) are skipped — they're observers, and would only add empty topics. |
| **When an agent leaves** | It **keeps** its topic. History survives and a return lands in the same place. |
| **The General topic** | Addresses nobody in particular, so anything typed there is ignored with a note. Use the DM for commands. |

**Recovery, because the Bot API is thin here.** There's **no way to list a forum's topics** and **no update
when one is deleted**, so the `name → thread_id` map is ours: persisted atomically to
`<state>/<name>.topics.json` and **not rebuildable** from Telegram if lost (losing it just means new topics
get created). Delete a topic in the app and the bridge finds out only when a send fails with
`message thread not found` — it drops the stale id, **recreates the topic, and retries**. If the recreate
fails too (rate limit, admin right revoked), the line goes to **General** rather than being dropped.

Known gaps in the group (all work as always in the DM): slash-commands, voice transcription, and file
attachments are DM-only for now — the group handles plain text in both directions.

## Test

```bash
npm run check:telegram   # hermetic: pure routing/format/allowlist + a fake transport & fake endpoint
npm run typecheck
```

State (peer id pin, getUpdates offset, chat allowlist, the per-agent topic map, and inbound `files/`) lives under
`$COTAL_TG_HOME` or `~/.cotal-telegram/<space>/` (the downloads dir is overridable with `--files-dir`).
