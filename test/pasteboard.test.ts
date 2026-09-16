import { describe, expect, test } from "bun:test";
import { createPasteboard, type PasteboardLease, type runUICommand } from "../src/pasteboard.ts";

// Execute the shipped JXA program against an in-memory AppKit boundary. No
// osascript process, native clipboard, or real binary data is accessed.
function appKit(initial: PasteboardLease["items"]) {
  let items = structuredClone(initial);
  let count = 0;
  const wrap = (js: string) => ({ js });
  const array = (values: any[]) => ({ count: values.length, objectAtIndex: (i: number) => values[i] });
  // isNil(), because an ObjC nil is truthy across the JXA bridge and `!data` never caught one.
  const data = (encoded: string) => ({ length: Buffer.from(encoded, "base64").length, isNil: () => false, base64EncodedStringWithOptions: () => wrap(encoded) });
  const item = (saved: Record<string, string> = {}) => ({
    saved: { ...saved },
    get types() { return array(Object.keys(this.saved).map(wrap)); },
    dataForType(type: { js: string }) { return data(this.saved[type.js]!); },
    setDataForType(value: ReturnType<typeof data>, type: { js: string }) { this.saved[type.js] = value.base64EncodedStringWithOptions().js; return true; },
    setStringForType(value: { js: string }, type: { js: string }) { this.saved[type.js] = Buffer.from(value.js).toString("base64"); return true; },
  });
  const board = {
    get changeCount() { return count; },
    get pasteboardItems() { return array(items.map(item)); },
    get clearContents() { items = []; return ++count; },
    writeObjects(objects: { values?: any[]; count: number; objectAtIndex?: (i: number) => any }) {
      items = objects.values?.map((value) => ({ ...value.saved }))
        ?? Array.from({ length: objects.count }, (_, i) => ({ ...objects.objectAtIndex!(i).saved }));
      return true;
    },
  };
  const run: typeof runUICommand = async (args, input) => {
    const bridge = Object.assign(wrap, {
      NSFileHandle: { fileHandleWithStandardInput: { readDataToEndOfFile: input } },
      NSString: { alloc: { initWithDataEncoding: (value: string) => wrap(value) } },
      NSPasteboard: { generalPasteboard: board },
      NSPasteboardTypeString: wrap("public.utf8-plain-text"),
      NSPasteboardItem: { alloc: { get init() { return item(); } } },
      NSData: { alloc: { initWithBase64EncodedStringOptions: (value: { js: string }) => data(value.js) } },
      NSArray: { arrayWithObject: (value: any) => array([value]) },
      NSMutableArray: { alloc: { get init() { return { values: [] as any[], get count() { return this.values.length; }, addObject(value: any) { this.values.push(value); } }; } } },
      NSUTF8StringEncoding: 4,
    });
    const execute = new Function("$", "ObjC", "args", `${args[4]}; return run(args);`);
    return { text: execute(bridge, { import() {} }, [args.at(-1)]), stderr: "", timedOut: false, exitCode: 0 };
  };
  return {
    pasteboard: createPasteboard(run), items: () => items,
    copy: (next: PasteboardLease["items"]) => { items = structuredClone(next); count++; },
  };
}

describe("native pasteboard transaction program", () => {
  const cases: PasteboardLease["items"][] = [[], [{ "public.png": "AAEC/w==", "public.rtf": "e1xydGYxfQ==" }, { "public.file-url": "ZmlsZTovLy90ZXN0" }]];
  for (const original of cases) {
    test(`preserves ${original.length} items and every binary representation`, async () => {
      const kit = appKit(original);
      const lease = await kit.pasteboard.prepare("requested text");
      expect(lease.items).toEqual(original);
      expect(kit.items()).toEqual([{ "public.utf8-plain-text": Buffer.from("requested text").toString("base64") }]);
      expect(await kit.pasteboard.restore(lease)).toBe(true);
      expect(kit.items()).toEqual(original);
    });
  }

  test("compare-and-restore refuses to overwrite a later user copy", async () => {
    const kit = appKit([{ "public.png": "AAEC" }]);
    const lease = await kit.pasteboard.prepare("requested text");
    const copied = [{ "public.png": "AwQF" }];
    kit.copy(copied);
    expect(await kit.pasteboard.restore(lease)).toBe(false);
    expect(kit.items()).toEqual(copied);
  });

  test("helper errors are refused instead of being parsed as successful snapshots", async () => {
    const pasteboard = createPasteboard(async () => ({ text: "{}", stderr: "", timedOut: false, exitCode: 1 }));
    await expect(pasteboard.prepare("requested text")).rejects.toThrow("Pasteboard helper failed");
  });
});
