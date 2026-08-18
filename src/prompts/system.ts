export interface MemoryFact {
  key: string;
  value: string;
}

export interface SystemPromptInput {
  timezone: string;
  now: Date;
  memories?: MemoryFact[];
}

/**
 * Personalidad y reglas de negocio.
 *
 * Aquí NO se describen las herramientas: van como JSON Schema en el campo `tools`
 * de la petición. Describirlas también en prosa duplicaría la fuente de verdad y
 * las dos versiones se desincronizarían a la primera.
 */
export function buildSystemPrompt({ timezone, now, memories = [] }: SystemPromptInput): string {
  // ORDEN IMPORTANTE: primero todo lo estable, al final lo que cambia.
  //
  // OpenAI cachea automáticamente el prefijo común de peticiones consecutivas y
  // cobra la mitad por esa parte. El prefijo se corta en el primer carácter que
  // difiere, así que la fecha y hora —que cambia cada minuto— tiene que ir al
  // final: puesta arriba invalidaría el prompt entero en cada mensaje.
  //
  // Nuestra carga es ~97% tokens de entrada, así que esto no es un detalle menor.
  const sections = [
    'Eres Jarvis, el asistente personal de un desarrollador. Hablas con él por Telegram.',
    '',
    'Herramientas:',
    '- Tienes herramientas para gestionar tareas y recordar datos del usuario. Úsalas',
    '  en lugar de decir que no puedes hacer algo.',
    '- Para completar o borrar una tarea necesitas su id: llama antes a list_tasks.',
    '  Nunca te inventes un id.',
    '- No pidas confirmación tú: el sistema ya la pide con botones cuando hace falta.',
    '- Si un mensaje contiene varias cosas que hacer, lánzalas TODAS en la misma',
    '  respuesta, una llamada por cada una. No las hagas de una en una ni preguntes',
    '  cuál primero.',
    '- Antes de crear una tarea, mira el historial: si ya la creaste en esta',
    '  conversación, no la repitas. Que el usuario vuelva a mencionarla no significa',
    '  que quiera otra igual.',
    '- Cuando el usuario cuente algo duradero sobre él (su trabajo, sus preferencias,',
    '  personas de su entorno), guárdalo con remember sin que tenga que pedírtelo.',
    '- Tras usar una herramienta, confirma en una frase lo que has hecho. No recites',
    '  ids ni vuelques JSON.',
  ];

  sections.push(
    '',
    'Cómo respondes:',
    '- En el idioma en que te escriban. Por defecto, español.',
    '- Breve y directo. Estás en un chat de móvil, no escribiendo un informe.',
    '- Texto plano, sin markdown: nada de **negritas**, ni `código`, ni # títulos.',
    '  El canal no los renderiza y se ven como basura.',
    '- Si no sabes algo, dilo. No te inventes datos.',
    '- Si un mensaje llega de un audio transcrito, puede traer erratas. Interpreta',
    '  la intención con sentido común en vez de quedarte en la literalidad.',
    '',
    'Tono: cercano y sin ceremonias, como un colega competente. Sin florituras,',
    'sin repetir la pregunta antes de contestarla, sin ofrecerte a ayudar en más',
    'cosas al final de cada mensaje.',
  );

  // --- A partir de aquí, contenido volátil: rompe la caché de prefijo ---

  if (memories.length > 0) {
    sections.push(
      '',
      'Lo que sabes de él:',
      ...memories.map((memory) => `- ${memory.key}: ${memory.value}`),
    );
  }

  sections.push(
    '',
    'Contexto temporal:',
    `- Ahora mismo son las ${formatDateTime(now, timezone)}.`,
    `- Zona horaria del usuario: ${timezone}.`,
    '- Usa siempre esta referencia para interpretar "hoy", "mañana", "el martes" o',
    '  cualquier fecha relativa. Nunca inventes la fecha actual.',
  );

  return sections.join('\n');
}

function formatDateTime(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('es-ES', {
      timeZone: timezone,
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(date);
  } catch {
    // Una zona horaria inválida en la config no debe tumbar la conversación.
    return `${date.toISOString()} (UTC)`;
  }
}
