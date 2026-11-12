/**
 * `browser read`'s answer as an agent gets it: compact, unless it asks for all of it.
 *
 * 2026-11-11: reading a page was what conch's results cost agents most. 175 reads in 7 days of Claude Code transcripts
 * on this Mac came to 1.5 MB, 8.6 KB each on average (p50 6.3 KB, p90 19.7 KB): a third the page's words, a third its
 * links (their full addresses alone 18%), 11% its buttons, and most of the rest the JSON's indentation. After a read,
 * agents acted on a ref (53 of the next calls) or opened another page (55); neither needs every word of a long page. So
 * a read shows one page of the words (`READ_PAGE_CHARS`, cut at a line), the links, buttons and fields that are in it,
 * same-site links by their path, and says how to get the rest: the next page, the lines that mention some words (find),
 * the section under a heading (section), one part of the page by a CSS selector (the Mac app reads only that part), or
 * the whole read as it was before (full).
 *
 * Pure: the MCP server's `browser_read` and `conch agent browser read` both answer with it (mcp.ts), and the evals and
 * tests run it on reads as the Mac app's script returns them (ConchDesign `WorkbenchScript`).
 */

/** The words one page of a read shows: about 500 tokens. A read's median page had 1,013 characters, its p90 8,344. */
export const READ_PAGE_CHARS = 2_000;
/** The most of each kind of element one view lists; the median read had 19 links, 13 buttons and 1 field. */
export const READ_SHOWN = { links: 40, buttons: 25, fields: 30 } as const;
/** The most lines a find shows, and how much of a long line round the words. */
export const READ_FIND_LINES = 40;
export const READ_FIND_LINE_CHARS = 300;
/** The headings the outline of a page names. */
export const READ_SECTIONS_SHOWN = 20;
/** The longest a link's address is shown: a longer one is a ref's to click, not an address to type (831 had a query). */
export const READ_HREF_MAX = 120;
/** The longest find or section words, and a selector (the browser's own target limit). */
export const READ_WORDS_MAX = 200;
export const READ_SELECTOR_MAX = 500;

/** What part of a read an agent asked for. Nothing: the first page. */
export interface ReadView {
  /** The whole read, as browser_read answered before 2026-11-11. */
  full?: boolean;
  /** A page of the words (of the section, when one is named), from 1. */
  page?: number;
  /** The lines, links, buttons and fields that mention these words (any case). */
  find?: string;
  /** The words under the heading that says this, to the next heading of its level or above. */
  section?: string;
  /** A CSS selector: the Mac app reads only the part of the page it selects. */
  selector?: string;
}

/** A view an agent can't have: what it asked doesn't fit the page (a page past the end, a section it doesn't have). */
export class ReadViewError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const oneLine = (value: string) => !/[\n\r\u0000-\u001f\u007f]/.test(value);

/** The view a call's arguments ask for, or what is wrong with them. Only `full`, `page`, `find`, `section`, `selector`. */
export function readView(args: Record<string, unknown>): ReadView | { error: string } {
  const view: ReadView = {};
  if (Object.hasOwn(args, "full")) {
    if (typeof args.full !== "boolean") return { error: "full must be true or false" };
    if (args.full) view.full = true;
  }
  if (Object.hasOwn(args, "page")) {
    const page = args.page;
    if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > 1000) return { error: "page must be a whole number from 1" };
    view.page = page;
  }
  for (const [name, max] of [["find", READ_WORDS_MAX], ["section", READ_WORDS_MAX], ["selector", READ_SELECTOR_MAX]] as const) {
    if (!Object.hasOwn(args, name)) continue;
    const value = args[name];
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed || trimmed.length > max || !oneLine(trimmed)) return { error: `${name} must be 1 to ${max} characters on one line` };
    view[name] = trimmed;
  }
  if (view.find !== undefined && view.section !== undefined) return { error: "pass one of find or section: find looks through the whole page" };
  if (view.find !== undefined && view.page !== undefined) return { error: "find shows every line that matches, so it has no pages" };
  if (view.full && (view.page !== undefined || view.find !== undefined || view.section !== undefined)) {
    return { error: "full is the whole read: pass it alone, or with selector" };
  }
  return view;
}

type Item = Record<string, unknown>;

const items = (value: unknown): Item[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const words = (value: unknown) => (typeof value === "string" ? value : "");

/** A link's address as a read shows it: a same-site one by its path (or its #fragment on this page), any other whole. */
export function compactHref(href: string, pageUrl: string): string {
  const cap = (text: string) => (text.length > READ_HREF_MAX ? `${text.slice(0, READ_HREF_MAX - 1)}…` : text);
  let page: URL;
  let link: URL;
  try {
    page = new URL(pageUrl);
    link = new URL(href);
  } catch {
    return cap(href);
  }
  if (link.origin !== page.origin || !/^https?:$/.test(link.protocol)) return cap(href);
  if (link.pathname === page.pathname && link.search === page.search && link.hash) return cap(link.hash);
  return cap(`${link.pathname}${link.search}${link.hash}`);
}

/**
 * Where each element's words appear in the page's words: the next place after the element before it, as the page has
 * them in order, else the first; undefined for one whose words aren't there at all (an icon's aria-label, a field
 * known by its placeholder: 1,477 of 4,010 buttons in the reads above), which the page's first view lists. Lines are
 * joined with spaces, as an element's own words are, so a card link over two lines is found.
 */
function placed(list: Item[], flat: string, wordsOf: (item: Item) => string): Array<number | undefined> {
  let cursor = 0;
  return list.map((item) => {
    const said = wordsOf(item).replace(/…$/, "").trim();
    if (said.length < 2) return undefined;
    let at = flat.indexOf(said, cursor);
    if (at < 0) at = flat.indexOf(said);
    if (at < 0) return undefined;
    if (at >= cursor) cursor = at + said.length;
    return at;
  });
}

/** The page's words cut into pages of about `size` characters, each ending at a line (else a space) when one is near. */
export function textPages(text: string, start: number, end: number, size = READ_PAGE_CHARS): Array<[number, number]> {
  const pages: Array<[number, number]> = [];
  let at = start;
  while (at < end) {
    let stop = Math.min(end, at + size);
    if (stop < end) {
      const line = text.lastIndexOf("\n", stop - 1);
      const space = text.lastIndexOf(" ", stop - 1);
      if (line > at + size / 2) stop = line + 1;
      else if (space > at + size / 2) stop = space + 1;
    }
    pages.push([at, stop]);
    at = stop;
  }
  return pages.length ? pages : [[start, start]];
}

/** Where a heading's words start a line, from `from` on; -1 when no line starts with them. */
function lineStart(text: string, said: string, from: number): number {
  const wanted = said.replace(/…$/, "").trim();
  if (!wanted) return -1;
  for (let at = text.indexOf(wanted, from); at >= 0; at = text.indexOf(wanted, at + 1)) {
    if (at === 0 || text[at - 1] === "\n") return at;
  }
  return -1;
}

interface Heading { level: number; text: string }

function headingsOf(value: unknown): Heading[] {
  return items(value).flatMap((heading) =>
    typeof heading.level === "number" && typeof heading.text === "string" && heading.text ? [{ level: heading.level, text: heading.text }] : []);
}

/** The first that matches, by the same words, then words it starts with, then words it holds (any case). */
function bestMatch<T>(candidates: T[], wordsOf: (candidate: T) => string, wanted: string): T | undefined {
  const lower = wanted.toLowerCase();
  const said = (candidate: T) => wordsOf(candidate).replace(/…$/, "").trim().toLowerCase();
  return candidates.find((one) => said(one) === lower)
    ?? candidates.find((one) => said(one).startsWith(lower))
    ?? candidates.find((one) => said(one).includes(lower));
}

/** The span of the words a section covers, and what it is called; a `ReadViewError` when the page has no such part. */
function sectionSpan(text: string, headings: Heading[], name: string): { start: number; end: number; section: string; note?: string } {
  const starts: number[] = [];
  let cursor = 0;
  for (const heading of headings) {
    const at = lineStart(text, heading.text, cursor);
    starts.push(at);
    if (at >= 0) cursor = at + 1;
  }
  const found = headings.map((heading, index) => ({ heading, index })).filter(({ index }) => starts[index]! >= 0);
  const match = bestMatch(found, ({ heading }) => heading.text, name);
  if (match) {
    const start = starts[match.index]!;
    const next = found.find(({ heading, index }) => index > match.index && heading.level <= match.heading.level && starts[index]! > start);
    return { start, end: next ? starts[next.index]! : text.length, section: match.heading.text };
  }
  // No heading says it (or the Mac app is older than headings): the line that does, and on from there.
  const lines: Array<{ at: number; line: string }> = [];
  for (let at = 0; at < text.length;) {
    const stop = text.indexOf("\n", at);
    const end = stop < 0 ? text.length : stop;
    if (end > at) lines.push({ at, line: text.slice(at, end) });
    at = end + 1;
  }
  const line = bestMatch(lines, (one) => one.line, name);
  if (line) {
    return {
      start: line.at,
      end: text.length,
      section: line.line.length > 120 ? `${line.line.slice(0, 119)}…` : line.line,
      note: headings.length ? "no heading says that: from the line that does, to the end" : "conch's Mac app didn't say where headings are, so this runs from the line that says it to the end",
    };
  }
  const outline = headings.filter((heading) => heading.level <= 3).slice(0, READ_SECTIONS_SHOWN).map((heading) => heading.text);
  throw new ReadViewError(`nothing on the page is a heading or a line that says "${name}"${outline.length ? `; its sections: ${outline.join(" · ")}` : ""}`);
}

/** The elements of one view: those whose words are in [start, end), and (on a page's first view) those placed nowhere. */
function inSpan(list: Item[], at: Array<number | undefined>, start: number, end: number, unplaced: boolean): Item[] {
  return list.filter((_, index) => {
    const position = at[index];
    return position === undefined ? unplaced : position >= start && position < end;
  });
}

/** At most `max`, and how many were left out. */
function capped(list: Item[], max: number): { shown: Item[]; left: number } {
  return { shown: list.slice(0, max), left: Math.max(0, list.length - max) };
}

/** Links as a view shows them: each address compact, and a link the same as one before it (words and address) once. */
function shownLinks(list: Item[], pageUrl: string): Item[] {
  const seen = new Set<string>();
  return list.flatMap((link) => {
    const href = typeof link.href === "string" ? compactHref(link.href, pageUrl) : undefined;
    const key = `${words(link.text)}\u0000${href ?? ""}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ref: link.ref, text: words(link.text), ...(href ? { href } : {}) }];
  });
}

/**
 * How to get more, in the words of the way the agent called it: flags for the CLI, arguments for the MCP tool. Absent
 * when the view showed everything there was.
 */
export function moreHint(answer: Record<string, unknown>, style: "cli" | "tool"): string | undefined {
  const flag = (name: string, value?: string) => (style === "cli" ? `--${name}${value ? ` ${value}` : ""}` : `${name}: ${value ?? "true"}`);
  const page = isRecord(answer.page) ? answer.page : undefined;
  const hidden = isRecord(answer.hidden) ? Object.entries(answer.hidden) : [];
  const finding = answer.find !== undefined;
  const parts: string[] = [];
  if (page && typeof page.at === "number" && typeof page.of === "number" && page.at < page.of) {
    parts.push(`${flag("page", String(page.at + 1))} for page ${page.at + 1} of ${page.of}`);
  }
  if (hidden.length) {
    const left = hidden.map(([kind, count]) => `${count} more ${kind}`).join(", ");
    parts.push(finding ? `${left} say it: more words narrow it` : `${left} in this part`);
  }
  if (!parts.length) return undefined;
  if (!finding) parts.push(`${flag("find", "WORDS")}, ${flag("section", "HEADING")} or ${flag("selector", "CSS")} to narrow it`);
  parts.push(`${style === "cli" ? "--full" : "full: true"} for the whole read`);
  return parts.join("; ");
}

/** The answer with its way to more, when there is more. */
function withMore(answer: Record<string, unknown>): Record<string, unknown> {
  const more = moreHint(answer, "tool");
  return more ? { ...answer, more } : answer;
}

/**
 * A read (`readPageResult`'s, with its tab) as the view asks for it. `full` is the read as it came, the answer before
 * 2026-11-11; anything else is compact. Throws `ReadViewError` for a page past the end or a section the page lacks.
 */
export function compactRead(read: Record<string, unknown>, view: ReadView = {}): Record<string, unknown> {
  if (view.full) return read;
  const text = words(read.text);
  const url = words(read.url);
  const flat = text.replace(/\n/g, " ");
  // A button with no words, or a link with neither words nor an address, says nothing an agent could act on: 678 of
  // 9,736 elements in the reads above. `full` still lists them, and hidden fields.
  const links = items(read.links).filter((link) => words(link.text).trim() || typeof link.href === "string");
  const buttons = items(read.buttons).filter((button) => words(button.text).trim());
  // A hidden field is the page's own (a CSRF token, a form's id): nothing an agent types into. `full` lists it.
  const fields = items(read.fields).filter((field) => field.type !== "hidden");
  const headings = headingsOf(read.headings);
  const at = {
    links: placed(links, flat, (link) => words(link.text)),
    buttons: placed(buttons, flat, (button) => words(button.text)),
    fields: placed(fields, flat, (field) => words(field.label)),
  };
  const head: Record<string, unknown> = {
    ...(read.tab !== undefined ? { tab: read.tab } : {}),
    url,
    title: words(read.title),
    ...(typeof read.scope === "string" ? { scope: read.scope } : {}),
  };
  const notes: string[] = [];
  // An app from before 2026-11-11 reads the whole page whatever it is asked.
  if (view.selector && typeof read.scope !== "string") notes.push("conch's Mac app read the whole page: the one running is older than reading one part");
  const tail = (answer: Record<string, unknown>) => ({
    ...answer,
    ...(read.truncated === true ? { truncated: true } : {}),
    ...(read.popup === true ? { popup: true } : {}),
    ...(notes.length ? { note: notes.join("; ") } : {}),
  });

  if (view.find !== undefined) {
    const wanted = view.find.toLowerCase();
    const lines = text.split("\n");
    const matching = lines.flatMap((line, index) => (line.toLowerCase().includes(wanted) ? [index] : []));
    const shownLines: string[] = [];
    let previous = -2;
    for (const index of matching.slice(0, READ_FIND_LINES)) {
      if (previous >= 0 && index !== previous + 1) shownLines.push("…");
      const line = lines[index]!;
      if (line.length <= READ_FIND_LINE_CHARS) shownLines.push(line);
      else {
        const hit = line.toLowerCase().indexOf(wanted);
        const start = Math.max(0, Math.min(hit - 120, line.length - READ_FIND_LINE_CHARS));
        const piece = line.slice(start, start + READ_FIND_LINE_CHARS);
        shownLines.push(`${start > 0 ? "…" : ""}${piece}${start + READ_FIND_LINE_CHARS < line.length ? "…" : ""}`);
      }
      previous = index;
    }
    const says = (item: Item, keys: string[]) => keys.some((key) => words(item[key]).toLowerCase().includes(wanted));
    const foundLinks = capped(shownLinks(links.filter((link) => says(link, ["text", "href"])), url), READ_SHOWN.links);
    const foundButtons = capped(buttons.filter((button) => says(button, ["text"])), READ_SHOWN.buttons);
    const foundFields = capped(fields.filter((field) => says(field, ["label", "name", "type", "value"])), READ_SHOWN.fields);
    const hidden = Object.fromEntries(Object.entries({ links: foundLinks.left, buttons: foundButtons.left, fields: foundFields.left }).filter(([, left]) => left));
    if (!matching.length && !foundLinks.shown.length && !foundButtons.shown.length && !foundFields.shown.length) notes.push(`nothing on the page says "${view.find}"`);
    return withMore(tail({
      ...head,
      find: view.find,
      lines: matching.length,
      text: shownLines.join("\n"),
      links: foundLinks.shown,
      buttons: foundButtons.shown,
      fields: foundFields.shown,
      ...(matching.length > READ_FIND_LINES ? { hidden: { ...hidden, lines: matching.length - READ_FIND_LINES } } : Object.keys(hidden).length ? { hidden } : {}),
    }));
  }

  let span = { start: 0, end: text.length };
  let section: string | undefined;
  if (view.section !== undefined) {
    const found = sectionSpan(text, headings, view.section);
    span = { start: found.start, end: found.end };
    section = found.section;
    if (found.note) notes.push(found.note);
  }
  const pages = textPages(text, span.start, span.end);
  const number = view.page ?? 1;
  if (number > pages.length) {
    throw new ReadViewError(`page ${number} is past the end: ${section ? `the section "${section}"` : "this page"} has ${pages.length} page${pages.length === 1 ? "" : "s"} of words`);
  }
  const [start, end] = pages[number - 1]!;
  // Elements whose words aren't in the text (an icon's label) are the whole page's, so its first page lists them.
  const first = section === undefined && number === 1;
  const viewLinks = capped(shownLinks(inSpan(links, at.links, start, end, first), url), READ_SHOWN.links);
  const viewButtons = capped(inSpan(buttons, at.buttons, start, end, first), READ_SHOWN.buttons);
  // A form is often the reason for a read, and small (12 fields at p90): every page of the whole page lists them all.
  const viewFields = capped(section === undefined ? fields : inSpan(fields, at.fields, start, end, false), READ_SHOWN.fields);
  const hidden = Object.fromEntries(Object.entries({ links: viewLinks.left, buttons: viewButtons.left, fields: viewFields.left }).filter(([, left]) => left));
  const outline = first ? headings.filter((heading) => heading.level <= 3).map((heading) => heading.text) : [];
  return withMore(tail({
    ...head,
    ...(section !== undefined ? { section } : {}),
    text: text.slice(start, end).trim(),
    ...(pages.length > 1 ? { page: { at: number, of: pages.length } } : {}),
    ...(outline.length > 1 ? { sections: outline.slice(0, READ_SECTIONS_SHOWN) } : {}),
    links: viewLinks.shown,
    buttons: viewButtons.shown,
    fields: viewFields.shown,
    ...(Object.keys(hidden).length ? { hidden } : {}),
  }));
}
