export interface SelPoint {
  line: number;
  column: number;
}

export interface SelectionSpan {
  start: number;
  end: number;
}

export interface SelectionDocumentLine {
  text: string;
}

const MAX_COORDINATE = Number.MAX_SAFE_INTEGER;

function coordinate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_COORDINATE, Math.max(0, Math.trunc(value)));
}

function point(value: SelPoint): SelPoint {
  return {
    line: coordinate(value.line),
    column: coordinate(value.column),
  };
}

function samePoint(a: SelPoint, b: SelPoint): boolean {
  return a.line === b.line && a.column === b.column;
}

function orderedPoints(a: SelPoint, b: SelPoint): [SelPoint, SelPoint] {
  if (a.line < b.line || (a.line === b.line && a.column <= b.column)) {
    return [a, b];
  }
  return [b, a];
}

function clamp(value: number, maximum: number): number {
  return Math.min(coordinate(value), coordinate(maximum));
}

function clampToDocument(
  value: SelPoint,
  doc: readonly SelectionDocumentLine[],
): SelPoint | null {
  if (!doc.length) return null;
  const line = Math.min(value.line, doc.length - 1);
  return {
    line,
    column: clamp(value.column, doc[line]!.text.length),
  };
}

/**
 * Anchor/focus selection in wrapped document coordinates. Screen-to-document
 * hit testing remains the renderer's responsibility.
 */
export class TheaterSelection {
  #anchor: SelPoint | null = null;
  #focus: SelPoint | null = null;
  #dragging = false;
  #fingerprint = "";

  get active(): boolean {
    return this.#anchor !== null && this.#focus !== null;
  }

  get dragging(): boolean {
    return this.#dragging;
  }

  get fingerprint(): string {
    return this.#fingerprint;
  }

  /** Start a new selection, replacing any prior anchor and focus. */
  begin(value: SelPoint, docFingerprint: string): void {
    const next = point(value);
    this.#anchor = next;
    this.#focus = next;
    this.#fingerprint = docFingerprint;
    this.#dragging = true;
  }

  /** Move the focus while a drag is live. */
  update(value: SelPoint): boolean {
    if (!this.#dragging || !this.#focus) return false;
    const next = point(value);
    if (samePoint(next, this.#focus)) return false;
    this.#focus = next;
    return true;
  }

  /**
   * Freeze a non-empty drag. A click without movement simply clears the old
   * selection and does not leave an invisible selection that can be copied.
   */
  end(): void {
    this.#dragging = false;
    if (this.#anchor && this.#focus && samePoint(this.#anchor, this.#focus)) {
      this.clear();
    }
  }

  clear(): boolean {
    const changed = this.active || this.#dragging;
    this.#anchor = null;
    this.#focus = null;
    this.#dragging = false;
    this.#fingerprint = "";
    return changed;
  }

  matchesFingerprint(docFingerprint: string): boolean {
    return this.active && this.#fingerprint === docFingerprint;
  }

  /** Clear live selection state when the renderer swaps or mutates its doc. */
  clearIfFingerprintChanged(docFingerprint: string): boolean {
    if (!this.active || this.#fingerprint === docFingerprint) return false;
    return this.clear();
  }

  /**
   * Return the normalized half-open span intersecting a document line.
   * Endpoint columns and the supplied line length are clamped defensively.
   */
  spanFor(line: number, lineLength: number): SelectionSpan | null {
    if (!this.#anchor || !this.#focus || !Number.isFinite(line) || line < 0) {
      return null;
    }

    const targetLine = Math.trunc(line);
    const length = coordinate(lineLength);
    const [startPoint, endPoint] = orderedPoints(this.#anchor, this.#focus);
    if (targetLine < startPoint.line || targetLine > endPoint.line) return null;

    const start = clamp(
      targetLine === startPoint.line ? startPoint.column : 0,
      length,
    );
    const end = clamp(
      targetLine === endPoint.line ? endPoint.column : length,
      length,
    );
    return start < end ? { start, end } : null;
  }

  /**
   * Extract the selected document text. Supplying the current renderer
   * fingerprint makes a changed document fail closed instead of copying text
   * under stale coordinates.
   */
  extract(
    doc: readonly SelectionDocumentLine[],
    expectedFingerprint?: string,
  ): string {
    if (
      !this.#anchor
      || !this.#focus
      || (expectedFingerprint !== undefined
        && expectedFingerprint !== this.#fingerprint)
    ) {
      return "";
    }

    const clampedAnchor = clampToDocument(this.#anchor, doc);
    const clampedFocus = clampToDocument(this.#focus, doc);
    if (!clampedAnchor || !clampedFocus) return "";
    const [startPoint, endPoint] = orderedPoints(clampedAnchor, clampedFocus);
    if (samePoint(startPoint, endPoint)) return "";

    if (startPoint.line === endPoint.line) {
      return doc[startPoint.line]!.text.slice(
        startPoint.column,
        endPoint.column,
      );
    }

    const selected: string[] = [];
    for (let line = startPoint.line; line <= endPoint.line; line++) {
      const text = doc[line]!.text;
      if (line === startPoint.line) selected.push(text.slice(startPoint.column));
      else if (line === endPoint.line) selected.push(text.slice(0, endPoint.column));
      else selected.push(text);
    }
    return selected.join("\n");
  }
}
