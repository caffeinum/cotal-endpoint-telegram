/**
 * Voice → text transcription, injectable like the Telegram transport.
 *
 * The `Transcriber` interface is the seam: the real impl POSTs the audio to Groq's OpenAI-compatible
 * Whisper endpoint over global `fetch` (no SDK — same "thin wrapper over fetch" philosophy as the
 * Telegram transport); a fake (test/) returns a canned string so the whole voice → mesh routing chain
 * is unit-testable with no network and no API key.
 *
 * Groq request shape (matched to makedora/dora-telegram's core/ai/groq.ts): multipart/form-data POST
 * to /openai/v1/audio/transcriptions with `file` + `model` + `response_format=text`, bearer-authed.
 */

import type { Transcriber } from "@cotal-ai/endpoint-core";

export type { Transcriber };

/** Groq's default Whisper model — the fast one dora uses (`whisper-large-v3-turbo`). */
export const GROQ_MODEL = "whisper-large-v3-turbo";

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

/**
 * The real Groq transcriber. Uses global `FormData`/`Blob`/`fetch` (node >= 22), so no dependency.
 * A non-2xx response throws with the status + body so the bridge can surface it to the chat.
 */
export function groqTranscriber(apiKey: string, model = GROQ_MODEL): Transcriber {
  return {
    async transcribe(audio, filename) {
      const form = new FormData();
      // A Blob carries the bytes; the filename's extension is the only container hint Whisper gets.
      form.append("file", new Blob([audio]), filename || "audio.ogg");
      form.append("model", model);
      form.append("response_format", "text");
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` }, // FormData sets its own multipart content-type + boundary
        body: form,
      });
      // response_format=text → the body IS the transcript (not JSON). Read once, branch on status.
      const body = await res.text();
      if (!res.ok) {
        throw new Error(`groq transcription failed: ${res.status} ${body.slice(0, 300)}`);
      }
      return body.trim();
    },
  };
}
