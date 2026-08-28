import { TelegramClient, TelegramError, isTimeout } from '../telegram/client';
import type { ToolDefinition, ToolResult } from './types';
import { requireString } from './types';

/**
 * Passing something to Telegram from the voice channel.
 *
 * The problem it fixes is small and had no workaround: talking to the page, a link, a
 * command or an address is useless read out loud —you cannot copy audio— and asking for
 * it "por Telegram" got answered with "ya estamos hablando por Telegram", which from
 * inside the model was true. Both channels resolve to the same `conversations` row, so it
 * had no way of telling one surface from the other; `ctx.channel` is what gives it one.
 *
 * It is the only tool that writes somewhere the answer is not going, and that is the
 * whole point: the spoken reply stays short and the text lands on the phone, where it can
 * be read twice and copied.
 */

/**
 * Telegram's own cap is 4096 and `sendMessage` truncates at it. Cutting earlier here is
 * not the same thing: what the tool reports as sent has to be what arrived, and a
 * silently trimmed message is the one case where the model would say otherwise.
 */
const MAX_TEXT_CHARS = 4_000;

/** One API call. It is the same 8 s the rest of the client takes, unless less is left. */
const MAX_SEND_MS = 8_000;

export const sendToTelegram: ToolDefinition = {
  name: 'send_to_telegram',
  description:
    'Le manda un mensaje escrito a su chat de Telegram, para que lo tenga ahí y pueda ' +
    'leerlo con calma o copiarlo. Úsala cuando te lo pida ("pásamelo por Telegram", ' +
    '"mándamelo por escrito", "escríbemelo") y también sin que te lo pida cuando lo que ' +
    'toca decir no se puede dictar: un enlace, un comando, un iban, una dirección, un ' +
    'texto para pegar en otro sitio o una lista larga. Manda solo el contenido, listo ' +
    'para copiar y sin presentación. Lo que le contestes de viva voz va aparte y va ' +
    'corto: basta con decirle que ya lo tiene en Telegram, sin repetirlo entero.',
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description:
          'El texto tal cual quieres que lo lea en Telegram. Sin negritas ni backticks: ' +
          'se envía en plano y esos caracteres se ven como basura en el chat.',
      },
    },
    required: ['text'],
  },
  // It writes nothing and there is nothing to undo: the message goes to his own chat, and
  // he is the one who just asked for it out loud. Making it wait behind a button would
  // mean pressing it in the browser to receive something on the phone.
  mutates: false,
  requiresConfirmation: false,
  // Inside Telegram this would be the assistant answering the same person twice on the
  // same screen. The token is not really optional —without it there is no bot at all—
  // but it is checked anyway, so the schema and the handler agree on what is needed.
  available: (env, channel) => channel === 'voice' && Boolean(env.TELEGRAM_BOT_TOKEN),
  handler: async (args, ctx): Promise<ToolResult> => {
    const text = requireString(args, 'text', MAX_TEXT_CHARS);

    if (!ctx.env.TELEGRAM_BOT_TOKEN) {
      return { ok: false, error: 'No hay bot de Telegram configurado en este despliegue.' };
    }

    const client = new TelegramClient(ctx.env.TELEGRAM_BOT_TOKEN);
    try {
      await client.sendMessage(ctx.chatId, text, {
        timeoutMs: ctx.deadline.budgetFor(MAX_SEND_MS),
      });
    } catch (error) {
      // Back to the model as a result, never as an exception: a failed send is something
      // it has to say out loud —"no te ha llegado"— instead of a silence the user reads
      // as a message that never arrives.
      if (isTimeout(error)) {
        return { ok: false, error: 'Telegram ha tardado demasiado; el mensaje no ha salido.' };
      }
      if (error instanceof TelegramError) {
        return { ok: false, error: `Telegram lo ha rechazado: ${error.message}` };
      }
      throw error;
    }

    return { ok: true, data: { sent: true, chars: text.length } };
  },
};
