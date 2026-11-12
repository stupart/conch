import { describe, expect, test } from "bun:test";
import {
  compactHref,
  compactRead,
  moreHint,
  READ_HREF_MAX,
  READ_PAGE_CHARS,
  READ_SHOWN,
  readView,
  ReadViewError,
  textPages,
} from "../src/browser-read.ts";

/**
 * `browser read` is compact unless asked for all of it (2026-11-11): one page of the words and the elements in them,
 * and a way to every other part. These hold it to showing less without losing anything: every element of a read is in
 * some view of it, under the ref the read gave it, and `full` is the read as it came.
 */

const URL = "https://acme.dev/docs/start";

/** A docs page: a nav, an intro, three sections (two longer than a page), and a footer. */
function docsRead() {
  const para = (words: string, n: number) => Array.from({ length: n }, (_, i) => `${words} sentence ${i} of the paragraph goes on for a while.`).join(" ");
  const lines = [
    "Home", "Pricing", "Docs", "Sign in",
    "Getting started",
    para("Acme helps you ship", 4),
    "Install",
    para("Install it with brew", 36),
    "Run brew install acme to begin.",
    "Configure",
    para("Configure the token", 12),
    "Options",
    para("Every option is listed", 6),
    "Deploy",
    para("Deploy to production", 36),
    "Read the deploy guide",
    "© Acme · Privacy",
  ];
  const text = lines.join("\n");
  return {
    tab: "tab-1",
    url: URL,
    title: "Getting started · Acme",
    text,
    links: [
      { ref: "e1", text: "Home", href: "https://acme.dev/" },
      { ref: "e2", text: "Pricing", href: "https://acme.dev/pricing" },
      { ref: "e3", text: "Docs", href: "https://acme.dev/docs" },
      { ref: "e4", text: "Read the deploy guide", href: "https://acme.dev/docs/deploy?from=start#top" },
      { ref: "e5", text: "Privacy", href: "https://acme.dev/privacy" },
      { ref: "e6", text: "", href: "https://acme.dev/" },
      { ref: "e7", text: "" },
      { ref: "e8", text: "GitHub", href: "https://github.com/acme/acme" },
    ],
    buttons: [
      { ref: "e9", text: "Sign in" },
      { ref: "e10", text: "Copy" },
      { ref: "e11", text: "" },
      { ref: "e12", text: "Hide sidebar" },
    ],
    fields: [{ ref: "e13", type: "search", label: "Search the docs", value: "" }, { ref: "e14", type: "hidden", name: "csrf" }],
    headings: [
      { level: 1, text: "Getting started" },
      { level: 2, text: "Install" },
      { level: 2, text: "Configure" },
      { level: 3, text: "Options" },
      { level: 2, text: "Deploy" },
    ],
  };
}

const refs = (answer: Record<string, unknown>) =>
  ["links", "buttons", "fields"].flatMap((kind) => (answer[kind] as Array<{ ref: string }>).map((item) => item.ref));

describe("browser read, compact", () => {
  test("a read shows one page of the words, the elements in them, the page's sections, and says how to get the rest", () => {
    const read = docsRead();
    const answer = compactRead(read);
    expect(read.text.length).toBeGreaterThan(3 * READ_PAGE_CHARS);
    expect((answer.text as string).length).toBeLessThanOrEqual(READ_PAGE_CHARS);
    expect(answer.text).toStartWith("Home\nPricing");
    expect(answer.page).toEqual({ at: 1, of: textPages(read.text, 0, read.text.length).length });
    expect(answer.sections).toEqual(["Getting started", "Install", "Configure", "Options", "Deploy"]);
    // The nav's links, a logo link with only its address, a link to another site whose words aren't on the page, and
    // buttons whose words aren't in the text (a code block's Copy, an icon known by its label).
    expect((answer.links as Array<{ ref: string }>).map((link) => link.ref)).toEqual(["e1", "e2", "e3", "e6", "e8"]);
    expect((answer.buttons as Array<{ ref: string }>).map((button) => button.ref)).toEqual(["e9", "e10", "e12"]);
    // A hidden field is the page's own, nothing to type into: full lists it, a view doesn't.
    expect(answer.fields).toEqual([read.fields[0]]);
    expect(answer.more).toContain("page: 2 for page 2 of");
    expect(answer.more).toContain("full: true for the whole read");
    expect(answer).not.toHaveProperty("headings");
  });

  test("every page together lists every element a read has words or an address for, once each, under the read's own ref", () => {
    const read = docsRead();
    const first = compactRead(read);
    const pages = (first.page as { of: number }).of;
    const seen: string[] = [];
    for (let page = 1; page <= pages; page++) {
      const answer = compactRead(read, { page });
      // Fields are every page's: a form is often why the page was read.
      seen.push(...refs({ ...answer, fields: [] }));
      expect(answer.fields).toEqual([read.fields[0]]);
      if (page === pages) expect(answer).not.toHaveProperty("more");
    }
    expect(seen.sort()).toEqual(["e1", "e10", "e12", "e2", "e3", "e4", "e5", "e6", "e8", "e9"].sort());
    // A button with no words and a link with neither words nor an address say nothing to act on; full keeps them.
    expect(seen).not.toContain("e7");
    expect(seen).not.toContain("e11");
    expect(refs(compactRead(read, { full: true }))).toEqual(expect.arrayContaining(["e7", "e11", "e14"]));
  });

  test("full is the read as it came, the answer from before", () => {
    const read = docsRead();
    expect(compactRead(read, { full: true })).toBe(read);
  });

  test("a same-site link shows its path, one on this page its fragment, another site's its whole address, a long one cut", () => {
    expect(compactHref("https://acme.dev/pricing", URL)).toBe("/pricing");
    expect(compactHref("https://acme.dev/docs/deploy?from=start#top", URL)).toBe("/docs/deploy?from=start#top");
    expect(compactHref("https://acme.dev/docs/start#install", URL)).toBe("#install");
    expect(compactHref("https://github.com/acme/acme", URL)).toBe("https://github.com/acme/acme");
    expect(compactHref("http://acme.dev/pricing", URL)).toBe("http://acme.dev/pricing");
    const long = compactHref(`https://acme.dev/search?q=${"x".repeat(300)}`, URL);
    expect(long.length).toBe(READ_HREF_MAX);
    expect(long).toEndWith("…");
    const answer = compactRead(docsRead(), { find: "deploy guide" });
    expect(answer.links).toEqual([{ ref: "e4", text: "Read the deploy guide", href: "/docs/deploy?from=start#top" }]);
  });

  test("find shows the lines and the elements that say the words, in any case, and nothing else", () => {
    const answer = compactRead(docsRead(), { find: "BREW" });
    expect(answer.find).toBe("BREW");
    expect(answer.lines).toBe(2);
    expect((answer.text as string).split("\n")[1]).toBe("Run brew install acme to begin.");
    // The paragraph's line is long: the words round the first match, cut at both ends.
    expect((answer.text as string).split("\n")[0]!.length).toBeLessThanOrEqual(302);
    expect(answer.links).toEqual([]);
    expect(answer.buttons).toEqual([]);
    expect(answer.fields).toEqual([]);
    expect(answer).not.toHaveProperty("page");
    expect(answer).not.toHaveProperty("more");
    const none = compactRead(docsRead(), { find: "kubernetes" });
    expect(none.note).toBe('nothing on the page says "kubernetes"');
    const field = compactRead(docsRead(), { find: "search" });
    expect(field.fields).toEqual([docsRead().fields[0]]);
  });

  test("a section runs from its heading to the next heading of its level or above, with the elements in it", () => {
    const configure = compactRead(docsRead(), { section: "configure" });
    expect(configure.section).toBe("Configure");
    expect(configure.text).toStartWith("Configure\nConfigure the token");
    // Options is an h3 under Configure, so it is in it; Deploy, an h2, ends it.
    expect(configure.text).toContain("Every option is listed");
    expect(configure.text).not.toContain("Deploy to production");
    // A section longer than a page has pages of its own.
    const deploy = compactRead(docsRead(), { section: "Deploy", page: 2 });
    expect(deploy.page).toEqual({ at: 2, of: 2 });
    expect((deploy.links as Array<{ ref: string }>).map((link) => link.ref)).toEqual(["e4", "e5"]);
    // A section's fields are its own.
    expect(deploy.fields).toEqual([]);
    expect(deploy).not.toHaveProperty("sections");
    // Words a heading starts with, or holds, find it too.
    expect(compactRead(docsRead(), { section: "Inst" }).section).toBe("Install");
  });

  test("with no heading that says it, a section runs from the line that does; with none at all, it is refused with the sections", () => {
    const { headings: _headings, ...older } = docsRead();
    const fromLine = compactRead(older, { section: "Configure" });
    expect(fromLine.text).toStartWith("Configure\n");
    expect(fromLine.note).toContain("didn't say where headings are");
    expect(() => compactRead(docsRead(), { section: "Kubernetes" })).toThrow(ReadViewError);
    expect(() => compactRead(docsRead(), { section: "Kubernetes" })).toThrow('nothing on the page is a heading or a line that says "Kubernetes"; its sections: Getting started · Install · Configure · Options · Deploy');
  });

  test("a page past the end is refused, saying how many there are", () => {
    const read = docsRead();
    const pages = (compactRead(read).page as { of: number }).of;
    expect(() => compactRead(read, { page: pages + 1 })).toThrow(`page ${pages + 1} is past the end: this page has ${pages} pages of words`);
    expect(() => compactRead(read, { section: "Options", page: 9 })).toThrow('the section "Options" has 1 page of words');
  });

  test("a read of one part says so; one an older app read whole says that instead", () => {
    const scoped = compactRead({ ...docsRead(), scope: "main" }, { selector: "main" });
    expect(scoped.scope).toBe("main");
    expect(scoped).not.toHaveProperty("note");
    const whole = compactRead(docsRead(), { selector: "main" });
    expect(whole.note).toBe("conch's Mac app read the whole page: the one running is older than reading one part");
  });

  test("a long list is cut to a view's share, and what was left out is counted", () => {
    const links = Array.from({ length: 120 }, (_, i) => ({ ref: `e${i + 1}`, text: `Result ${i}`, href: `https://acme.dev/r/${i}` }));
    const read = { url: URL, title: "Results", text: links.map((link) => link.text).join("\n"), links, buttons: [], fields: [] };
    const answer = compactRead(read);
    expect((answer.links as unknown[]).length).toBe(READ_SHOWN.links);
    expect(answer.hidden).toEqual({ links: 120 - READ_SHOWN.links });
    expect(answer.more).toContain(`${120 - READ_SHOWN.links} more links in this part`);
    // find reaches the rest by their words.
    expect(compactRead(read, { find: "Result 119" }).links).toEqual([{ ref: "e120", text: "Result 119", href: "/r/119" }]);
  });

  /**
   * The size it is for. 201 real reads in 7 days of transcripts averaged 8.4 KB as sent (p90 16.8 KB); the largest
   * the Mac app sends is about 45 KB. A read that size is a few KB compact.
   */
  test("a read as large as the Mac app sends is a few KB compact, and no smaller with full", () => {
    const word = "lorem ipsum dolor sit amet consectetur";
    const text = Array.from({ length: 300 }, (_, i) => `${word} ${i}`).join("\n");
    const read = {
      url: URL,
      title: "Everything",
      text,
      links: Array.from({ length: 150 }, (_, i) => ({ ref: `e${i + 1}`, text: `${word} ${i}`, href: `https://acme.dev/a/very/long/path/${i}?utm_source=x&utm_medium=y` })),
      buttons: Array.from({ length: 100 }, (_, i) => ({ ref: `e${151 + i}`, text: `Action ${i} options` })),
      fields: Array.from({ length: 12 }, (_, i) => ({ ref: `e${251 + i}`, type: "text", label: `Field ${i}`, value: "" })),
    };
    const full = JSON.stringify(compactRead(read, { full: true })).length;
    const compact = JSON.stringify(compactRead(read)).length;
    expect(full).toBeGreaterThan(25_000);
    // 40 links with long query strings and 25 buttons known by their labels: the most one view lists.
    expect(compact).toBeLessThan(10_000);
    expect(compact).toBeLessThan(full / 3);
  });
});

describe("browser read's arguments", () => {
  test("each is checked, and combinations that mean nothing are refused", () => {
    expect(readView({})).toEqual({});
    expect(readView({ page: 2, section: "Install", selector: " main " })).toEqual({ page: 2, section: "Install", selector: "main" });
    expect(readView({ full: true, selector: "main" })).toEqual({ full: true, selector: "main" });
    expect(readView({ full: false })).toEqual({});
    expect(readView({ page: 0 })).toEqual({ error: "page must be a whole number from 1" });
    expect(readView({ page: 1.5 })).toEqual({ error: "page must be a whole number from 1" });
    expect(readView({ full: "yes" })).toEqual({ error: "full must be true or false" });
    expect(readView({ find: "" })).toEqual({ error: "find must be 1 to 200 characters on one line" });
    expect(readView({ section: "a\nb" })).toEqual({ error: "section must be 1 to 200 characters on one line" });
    expect(readView({ find: "x", section: "y" })).toEqual({ error: "pass one of find or section: find looks through the whole page" });
    expect(readView({ find: "x", page: 2 })).toEqual({ error: "find shows every line that matches, so it has no pages" });
    expect(readView({ full: true, page: 2 })).toEqual({ error: "full is the whole read: pass it alone, or with selector" });
  });

  test("the way to more is said in the words of the way in", () => {
    const answer = { page: { at: 1, of: 3 }, hidden: { links: 4 } };
    expect(moreHint(answer, "cli")).toBe("--page 2 for page 2 of 3; 4 more links in this part; --find WORDS, --section HEADING or --selector CSS to narrow it; --full for the whole read");
    expect(moreHint(answer, "tool")).toBe("page: 2 for page 2 of 3; 4 more links in this part; find: WORDS, section: HEADING or selector: CSS to narrow it; full: true for the whole read");
    expect(moreHint({ page: { at: 3, of: 3 } }, "cli")).toBeUndefined();
    expect(moreHint({ find: "x", hidden: { lines: 5 } }, "cli")).toBe("5 more lines say it: more words narrow it; --full for the whole read");
  });
});
