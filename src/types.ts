/**
 * Bindings, secrets and vars available to the Worker.
 * Secrets are injected with `wrangler secret put`; vars come from wrangler.toml.
 */
export interface Env {
  // --- Bindings ---
  STATE: KVNamespace;
  AI: Ai;

  // --- Secrets (wrangler secret put / dashboard) ---
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  /** A secret and not a var: the repo is public and wrangler.toml is read from GitHub. */
  ALLOWED_TELEGRAM_IDS: string;
  /** Optional: only the active provider's key is needed (LLM_PROVIDER). */
  OPENAI_API_KEY?: string;
  GROQ_API_KEY?: string;
  NVIDIA_API_KEY?: string;
  SUPABASE_URL?: string;
  /** It bypasses RLS: the most powerful credential in the project. */
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /**
   * Google service account, for writing to the calendar. Optional: without them
   * create_event returns an error explaining what is missing and the rest of the
   * assistant keeps working exactly the same.
   */
  GOOGLE_SA_EMAIL?: string;
  /** The `private_key` field from the service account JSON, PEM included. */
  GOOGLE_SA_PRIVATE_KEY?: string;
  /** Id of the shared calendar. Never 'primary': see src/calendar/index.ts. */
  GOOGLE_CALENDAR_ID?: string;

  // --- Vars (wrangler.toml) ---
  DEFAULT_TIMEZONE: string;
  LLM_PROVIDER?: string;
  LLM_MODEL?: string;
  HISTORY_WINDOW?: string;
  MAX_AGENT_ITERATIONS?: string;
  STT_PROVIDER?: string;
  STT_MODEL?: string;
  STT_LANGUAGE?: string;
  BRIEFING_HOUR?: string;
  EVENT_ALERT_MINUTES?: string;
  /** The day's window (local hours) find_free_slots searches for gaps in. */
  DAY_START_HOUR?: string;
  DAY_END_HOUR?: string;
  LOG_LEVEL?: string;
}

/* ------------------------------------------------------------------ *
 * Telegram Bot API types.
 * Only the fields we consume: the real objects carry many more.
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

/**
 * One of the versions Telegram makes of a photo.
 *
 * They arrive as an array, from a thumbnail to the compressed original. Which one gets
 * downloaded is decided in `telegram/photos.ts`: the biggest is not the best choice.
 */
export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
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
  photo?: TelegramPhotoSize[];
  /** Not consumed: a photo sent "as a file" arrives here and is not supported. */
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
