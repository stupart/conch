export type MouseEvent =
  | { kind: "wheel"; delta: -1 | 1; column: number; row: number }
  | {
      kind: "down" | "drag" | "up";
      button: number;
      column: number;
      row: number;
    };

const SGR_MOUSE_PREFIX = "\x1b[<";
const CSI_PREFIX = "\x1b[";

/**
 * Long enough for real terminal coordinates while preventing an unfinished
 * mouse-looking prefix from growing without bound across stdin chunks.
 */
export const SGR_MOUSE_MAX_CARRY = 32;

type Candidate =
  | {
      kind: "complete";
      end: number;
      button: number;
      column: number;
      row: number;
      terminator: "M" | "m";
    }
  | { kind: "incomplete" }
  | { kind: "invalid" };

interface DecimalField {
  start: number;
  end: number;
}

function decimalField(input: string, start: number): DecimalField | null | undefined {
  if (start >= input.length) return undefined;
  const first = input.charCodeAt(start);
  if (first < 48 || first > 57) return null;

  let end = start + 1;
  while (end < input.length) {
    const code = input.charCodeAt(end);
    if (code < 48 || code > 57) break;
    end++;
  }
  return { start, end };
}

function parseCandidate(input: string, start: number): Candidate {
  let cursor = start + SGR_MOUSE_PREFIX.length;
  const fields: DecimalField[] = [];

  for (let index = 0; index < 3; index++) {
    const field = decimalField(input, cursor);
    if (field === undefined) return { kind: "incomplete" };
    if (field === null) return { kind: "invalid" };
    fields.push(field);
    cursor = field.end;

    if (index < 2) {
      if (cursor >= input.length) return { kind: "incomplete" };
      if (input[cursor] !== ";") return { kind: "invalid" };
      cursor++;
    }
  }

  if (cursor >= input.length) return { kind: "incomplete" };
  const terminator = input[cursor];
  if (terminator !== "M" && terminator !== "m") return { kind: "invalid" };

  const [buttonField, columnField, rowField] = fields as [
    DecimalField,
    DecimalField,
    DecimalField,
  ];
  return {
    kind: "complete",
    end: cursor + 1,
    button: Number(input.slice(buttonField.start, buttonField.end)),
    column: Number(input.slice(columnField.start, columnField.end)),
    row: Number(input.slice(rowField.start, rowField.end)),
    terminator,
  };
}

function decodeCandidate(candidate: Extract<Candidate, { kind: "complete" }>): MouseEvent | null {
  const { button, column, row, terminator } = candidate;
  if (
    !Number.isSafeInteger(button)
    || button < 0
    || button > 0x7fff_ffff
    || !Number.isSafeInteger(column)
    || !Number.isSafeInteger(row)
  ) {
    return null;
  }

  // xterm SGR modifier flags: Shift=4, Meta=8, Ctrl=16.
  const base = button & ~28;
  if (terminator === "m") {
    return {
      kind: "up",
      button: base & 3,
      column,
      row,
    };
  }

  if (base === 64 || base === 65) {
    return {
      kind: "wheel",
      delta: base === 64 ? -1 : 1,
      column,
      row,
    };
  }

  if ((base & 32) !== 0) {
    const heldButton = base & 3;
    // 1003 reports motion with low bits 3 when no button is held. Theater
    // has no hover UI, so suppress those reports before they can repaint.
    if (heldButton === 3) return null;
    return {
      kind: "drag",
      button: heldButton,
      column,
      row,
    };
  }

  if (base === 0 || base === 1 || base === 2) {
    return {
      kind: "down",
      button: base,
      column,
      row,
    };
  }

  return null;
}

/**
 * Incremental parser for xterm SGR 1006 mouse reports.
 *
 * Complete reports are removed from `rest`; every other byte is returned in
 * its original order. A trailing `ESC[` or syntactically valid `ESC[<...`
 * prefix is carried to the next call, up to SGR_MOUSE_MAX_CARRY bytes. A lone
 * ESC is deliberately not carried, so the theater's Escape key stays prompt.
 */
export class SgrMouseParser {
  #carry = "";

  feed(chunk: string): { events: MouseEvent[]; rest: string } {
    const input = this.#carry + chunk;
    this.#carry = "";

    const events: MouseEvent[] = [];
    const rest: string[] = [];
    let cursor = 0;

    while (cursor < input.length) {
      const start = input.indexOf(SGR_MOUSE_PREFIX, cursor);
      if (start < 0) {
        if (input.endsWith(CSI_PREFIX)) {
          rest.push(input.slice(cursor, -CSI_PREFIX.length));
          this.#carry = CSI_PREFIX;
        } else {
          rest.push(input.slice(cursor));
        }
        break;
      }

      rest.push(input.slice(cursor, start));
      const candidate = parseCandidate(input, start);
      if (candidate.kind === "complete") {
        const event = decodeCandidate(candidate);
        if (event) events.push(event);
        cursor = candidate.end;
        continue;
      }

      if (candidate.kind === "incomplete") {
        const pending = input.slice(start);
        if (pending.length <= SGR_MOUSE_MAX_CARRY) {
          this.#carry = pending;
        } else {
          rest.push(pending);
        }
        cursor = input.length;
        break;
      }

      // The introducer was followed by invalid grammar. Preserve its ESC now
      // and resume scanning one byte later, which also allows a later valid
      // report in the same chunk to be recognized.
      rest.push(input[start]!);
      cursor = start + 1;
    }

    return { events, rest: rest.join("") };
  }
}

/** Maximum base64 payload emitted inside one OSC 52 clipboard sequence. */
export const OSC_52_MAX_PAYLOAD_BYTES = 100 * 1024;

/**
 * Build an OSC 52 clipboard write, or null when its base64 payload exceeds
 * the configured cap. Buffer performs UTF-8 encoding before base64.
 */
export function buildOsc52(
  text: string,
  maxPayloadBytes = OSC_52_MAX_PAYLOAD_BYTES,
): string | null {
  const payload = Buffer.from(text, "utf8").toString("base64");
  if (payload.length > maxPayloadBytes) return null;
  return `\x1b]52;c;${payload}\x07`;
}

/** Wrap an escape payload for tmux DCS passthrough. */
export function wrapTmuxDcs(payload: string): string {
  return `\x1bPtmux;${payload.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

/** Convenience builder for the raw or tmux-wrapped OSC 52 copy path. */
export function buildClipboardEscape(
  text: string,
  tmux = false,
  maxPayloadBytes = OSC_52_MAX_PAYLOAD_BYTES,
): string | null {
  const osc52 = buildOsc52(text, maxPayloadBytes);
  if (osc52 === null) return null;
  return tmux ? wrapTmuxDcs(osc52) : osc52;
}
