import type { TelegramFile } from '../types';

const API_BASE = 'https://api.telegram.org';

export type ChatAction = 'typing' | 'upload_voice' | 'record_voice';

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface SendMessageOptions {
  replyToMessageId?: number;
  inlineKeyboard?: InlineKeyboardButton[][];
}

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly errorCode: number | undefined,
    description: string,
  ) {
    super(`Telegram ${method} falló (${errorCode ?? 'sin código'}): ${description}`);
    this.name = 'TelegramError';
  }
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

export class TelegramClient {
  constructor(private readonly token: string) {}

  private async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${API_BASE}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const body = (await response.json()) as TelegramApiResponse<T>;
    if (!body.ok || body.result === undefined) {
      throw new TelegramError(method, body.error_code, body.description ?? 'sin descripción');
    }
    return body.result;
  }

  /**
   * Envía texto plano, sin `parse_mode`.
   *
   * Deliberado: MarkdownV2 obliga a escapar una lista larga de caracteres y un
   * fallo de escapado devuelve un 400 que descarta el mensaje entero. Cuando el
   * contenido lo genere el LLM (Fase 1) el riesgo es constante, así que el
   * formato enriquecido se añadirá con un escapador propio y probado, no antes.
   */
  async sendMessage(chatId: number, text: string, options: SendMessageOptions = {}) {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: truncate(text),
    };
    if (options.replyToMessageId !== undefined) {
      payload['reply_to_message_id'] = options.replyToMessageId;
    }
    if (options.inlineKeyboard) {
      payload['reply_markup'] = { inline_keyboard: options.inlineKeyboard };
    }
    return this.call<unknown>('sendMessage', payload);
  }

  /** Muestra "escribiendo…". Caduca a los 5 s o al enviar el mensaje. */
  async sendChatAction(chatId: number, action: ChatAction = 'typing') {
    return this.call<boolean>('sendChatAction', { chat_id: chatId, action });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string) {
    const payload: Record<string, unknown> = { callback_query_id: callbackQueryId };
    if (text) payload['text'] = text;
    return this.call<boolean>('answerCallbackQuery', payload);
  }

  /** Paso 1 para descargar audio (Fase 3): resuelve el file_path. */
  async getFile(fileId: string): Promise<TelegramFile> {
    return this.call<TelegramFile>('getFile', { file_id: fileId });
  }

  fileUrl(filePath: string): string {
    return `${API_BASE}/file/bot${this.token}/${filePath}`;
  }

  /** Resuelve el file_id y descarga el contenido. Usado para las notas de voz. */
  async downloadFile(fileId: string): Promise<ArrayBuffer> {
    const file = await this.getFile(fileId);
    if (!file.file_path) {
      throw new TelegramError('getFile', undefined, 'la respuesta no traía file_path');
    }

    const response = await fetch(this.fileUrl(file.file_path), {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new TelegramError('downloadFile', response.status, 'no se pudo descargar el fichero');
    }
    return response.arrayBuffer();
  }
}

/** Tope de descarga de la Bot API. Más allá, getFile falla. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/** Telegram rechaza mensajes de más de 4096 caracteres. */
const MAX_MESSAGE_LENGTH = 4096;

function truncate(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '(respuesta vacía)';
  if (trimmed.length <= MAX_MESSAGE_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}
