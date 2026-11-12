import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

/**
 * The passkey watcher the Mac app puts in every Workbench page, in conch's own world (ConchDesign `WorkbenchPasskeys`),
 * read out of its Swift file and run in a realm of its own against a pretend page: a page that shows a way to use a
 * passkey or a security key is said once, one that only mentions them isn't, and Tyler pressing one is said at once. It
 * touches nothing of the page's: it never names `navigator.credentials` or `Function.prototype`, which the old watcher
 * wrapped in the page's own world and CreepJS read as a stealth plugin (2026-11-11). WorkbenchPasskeysTests runs the same
 * script in real WebKit.
 */

const swift = readFileSync(join(import.meta.dir, "..", "design/ConchDesign/Sources/ConchDesign/WorkbenchPasskeys.swift"), "utf8");

function literal(name: string): string {
  const open = `static let ${name} = #"""\n`;
  const start = swift.indexOf(open);
  const end = swift.indexOf('\n    """#', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return swift.slice(start + open.length, end).split("\n").map((line) => line.replace(/^ {4}/, "")).join("\n");
}

const words = /public static let words = #"(.*)"#/.exec(swift)?.[1] ?? "";
const source = literal("source").replace("__CONCH_HANDLER__", "conchPasskeys").replace("__CONCH_WORDS__", words);

class El {
  tagName: string;
  textContent: string;
  attrs: Record<string, string>;
  width: number;
  parent?: El;
  constructor(tag: string, text = "", attrs: Record<string, string> = {}, width = 120) {
    this.tagName = tag.toUpperCase();
    this.textContent = text;
    this.attrs = attrs;
    this.width = width;
  }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  getBoundingClientRect() { return { width: this.width, height: this.width ? 20 : 0 }; }
  matches(selector: string) {
    return selector.split(",").map((part) => part.trim()).some((part) => {
      const role = /^\[role="(\w+)"\]$/.exec(part);
      return role ? this.attrs.role === role[1] : part === this.tagName.toLowerCase();
    });
  }
  closest(selector: string): El | null { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null; }
}

/** A realm with a pretend page, the watcher run in it, and what it posted. */
function page(elements: El[]) {
  const posted: string[] = [];
  const timers: Array<() => void> = [];
  const listeners: Record<string, Array<(event: unknown) => void>> = {};
  const observers: Array<() => void> = [];
  const document = {
    body: {},
    all: elements,
    querySelectorAll: (selector: string) => document.all.filter((element) => element.matches(selector)),
    addEventListener: (type: string, listener: () => void) => { (listeners[`doc:${type}`] ??= []).push(listener); },
  };
  const window = {
    webkit: { messageHandlers: { conchPasskeys: { postMessage: (what: string) => posted.push(what) } } },
    setTimeout: (run: () => void) => { timers.push(run); return timers.length; },
    addEventListener: (type: string, listener: (event: unknown) => void) => { (listeners[type] ??= []).push(listener); },
    MutationObserver: class { constructor(run: () => void) { observers.push(run); } observe() {} },
  };
  const context = createContext({ window, document });
  runInContext(source, context);
  return {
    posted,
    document,
    loaded: () => { for (const listener of listeners["doc:DOMContentLoaded"] ?? []) listener({}); },
    changed: () => { for (const run of observers) run(); },
    tick: () => { while (timers.length) timers.shift()!(); },
    click: (target: El, isTrusted = true) => { for (const listener of listeners.click ?? []) listener({ isTrusted, target }); },
  };
}

describe("the passkey watcher", () => {
  test("a page that shows a way in with a passkey or a security key is said once", () => {
    for (const element of [
      new El("button", "Sign in with a passkey"),
      new El("a", "Use a security key"),
      new El("h1", "Use your passkey to confirm it's really you"),
      new El("div", "", { role: "button", "aria-label": "Sign in with Passkey" }),
    ]) {
      const p = page([new El("h1", "Sign in"), element]);
      p.loaded();
      p.tick();
      p.changed();
      p.tick();
      expect(p.posted, element.textContent || element.attrs["aria-label"]).toEqual(["offer"]);
    }
  });

  test("words in a paragraph, a passkey button not shown, or nothing: not said", () => {
    const p = page([new El("p", "Read our guide to passkeys"), new El("button", "Use a passkey", {}, 0), new El("button", "Continue")]);
    p.loaded();
    p.tick();
    expect(p.posted).toEqual([]);
  });

  test("a sign-in's later step is heard when it comes, a second after the page changes, never more often", () => {
    const p = page([new El("button", "Next")]);
    p.loaded();
    p.tick();
    expect(p.posted).toEqual([]);
    p.document.all.push(new El("h2", "Use your passkey"));
    p.changed();
    p.changed();
    p.changed();
    p.tick();
    expect(p.posted).toEqual(["offer"]);
  });

  test("Tyler pressing one is said at once; the page's own click isn't his", () => {
    const button = new El("button", "Sign in with a passkey");
    const inner = new El("span", "");
    inner.parent = button;
    const p = page([button]);
    p.click(inner);
    p.click(button, false);
    p.click(new El("button", "Continue"));
    expect(p.posted).toEqual(["pressed"]);
  });

  test("it touches nothing of the page's", () => {
    for (const wrapped of ["navigator", "credentials", "Function.prototype", "toString", "defineProperty", "Proxy"]) {
      expect(source, wrapped).not.toContain(wrapped);
    }
    expect(swift).toContain('public static let entitlement = "com.apple.developer.web-browser.public-key-credential"');
  });
});
