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
import type { CotalEndpoint, CotalMessage, Presence } from "@cotal-ai/core";
import { chunkMessage, outboundLabel, textOf, type Formatter } from "@cotal-ai/endpoint-core";
import type { Config } from "./config.js";
import type { TelegramApi, TgMessage } from "./telegram.js";
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
  log?: (m: string) => void;
}

/**
 * Wire the organizer group to the mesh. Returns a handle exposing the inbound hook the transport calls
 * for updates in this group (see {@link GroupMirror.handleUpdate}).
 */
export function attachGroupMirror(deps: GroupMirrorDeps): GroupMirror {
  return new GroupMirror(deps);
}

export class GroupMirror {
  private readonly ep: CotalEndpoint;
  private readonly api: TelegramApi;
  private readonly cfg: Config;
  private readonly formatter: Formatter;
  private readonly maxLen: number;
  private readonly log: (m: string) => void;
  private readonly topics: TopicRegistry;
  /** The group this mirror owns — every method is a no-op for any other chat. */
  readonly chatId: number;

  constructor({ ep, api, cfg, formatter, maxLen, log = () => {} }: GroupMirrorDeps) {
    this.ep = ep;
    this.api = api;
    this.cfg = cfg;
    this.formatter = formatter;
    this.maxLen = maxLen;
    this.log = log;
    this.topics = new TopicRegistry(api, cfg, log);
    // Non-null by construction: the composition root only builds a mirror when --topics gave a chat id.
    this.chatId = cfg.topicsChat as number;
  }

  /** Subscribe to the mesh: presence → topics, messages → threaded delivery. */
  start(): void {
    this.ep.on("presence", (e: PresenceEvent) => {
      // A topic is created when an agent JOINS — the topic list is the agent list, not a log of who
      // happened to speak. "update" (a heartbeat/status change) and "offline" are ignored: an agent that
      // leaves KEEPS its topic, so its history survives and a return lands back in the same place.
      if (e?.type !== "join") return;
      void this.ensureTopicFor(e.presence?.card);
    });

    this.ep.on("message", (msg: CotalMessage, delivery: Delivery, meta: MessageMeta) => {
      void this.onMeshMessage(msg, delivery, meta);
    });

    // Agents already present when we connect never emit a "join" — without this, the group would only
    // fill up as agents restart. Runs after the presence watch has its first snapshot.
    void this.seedFromRoster();
  }

  /** Create topics for everyone already on the roster at startup (no join event fires for them). */
  private async seedFromRoster(): Promise<void> {
    try {
      await this.ep.waitForPresenceSnapshot();
      for (const p of this.ep.getRoster() as Presence[]) await this.ensureTopicFor(p.card);
    } catch (e) {
      this.log(`seeding topics from the roster failed (they'll be created as agents speak): ${(e as Error).message}`);
    }
  }

  /** One topic per agent. Endpoints (this bridge, other dashboards) and ourselves are skipped — they're
   *  observers, not conversation partners, so they'd only add empty topics. */
  private async ensureTopicFor(card: Card | undefined): Promise<void> {
    if (!card || card.id === this.ep.card.id || card.kind === "endpoint") return;
    try {
      await this.topics.ensure(this.chatId, card.name);
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
    const label = outboundLabel(msg, kind);
    const body = textOf(msg);
    const threadId = await this.threadFor(msg.from.name);
    // Same chunking + independent per-chunk formatting the bridge uses, so a markup span split across a
    // boundary degrades to literal text instead of emitting a half-open tag.
    const chunks = chunkMessage(label + body, this.maxLen);
    for (let i = 0; i < chunks.length; i++) {
      await this.post(chunks[i], i === 0 ? label : undefined, threadId, msg.from.name);
    }
    // Mirrors the bridge's own `→ @name` line, so a tail of the log shows the group filling up.
    this.log(`→ topic ${threadId ?? "General"} (${msg.from.name}): ${chunks.length} chunk(s)`);
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
    const agent = this.topics.agentOf(this.chatId, threadId);
    const text = (typeof m.text === "string" ? m.text : m.caption ?? "").trim();
    if (!agent) {
      // A topic we didn't create (or whose mapping was lost) has no agent behind it — say so rather than
      // guessing from the topic's title, which the human can rename at any time.
      await this.reply(threadId, "this topic isn't bound to an agent — message it from the bot's DM instead");
      return true;
    }
    if (!text) return true;
    const target = this.resolve(agent);
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
