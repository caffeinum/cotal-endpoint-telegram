/** A minimal TelegramApi for the wake tests — only the run-loop surface is exercised. (Not a *.test.ts,
 *  so the runner never treats it as a suite.) */
import type { TelegramApi, TgUpdate } from "../src/telegram.js";

export class FakeApiForWake implements TelegramApi {
  updates: TgUpdate[][] = [];
  nextId = 1;
  async getMe() { return { id: 1, username: "bot" }; }
  async getUpdates() {
    const b = this.updates.shift();
    if (b) return b;
    await new Promise((r) => setTimeout(r, 5));
    return [];
  }
  async sendMessage() { return { message_id: this.nextId++ }; }
  async editMessageText(_c: number, messageId: number) { return { message_id: messageId }; }
  async answerCallbackQuery() {}
  async setMessageReaction() {}
  async sendDocument() { return { message_id: this.nextId++ }; }
  async isForum() { return false; }
  async createForumTopic() { return { message_thread_id: 1 }; }
  async editForumTopicIcon() {}
  async getForumTopicIconStickers() { return []; }
  async getFile(fileId: string) { return { file_id: fileId, file_path: "v/f.oga" }; }
  async downloadFile() { return new Uint8Array(); }
  async deleteWebhook() {}
  async setMyCommands() {}
  async getMyCommands() { return []; }
}
