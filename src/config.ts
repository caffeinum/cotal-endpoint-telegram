/**
 * Telegram-specific config + CLI parsing. The channel-agnostic state helpers (peerId / offset /
 * allowlist / sticky) live in @cotal-ai/endpoint-core; this only adds the Telegram fields (token, Groq
 * key, markdown flag) and the CLI. Fail-loud: a missing/unreadable token throws with a clear message
 * rather than starting a half-dead bridge.
 *
 * State lives under `<stateRoot>/<space>/` (stateRoot = $COTAL_TG_HOME or ~/.cotal-telegram) — see
 * endpoint-core's config for the file layout.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EndpointConfig } from "@cotal-ai/endpoint-core";
import { agentFromWakeCommand } from "./wake.js";

/** The full Telegram endpoint config: the channel-agnostic {@link EndpointConfig} plus Telegram bits. */
export interface Config extends EndpointConfig {
  token: string;
  /** Groq API key for voice-message transcription. Absent → voice messages are skipped (not fatal). */
  groqKey?: string;
  /** Render agent markdown as Telegram HTML on outbound messages. Default TRUE; `--no-markdown`/`--plain`
   *  disables it (raw text, no parse_mode). A formatted message Telegram rejects with a 400 is auto-
   *  retried as plain text, so it can never be lost. */
  markdown: boolean;
  /** The FORUM supergroup to organize into one topic per agent (`--topics <chat-id>`). Absent → the
   *  organizer group is off entirely. Deliberately NOT one of the {@link seedChats}: the bridge must not
   *  know this chat, or it would fan every line out to it a second time, unthreaded. */
  topicsChat?: number;
  /** Drive each agent topic's icon from its status (✅ idle · ⚡️ working · 👀 waiting · ☕️ offline).
   *  DEFAULT OFF — the constant icon churn was more noise than signal. `--status-icons` turns it back
   *  on; the code is intact, just inert. Channel topics keep their one-time 💬, which is identity, not
   *  status. */
  statusIcons: boolean;
  /** Channels to mirror into the organizer group, one topic per channel (`--channels a,b,c`). The
   *  endpoint JOINS each at startup, so a channel listed here is one whose traffic actually arrives.
   *  Absent → just {@link EndpointConfig.channel}, the one the bridge already subscribes to. */
  mirrorChannels: string[];
  /** After a successful `/wake`, point the chat at this agent, so the next line you type goes to the
   *  agent you just woke. Defaults to the agent named in {@link EndpointConfig.wakeCommand} (`paw global
   *  …` → `global`), since the deployment already says what it wakes; `--wake-agent <name>` overrides.
   *  Absent (no wake command at all) → `/wake` leaves the target alone. */
  wakeAgent?: string;
  /** Command that starts a TOPIC's agent when it isn't on the mesh — `paw start {agent} --space paw`.
   *  `{agent}` marks the slot; with no slot the name is appended. Run WITHOUT a shell (wake-agent.ts),
   *  so the name is argv, never something a shell could reinterpret. Absent ⇒ an offline topic is still
   *  only reported, never started. */
  agentWakeCommand?: string;
}

const DEFAULT_SERVER = "nats://127.0.0.1:4222"; // core's DEFAULT_SERVER (kept literal so config has no core-runtime dep)
const DEFAULT_CHANNEL = "general";
const DEFAULT_SPACE = "main"; // core's DEFAULT_SPACE

function stateRoot(): string {
  return process.env.COTAL_TG_HOME || join(homedir(), ".cotal-telegram");
}

/** Resolve the bot token from an explicit value, a file path, or $TELEGRAM_BOT_TOKEN. Fail loud. */
export function resolveToken(tokenArg: string | undefined): string {
  const raw = tokenArg ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!raw) {
    throw new Error(
      "cotal-telegram: no bot token — pass --token <file|value> or set TELEGRAM_BOT_TOKEN " +
        "(get one from @BotFather)",
    );
  }
  // A path to a token file wins if it exists on disk; else treat the value as the token itself.
  const value = existsSync(raw) ? readFileSync(raw, "utf8").trim() : raw.trim();
  if (!/^\d+:[\w-]+$/.test(value)) {
    throw new Error(`cotal-telegram: token does not look like a Bot API token ("<id>:<secret>")`);
  }
  return value;
}

/** Resolve the Groq API key from an explicit value, a file path, or $GROQ_API_KEY. Returns undefined
 *  when none is set — voice transcription is OPTIONAL, so absence is not an error (voice is skipped). */
export function resolveGroqKey(keyArg: string | undefined): string | undefined {
  const raw = keyArg ?? process.env.GROQ_API_KEY;
  if (!raw) return undefined;
  const value = existsSync(raw) ? readFileSync(raw, "utf8").trim() : raw.trim();
  return value || undefined;
}

export interface RawArgs {
  space?: string;
  server?: string;
  name?: string;
  channel?: string;
  token?: string;
  creds?: string;
  groqKey?: string;
  chat?: string;
  learnFirstChat?: boolean;
  /** Set false by `--no-markdown` / `--plain`. Undefined → default (markdown on). */
  markdown?: boolean;
  /** Override for the inbound-attachment downloads dir (`--files-dir`). Default `<stateRoot>/<space>/files/`. */
  filesDir?: string;
  /** Free-text line appended to the bottom of /help (`--help-footer`, else $COTAL_TG_HELP_FOOTER). */
  helpFooter?: string;
  /** Shell command `/wake` runs (`--wake-command`, else $COTAL_TG_WAKE_COMMAND) — e.g. `paw start global`. */
  wakeCommand?: string;
  /** Seconds `/wake` waits for it (`--wake-timeout`); absent → endpoint-core's default. */
  wakeTimeout?: string;
  /** Command that starts the agent a TOPIC belongs to when it isn't on the mesh
   *  (`--agent-wake-command`, else $COTAL_TG_AGENT_WAKE_COMMAND) — e.g. `paw start {agent} --space paw`.
   *  `{agent}` marks where the name goes; with no slot it is appended. Split into argv and run WITHOUT a
   *  shell, so the name can never be interpreted as anything but a name (see wake-agent.ts). Absent ⇒
   *  messaging an offline topic still just says so. */
  agentWakeCommand?: string;
  /** Set by `--topics <chat-id>`: the forum supergroup to organize into one topic per agent. */
  topics?: string;
  /** Set by `--channels a,b,c`: which channels get their own topic in the organizer group. */
  channels?: string;
  /** Set by `--status-icons`: re-enable status-driven topic icons (off by default). */
  statusIcons?: boolean;
  /** Set by `--wake-agent <name>`: the agent `/wake` switches the chat to once it's up. */
  wakeAgent?: string;
}

export function parseArgs(argv: string[]): RawArgs {
  const out: RawArgs = {};
  // A value-taking flag consumes the NEXT arg; fail loud if it's missing (a dangling `--space` at
  // the end of argv would otherwise silently set undefined → the wrong fallback).
  const val = (flag: string, i: number): string => {
    const v = argv[i];
    if (v === undefined) throw new Error(`cotal-telegram: flag "${flag}" needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space") out.space = val(a, ++i);
    else if (a === "--server") out.server = val(a, ++i);
    else if (a === "--name") out.name = val(a, ++i);
    else if (a === "--channel") out.channel = val(a, ++i);
    else if (a === "--token") out.token = val(a, ++i);
    else if (a === "--creds") out.creds = val(a, ++i);
    else if (a === "--groq-key") out.groqKey = val(a, ++i);
    else if (a === "--chat") out.chat = val(a, ++i);
    else if (a === "--files-dir") out.filesDir = val(a, ++i);
    else if (a === "--help-footer") out.helpFooter = val(a, ++i);
    else if (a === "--wake-command") out.wakeCommand = val(a, ++i);
    else if (a === "--wake-timeout") out.wakeTimeout = val(a, ++i);
    else if (a === "--agent-wake-command") out.agentWakeCommand = val(a, ++i);
    else if (a === "--learn-first-chat") out.learnFirstChat = true;
    else if (a === "--topics") out.topics = val(a, ++i);
    else if (a === "--channels") out.channels = val(a, ++i);
    else if (a === "--wake-agent") out.wakeAgent = val(a, ++i);
    else if (a === "--status-icons") out.statusIcons = true;
    else if (a === "--no-markdown" || a === "--plain") out.markdown = false;
    else throw new Error(`cotal-telegram: unknown flag "${a}"`);
  }
  return out;
}

/** Build the full Config from parsed args (resolving the token + reading a creds file). */
export function buildConfig(raw: RawArgs): Config {
  const creds = raw.creds ? readFileSync(raw.creds, "utf8") : undefined;
  const seedChats = raw.chat ? [numOrThrow(raw.chat)] : [];
  return {
    space: raw.space ?? DEFAULT_SPACE,
    server: raw.server ?? DEFAULT_SERVER,
    name: raw.name ?? "telegram",
    channel: raw.channel ?? DEFAULT_CHANNEL,
    token: resolveToken(raw.token),
    creds,
    groqKey: resolveGroqKey(raw.groqKey),
    stateRoot: stateRoot(),
    seedChats,
    learnFirstChat: raw.learnFirstChat ?? false,
    markdown: raw.markdown ?? true,
    topicsChat: raw.topics === undefined ? undefined : topicsChatOrThrow(raw.topics),
    statusIcons: raw.statusIcons ?? false,
    mirrorChannels: parseChannelList(raw.channels, raw.channel ?? DEFAULT_CHANNEL),
    wakeAgent:
      raw.wakeAgent ?? process.env.COTAL_TG_WAKE_AGENT ?? agentFromWakeCommand(raw.wakeCommand ?? process.env.COTAL_TG_WAKE_COMMAND),
    filesDir: raw.filesDir,
    helpFooter: raw.helpFooter ?? process.env.COTAL_TG_HELP_FOOTER,
    wakeCommand: raw.wakeCommand ?? process.env.COTAL_TG_WAKE_COMMAND,
    agentWakeCommand: raw.agentWakeCommand ?? process.env.COTAL_TG_AGENT_WAKE_COMMAND,
    wakeTimeoutSec: raw.wakeTimeout === undefined ? undefined : wakeSecsOrThrow(raw.wakeTimeout),
  };
}

/** Fail loud rather than falling back to the default — a typo'd --wake-timeout that silently does
 *  nothing is the kind of thing you re-pass three times before suspecting the flag. */
function wakeSecsOrThrow(s: string): number {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`cotal-telegram: --wake-timeout expects seconds, got "${s}"`);
  return n;
}

/**
 * `--channels a, b ,c` → ["a","b","c"]. A `#` prefix is accepted and stripped (people write `#general`).
 * Omitted → just the endpoint's own default channel, so `--topics` alone mirrors #general with no extra
 * configuration. Fail loud on a value that parses to nothing — a typo'd `--channels ",,"` that silently
 * mirrored nothing is exactly the kind of thing you re-pass three times before noticing.
 */
export function parseChannelList(raw: string | undefined, fallback: string): string[] {
  if (raw === undefined) return [fallback];
  const names = raw
    .split(",")
    .map((c) => c.trim().replace(/^#/, ""))
    .filter(Boolean);
  if (names.length === 0) throw new Error(`cotal-telegram: --channels listed no channel names (got "${raw}")`);
  return [...new Set(names)];
}

/** A forum supergroup id is negative and starts -100 — fail loud on a positive/user id rather than
 *  silently organizing nothing (the mirror would just never match a chat). */
function topicsChatOrThrow(s: string): number {
  const n = Number(s);
  if (!Number.isInteger(n)) throw new Error(`cotal-telegram: --topics expects a numeric chat id, got "${s}"`);
  if (n >= 0) {
    throw new Error(`cotal-telegram: --topics expects a SUPERGROUP id (negative, e.g. -100…), got "${s}"`);
  }
  return n;
}

function numOrThrow(s: string): number {
  const n = Number(s);
  if (!Number.isInteger(n)) throw new Error(`cotal-telegram: --chat expects a numeric chat id, got "${s}"`);
  return n;
}
