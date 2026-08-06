/**
 * Forum topics: one Telegram topic per agent, so a group MIRRORS the endpoint's DM stream organized by
 * sender instead of interleaving every agent into one scroll. This is the Telegram implementation of
 * endpoint-core's {@link Transport.threadFor} seam — it changes WHERE INSIDE a chat a line lands, never
 * which chats are delivered to.
 *
 * What the Bot API does and does NOT give us (this shapes everything below):
 *   - A bot CANNOT create a supergroup, and CANNOT enable Topics on one (`channels.toggleForum` is
 *     owner-only). The operator does that once by hand and makes the bot an admin with
 *     `can_manage_topics`. We only ever create topics INSIDE an already-forum chat.
 *   - There is NO API to list a forum's topics — `getForumTopicIconStickers` is the only forum getter.
 *     So the name → thread_id map is OURS to persist at creation time and CANNOT be rebuilt from
 *     Telegram after a loss. It's written atomically on every mutation.
 *   - There is NO topic-deleted update. A topic deleted in the app is invisible to us until a send fails
 *     with `message thread not found` — which {@link TopicRegistry.forget} turns into "recreate it".
 *   - The General topic has NO thread id (and passing `message_thread_id: 1` is rejected), so "no topic"
 *     and "General" are the same thing on the wire: an omitted field.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir, writeFileAtomic, type EndpointConfig } from "@cotal-ai/endpoint-core";

/** The persisted map, per chat: agent name → the topic's `message_thread_id`. */
export interface TopicFile {
  v: 1;
  /** chatId (as a JSON key) → { agent name → thread id }. */
  chats: Record<string, Record<string, number>>;
}

/** Telegram's SIX allowed topic icon colors (any other value is rejected by createForumTopic). */
export const TOPIC_COLORS = [0x6fb9f0, 0xffd67e, 0xcb86db, 0x8eee98, 0xff93b2, 0xfb6f5f];

/** Pick a stable icon color for an agent — same name always gets the same color, so topics stay visually
 *  identifiable across recreations. A plain FNV-1a over the name; pure. */
export function colorFor(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return TOPIC_COLORS[h % TOPIC_COLORS.length];
}

/** Telegram's hard cap on a topic name. */
const MAX_TOPIC_NAME = 128;

/** The topic title for an agent. Truncated to Telegram's 128-char cap (a name that long is pathological,
 *  but a 400 here would cost the agent its topic). Pure. */
export function topicName(agent: string): string {
  return agent.length <= MAX_TOPIC_NAME ? agent : agent.slice(0, MAX_TOPIC_NAME);
}

/** True when a Telegram error means "that topic is gone" — the ONLY signal we get that a topic was
 *  deleted, since the Bot API has no deletion update and no way to probe a thread id. */
export function isMissingThread(e: unknown): boolean {
  return /message thread not found/i.test((e as Error)?.message ?? "");
}

const TOPICS_FILE = (cfg: EndpointConfig) => join(stateDir(cfg), `${cfg.name}.topics.json`);

/** Load the persisted map. A corrupt file must NOT brick startup — it's logged and treated as empty
 *  (topics are then recreated on demand, which is the same path a first run takes). */
export function readTopics(cfg: EndpointConfig, log?: (m: string) => void): TopicFile {
  const f = TOPICS_FILE(cfg);
  const empty: TopicFile = { v: 1, chats: {} };
  if (!existsSync(f)) return empty;
  try {
    const raw = JSON.parse(readFileSync(f, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return empty;
    const chats = (raw as TopicFile).chats;
    if (!chats || typeof chats !== "object") return empty;
    const out: TopicFile = { v: 1, chats: {} };
    for (const [chatId, agents] of Object.entries(chats)) {
      if (!agents || typeof agents !== "object") continue;
      const clean: Record<string, number> = {};
      for (const [name, thread] of Object.entries(agents as Record<string, unknown>)) {
        // Skip a malformed entry rather than loading a thread id that can never resolve — a bad value
        // would send every one of that agent's lines into a 400 loop.
        if (Number.isInteger(thread) && (thread as number) > 0) clean[name] = thread as number;
      }
      out.chats[chatId] = clean;
    }
    return out;
  } catch (e) {
    (log ?? (() => {}))(`topics file is corrupt (${(e as Error).message}) — treating as empty (topics will be recreated)`);
    return empty;
  }
}

export function writeTopics(cfg: EndpointConfig, file: TopicFile): void {
  writeFileAtomic(TOPICS_FILE(cfg), JSON.stringify(file));
}

/** The slice of the Telegram API the registry needs (injectable — the tests fake it). */
export interface TopicApi {
  isForum(chatId: number): Promise<boolean>;
  createForumTopic(chatId: number, name: string, iconColor?: number): Promise<{ message_thread_id: number }>;
}

/**
 * The per-chat, per-agent topic map: resolves an agent to its topic id, creating the topic on first use.
 *
 * LAZY by design: a topic appears the first time an agent actually says something, not when it joins the
 * mesh. Presence-driven creation would burn the group's ~20-messages-per-minute budget announcing agents
 * that may never speak (every createForumTopic emits a service message into the group).
 *
 * Keyed on the agent NAME, not its `card.id`: the name is what's addressable on the mesh (`@name` routing
 * resolves by name) and it survives a respawn, so an agent that restarts returns to its own topic instead
 * of stranding its history in a dead one.
 */
export class TopicRegistry {
  private readonly file: TopicFile;
  /** chatId → is it a forum (cached; `getChat` per chat, once). */
  private readonly forum = new Map<number, Promise<boolean>>();
  /** In-flight creations, keyed `chatId:name` — two rapid lines from one agent must not race into TWO
   *  topics (the second create would silently win and orphan the first). */
  private readonly creating = new Map<string, Promise<number | undefined>>();

  constructor(
    private readonly api: TopicApi,
    private readonly cfg: EndpointConfig,
    private readonly log: (m: string) => void = () => {},
  ) {
    this.file = readTopics(cfg, log);
  }

  /** The agent that owns a thread id in a chat, if we created it — the reverse lookup {@link forget} and
   *  the transport's retry-after-deletion need to know WHICH agent's topic vanished. */
  agentOf(chatId: number, threadId: number): string | undefined {
    const agents = this.file.chats[String(chatId)];
    if (!agents) return undefined;
    for (const [name, id] of Object.entries(agents)) if (id === threadId) return name;
    return undefined;
  }

  /** Drop a mapping — called when Telegram reports the thread is gone, so the next line recreates it. */
  forget(chatId: number, threadId: number): void {
    const name = this.agentOf(chatId, threadId);
    if (!name) return;
    delete this.file.chats[String(chatId)][name];
    try {
      writeTopics(this.cfg, this.file);
    } catch (e) {
      this.log(`couldn't persist topic removal for ${name} (in-memory only): ${(e as Error).message}`);
    }
    this.log(`topic ${threadId} for "${name}" is gone — it will be recreated on the next message`);
  }

  /**
   * This agent's topic in `chatId`, creating it if we have none. Returns undefined when the chat isn't a
   * forum — the operator's 1:1 DM has no topics, and asking for one there is a no-op, not an error.
   *
   * Throws only if the CREATION itself fails, so the caller can decide (the mirror falls back to posting
   * in General rather than dropping the agent's line).
   */
  async ensure(chatId: number, agent: string): Promise<number | undefined> {
    if (!(await this.isForum(chatId))) return undefined;
    const known = this.file.chats[String(chatId)]?.[agent];
    if (known !== undefined) return known;
    return this.create(chatId, agent);
  }

  private async isForum(chatId: number): Promise<boolean> {
    let hit = this.forum.get(chatId);
    if (!hit) {
      // A getChat failure must not be cached as a permanent "not a forum" — drop the cache entry so the
      // next message re-checks, otherwise one transient blip disables topics until a restart.
      hit = this.api.isForum(chatId).catch((e) => {
        this.forum.delete(chatId);
        this.log(`getChat(${chatId}) failed, treating as non-forum for now: ${(e as Error).message}`);
        return false;
      });
      this.forum.set(chatId, hit);
    }
    return hit;
  }

  private async create(chatId: number, name: string): Promise<number | undefined> {
    const key = `${chatId}:${name}`;
    const inFlight = this.creating.get(key);
    if (inFlight) return inFlight;
    const p = (async () => {
      const topic = await this.api.createForumTopic(chatId, topicName(name), colorFor(name));
      const chatKey = String(chatId);
      (this.file.chats[chatKey] ??= {})[name] = topic.message_thread_id;
      // Persist BEFORE returning: an unpersisted id means a restart creates a duplicate topic for the
      // same agent, and there's no API to find and clean up the orphan.
      writeTopics(this.cfg, this.file);
      this.log(`created topic "${name}" (thread ${topic.message_thread_id}) in chat ${chatId}`);
      return topic.message_thread_id;
    })().finally(() => this.creating.delete(key));
    this.creating.set(key, p);
    return p;
  }
}
