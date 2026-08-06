/**
 * The organizer group: one Telegram forum topic per agent, in ONE supergroup, driven entirely from this
 * package. Purely a way to ORGANIZE the stream the endpoint already carries — it changes nothing about
 * who may talk to whom.
 *
 * It attaches to the SAME mesh peer and the SAME bot the bridge already uses (endpoint-core's
 * `runBridge` takes an injectable `buildEndpoint`, so the composition root builds the endpoint, hands the
 * same instance to the bridge, and hands it here too):
 *
 *   agent joins the mesh  → `ep.on("presence")` → create that agent's topic
 *   agent sends a message → `ep.on("message")`  → post it into that agent's topic
 *   human types in a topic → the topic IS the address → unicast to that agent
 *
 * The group is deliberately NOT on the bridge's chat allowlist: the bridge therefore never fans out to
 * it and never routes its inbound, so there is no double delivery and no contention — this module owns
 * the group end to end, and endpoint-core stays exactly as published.
 */
import { basename } from "node:path";
import type { CotalEndpoint, CotalMessage, Presence } from "@cotal-ai/core";
import {
  appendFileManifest,
  chunkMessage,
  FILE_PART_PROTO,
  formatFileAnnouncement,
  outboundLabel,
  parseFileDirective,
  resolveFilesChannel,
  resolveFilesDir,
  saveInboundFile,
  textOf,
  type FileEntry,
  type Formatter,
  type Transcriber,
} from "@cotal-ai/endpoint-core";
import type { Config } from "./config.js";
import { fileAttachment, groqFilename, voiceFileId, type TelegramApi, type TgMessage } from "./telegram.js";
import { isMissingThread, TopicRegistry } from "./topics.js";

/** A mesh peer as it appears in presence/roster. */
interface Card {
  id: string;
  name: string;
  kind?: string;
  role?: string;
}

/** The bits of a cotal presence event this module reads. */
interface PresenceEvent {
  type: "join" | "update" | "offline";
  presence: { card: Card; status: string };
}

export interface GroupMirrorDeps {
  ep: CotalEndpoint;
  api: TelegramApi;
  cfg: Config;
  formatter: Formatter;
  maxLen: number;
  /** Voice transcription for messages spoken into a topic. Absent → voice is skipped gracefully
   *  (logged, answered in the topic), exactly as the DM leg behaves with no key. */
  transcriber?: Transcriber;
  log?: (m: string) => void;
}

/**
 * Wire the organizer group to the mesh. Returns a handle exposing the inbound hook the transport calls
 * for updates in this group (see {@link GroupMirror.handleUpdate}).
 */
export function attachGroupMirror(deps: GroupMirrorDeps): GroupMirror {
  return new GroupMirror(deps);
}

/** "This message was handled and produced nothing to route" — distinct from `undefined`, which means
 *  "not this kind of message, carry on". */
const SKIP = Symbol("skip");

/**
 * Agent status → the topic icon that shows it.
 *
 * `icon_color` is IMMUTABLE once a topic exists (editForumTopic has no such parameter), so the colored
 * dot can never carry status — a custom emoji is the only mutable icon. And a bot isn't Premium, so the
 * only emoji it may use are the ~112 in Telegram's default topic-icon pack, which contains no traffic
 * lights. These are the closest the pack allows:
 *
 *   idle    ✅  present and free
 *   working ⚡️  busy (and the pack's yellow)
 *   waiting 👀  blocked on something — the same glyph the send signal uses for "one agent has this"
 *   offline ☕️  away
 */
/** A channel topic's icon. Static — a channel has no status, and 💬 reads "conversation". */
export const CHANNEL_ICON = "💬";

/**
 * A channel's registry key. Channels and agents share one topic map, so channel keys carry the `#`
 * sigil — the same one cotal addresses channels with, and a character an agent name never starts with,
 * so the two namespaces can't collide.
 */
export const channelKey = (channel: string) => `#${channel}`;

export const STATUS_ICONS: Record<string, string> = {
  idle: "✅",
  working: "⚡️",
  waiting: "👀",
  offline: "☕️",
};

/** Telegram writes emoji with a trailing variation selector inconsistently — compare without it. */
const bareEmoji = (e: string) => e.replace(/\uFE0F/g, "");

export class GroupMirror {
  private readonly ep: CotalEndpoint;
  private readonly api: TelegramApi;
  private readonly cfg: Config;
  private readonly formatter: Formatter;
  private readonly maxLen: number;
  private readonly log: (m: string) => void;
  private readonly transcriber?: Transcriber;
  private readonly topics: TopicRegistry;
  /** Lazily-resolved emoji → custom_emoji_id map for the bot-allowed icon pack. */
  private iconPack?: Promise<Map<string, string>>;
  /** The group this mirror owns — every method is a no-op for any other chat. */
  readonly chatId: number;

  constructor({ ep, api, cfg, formatter, maxLen, transcriber, log = () => {} }: GroupMirrorDeps) {
    this.ep = ep;
    this.api = api;
    this.cfg = cfg;
    this.formatter = formatter;
    this.maxLen = maxLen;
    this.log = log;
    this.transcriber = transcriber;
    this.topics = new TopicRegistry(api, cfg, log);
    // Non-null by construction: the composition root only builds a mirror when --topics gave a chat id.
    this.chatId = cfg.topicsChat as number;
  }

  /** Subscribe to the mesh: presence → topics, messages → threaded delivery. */
  start(): void {
    this.ep.on("presence", (e: PresenceEvent) => {
      const card = e?.presence?.card;
      if (!card) return;
      // A topic is created when an agent JOINS — the topic list is the agent list, not a log of who
      // happened to speak. An agent that leaves KEEPS its topic, so its history survives and a return
      // lands back in the same place; only its ICON changes.
      if (e.type === "join") void this.ensureTopicFor(card, e.presence.status);
      // EVERY event (join / heartbeat / offline) carries the current status, and applyStatusIcon is a
      // no-op unless it actually differs from what's on the topic.
      else void this.applyStatusIcon(card.name, e.presence.status);
    });

    this.ep.on("message", (msg: CotalMessage, delivery: Delivery, meta: MessageMeta) => {
      void this.onMeshMessage(msg, delivery, meta);
    });

    // Agents already present when we connect never emit a "join" — without this, the group would only
    // fill up as agents restart. Runs after the presence watch has its first snapshot.
    void this.seedFromRoster();
    void this.seedChannels();
  }

  /** Create topics for everyone already on the roster at startup (no join event fires for them). */
  private async seedFromRoster(): Promise<void> {
    try {
      await this.ep.waitForPresenceSnapshot();
      for (const p of this.ep.getRoster() as Presence[]) await this.ensureTopicFor(p.card, p.status);
    } catch (e) {
      this.log(`seeding topics from the roster failed (they'll be created as agents speak): ${(e as Error).message}`);
    }
  }

  /**
   * One topic per mirrored CHANNEL. Each is JOINED first — the endpoint only receives channels it
   * subscribes to, so a channel listed but not joined would sit there as a topic that never fills.
   * The bridge's own default channel is already joined by buildEndpoint; re-joining is harmless.
   */
  private async seedChannels(): Promise<void> {
    for (const channel of this.cfg.mirrorChannels) {
      try {
        await this.ep.joinChannel(channel);
      } catch (e) {
        // Already joined, or a permission problem. Keep going: the topic is still worth having if the
        // channel is the one the bridge subscribes to anyway.
        this.log(`joinChannel(${channel}) — ${(e as Error).message}`);
      }
      try {
        const key = channelKey(channel);
        await this.topics.ensure(this.chatId, key);
        await this.applyIcon(key, CHANNEL_ICON);
      } catch (e) {
        this.log(`couldn't create the #${channel} topic (retried on its next message): ${(e as Error).message}`);
      }
    }
  }

  /** One topic per agent. Endpoints (this bridge, other dashboards) and ourselves are skipped — they're
   *  observers, not conversation partners, so they'd only add empty topics. */
  private async ensureTopicFor(card: Card | undefined, status?: string): Promise<void> {
    if (!card || card.id === this.ep.card.id || card.kind === "endpoint") return;
    try {
      await this.topics.ensure(this.chatId, card.name);
      if (status) await this.applyStatusIcon(card.name, status);
    } catch (e) {
      // Never fatal: the topic is retried on this agent's next message, and delivery falls back to
      // General meanwhile. A rate limit on a burst of joins resolves itself.
      this.log(`couldn't create a topic for "${card.name}" (will retry on its next message): ${(e as Error).message}`);
    }
  }

  // ── mesh → the agent's topic ────────────────────────────────────────────────────────────────────
  private async onMeshMessage(msg: CotalMessage, delivery: Delivery, meta: MessageMeta): Promise<void> {
    // Mirror EXACTLY what the bridge forwards: live DMs and channel posts, never replayed history, never
    // role work-queue traffic, and never our own broadcast echoing back off the channel we joined.
    if (meta.historical || meta.kind === "anycast") return;
    if (meta.kind === "channel" && msg.from.id === this.ep.card.id) return;
    // The bridge ACKs/NAKs this same delivery for the DM chat; the mirror is a second, read-only consumer
    // of the event and must never touch it, or an ack race would drop or duplicate the message there.
    void delivery;
    try {
      await this.deliver(msg, meta.kind);
    } catch (e) {
      // Loud, but never thrown: the bridge's own delivery to the DM chat is unaffected, so a group
      // failure must not look like a lost message.
      this.log(`group delivery failed for ${msg.from.name} (the DM chat still got it): ${(e as Error).message}`);
    }
  }

  private async deliver(msg: CotalMessage, kind: "dm" | "channel"): Promise<void> {
    // A CHANNEL post belongs to the channel's topic, not the sender's: it's a shared conversation, and
    // filing it under whoever happened to speak would scatter one thread across every agent's topic.
    // Inside #general the `[#general]` prefix is noise, so the label is just the sender.
    const channel = kind === "channel" ? (msg as { channel?: string }).channel : undefined;
    const target = channel ? channelKey(channel) : msg.from.name;
    const label = channel ? `${msg.from.name}: ` : outboundLabel(msg, kind);
    const body = textOf(msg);
    const threadId = await this.threadFor(target);
    // An agent sends a file back by embedding `[[file:<abs-path>]]` — strip the directive and upload the
    // local file into that agent's topic, exactly as the DM leg does for the private chat.
    const directive = parseFileDirective(body);
    if (directive) {
      const caption = (label + (directive.caption ?? directive.rest ?? "")).trimEnd() || undefined;
      await this.api.sendDocument(this.chatId, directive.path, { caption, message_thread_id: threadId });
      this.log(`→ topic ${threadId ?? "General"} (${target}): file ${basename(directive.path)}`);
      return;
    }
    // Same chunking + independent per-chunk formatting the bridge uses, so a markup span split across a
    // boundary degrades to literal text instead of emitting a half-open tag.
    const chunks = chunkMessage(label + body, this.maxLen);
    for (let i = 0; i < chunks.length; i++) {
      await this.post(chunks[i], i === 0 ? label : undefined, threadId, target);
    }
    // Mirrors the bridge's own `→ @name` line, so a tail of the log shows the group filling up.
    this.log(`→ topic ${threadId ?? "General"} (${target}): ${chunks.length} chunk(s)`);
  }

  /** This agent's topic, or undefined to post in General. A creation failure is NOT fatal — landing in
   *  General beats dropping the line. */
  private async threadFor(agent: string): Promise<number | undefined> {
    try {
      return await this.topics.ensure(this.chatId, agent);
    } catch (e) {
      this.log(`no topic for "${agent}" (posting in General): ${(e as Error).message}`);
      return undefined;
    }
  }

  /**
   * Post one chunk, with the two fallbacks that matter:
   *   - Telegram rejected the FORMATTED text → resend it plain (a formatting bug can't lose a message)
   *   - the topic is GONE (deleted in the app — there's no update for that, a failed send is the only
   *     signal) → drop the stale id, recreate the topic, retry once; if that fails too, post in General.
   */
  private async post(chunk: string, label: string | undefined, threadId: number | undefined, agent: string): Promise<void> {
    const rendered = this.formatter.render(chunk, label);
    const send = (thread: number | undefined, mode: "HTML" | undefined, text: string) =>
      this.api.sendMessage(this.chatId, text, { parse_mode: mode, message_thread_id: thread });
    try {
      await send(threadId, rendered.mode as "HTML" | undefined, rendered.text);
      return;
    } catch (e) {
      if (isMissingThread(e) && threadId !== undefined) {
        this.topics.forget(this.chatId, threadId);
        const fresh = await this.threadFor(agent);
        await send(fresh, rendered.mode as "HTML" | undefined, rendered.text);
        return;
      }
      if (!rendered.mode) throw e;
      this.log(`group: formatted send rejected (${(e as Error).message}) — retrying as plain text`);
      await send(threadId, undefined, chunk);
    }
  }

  // ── the agent's topic → mesh ────────────────────────────────────────────────────────────────────
  /**
   * A message the human typed in this group. The TOPIC is the address — no `@name` needed, because the
   * topic already names the agent — so this resolves the thread back to its agent and unicasts.
   *
   * Returns true when the update belonged to this group and was handled (so the transport does NOT also
   * hand it to the bridge). Anything typed in General is left alone: the group's root is not a
   * conversation with anyone in particular.
   */
  async handleUpdate(m: TgMessage): Promise<boolean> {
    if (m.chat.id !== this.chatId) return false;
    const threadId = m.is_topic_message === true ? m.message_thread_id : undefined;
    if (threadId === undefined) {
      this.log(`group: ignoring a message in General (type in an agent's topic to reach it)`);
      return true;
    }
    const owner = this.topics.agentOf(this.chatId, threadId);
    // A CHANNEL topic is addressed like the channel it mirrors — typing there broadcasts, exactly as
    // `#channel …` does from the DM. Symmetric with an agent topic: the topic is the address.
    const channel = owner?.startsWith("#") ? owner.slice(1) : undefined;
    const agent = channel ? undefined : owner;
    if (!owner) {
      // A topic we didn't create (or whose mapping was lost) has no agent behind it — say so rather than
      // guessing from the topic's title, which the human can rename at any time.
      await this.reply(threadId, "this topic isn't bound to an agent — message it from the bot's DM instead");
      return true;
    }
    // VOICE and ATTACHMENTS resolve to TEXT first, then take exactly the same path as a typed line —
    // spoken words become the message, a file becomes a reference to where it was saved.
    let text = (typeof m.text === "string" ? m.text : m.caption ?? "").trim();
    const spoken = await this.transcribe(m, threadId);
    if (spoken === SKIP) return true;
    if (spoken !== undefined) text = spoken;
    else {
      const saved = await this.saveAttachment(m, threadId, text);
      if (saved === SKIP) return true;
      if (saved !== undefined) text = saved;
    }
    if (!text) return true;
    if (channel) {
      await this.ep.multicast(text, { channel });
      this.log(`→ #${channel} (topic ${threadId}): ${text}`);
      // ⚡ is the broadcast signal (👀 means exactly one agent has it) — same vocabulary as the DM leg.
      await this.api.setMessageReaction(this.chatId, m.message_id, "⚡").catch(() => {});
      return true;
    }
    const target = this.resolve(agent as string);
    if (!target) {
      await this.reply(threadId, `"${agent}" isn't on the mesh right now`);
      return true;
    }
    await this.ep.unicast(target.id, text);
    this.log(`→ @${agent} (topic ${threadId}): ${text}`);
    // The same send signal the DM chat uses: a single recipient reacts 👀. Best-effort.
    await this.api.setMessageReaction(this.chatId, m.message_id, "👀").catch(() => {});
    return true;
  }

  /**
   * A voice note spoken into a topic → its transcript, which then routes exactly like a typed line.
   *   - undefined — not a voice message; the caller carries on
   *   - SKIP      — it WAS voice but produced nothing routable (no key, empty, or a real failure); the
   *                 human has been answered in the topic and there is nothing to send
   * Never throws: a transcription failure must not wedge the poll loop.
   */
  private async transcribe(m: TgMessage, threadId: number): Promise<string | undefined | typeof SKIP> {
    const fileId = voiceFileId(m);
    if (!fileId) return undefined;
    if (!this.transcriber) {
      this.log("voice received in a topic but transcription is disabled (no key configured)");
      return SKIP;
    }
    try {
      const f = await this.api.getFile(fileId);
      const bytes = await this.api.downloadFile(f.file_path);
      const transcript = (await this.transcriber.transcribe(bytes, groqFilename(f.file_path))).trim();
      if (!transcript) {
        await this.reply(threadId, "🎙 (heard nothing — empty transcript)");
        return SKIP;
      }
      return transcript;
    } catch (e) {
      // Surfaced in the topic and dropped — the poll cursor advances either way, so never a redelivery loop.
      await this.reply(threadId, `🎙 transcription failed: ${(e as Error).message}`);
      return SKIP;
    }
  }

  /**
   * A document/photo dropped into a topic → saved to the per-space downloads dir, announced on #files,
   * and turned into the reference line `📎 <name> saved to <abs-path>` that routes to the agent. The
   * BINARY never crosses the mesh — a local agent just reads the path.
   *
   * Returns undefined when there's no attachment, SKIP when the download/save failed (answered in the
   * topic). Never throws.
   */
  private async saveAttachment(m: TgMessage, threadId: number, caption: string): Promise<string | undefined | typeof SKIP> {
    const att = fileAttachment(m);
    if (!att) return undefined;
    let saved: string;
    let size: number | undefined;
    try {
      const f = await this.api.getFile(att.fileId);
      const bytes = await this.api.downloadFile(f.file_path);
      size = bytes.length;
      saved = saveInboundFile(resolveFilesDir(this.cfg), att.filename, bytes);
    } catch (e) {
      await this.reply(threadId, `📎 file download failed: ${(e as Error).message}`);
      return SKIP;
    }
    const name = basename(saved);
    void this.announceFile({
      v: 1,
      ts: Date.now(),
      name,
      path: saved,
      size: size ?? att.size,
      mime: att.mimeType,
      caption: caption || undefined,
      source: this.cfg.name,
      chatId: this.chatId,
    });
    this.log(`saved inbound file → ${saved}`);
    const reference = `📎 ${name} saved to ${saved}`;
    return caption ? `${caption}\n${reference}` : reference;
  }

  /** The same #files feed the DM leg publishes: append to the local manifest + multicast a FileEntry
   *  data part. BOTH legs are best-effort — the bytes are already safely on disk, so a failure here only
   *  logs; it must never break the route to the agent. */
  private async announceFile(entry: FileEntry): Promise<void> {
    try {
      appendFileManifest(resolveFilesDir(this.cfg), entry);
    } catch (e) {
      this.log(`file manifest append failed (ignored): ${(e as Error).message}`);
    }
    try {
      // core's multicast DISCARDS `text` when `parts` is supplied, so the readable line must ride as an
      // explicit text part or live #files watchers get an empty message.
      const line = formatFileAnnouncement(entry);
      await this.ep.multicast(line, {
        channel: resolveFilesChannel(this.cfg),
        parts: [
          { kind: "text", text: line },
          { kind: "data", data: { proto: FILE_PART_PROTO, ...entry } },
        ],
      });
    } catch (e) {
      this.log(`#files announce failed (ignored): ${(e as Error).message}`);
    }
  }

  /** emoji → custom_emoji_id for the bot-allowed topic-icon pack, fetched once. A failure caches an
   *  EMPTY map (icons are cosmetic — never block delivery on them) but is logged. */
  private async iconIds(): Promise<Map<string, string>> {
    this.iconPack ??= this.api
      .getForumTopicIconStickers()
      .then((stickers) => {
        const m = new Map<string, string>();
        for (const s of stickers) if (s.emoji) m.set(bareEmoji(s.emoji), s.custom_emoji_id);
        return m;
      })
      .catch((e) => {
        this.log(`couldn't load the topic-icon pack, status icons disabled: ${(e as Error).message}`);
        return new Map<string, string>();
      });
    return this.iconPack;
  }

  /**
   * Stamp an agent's topic with the icon for its current status. Skipped when the icon is ALREADY the
   * one we want — every edit posts a `forum_topic_edited` service message into the topic, so re-stamping
   * on each presence heartbeat would bury the conversation under notices.
   *
   * Entirely best-effort: an icon is decoration, and must never interfere with delivery.
   */
  private async applyStatusIcon(agent: string, status: string): Promise<void> {
    const emoji = STATUS_ICONS[status];
    if (emoji) await this.applyIcon(agent, emoji, status);
  }

  /** Stamp `key`'s topic with `emoji`, if it isn't already wearing it. */
  private async applyIcon(key: string, emoji: string, why = "icon"): Promise<void> {
    if (this.topics.iconOf(this.chatId, key) === emoji) return;
    const threadId = this.topics.threadIdOf(this.chatId, key);
    if (threadId === undefined) return; // no topic yet — the icon is applied when it's created
    const id = (await this.iconIds()).get(bareEmoji(emoji));
    if (!id) return;
    try {
      await this.api.editForumTopicIcon(this.chatId, threadId, id);
      this.topics.setIcon(this.chatId, key, emoji);
      this.log(`topic ${threadId} (${key}) → ${emoji} ${why}`);
    } catch (e) {
      this.log(`couldn't set the ${why} icon on ${key}'s topic (ignored): ${(e as Error).message}`);
    }
  }

  private resolve(name: string): { id: string } | undefined {
    const me = this.ep.card.id;
    return this.ep
      .getRoster()
      .filter((p: Presence) => p.card.name.toLowerCase() === name.toLowerCase() && p.card.id !== me)
      .find((p: Presence) => p.status !== "offline")?.card;
  }

  private async reply(threadId: number, text: string): Promise<void> {
    await this.api.sendMessage(this.chatId, text, { message_thread_id: threadId }).catch((e) => {
      this.log(`group reply failed: ${(e as Error).message}`);
      return { message_id: 0 };
    });
  }
}

interface Delivery {
  ack(): void;
  nak(): void;
}
interface MessageMeta {
  historical: boolean;
  kind: "dm" | "channel" | "anycast";
}
