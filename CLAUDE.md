# Instrucciones para Claude Code

Contexto y convenciones de este repo. Se lee en cada sesión, así que va al grano.

## El proyecto

Jarvis: asistente personal por Telegram sobre Cloudflare Workers (plan **free**),
con Supabase como base de datos. Usuario único, no es multi-tenant.

[ARCHITECTURE.md](ARCHITECTURE.md) es la **fuente de verdad** de las decisiones
técnicas. Antes de proponer un cambio de diseño, leerlo: muchas cosas que parecen
mejorables están así por un motivo que ya está escrito ahí.

## Cómo trabajamos

- **Idioma: el código y la documentación, en inglés.** Comentarios, nombres,
  ARCHITECTURE.md, README.md y los mensajes de commit. En español se queda solo lo
  que lee una persona o el modelo: los textos que salen por Telegram, el system
  prompt, las descripciones de las tools y los `error` que vuelven al modelo. Eso es
  producto, no código, y traducirlo cambiaría cómo suena el bot. Las respuestas de
  este chat y este propio fichero también van en español.
- **Formato de las respuestas de este chat.** Cuando pregunte algo, contesta siempre
  con estas tres secciones y nada más, salvo que te pida explícitamente que te
  explayes:

  ```
  *PROBLEMA (Claro y conciso)*
  - Descripción si es necesaria

  *SOLUCIÓN (Clara y concisa)*
  - Descripción

  *PASOS A SEGUIR POR EL USUARIO*
  - Explicación (Clara y concisa)
  ```

  Conciso es conciso: una línea por punto y fuera. Si algo no aplica —no hay pasos
  míos, o el problema no tiene solución todavía— dilo en su sección en vez de
  inventar contenido para rellenarla o de saltártela.
- **Vamos por fases.** El roadmap está al final de ARCHITECTURE.md. Cuando digo
  "el siguiente punto" o "continuamos", es la siguiente fase pendiente de esa tabla.
- Al cerrar una fase se actualizan **los tres**: el código, el roadmap de
  ARCHITECTURE.md y la sección correspondiente del README.
- No hagas commit ni push si no te lo pido.

## Estilo de código

- **TypeScript estricto, cero dependencias nuevas.** Solo `hono`. El cliente de
  Supabase y el de los LLM están escritos a mano a propósito: los SDK arrastran
  peso y dependencias de Node al bundle del Worker, y solo usamos cuatro
  operaciones de cada uno. No añadas `@supabase/supabase-js` ni `openai`.
- **Los comentarios explican el *por qué*, no el *qué*.** Si un comentario se
  limita a repetir lo que hace la línea siguiente, sobra. Los que valen son los que
  cuentan qué se probó antes, qué falló en producción y por qué está así.
- Nada de comentarios `TODO` sueltos: o se hace, o se apunta en el roadmap.
- Todo lo que sale hacia fuera (LLM, Telegram, Supabase, STT) va detrás de una
  interfaz en su directorio. Cambiar de proveedor debe ser una variable de entorno.
- Los errores de herramienta **nunca** se lanzan al usuario: vuelven al modelo como
  `{ok: false, error}` para que se corrija en la siguiente iteración.

## Antes de dar algo por bueno

- `npm run typecheck` **siempre**. Es la barrera del CI: un push que no compila no
  se despliega, y el bot se queda en la versión anterior sin avisar.
- No hay framework de tests. Para lógica delicada, el patrón que funciona es
  compilar el módulo con `npx tsc <fichero> --outDir <scratchpad>` y ejercitarlo
  desde un `.mjs` con un doble del `Db` que emule PostgREST. Ya ha pescado bugs
  reales; no te lo saltes cuando toques historial, ventanas o presupuestos.
- No puedo probar contra Supabase ni Telegram desde aquí: no hay `.dev.vars` con
  credenciales. Si algo solo se puede validar en producción, dilo en claro.

## Trampas de este entorno (comprobadas en producción)

- **`waitUntil()` tiene un margen corto y luego Cloudflare cancela la tarea sin
  excepción ni log.** Por eso todo el procesamiento de un mensaje vive dentro de un
  presupuesto de tiempo global ([src/lib/deadline.ts](src/lib/deadline.ts)). Toda
  llamada externa nueva debe pedirle su tope al `Deadline`, nunca fijar uno propio.
- **KV: 1.000 escrituras/día.** Ya se gasta una por mensaje en el dedupe de
  `update_id`, que no es negociable. No añadas escrituras por mensaje; lo que
  necesite persistir va a Supabase.
- **Respuestas en texto plano.** Telegram no renderiza markdown en nuestro envío:
  `**negritas**` y backticks se ven como basura en el chat.
- **El modelo no calcula fechas.** La fecha, hora y zona horaria se inyectan en el
  system prompt y las relativas se resuelven en los handlers.
- **Lo volátil va al final del system prompt.** Rompe la caché de prefijo del
  proveedor, y nuestra carga es ~97% tokens de entrada.

## Commits

**En inglés, una sola línea, sin cuerpo.** Conventional commits en minúscula e
imperativo, con uno de estos tres prefijos:

| Prefijo | Cuándo |
|---|---|
| `feat:` | funcionalidad nueva |
| `fix:` | corregir algo que estaba mal |
| `chore:` | todo lo demás: dependencias, config, tooling, documentación |

El asunto dice el efecto, no el fichero tocado.

```
feat: store conversation history in supabase instead of kv
fix: share one time budget across audio download, stt and llm calls
chore: document project conventions for claude code
```

Los commits anteriores a agosto de 2026 están en español y con cuerpo. Es historia,
no un patrón a seguir.

Cada push a `main` despliega a producción vía Cloudflare Workers Builds. Es la rama
de trabajo y es deliberado: no crees ramas ni PR salvo que te lo pida.
