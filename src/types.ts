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
  /**
   * Web search (phase 20). Optional: without it search_web is not even offered to the
   * model and the prompt goes back to saying it cannot search.
   */
  TAVILY_API_KEY?: string;
  /**
   * Page reading (phase 20). Genuinely optional, unlike the rest: Jina Reader works
   * with no key at a lower rate limit, so read_url never depends on this being set.
   */
  JINA_API_KEY?: string;

  /** cbGesPro, the imputation portal (phase 24). */
  IMPUTE_USR?: string;
  IMPUTE_PASS?: string;
  /**
   * Bearer token of the voice channel (phase 25).
   *
   * Separate from TELEGRAM_WEBHOOK_SECRET on purpose: they protect different things and
   * leak differently. This one is typed into a browser by a person, so it lives in a
   * localStorage on whatever device was used to test; the Telegram one never leaves
   * Cloudflare. Sharing them would mean rotating the bot to revoke a laptop.
   *
   * With VOICE_ENABLED off it is not read at all. Without it set, the routes answer 401
   * even when they are enabled: an endpoint that spends money must not be open by
   * omission.
   */
  VOICE_API_TOKEN?: string;
  /**
   * Base URL of the imputation portal.
   *
   * A secret and not a var, even though a hostname is not a credential: wrangler.toml is
   * read straight off a public repo, and there is no reason to publish which company's
   * time-tracking system this talks to.
   */
  IMPUTE_BASE_URL?: string;

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
  /** Weekly review (phase 13): local day, 0 = Sunday, and local hour. */
  REVIEW_DAY?: string;
  REVIEW_HOUR?: string;
  EVENT_ALERT_MINUTES?: string;
  /** The day's window (local hours) find_free_slots searches for gaps in. */
  DAY_START_HOUR?: string;
  DAY_END_HOUR?: string;
  /**
   * Master switch of the voice channel (phase 25). "true" turns it on; anything else,
   * including it being absent, leaves it off.
   *
   * Off is the default and that is the point: this is the one surface of the project that
   * is reachable without Telegram's whitelist in front of it, so it has to be switched on
   * deliberately. The routes are not even registered when it is off — see src/index.ts.
   */
  VOICE_ENABLED?: string;
  /** Voice synthesis (phase 25). Only /voice reads these; Telegram never speaks. */
  TTS_PROVIDER?: string;
  TTS_MODEL?: string;
  TTS_VOICE?: string;
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
