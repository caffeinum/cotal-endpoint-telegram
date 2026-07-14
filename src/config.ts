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

/** The full Telegram endpoint config: the channel-agnostic {@link EndpointConfig} plus Telegram bits. */
export interface Config extends EndpointConfig {
  token: string;
  /** Groq API key for voice-message transcription. Absent → voice messages are skipped (not fatal). */
  groqKey?: string;
  /** Render agent markdown as Telegram HTML on outbound messages. Default TRUE; `--no-markdown`/`--plain`
   *  disables it (raw text, no parse_mode). A formatted message Telegram rejects with a 400 is auto-
   *  retried as plain text, so it can never be lost. */
  markdown: boolean;
}

const DEFAULT_SERVER = "nats://127.0.0.1:4222"; // core's DEFAULT_SERVER (kept literal so config has no core-runtime dep)
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
    else if (a === "--learn-first-chat") out.learnFirstChat = true;
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
    channel: raw.channel ?? "general",
    token: resolveToken(raw.token),
    creds,
    groqKey: resolveGroqKey(raw.groqKey),
    stateRoot: stateRoot(),
    seedChats,
    learnFirstChat: raw.learnFirstChat ?? false,
    markdown: raw.markdown ?? true,
  };
}

function numOrThrow(s: string): number {
  const n = Number(s);
  if (!Number.isInteger(n)) throw new Error(`cotal-telegram: --chat expects a numeric chat id, got "${s}"`);
  return n;
}
