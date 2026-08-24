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
}

/** A control that submits the form: either a real submit input or a __doPostBack link. */
export interface FormControl {
  /** What the user reads on it, normalised. */
  label: string;
  /** Fields to add to the POST to press this control. */
  fields: Record<string, string>;
}

export interface ParsedForm {
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

const TAG_ATTRS = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

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

/** Visible text of a fragment: tags out, entities in, whitespace collapsed. */
export function textOf(html: string): string {
  return norm(decodeEntities(html.replace(/<[^>]*>/g, ' ')));
}

/**
 * `__doPostBack('target','argument')` as it appears inside an href or an onclick.
 *
 * The quotes are matched loosely because they arrive three different ways depending on
 * whether the attribute was written with double or single quotes: `'`, `&#39;`, `\'`.
 */
const DO_POSTBACK =
  /__doPostBack\(\s*(?:&#39;|&apos;|['"])([^'"&]+)(?:&#39;|&apos;|['"])\s*,\s*(?:&#39;|&apos;|['"])([^'"&]*)/i;

export function parseForm(html: string): ParsedForm {
  const formTag = /<form\b[^>]*>/i.exec(html);
  const action = formTag ? (attributes(formTag[0])['action'] ?? null) : null;

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
      if (name) controls.push({ label: norm(value || attrs['alt'] || ''), fields: { [name]: value } });
      continue;
    }

    // Unnamed inputs are decoration: the browser would not send them either.
    if (!name) continue;

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

    // Only submits: a `type="button"` does whatever its script does and pressing it by
    // posting the form would be inventing an action. That is what "Cambiar Contraseña" is
    // on the login page, and posting it would land on a password change form.
    const type = (attrs['type'] ?? '').toLowerCase();
    if (match[1]!.toLowerCase() !== 'button' || type !== 'submit') continue;
    if (!label) continue;

    controls.push({
      label,
      fields: attrs['name'] ? { [attrs['name']]: attrs['value'] ?? '' } : {},
    });
  }

  return { action, inputs, controls, radios: parseRadios(html) };
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
  const radios: { name: string; value: string; id: string; end: number }[] = [];
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    if ((attrs['type'] ?? '').toLowerCase() !== 'radio') continue;
    if (!attrs['name']) continue;
    radios.push({
      name: attrs['name'],
      value: attrs['value'] ?? '',
      id: attrs['id'] ?? '',
      end: (match.index ?? 0) + match[0].length,
    });
  }

  const labelFor = new Map<string, string>();
  for (const match of html.matchAll(/<label([^>]*)>([\s\S]*?)<\/label>/gi)) {
    const target = attributes(match[1] ?? '')['for'];
    if (target) labelFor.set(target, textOf(match[2] ?? ''));
  }

  return radios.map((radio, index) => ({
    name: radio.name,
    value: radio.value,
    label:
      labelFor.get(radio.id) ||
      textOf(html.slice(radio.end, radios[index + 1]?.end ?? radio.end + 300)),
  }));
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
