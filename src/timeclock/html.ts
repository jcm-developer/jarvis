/**
 * The little bit of HTML parsing this project needs.
 *
 * Regexes and not `HTMLRewriter`, which is right there in the runtime: the rewriter is
 * built for streaming a transformation, and what is needed here is the opposite —the
 * whole form at once, in document order, before deciding anything. Doing that with the
 * rewriter means buffering into these same structures with more ceremony.
 *
 * It leans on one property of ASP.NET WebForms and would be wrong without it: the page
 * has a single `<form runat="server">` wrapping everything, so every input on the page
 * belongs to the same form and there is no form to disambiguate.
 */

export interface FormInput {
  name: string;
  type: string;
  value: string;
}

/** One option of a radio group, with the text printed next to it. */
export interface RadioOption {
  name: string;
  value: string;
  /** The visible text, normalised. What the user reads on the row. */
  label: string;
  /**
   * Whether the page's own submit refuses to send this option without a written comment.
   *
   * `consubmotivo` and NOT `conobservacion`, and the difference cost a day of silent
   * failures. `fEnviar()` submits only when `consubmotivo == "False"`, or when it is
   * "True" and `#comentario` is not empty — and when the attribute is missing altogether
   * it falls through and submits nothing, without so much as an alert. `conobservacion` is
   * a different job: `fActivar()` reads it to reveal the comment box. Reading the second
   * one to decide the first meant refusing options the page would have sent.
   */
  requiresComment: boolean;
  /**
   * `conobservacion`: the page offers a comment box for this option.
   *
   * Kept although nothing acts on it, because the two attributes were confused once and a
   * diagnosis that prints both is what stops it happening again.
   */
  showsComment: boolean;
}

/** A control that submits the form: either a real submit input or a __doPostBack link. */
export interface FormControl {
  /** What the user reads on it, normalised. */
  label: string;
  /** Fields to add to the POST to press this control. */
  fields: Record<string, string>;
  /**
   * The phase this control registers, for a page whose buttons call `fEnviar()`.
   *
   * The register page carries one hidden `tipo` field meaning entrada or salida, and it is
   * the button —not the reason— that decides its value: `fEnviar('send')` writes "S" and
   * any other argument writes "E". Taken from the control instead of mapped by hand
   * because the button on screen is already the phase, so there is nothing left to guess.
   */
  phase?: 'S' | 'E';
}

export interface ParsedForm {
  /** Whether the page carries a form at all. A page without one is not the application. */
  hasForm: boolean;
  /** The form's action, as written in the HTML. Relative more often than not. */
  action: string | null;
  /** The radio options, with the text printed beside each one. */
  radios: RadioOption[];
  /**
   * Every input on the page, in document order.
   *
   * Order is not decoration: the username field is identified as "the text input before
   * the password one", which is the only rule that holds without knowing the site's
   * field names.
   */
  inputs: FormInput[];
  controls: FormControl[];
}

/** Lowercase, no accents, single spaces. Every label comparison goes through here. */
export function norm(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Attributes, with or without a value.
 *
 * The value is optional and that is not tidiness: `checked`, `selected` and `disabled` are
 * written bare in real HTML, and this page writes the checked radio exactly that way. With
 * a regex that demanded `=`, the selected option was invisible — so the state we posted back
 * was missing the very field the page had already chosen.
 */
const TAG_ATTRS = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function attributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(TAG_ATTRS)) {
    attrs[match[1]!.toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

/**
 * The entities that actually show up in a WebForms page.
 *
 * Not a general decoder: `__doPostBack('ctl00$x','')` arrives with its quotes as `&#39;`
 * and hidden values carry `&amp;`, and those two are the ones that break a parse. A full
 * entity table would be dead code the day it was written.
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * Visible text of a fragment: scripts out, tags out, entities in, whitespace collapsed.
 *
 * Dropping `<script>` and `<style>` bodies is not tidiness. Stripping only tags leaves the
 * JavaScript behind as if it were text, and that reached production twice: a diagnosis that
 * quoted `$(function () { //$("#mif").submit();` as what the page "said", and —worse— radio
 * labels and the "Último movimiento" line matched against code instead of against words.
 */
export function textOf(html: string): string {
  const visible = html
    // Comments FIRST, and this order is the whole point. Commented-out markup is full of
    // `>` characters, so stripping tags first eats `<!-- <input ...>` and leaves ` -->`
    // behind as if it were text. That is how the register page's reasons came out reading
    // "--> / --> / <input type=text placeholder=escriba un comentario".
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    // A tag with no closing bracket, i.e. a fragment cut off by whoever sliced the html.
    // Without this it survives as "text" and reads like a label: the register page's
    // reasons came out as `<input type=text class=form-control placeholder=escr`.
    .replace(/<[^>]*$/, ' ');
  return norm(decodeEntities(visible));
}

/**
 * Ceiling on a radio's label.
 *
 * The label is taken as the text that follows the radio, so a page laid out differently
 * from what this expects yields a paragraph instead of two words. Matching is by
 * containment, so a long label is not wrong on its own — but it makes the diagnosis
 * unreadable, and unreadable is what sent the last two runs chasing the wrong thing.
 */
const MAX_LABEL_CHARS = 80;

const DO_POSTBACK =
  /__doPostBack\(\s*(?:&#39;|&apos;|['"])([^'"&]+)(?:&#39;|&apos;|['"])\s*,\s*(?:&#39;|&apos;|['"])([^'"&]*)/i;

/**
 * `fEnviar('send')` in an onclick, which is how the register page's own buttons submit.
 *
 * The argument is not the reason and not the button: it is the phase, and the function
 * turns it into the hidden `tipo` field —"S" for 'send', "E" for anything else— before
 * submitting. Reading it here is what keeps that mapping out of the caller.
 */
const F_ENVIAR = /fEnviar\(\s*(?:&#39;|&apos;|['"])([^'"&)]*)/i;

function phaseOf(attrs: Record<string, string>): { phase?: 'S' | 'E' } {
  const call = F_ENVIAR.exec(attrs['onclick'] ?? '');
  if (!call) return {};
  return { phase: call[1]!.trim().toLowerCase() === 'send' ? 'S' : 'E' };
}

/**
 * The page's forms, tag and contents, in document order.
 *
 * Forms do not nest, so a non-greedy match between the open and close tags is exact. A form
 * left unclosed —which happens— takes the rest of the document, which is what a browser
 * does with it too.
 */
interface FormBlock {
  tag: string;
  body: string;
  from: number;
  to: number;
}

function formBlocks(html: string): FormBlock[] {
  const blocks: FormBlock[] = [];
  for (const match of html.matchAll(/<form\b[^>]*>/gi)) {
    const from = match.index + match[0].length;
    const close = html.toLowerCase().indexOf('</form', from);
    const to = close < 0 ? html.length : close;
    blocks.push({ tag: match[0], body: html.slice(from, to), from, to });
  }
  return blocks;
}

/**
 * Which form the page means, and it is not always the first one.
 *
 * A browser posts the fields of the form that contains the button that was pressed, to that
 * form's own action. This code used to take the first `<form>` on the page for its action
 * and every `<input>` in the document for its body, which is the same thing only while
 * there is exactly one form. The register page is not that page: it carries the punch form
 * plus whatever the layout around it puts there, so the punch was being posted to another
 * form's endpoint carrying another form's fields.
 *
 * The order is the order of what we came for: the form with the punch buttons, then the one
 * with the password, then the first one there is.
 */
function pickForm(blocks: FormBlock[]): FormBlock | null {
  if (blocks.length === 0) return null;
  const punch = blocks.find((block) => /name\s*=\s*['"]?bmotivo/i.test(block.body));
  if (punch) return punch;
  const login = blocks.find((block) => /<input\b[^>]*type\s*=\s*['"]?password/i.test(block.body));
  return login ?? blocks[0]!;
}

export function parseForm(html: string): ParsedForm {
  const blocks = formBlocks(html);
  const chosen = pickForm(blocks);
  const action = chosen ? (attributes(chosen.tag)['action'] ?? null) : null;

  // Controls are read from the whole document and fields only from the chosen form, and the
  // asymmetry is deliberate. A button that submits through `$("#fr").submit()` does not have
  // to live inside `#fr` —that call is precisely how a page submits a form from outside it—
  // so scoping the buttons would risk losing the one we came to press. A field outside the
  // form, on the other hand, is a field a browser would never send.
  const inside = (at: number): boolean => !chosen || (at >= chosen.from && at < chosen.to);
  const inputs: FormInput[] = [];
  const controls: FormControl[] = [];

  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const type = (attrs['type'] ?? 'text').toLowerCase();
    const name = attrs['name'] ?? '';
    const value = attrs['value'] ?? '';

    if (type === 'submit' || type === 'button' || type === 'image') {
      // A submit control is pressed by sending its own name and value, which is also
      // how the server knows which button was clicked.
      if (name) {
        controls.push({
          label: norm(value || attrs['alt'] || ''),
          fields: { [name]: value },
          ...phaseOf(attrs),
        });
      }
      continue;
    }

    // Unnamed inputs are decoration: the browser would not send them either.
    if (!name) continue;
    if (!inside(match.index)) continue;

    // Unchecked boxes and unselected radios are not sent by a browser, so sending them
    // would be inventing a state the user never chose.
    if ((type === 'checkbox' || type === 'radio') && attrs['checked'] === undefined) continue;

    inputs.push({ name, type, value });
  }

  // Anchors and buttons. Two different jobs in one loop:
  //
  // - A `<button type="submit">` is a real control and the page's own login uses one, with
  //   an icon inside and no `name` at all. Its label is its text, and a browser sends no
  //   field for a nameless button, so neither do we.
  // - An anchor or button wired to `__doPostBack` is the other way a platform renders a
  //   button, and which of the two a given page uses is not predictable from outside.
  for (const match of html.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const attrs = attributes(match[2] ?? '');
    const label = textOf(match[3] ?? '') || norm(attrs['title'] ?? '');
    const postback = DO_POSTBACK.exec(`${attrs['href'] ?? ''} ${attrs['onclick'] ?? ''}`);

    if (postback) {
      controls.push({
        label,
        fields: { __EVENTTARGET: postback[1]!, __EVENTARGUMENT: postback[2] ?? '' },
      });
      continue;
    }

    // Every `<button>` is recorded, whatever its type, and the difference is in what gets
    // sent rather than in whether it exists:
    //
    // - `type="submit"` (the default when the attribute is absent) contributes its own
    //   name and value, which is how a server knows which button was pressed.
    // - `type="button"` contributes nothing, because a browser sends nothing for it: it
    //   runs a script. The register page's own button is one of these —
    //   `onclick="fEnviar('send')"`— and skipping those meant never finding it. What
    //   protects against pressing the wrong one is matching the label, not the type.
    if (match[1]!.toLowerCase() !== 'button' || !label) continue;

    const type = (attrs['type'] ?? 'submit').toLowerCase();
    if (type === 'reset') continue;

    controls.push({
      label,
      fields: type === 'submit' && attrs['name'] ? { [attrs['name']]: attrs['value'] ?? '' } : {},
      ...phaseOf(attrs),
    });
  }

  return { hasForm: chosen !== null, action, inputs, controls, radios: parseRadios(html) };
}

/**
 * The radio group and the text next to each option.
 *
 * The label is not inside the input —it never is— so it is taken as the visible text
 * between one radio and the next. That is a heuristic and it is the right one here: the
 * page lays the options out as rows, so whatever text follows a radio belongs to it until
 * the following radio starts. A `<label for>` is preferred when the page provides one.
 */
export function parseRadios(html: string): RadioOption[] {
  const radios: {
    name: string;
    value: string;
    id: string;
    requiresComment: boolean;
    showsComment: boolean;
    end: number;
  }[] = [];
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    if ((attrs['type'] ?? '').toLowerCase() !== 'radio') continue;
    if (!attrs['name']) continue;
    radios.push({
      name: attrs['name'],
      value: attrs['value'] ?? '',
      id: attrs['id'] ?? '',
      // Not `!== 'false'`: an option whose attribute is missing is one the page's own
      // submit silently declines to send, so treating it as "needs a comment" refuses it
      // here instead of posting something the browser never would.
      requiresComment: (attrs['consubmotivo'] ?? '').toLowerCase() !== 'false',
      showsComment: (attrs['conobservacion'] ?? '').toLowerCase() === 'true',
      end: (match.index ?? 0) + match[0].length,
    });
  }

  const labelFor = new Map<string, string>();
  for (const match of html.matchAll(/<label([^>]*)>([\s\S]*?)<\/label>/gi)) {
    const target = attributes(match[1] ?? '')['for'];
    if (target) labelFor.set(target, textOf(match[2] ?? ''));
  }

  return radios.map((radio, index) => {
    const following = html.slice(radio.end, radios[index + 1]?.end ?? radio.end + 500);
    return {
      name: radio.name,
      value: radio.value,
      requiresComment: radio.requiresComment,
      showsComment: radio.showsComment,
      // Three ways of naming an option, in order of how much they can be trusted. The
      // middle one is the one this page actually uses and the one no amount of staring at
      // a failed parse would have suggested: the reason is not text next to the radio, it
      // is the `value` of a text input beside it, printed as an editable field.
      label: (
        labelFor.get(radio.id) ||
        valueOfNeighbour(following) ||
        textOf(following)
      ).slice(0, MAX_LABEL_CHARS),
    };
  });
}

/**
 * The value of the first text input that follows a radio, which is how this page prints the
 * name of each option.
 *
 * Inputs with no value are skipped, which is what keeps the neighbouring comment box —
 * `placeholder="Escriba un comentario"`, no value— from being taken for a label.
 */
function valueOfNeighbour(html: string): string {
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const type = (attrs['type'] ?? 'text').toLowerCase();
    if (type !== 'text' && type !== 'hidden') continue;
    const value = (attrs['value'] ?? '').trim();
    if (value) return norm(value);
  }
  return '';
}

/** The first radio whose visible text contains one of the given phrases. */
export function findRadio(radios: RadioOption[], phrases: string[]): RadioOption | null {
  for (const phrase of phrases) {
    const wanted = norm(phrase);
    const found = radios.find((radio) => radio.label.includes(wanted));
    if (found) return found;
  }
  return null;
}

/** The first control whose label contains one of the given phrases. */
export function findControl(form: ParsedForm, phrases: string[]): FormControl | null {
  for (const phrase of phrases) {
    const wanted = norm(phrase);
    const found = form.controls.find((control) => control.label.includes(wanted));
    if (found) return found;
  }
  return null;
}

/**
 * What a `.html("…")` call in the page's own script writes into the document.
 *
 * It exists for one line of this portal: "Último movimiento" is not served as markup, it is
 * assigned by `fVerResultado()` on load. `textOf` drops script bodies —deliberately, and it
 * has earned that twice— so the only way to read the time the portal recorded is to fetch
 * it out of the script before the stripping happens. Without this, confirming a punch falls
 * back to "the button changed phase" and the hour reported to the user is our clock instead
 * of theirs, on a record where theirs is the one that counts.
 */
export function scriptAssignedText(html: string): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(/\.html\(\s*(['"])([\s\S]{0,300}?)\1\s*\)/g)) {
    const text = textOf(match[2] ?? '');
    if (text) found.push(text);
  }
  return found;
}

/**
 * The form's state, ready to be posted back.
 *
 * Hidden fields are copied verbatim and that is the whole trick: `__VIEWSTATE`,
 * `__EVENTVALIDATION` and whatever else the platform decides to add travel through
 * without this code having to know they exist.
 */
export function formState(form: ParsedForm): Record<string, string> {
  const state: Record<string, string> = {};
  for (const input of form.inputs) state[input.name] = input.value;
  return state;
}
