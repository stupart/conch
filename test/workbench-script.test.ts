import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readPageResult } from "../src/browser-workbench.ts";

/**
 * The script the Mac app runs in a Workbench page (ConchDesign `WorkbenchScript.page`), read out of its Swift file and run
 * here against a page of fake elements: what the app injects is exactly what this holds to the rules about secrets.
 * A password's, a hidden field's or a one-time code's value is never read, and an agent never types into a password
 * field, however it names the field.
 */

const swift = readFileSync(join(import.meta.dir, "..", "design/ConchDesign/Sources/ConchDesign/WorkbenchScript.swift"), "utf8");

/** The raw string literal's lines, its four spaces of indentation taken off as Swift takes them. */
function scriptSource(): string {
  const open = "public static let page = #\"\"\"\n";
  const start = swift.indexOf(open);
  const end = swift.indexOf('\n    """#', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return swift.slice(start + open.length, end).split("\n").map((line) => line.replace(/^ {4}/, "")).join("\n");
}

const PASSWORD_REFUSAL = "agents don't type passwords; sign in yourself in the tab";

// ---- A page, small enough to read: elements with the parts of the DOM the script touches. ----

class FakeEvent {
  type: string;
  init: Record<string, unknown>;
  defaultPrevented = false;
  constructor(type: string, init: Record<string, unknown> = {}) {
    this.type = type;
    this.init = init;
  }
  preventDefault() { this.defaultPrevented = true; }
}

interface Simple { tag?: string; id?: string; classes: string[]; attrs: Array<[string, string | undefined]> }

function parseSimple(selector: string): Simple | null {
  const simple: Simple = { classes: [], attrs: [] };
  let rest = selector.trim();
  const tag = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(rest);
  if (tag) { simple.tag = tag[0].toLowerCase(); rest = rest.slice(tag[0].length); }
  while (rest) {
    let match: RegExpExecArray | null;
    if ((match = /^#([\w-]+)/.exec(rest))) simple.id = match[1];
    else if ((match = /^\.([\w-]+)/.exec(rest))) simple.classes.push(match[1]!);
    else if ((match = /^\[([\w-]+)(?:="([^"]*)")?\]/.exec(rest))) simple.attrs.push([match[1]!, match[2]]);
    else return null;
    rest = rest.slice(match[0].length);
  }
  return simple;
}

class FakeElement {
  tagName: string;
  attributes = new Map<string, string>();
  children: FakeElement[] = [];
  parent?: FakeElement;
  own = "";
  #value = "";
  valueSets = 0;
  checked = false;
  disabled = false;
  readOnly = false;
  display = "block";
  visibility = "visible";
  size = { width: 120, height: 24 };
  isConnected = true;
  isContentEditable = false;
  events: string[] = [];
  clicks = 0;
  focused = false;
  labels: FakeElement[] = [];
  control?: FakeElement;
  form?: { requestSubmit(): void; submitted: number };

  constructor(tagName: string, attributes: Record<string, string> = {}, own = "") {
    this.tagName = tagName.toUpperCase();
    for (const [name, value] of Object.entries(attributes)) this.attributes.set(name, value);
    this.own = own;
    if (attributes.value !== undefined) this.#value = attributes.value;
  }

  get value(): string { return this.#value; }
  set value(next: string) { this.#value = next; this.valueSets += 1; }

  append(...children: FakeElement[]): this {
    for (const child of children) { child.parent = this; this.children.push(child); }
    return this;
  }

  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  get id(): string { return this.attributes.get("id") ?? ""; }
  get href(): string {
    const href = this.attributes.get("href") ?? "";
    try { return new URL(href, "https://acme.dev/").href; } catch { return href; }
  }
  get innerText(): string {
    if (this.display === "none") return "";
    return [this.own, ...this.children.map((child) => child.innerText)].filter(Boolean).join(this.tagName === "BODY" ? "\n" : " ");
  }
  get textContent(): string { return [this.own, ...this.children.map((child) => child.textContent)].join(""); }
  getBoundingClientRect() {
    return { left: 10, top: 10, width: this.size.width, height: this.size.height };
  }
  descendants(): FakeElement[] { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  matchesSimple(simple: Simple): boolean {
    if (simple.tag && this.tagName.toLowerCase() !== simple.tag) return false;
    if (simple.id && this.id !== simple.id) return false;
    const classes = (this.attributes.get("class") ?? "").split(/\s+/);
    if (simple.classes.some((name) => !classes.includes(name))) return false;
    return simple.attrs.every(([name, value]) => this.attributes.has(name) && (value === undefined || this.attributes.get(name) === value));
  }
  matches(selector: string): boolean {
    return selector.split(",").some((part) => {
      const simple = parseSimple(part);
      if (!simple) throw new SyntaxError(`invalid selector ${selector}`);
      return this.matchesSimple(simple);
    });
  }
  querySelectorAll(selector: string): FakeElement[] {
    for (const part of selector.split(",")) if (!parseSimple(part)) throw new SyntaxError(`'${selector}' is not a valid selector`);
    return this.descendants().filter((element) => element.matches(selector));
  }
  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null; }
  dispatchEvent(event: FakeEvent): boolean { this.events.push(event.type); return !event.defaultPrevented; }
  click() { this.clicks += 1; this.events.push("click"); }
  focus() { this.focused = true; }
  scrollIntoView() {}
}

/** Fields named by a <label for>: the label's words are theirs. */
function label(text: string, field: FakeElement): FakeElement {
  const element = new FakeElement("label", {}, text);
  element.control = field;
  field.labels.push(element);
  return element;
}

function page() {
  const form = { submitted: 0, requestSubmit() { this.submitted += 1; } };
  const email = new FakeElement("input", { type: "email", name: "email", id: "email", value: "tyler@example.com" });
  const password = new FakeElement("input", { type: "password", name: "password", id: "password", value: "hunter2-SECRET" });
  const shown = new FakeElement("input", { type: "text", name: "pw-visible", autocomplete: "current-password", value: "shown-SECRET" });
  const hidden = new FakeElement("input", { type: "hidden", name: "csrf", value: "csrf-TOKEN-123" });
  const code = new FakeElement("input", { type: "text", name: "otp", autocomplete: "one-time-code", value: "424242" });
  const notes = new FakeElement("textarea", { name: "notes", "aria-label": "Notes", value: "Ship it" });
  for (const field of [email, password, shown, code, notes]) field.form = form;
  hidden.size = { width: 0, height: 0 };
  hidden.display = "none";
  const passwordBox = new FakeElement("div", { class: "password-box" }).append(label("Password", password), password);
  const signIn = new FakeElement("button", { type: "submit" }, "Sign in");
  const docs = new FakeElement("a", { href: "/docs" }, "Docs");
  const external = new FakeElement("a", { href: "https://github.com/acme" }, "GitHub");
  const script = new FakeElement("a", { href: "javascript:void(0)" }, "Menu");
  const offscreen = new FakeElement("a", { href: "/hidden" }, "Hidden link");
  offscreen.display = "none";
  const body = new FakeElement("body", {}, "Welcome back").append(
    new FakeElement("h1", {}, "Sign in to Acme"),
    label("Email", email), email,
    passwordBox,
    shown, hidden, code, notes,
    signIn, docs, external, script, offscreen,
  );
  const document = {
    title: "Sign in · Acme",
    body,
    documentElement: body,
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    querySelector: (selector: string) => body.querySelector(selector),
    getElementById: (id: string) => body.descendants().find((element) => element.id === id) ?? null,
  };
  const window: Record<string, unknown> = {
    location: { href: "https://acme.dev/login" },
    getComputedStyle: (element: FakeElement) => ({ display: element.display, visibility: element.visibility }),
    Event: FakeEvent,
    MouseEvent: FakeEvent,
    KeyboardEvent: FakeEvent,
    PointerEvent: FakeEvent,
    HTMLInputElement: FakeElement,
    HTMLTextAreaElement: FakeElement,
  };
  return { window, document, form, email, password, shown, hidden, code, notes, passwordBox, signIn, docs, external, body };
}

type Page = ReturnType<typeof page>;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<any>;
const script = new AsyncFunction("op", "how", "what", "text", "submit", "window", "document", scriptSource());
const run = (p: Page, op: string, args: { how?: string; what?: string; text?: string; submit?: boolean } = {}) =>
  script(op, args.how ?? "", args.what ?? "", args.text ?? "", args.submit ?? false, p.window, p.document);

const SECRETS = ["hunter2-SECRET", "shown-SECRET", "csrf-TOKEN-123", "424242"];

describe("the Workbench's page script", () => {
  test("the Swift file's constants are the script's own", () => {
    expect(swift).toContain(`public static let passwordRefusal = "${PASSWORD_REFUSAL}"`);
    expect(scriptSource()).toContain(`const PASSWORD_REFUSAL = "${PASSWORD_REFUSAL}";`);
    expect(swift).toContain('public static let contentWorld = "conch-workbench"');
  });

  test("read lists the page's words, links, buttons and fields with refs, and never a secret's value", async () => {
    const p = page();
    const read = await run(p, "read");
    const wire = JSON.stringify(read);
    for (const secret of SECRETS) expect(wire).not.toContain(secret);
    expect(read.text).toContain("Sign in to Acme");
    expect(read.links.map((link: any) => link.text)).toEqual(["Docs", "GitHub", "Menu"]);
    expect(read.links[0]).toEqual({ ref: "e1", text: "Docs", href: "https://acme.dev/docs" });
    // A script link is listed, with no address to follow.
    expect(read.links[2].href).toBeUndefined();
    expect(read.buttons).toEqual([{ ref: "e4", text: "Sign in" }]);
    const byName = Object.fromEntries(read.fields.map((field: any) => [field.name, field]));
    expect(byName.email).toMatchObject({ type: "email", label: "Email", value: "tyler@example.com" });
    expect(byName.notes).toMatchObject({ type: "textarea", label: "Notes", value: "Ship it" });
    for (const name of ["password", "pw-visible", "csrf", "otp"]) {
      expect(byName[name], name).toBeDefined();
      expect(Object.hasOwn(byName[name], "value"), name).toBe(false);
      expect(byName[name].secret, name).toBe(true);
    }
    expect(byName.password).toMatchObject({ type: "password", label: "Password" });
    expect(byName.csrf.type).toBe("hidden");
    // Reading changes nothing on the page.
    for (const field of [p.email, p.password, p.notes]) expect(field.valueSets).toBe(0);
  });

  test("the daemon reads the answer field by field, and drops a secret's value whatever the app sent", async () => {
    const read = await run(page(), "read");
    const passed = readPageResult({ ...read, url: "https://acme.dev/login", title: "Sign in · Acme" });
    for (const secret of SECRETS) expect(JSON.stringify(passed)).not.toContain(secret);
    expect(passed.fields).toContainEqual({ ref: expect.any(String), type: "email", label: "Email", name: "email", value: "tyler@example.com" });
    // An app that sent one anyway, and anything else it sent: none of it gets through.
    const forged = readPageResult({
      url: "https://acme.dev/login",
      title: "x",
      text: "",
      links: [],
      buttons: [],
      fields: [
        { ref: "e1", type: "password", name: "password", value: "hunter2-SECRET" },
        { ref: "e2", type: "HIDDEN", name: "csrf", value: "csrf-TOKEN-123" },
        { ref: "e3", type: "text", name: "otp", value: "424242", secret: true },
      ],
      cookies: "session=abc123",
      localStorage: { token: "xyz" },
    });
    expect(JSON.stringify(forged)).not.toMatch(/hunter2|csrf-TOKEN|424242|session=abc123|xyz/);
    expect(Object.keys(forged).sort()).toEqual(["buttons", "fields", "links", "text", "title", "url"]);
  });

  test("type refuses a password field however it is named, and leaves it as it was", async () => {
    const p = page();
    const read = await run(p, "read");
    const passwordRef = read.fields.find((field: any) => field.name === "password").ref;
    const shownRef = read.fields.find((field: any) => field.name === "pw-visible").ref;
    const attempts = [
      { how: "ref", what: passwordRef },
      { how: "auto", what: passwordRef },
      { how: "selector", what: "#password" },
      { how: "selector", what: 'input[type="password"]' },
      { how: "text", what: "Password" },
      { how: "auto", what: "Password" },
      // The box round it: the field inside is the one that would be typed into.
      { how: "selector", what: ".password-box" },
      // A password shown as text by its eye toggle is still a password, by what the page says it is for.
      { how: "ref", what: shownRef },
      { how: "selector", what: 'input[name="pw-visible"]' },
    ];
    for (const attempt of attempts) {
      expect(await run(p, "type", { ...attempt, text: "hunter2-SECRET", submit: true }), JSON.stringify(attempt))
        .toEqual({ error: PASSWORD_REFUSAL });
    }
    expect(p.password.value).toBe("hunter2-SECRET");
    expect(p.password.valueSets).toBe(0);
    expect(p.password.events).toEqual([]);
    expect(p.shown.valueSets).toBe(0);
    expect(p.form.submitted).toBe(0);
  });

  test("type sets a field through its own setter, says so as typing, and submits its form on Return", async () => {
    const p = page();
    expect(await run(p, "type", { how: "auto", what: "Email", text: "agent@example.com" })).toEqual({ typed: 'field "Email"' });
    expect(p.email.value).toBe("agent@example.com");
    expect(p.email.valueSets).toBe(1);
    expect(p.email.events).toEqual(["input", "change"]);
    expect(p.email.focused).toBe(true);
    expect(p.form.submitted).toBe(0);
    expect(await run(p, "type", { how: "selector", what: "#email", text: "again@example.com", submit: true })).toEqual({ typed: 'field "Email"', submitted: true });
    expect(p.email.events.slice(2)).toEqual(["input", "change", "keydown", "keypress", "keyup"]);
    expect(p.form.submitted).toBe(1);
    // Not a field: said, and nothing typed.
    expect((await run(p, "type", { how: "selector", what: "h1", text: "x" })).error).toBe('h1 "Sign in to Acme" isn\'t a field you can type in');
  });

  test("click finds its element by ref, selector or words, and clicks it as a pointer would", async () => {
    const p = page();
    const read = await run(p, "read");
    expect(await run(p, "click", { how: "ref", what: read.buttons[0].ref })).toEqual({ clicked: 'button "Sign in"' });
    expect(p.signIn.events).toEqual(["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
    expect(await run(p, "click", { how: "auto", what: "docs" })).toEqual({ clicked: 'link "Docs"' });
    expect(p.docs.clicks).toBe(1);
    expect(await run(p, "click", { how: "auto", what: 'a[href="https://github.com/acme"]' })).toEqual({ clicked: 'link "GitHub"' });
    expect(p.external.clicks).toBe(1);
    expect(await run(p, "click", { how: "text", what: "Sign" })).toEqual({ clicked: 'button "Sign in"' });
  });

  test("a ref is the last read's: unknown or gone from the page, the agent is told to read again", async () => {
    const p = page();
    expect((await run(p, "click", { how: "ref", what: "e1" })).error).toContain("read it again (browser_read)");
    const read = await run(p, "read");
    p.docs.isConnected = false;
    expect((await run(p, "click", { how: "ref", what: read.links[0].ref })).error).toContain("is gone from the page");
    expect((await run(p, "click", { how: "selector", what: "#nothing" })).error).toBe('nothing on the page matches "#nothing"');
    expect((await run(p, "click", { how: "selector", what: "a[[" })).error).toBe('"a[[" isn\'t a valid CSS selector');
    expect((await run(p, "click", { how: "auto", what: "Checkout now" })).error).toContain("not a ref from browser_read");
  });

  /** 2026-10-16: the user watches an agent work, so the app marks what it is about to click or type into. */
  test("locate answers only where a click or a type will land, and refuses a password field before anything is marked", async () => {
    const p = page();
    expect(await run(p, "locate", { how: "auto", what: "Sign in" })).toEqual({ box: [10, 10, 120, 24] });
    expect(await run(p, "locate-field", { how: "auto", what: "Email" })).toEqual({ box: [10, 10, 120, 24] });
    // A label's box is its field's: what will be typed into is what is marked.
    p.email.size = { width: 300, height: 32 };
    expect(await run(p, "locate-field", { how: "text", what: "Email" })).toEqual({ box: [10, 10, 300, 32] });
    for (const what of ["Password", ".password-box", "#password"]) {
      expect(await run(p, "locate-field", { how: "auto", what }), what).toEqual({ error: PASSWORD_REFUSAL });
    }
    expect((await run(p, "locate", { how: "selector", what: "#nothing" })).error).toBe('nothing on the page matches "#nothing"');
    // Nothing was clicked, typed or read out on the way.
    expect(p.signIn.clicks).toBe(0);
    for (const field of [p.email, p.password]) expect(field.valueSets).toBe(0);
    const wire = JSON.stringify(await run(p, "locate-field", { how: "auto", what: "Email" }));
    expect(wire).not.toContain("tyler@example.com");
  });

  test("type fills its field in steps the user can watch, each heard as typing, and answers no value", async () => {
    const p = page();
    const timers: number[] = [];
    p.window.setTimeout = (resolve: () => void, ms: number) => { timers.push(ms); resolve(); };
    // What the field holds each time the page hears typing.
    const seen: string[] = [];
    const dispatch = p.email.dispatchEvent.bind(p.email);
    p.email.dispatchEvent = (event: FakeEvent) => {
      if (event.type === "input") seen.push(p.email.value);
      return dispatch(event);
    };
    const typed = "agent-at-work@example.com";
    expect(await run(p, "type", { how: "auto", what: "Email", text: typed })).toEqual({ typed: 'field "Email"' });
    expect(p.email.valueSets).toBe(12);
    expect(seen).toHaveLength(12);
    expect(seen.at(-1)).toBe(typed);
    for (const [index, value] of seen.entries()) {
      expect(typed.startsWith(value), value).toBe(true);
      if (index) expect(value.length).toBeGreaterThan(seen[index - 1]!.length);
    }
    expect(timers).toEqual(Array(11).fill(28));
    expect(p.email.events).toEqual([...Array(11).fill("input"), "input", "change"]);
    // A short word fills a character at a time; the swift constants are the script's own.
    seen.length = 0;
    await run(p, "type", { how: "auto", what: "Email", text: "hey" });
    expect(seen).toEqual(["h", "he", "hey"]);
    expect(swift).toContain("public static let fillSteps = 12");
    expect(swift).toContain("public static let fillStepMs = 28");
    expect(scriptSource()).toContain("const FILL = { steps: 12, ms: 28 };");
  });

  test("a long page comes back cut to fit one answer, and says so", async () => {
    const p = page();
    p.body.own = "word ".repeat(40_000);
    for (let i = 0; i < 400; i += 1) p.body.append(new FakeElement("a", { href: `/page/${i}/${"x".repeat(200)}` }, `Link number ${i} `.repeat(6)));
    const read = await run(p, "read");
    expect(read.truncated).toBe(true);
    expect(read.text.length).toBeLessThanOrEqual(12_000);
    expect(read.links.length).toBeLessThanOrEqual(150);
    expect(new TextEncoder().encode(JSON.stringify(read)).length).toBeLessThanOrEqual(45_000);
  });
});
