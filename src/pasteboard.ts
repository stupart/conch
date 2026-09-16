/** Each item's advertised pasteboard types and their complete base64 data. */
export interface PasteboardLease {
  changeCount: number;
  items: Array<Record<string, string>>;
}

export interface Pasteboard {
  prepare(text: string): Promise<PasteboardLease>;
  restore(lease: PasteboardLease): Promise<boolean>;
}

export interface UICommandResult {
  text: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

interface UIChild {
  stdout: ReadableStream;
  stderr: ReadableStream;
  exited: Promise<number>;
  kill(signal: "SIGKILL"): void;
}

export interface UICommandScope { unreaped: Set<Promise<number>> }
const nativeUIScope: UICommandScope = { unreaped: new Set() };
export const hasUnreapedUIChild = (): boolean => nativeUIScope.unreaped.size > 0;

/** One bounded child, including its exit status. Only this owned child is killed. */
export async function runUICommand(
  args: string[],
  input?: string,
  options: {
    spawn?: (args: string[], input?: string) => UIChild;
    timeoutMs?: number;
    reapTimeoutMs?: number;
    scope?: UICommandScope;
  } = {},
): Promise<UICommandResult> {
  const scope = options.scope ?? nativeUIScope;
  if (scope.unreaped.size) return { text: "", stderr: "Previous UI child has not exited", exitCode: -1, timedOut: true };
  const child = (options.spawn ?? ((argv, stdin) => Bun.spawn(argv, {
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe",
  })))(args, input);
  let exited = false;
  const childExit = child.exited.then((code) => { exited = true; return code; });
  const reap = async (): Promise<void> => {
    if (exited) return;
    scope.unreaped.add(childExit);
    // A rejected exit observation is unknown, so it keeps the scope sealed.
    void childExit.then(() => scope.unreaped.delete(childExit), () => {});
    try { child.kill("SIGKILL"); } catch { /* natural-exit race; still wait for observation */ }
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        childExit.catch(() => {}),
        new Promise<void>((resolve) => { drainTimer = setTimeout(resolve, options.reapTimeoutMs ?? 250); }),
      ]);
    } finally {
      clearTimeout(drainTimer);
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), childExit,
    ]).then(([text, stderr, exitCode]) => ({ text, stderr, exitCode, timedOut: false }));
    const timeout = new Promise<UICommandResult>((resolve) => {
      timer = setTimeout(() => resolve({ text: "", stderr: "", exitCode: -1, timedOut: true }), options.timeoutMs ?? 4_000);
    });
    const result = await Promise.race([read, timeout]);
    if (result.timedOut) await reap();
    return result;
  } catch (error) {
    await reap();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// AppKit preserves binary and multiple-item pasteboards that pbpaste cannot.
// Input travels through stdin, not process arguments. Refuse promised/unreadable
// or oversized data before changing the board. Each changeCount check happens
// in the same synchronous helper invocation as the corresponding write.
const PASTEBOARD_SCRIPT = `
ObjC.import('AppKit');
function run(argv) {
  var raw = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  var input = JSON.parse($.NSString.alloc.initWithDataEncoding(raw, $.NSUTF8StringEncoding).js);
  // Every count, length and changeCount below crosses the ObjC bridge as a STRING.
  // Number() at each read: '+' on a raw one CONCATENATES ("0" + "3883" + "35" + "24"
  // read as 38 million bytes and refused every ordinary clipboard), and "0" is truthy.
  // A named board is a private one, so tests never touch the general pasteboard.
  var board = input.board ? $.NSPasteboard.pasteboardWithName($(input.board)) : $.NSPasteboard.generalPasteboard;
  function decode(items) {
    var restored = $.NSMutableArray.alloc.init;
    items.forEach(function(saved) {
      var item = $.NSPasteboardItem.alloc.init;
      Object.keys(saved).forEach(function(type) {
        var data = $.NSData.alloc.initWithBase64EncodedStringOptions($(saved[type]), 0);
        if (!data || data.isNil() || !item.setDataForType(data, $(type))) throw new Error('Invalid pasteboard data');
      });
      restored.addObject(item);
    });
    return restored;
  }
  if (argv[0] === 'prepare') {
    var count = Number(board.changeCount), items = [], bytes = 0;
    var source = board.pasteboardItems;
    var sourceCount = source ? Number(source.count) : 0;
    for (var i = 0; i < sourceCount; i++) {
      var item = source.objectAtIndex(i), saved = {}, types = item.types;
      var typeCount = Number(types.count);
      for (var j = 0; j < typeCount; j++) {
        var type = types.objectAtIndex(j), data = item.dataForType(type);
        if (!data || data.isNil()) throw new Error('Unreadable pasteboard representation');
        bytes += Number(data.length);
        if (!(bytes <= 16 * 1024 * 1024)) throw new Error('Pasteboard too large to preserve');
        var encoded = data.base64EncodedStringWithOptions(0).js;
        if (typeof encoded !== 'string') throw new Error('Unreadable pasteboard data');
        saved[type.js] = encoded;
      }
      items.push(saved);
    }
    var replacement = $.NSPasteboardItem.alloc.init;
    if (!replacement.setStringForType($(input.text), $.NSPasteboardTypeString)) throw new Error('Cannot set paste text');
    var original = decode(items);
    if (count !== Number(board.changeCount)) throw new Error('Pasteboard changed during capture');
    board.clearContents;
    if (!board.writeObjects($.NSArray.arrayWithObject(replacement))) {
      board.clearContents;
      if (Number(original.count)) board.writeObjects(original);
      throw new Error('Cannot write pasteboard');
    }
    return JSON.stringify({ changeCount: Number(board.changeCount), items: items });
  }
  if (argv[0] !== 'restore') throw new Error('Unknown pasteboard operation');
  var restored = decode(input.items);
  if (Number(board.changeCount) !== Number(input.changeCount)) return 'false';
  board.clearContents;
  if (Number(restored.count) && !board.writeObjects(restored)) throw new Error('Cannot restore pasteboard');
  return 'true';
}`;

/**
 * A refusal the helper made on purpose, told apart from a helper that broke.
 *
 * The program declines a clipboard it could not put back afterwards — a promised or otherwise
 * unreadable representation, more than 16 MiB — and one that moved under it mid-capture. Those
 * are exactly the clipboards conch must leave alone, so they must never become "copy over it
 * and paste anyway" (#248 made every failure here do that). Anything else — a timeout, a JXA
 * that fell over — is a broken helper, and delivering the words still matters more than the
 * courtesy of preserving what was there.
 */
export function pasteboardRefusal(error: unknown): "clipboard-unpreservable" | "clipboard-changed" | undefined {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message.includes("Pasteboard changed during capture")) return "clipboard-changed";
  return /Unreadable pasteboard|Pasteboard too large to preserve/.test(message) ? "clipboard-unpreservable" : undefined;
}

export function createPasteboard(run: typeof runUICommand = runUICommand, board?: string): Pasteboard {
  async function call<T>(operation: string, input: object = {}): Promise<T> {
    const result = await run(["osascript", "-l", "JavaScript", "-e", PASTEBOARD_SCRIPT, "--", operation], JSON.stringify({ ...input, board }));
    // The refusal travels with the failure: a helper that broke and a helper that declined
    // a clipboard on purpose are the same exit code, and only its own words tell them apart.
    if (result.timedOut || result.exitCode !== 0) {
      throw new Error(`Pasteboard helper failed: ${result.stderr.trim() || result.text.trim() || "no output"}`);
    }
    return JSON.parse(result.text) as T;
  }
  return {
    prepare: (text) => call("prepare", { text }),
    restore: (lease) => call("restore", lease),
  };
}
