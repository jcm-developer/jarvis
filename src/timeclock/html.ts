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

  // Anchors and buttons that post back. WebForms renders half its buttons this way, and
  // which half is not something you can predict from outside.
  for (const match of html.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const attrs = attributes(match[2] ?? '');
    const postback = DO_POSTBACK.exec(`${attrs['href'] ?? ''} ${attrs['onclick'] ?? ''}`);
    if (!postback) continue;
    controls.push({
      label: textOf(match[3] ?? '') || norm(attrs['title'] ?? ''),
      fields: { __EVENTTARGET: postback[1]!, __EVENTARGUMENT: postback[2] ?? '' },
    });
  }

  return { action, inputs, controls };
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
