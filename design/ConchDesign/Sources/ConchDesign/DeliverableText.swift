import Foundation

/// Whether a deliverable file is text to a person: source, config, data, a log, a LICENSE. Decided by what the file is
/// called and, where the name says nothing, by its first bytes. Never by WebKit's MIME guess: WebKit calls `.ts` an MPEG
/// transport stream (video/mp2t), so a TypeScript file clicked in a published folder's tree came back as "Couldn't
/// load deliverable — Frame load interrupted" (Tyler, 30 Sep, `5-agent-experience/starter-prompts.ts`). Every name the
/// viewers didn't know fell to the web view, and a source file with an unknown extension or none at all failed or
/// downloaded the same way.
///
/// The Mac reads the bytes of the file on its own disk (`isText(path:)`); the phone decides from the name alone
/// (`byName`), since it sees a file only once it has fetched it.
public enum DeliverableText {
    /// Extensions that are text to a person. Markdown is not here: it is rendered, not shown as source.
    public static let extensions: Set<String> = [
        // Prose, data and config.
        "txt", "text", "log", "csv", "tsv", "json", "jsonl", "ndjson", "json5", "jsonc", "yaml", "yml", "toml", "ini",
        "cfg", "conf", "config", "properties", "xml", "plist", "rst", "adoc", "tex", "srt", "vtt", "diff", "patch",
        "lock", "sql", "graphql", "gql", "proto",
        // Web source, as source: a page stays a page (`pages`).
        "css", "scss", "sass", "less", "js", "mjs", "cjs", "jsx", "tsx", "cts", "vue", "svelte", "astro", "mdx",
        // Languages.
        "swift", "m", "mm", "h", "hpp", "hh", "c", "cc", "cpp", "cxx", "cs", "java", "kt", "kts", "scala", "groovy",
        "gradle", "go", "rs", "py", "pyi", "rb", "php", "pl", "pm", "lua", "r", "jl", "dart", "ex", "exs", "erl", "hrl",
        "clj", "cljs", "edn", "hs", "elm", "ml", "mli", "fs", "fsx", "nim", "zig", "sol", "v", "vhd", "tf", "tfvars",
        "hcl", "nix", "cmake", "mk", "make", "bzl", "bazel", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "awk",
        "sed", "vim", "el", "applescript", "ipynb",
    ]

    /// Extensions that name text and something else: `.ts` is TypeScript or an MPEG transport stream, `.mts` a
    /// TypeScript module or a camera's video. Only the bytes can say which.
    public static let ambiguous: Set<String> = ["ts", "mts"]

    /// Pages, which stay pages: a web view draws them, and never shows them as source.
    public static let pages: Set<String> = ["html", "htm", "xhtml", "shtml"]

    /// Names with no extension that are always text, compared without case: `LICENSE`, `Makefile`, a dotfile.
    public static let fileNames: Set<String> = [
        "license", "licence", "copying", "notice", "authors", "contributors", "changelog", "changes", "readme",
        "makefile", "gnumakefile", "dockerfile", "containerfile", "procfile", "gemfile", "rakefile", "podfile",
        "brewfile", "justfile", "vagrantfile", "jenkinsfile", "codeowners", "version",
        ".gitignore", ".gitattributes", ".gitmodules", ".editorconfig", ".npmrc", ".nvmrc", ".node-version",
        ".python-version", ".tool-versions", ".prettierrc", ".eslintrc", ".dockerignore", ".env.example",
    ]

    /// How much of a file its bytes are judged by.
    public static let sniffBytes = 8192

    /// By name alone: true or false when the name says, nil when only the bytes can.
    public static func byName(_ path: String) -> Bool? {
        let name = (path as NSString).lastPathComponent
        let ext = (name as NSString).pathExtension.lowercased()
        if fileNames.contains(name.lowercased()) { return true }
        if ext.isEmpty || ambiguous.contains(ext) { return nil }
        if pages.contains(ext) { return false }
        return extensions.contains(ext) ? true : nil
    }

    /// Whether these bytes read as text: UTF-8 (a character cut at the end allowed), with no NUL and next to no
    /// control characters beyond tab, newline, carriage return and form feed. Empty is text: an empty file shows empty.
    public static func looksLikeText(_ head: Data) -> Bool {
        let bytes = [UInt8](head.prefix(sniffBytes))
        if bytes.contains(0) { return false }
        let controls = bytes.filter { $0 < 0x20 && $0 != 0x09 && $0 != 0x0A && $0 != 0x0D && $0 != 0x0C }.count
        if controls * 100 > max(bytes.count, 1) { return false }
        // A multi-byte character cut by the sniff's edge is not a reason to call a file binary.
        for trim in 0...min(3, bytes.count) {
            if String(bytes: bytes.dropLast(trim), encoding: .utf8) != nil { return true }
        }
        return false
    }

    /// The Mac's decision for a file on its own disk: by name, else by its first `sniffBytes` bytes (`read`).
    public static func isText(path: String, read: (String) -> Data? = firstBytes) -> Bool {
        if let named = byName(path) { return named }
        guard let head = read(path) else { return false }
        return looksLikeText(head)
    }

    /// A file's first `sniffBytes` bytes, or nil when it can't be read.
    public static func firstBytes(_ path: String) -> Data? {
        guard let handle = FileHandle(forReadingAtPath: path) else { return nil }
        defer { try? handle.close() }
        return try? handle.read(upToCount: sniffBytes) ?? Data()
    }
}
