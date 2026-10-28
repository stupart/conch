import { existsSync } from "node:fs";
import { join } from "node:path";
// Text, not JSON: Bun inlines it either way, and the shape is checked here rather than trusted (`isBenchmarkCatalog`).
import catalogSource from "../assets/benchmarks.json" with { type: "text" };
import { atlasCopiesFolder, atlasPagePath } from "./atlas-copies.ts";
import { CONTROL_FRAME_MAX_BYTES } from "./control-framing.ts";
import { PAGE_BUDGET, pageOf } from "./skills-library.ts";

/**
 * Benchmarks (2026-10-28): the indexes and leaderboards worth knowing when judging a model or an agent, as a catalog
 * beside the skills library. Tyler: "and then lets also make a new tab for benchmarks".
 *
 * The catalog is a file in the repository (`assets/benchmarks.json`), compiled into the daemon as its other texts are,
 * and researched by hand (106 indexes on 28 Oct 2026): what each one measures, who keeps it, how fresh it is, and a
 * one-line take on when to trust it. Nothing is fetched. It is sent a page at a time, as the skills library's lists are. Its report, the longer guidance on which evals to trust, lives in Atlas; Atlas has no web
 * view of a page, so the report opens from the copy agents keep of it (`atlas_show`, atlas-copies.ts) when there is one
 * on this Mac.
 */

export const BENCHMARK_KINDS = ["aggregator", "leaderboard", "benchmark", "suite"] as const;
export type BenchmarkKind = (typeof BENCHMARK_KINDS)[number];

export interface BenchmarkIndex {
  id: string;
  name: string;
  url: string;
  kind: BenchmarkKind;
  domains: string[];
  maintainer: string;
  measures: string;
  freshness: string;
  take: string;
}

export interface BenchmarkCatalog {
  updatedAt: string;
  report?: { title: string; atlasPath: string };
  indexes: BenchmarkIndex[];
}

export interface BenchmarksRequest {
  kind: "benchmarks";
  /** A page's start: the previous reply's `next`. */
  offset?: number;
}

export interface BenchmarksReply {
  kind: "benchmarks";
  /** The catalog with one page of its indexes: a hundred of them run past one control frame (64 KiB). */
  catalog: BenchmarkCatalog;
  total: number;
  next?: number;
  /** The report's copy on this Mac (`~/Documents/conch-notes/atlas/<path>`), when an agent has shown it. */
  reportCopy?: string;
}

const INDEXES_MAX = 200;
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const line = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !UNPRINTABLE.test(value);

function isHttpsUrl(value: unknown): value is string {
  if (!line(value, 2048)) return false;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

function isBenchmarkIndex(value: unknown): value is BenchmarkIndex {
  return record(value)
    && line(value.id, 100) && /^[a-z0-9][a-z0-9-]*$/.test(value.id)
    && line(value.name, 120)
    && isHttpsUrl(value.url)
    && (BENCHMARK_KINDS as readonly string[]).includes(String(value.kind))
    && Array.isArray(value.domains) && value.domains.length <= 12 && value.domains.every((domain) => line(domain, 40))
    && line(value.maintainer, 160)
    && line(value.measures, 600)
    && line(value.freshness, 200)
    && line(value.take, 400);
}

/** The catalog's shape, as the research that fills it agreed: refused whole if any part is off, never patched. */
export function isBenchmarkCatalog(value: unknown): value is BenchmarkCatalog {
  if (!record(value) || !line(value.updatedAt, 40) || !Array.isArray(value.indexes)) return false;
  if (value.indexes.length > INDEXES_MAX || !value.indexes.every(isBenchmarkIndex)) return false;
  const ids = new Set(value.indexes.map((index) => (index as BenchmarkIndex).id));
  if (ids.size !== value.indexes.length) return false;
  if (value.report !== undefined) {
    if (!record(value.report) || !line(value.report.title, 200) || !atlasPagePath(value.report.atlasPath).ok) return false;
  }
  return true;
}

/** The catalog this build carries; a malformed one is a build mistake, and says so rather than showing nothing. */
export function benchmarkCatalog(source: string = catalogSource as unknown as string): BenchmarkCatalog {
  const parsed: unknown = JSON.parse(source);
  if (!isBenchmarkCatalog(parsed)) throw new Error("assets/benchmarks.json does not match the benchmark catalog's shape");
  return parsed;
}

/** One page of the catalog from `offset`, with where its report's copy is on this Mac. */
export function readBenchmarks(catalog: BenchmarkCatalog = benchmarkCatalog(), copies: string = atlasCopiesFolder(), offset = 0): BenchmarksReply {
  const path = catalog.report ? atlasPagePath(catalog.report.atlasPath) : undefined;
  const copy = path?.ok ? join(copies, path.file) : undefined;
  const page = pageOf(catalog.indexes, offset, PAGE_BUDGET);
  return {
    kind: "benchmarks",
    catalog: { ...catalog, indexes: page.items },
    total: catalog.indexes.length,
    ...(page.next === undefined ? {} : { next: page.next }),
    ...(copy && existsSync(copy) ? { reportCopy: copy } : {}),
  };
}

export function benchmarksRequestError(value: Record<string, unknown>): string | undefined {
  if (!Object.keys(value).every((key) => key === "kind" || key === "offset")) return "benchmarks takes only an offset";
  if (value.offset !== undefined && !(Number.isSafeInteger(value.offset) && (value.offset as number) >= 0 && (value.offset as number) <= 10_000)) {
    return "offset must be a page's start";
  }
}

export function isBenchmarksReply(value: unknown): value is BenchmarksReply {
  return record(value) && value.kind === "benchmarks" && isBenchmarkCatalog(value.catalog)
    && Number.isSafeInteger(value.total) && (value.next === undefined || Number.isSafeInteger(value.next))
    && (value.reportCopy === undefined || line(value.reportCopy, 4096))
    && Buffer.byteLength(JSON.stringify(value)) < CONTROL_FRAME_MAX_BYTES;
}
