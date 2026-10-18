import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

/**
 * The passkey watcher the Mac app puts in every Workbench page (ConchDesign `WorkbenchPasskeys`), read out of its Swift
 * file and run in a realm of its own against a pretend `navigator.credentials`: a passkey asked for is said, by an event
 * whose name is the page's own, and the page gets exactly what it would have got; the wrappers pass for the originals.
 * WorkbenchPasskeysTests runs the same script in real WebKit.
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

const EVENT = "conch-pk-0123456789abcdef0123456789abcdef";

/** A realm with a pretend `navigator.credentials`, the page script run in it, and the events it dispatched. */
function page() {
  const context = createContext({});
  runInContext(`
    globalThis.heard = [];
    class Event { constructor(type) { this.type = type; } }
    class EventTarget { dispatchEvent(event) { heard.push(event.type); return true; } }
    class Document extends EventTarget {}
    class CredentialsContainer {
      get(options) { return options && options.fail ? Promise.reject(new TypeError("no")) : Promise.resolve({ asked: options }); }
      create(options) { return Promise.reject(Object.assign(new Error("not allowed"), { name: "NotAllowedError" })); }
    }
    globalThis.Event = Event;
    globalThis.EventTarget = EventTarget;
    globalThis.CredentialsContainer = CredentialsContainer;
    globalThis.window = globalThis;
    globalThis.document = new Document();
    globalThis.navigator = { credentials: new CredentialsContainer() };
    globalThis.originals = { get: CredentialsContainer.prototype.get, create: CredentialsContainer.prototype.create, toString: Function.prototype.toString };
    globalThis.sources = { get: Function.prototype.toString.call(originals.get), toString: Function.prototype.toString.call(originals.toString) };
  `, context);
  runInContext(literal("page").replace("__CONCH_EVENT__", EVENT), context);
  return { run: (source: string) => runInContext(source, context), heard: () => runInContext("heard.slice()", context) as string[] };
}

describe("the passkey watcher", () => {
  test("a passkey asked for is said by the page's own event, then the original answers, exactly", async () => {
    const p = page();
    const options = await p.run("navigator.credentials.get({ publicKey: { challenge: 1 } })");
    expect(options).toEqual({ asked: { publicKey: { challenge: 1 } } });
    await expect(p.run("navigator.credentials.create({ publicKey: {} })")).rejects.toMatchObject({ name: "NotAllowedError" });
    await expect(p.run("navigator.credentials.get({ publicKey: {}, fail: true })")).rejects.toMatchObject({ message: "no" });
    expect(p.heard()).toEqual([`${EVENT}-get`, `${EVENT}-create`, `${EVENT}-get`]);
  });

  test("the quiet autofill offer, a password, nothing at all, or options whose getter throws: not said, and passed on", async () => {
    const p = page();
    await p.run("navigator.credentials.get({ publicKey: {}, mediation: 'conditional' })");
    await p.run("navigator.credentials.get({ password: true })");
    await p.run("navigator.credentials.get()");
    await p.run("navigator.credentials.get(Object.defineProperty({}, 'publicKey', { get() { throw new Error('page') } }))");
    expect(p.heard()).toEqual([]);
  });

  test("the wrappers pass for the originals: source, name, length, the property's attributes, and toString's own", () => {
    const p = page();
    expect(p.run("Function.prototype.toString.call(CredentialsContainer.prototype.get) === sources.get")).toBe(true);
    expect(p.run("String(navigator.credentials.get) === sources.get")).toBe(true);
    expect(p.run("Function.prototype.toString.call(Function.prototype.toString) === sources.toString")).toBe(true);
    expect(p.run("Function.prototype.toString.toString() === sources.toString")).toBe(true);
    expect(p.run("[CredentialsContainer.prototype.get.name, CredentialsContainer.prototype.get.length, CredentialsContainer.prototype.create.name]")).toEqual(["get", 1, "create"]);
    expect(p.run("JSON.stringify(Object.getOwnPropertyDescriptor(CredentialsContainer.prototype, 'get'), ['writable', 'enumerable', 'configurable'])"))
      .toBe(JSON.stringify({ writable: true, enumerable: false, configurable: true }));
    expect(p.run("Object.getOwnPropertyDescriptor(Function.prototype, 'toString').enumerable")).toBe(false);
    // Not the same function, which nothing a page does can tell but identity with a reference it kept from before.
    expect(p.run("CredentialsContainer.prototype.get !== originals.get")).toBe(true);
    // Nothing new on the page's window.
    expect(p.run("Object.getOwnPropertyNames(globalThis).filter((key) => /conch|webkit/i.test(key))")).toEqual([]);
  });

  test("a page without navigator.credentials is left alone", () => {
    const context = createContext({ window: {} });
    runInContext("window.window = window; globalThis.before = Function.prototype.toString;", context);
    runInContext(literal("page").replace("__CONCH_EVENT__", EVENT), context);
    expect(runInContext("Function.prototype.toString === before", context)).toBe(true);
  });

  test("conch's half posts only the op, to its own handler, on the page's own event", () => {
    const posted: unknown[] = [];
    const listeners = new Map<string, () => void>();
    const context = createContext({
      window: { webkit: { messageHandlers: { conchPasskeys: { postMessage: (value: unknown) => posted.push(value) } } } },
      document: { addEventListener: (type: string, listener: () => void) => listeners.set(type, listener) },
    });
    runInContext(literal("listener").replace("__CONCH_EVENT__", EVENT).replace("__CONCH_HANDLER__", "conchPasskeys"), context);
    expect([...listeners.keys()]).toEqual([`${EVENT}-get`, `${EVENT}-create`]);
    listeners.get(`${EVENT}-create`)!();
    listeners.get(`${EVENT}-get`)!();
    expect(posted).toEqual(["create", "get"]);
  });
});
