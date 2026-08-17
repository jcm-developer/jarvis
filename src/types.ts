/**
 * Bindings, secrets y vars disponibles en el Worker.
 * Los secrets se inyectan con `wrangler secret put`; las vars vienen de wrangler.toml.
 */
export interface Env {
  // --- Bindings ---
  STATE: KVNamespace;
  AI: Ai;

  // --- Secrets (wrangler secret put / dashboard) ---
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  /** Secret y no var: el repo es público y wrangler.toml se lee desde GitHub. */
  ALLOWED_TELEGRAM_IDS: string;

  // --- Vars (wrangler.toml) ---
  DEFAULT_TIMEZONE: string;
  LOG_LEVEL?: string;
}

/* ------------------------------------------------------------------ *
 * Tipos de la Telegram Bot API.
 * Solo los campos que consumimos: el objeto real trae muchos más.
 * ------------------------------------------------------------------ */

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  photo?: unknown[];
  document?: unknown;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}
