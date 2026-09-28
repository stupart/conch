#!/bin/bash
# Build the tmux conch.app carries, for one architecture, verify it, cache it,
# print the directory.
#
#   scripts/fetch-tmux.sh arm64     -> /…/build/vendor/tmux-3.7c-arm64
#   scripts/fetch-tmux.sh x86_64
#
# conch hosts sessions in its own tmux server (its own socket), so a Mac
# without Homebrew needs a tmux: this one, embedded at Contents/Helpers/tmux by
# scripts/embed-tmux.sh. It is tmux as Homebrew builds it on macOS — utf8proc
# for character widths, jemalloc as the allocator, sixel on — with every
# library linked in statically except the system's own:
#
#   libevent  2.1.13-stable  static  (BSD-3-Clause)
#   jemalloc  5.3.1          static  (BSD-2-Clause) — tmux 3.7c asks for it on
#             macOS: the system calloc can hand back memory that is not zero
#             (tmux issue 5385), which aborts the server entering copy mode.
#             Built with the je_ prefix and registered as the default malloc
#             zone, exactly as Homebrew's dylib does it: tmux's malloc and free
#             stay libSystem's, which route to jemalloc and still free a
#             pointer the system allocated.
#   utf8proc  2.11.3         static  (MIT) — tmux refuses to configure on
#             macOS without choosing: the system's wcwidth gets emoji wrong.
#   ncurses   the system's /usr/lib/libncurses.5.4.dylib, dynamically. tmux
#             only reads terminfo through it, and that way tmux reads the same
#             database, with the same reader, as the zsh, vim and less it runs
#             in its panes: a TERM tmux accepts is one they know. It is part of
#             every macOS (ncurses 6.0 from 14 on, the app's minimum), so there
#             is nothing to ship and no notice to carry for it.
#
# The default TERM inside panes is pinned to screen-256color, not left to
# configure (which probes the BUILD machine's terminfo): it is in every macOS's
# /usr/share/terminfo, and on remote hosts, where tmux-256color often is not.
#
# Pinned by version AND by the sha256 of every download: a changed or
# substituted source fails here, before anything is built or copied into a
# signed app. Downloads are resumable (a slow network is normal) and kept,
# verified, in build/vendor/tmux-sources (scripts/fetch-pinned.sh). Built under `env -i` with explicit
# flags, so neither Xcode's build environment nor a Homebrew prefix leaks in;
# build paths, archive dates and debug maps are kept out of the binary, so two
# builds of the same pins are the same bytes. A cached build is reused only
# while this script is unchanged and its files are the bytes it recorded.
#
# Needs the Xcode command line tools. Test seam: CONCH_TMUX_CACHE (the cache root).
set -euo pipefail

ARCH="${1:-}"
case "$ARCH" in
  arm64 | x86_64) ;;
  *) echo "usage: scripts/fetch-tmux.sh arm64|x86_64" >&2; exit 2 ;;
esac

TMUX_VERSION=3.7c
TMUX_SHA256=7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf
LIBEVENT_VERSION=2.1.13-stable
LIBEVENT_SHA256=f7e9383b8c0baa81b687e5b5eecc01beefaf1b19b64151d95ed61647fe7a315c
JEMALLOC_VERSION=5.3.1
JEMALLOC_SHA256=3826bc80232f22ed5c4662f3034f799ca316e819103bdc7bb99018a421706f92
UTF8PROC_VERSION=2.11.3
UTF8PROC_SHA256=abfed50b6d4da51345713661370290f4f4747263ee73dc90356299dfc7990c78
DEFAULT_TERM=screen-256color
MACOS_MIN=14.0

TMUX_URL="https://github.com/tmux/tmux/releases/download/$TMUX_VERSION/tmux-$TMUX_VERSION.tar.gz"
LIBEVENT_URL="https://github.com/libevent/libevent/releases/download/release-$LIBEVENT_VERSION/libevent-$LIBEVENT_VERSION.tar.gz"
JEMALLOC_URL="https://github.com/jemalloc/jemalloc/releases/download/$JEMALLOC_VERSION/jemalloc-$JEMALLOC_VERSION.tar.bz2"
UTF8PROC_URL="https://github.com/JuliaStrings/utf8proc/archive/refs/tags/v$UTF8PROC_VERSION.tar.gz"

SCRIPT="${BASH_SOURCE[0]}"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RECIPE="$(shasum -a 256 "$SCRIPT" | cut -d' ' -f1)"
CACHE_ROOT="${CONCH_TMUX_CACHE:-$REPO_ROOT/build/vendor}"
OUT="$CACHE_ROOT/tmux-$TMUX_VERSION-$ARCH"
SOURCES="$CACHE_ROOT/tmux-sources"
NOTICES="$REPO_ROOT/mac-app/third-party/tmux"

# A cached build is reused only while it is still the exact bytes this recipe
# produced: the recipe it was built by, and the digests recorded at build time.
if [[ -f "$OUT/tmux.sha256" && "$(cat "$OUT/recipe" 2>/dev/null)" == "$RECIPE" ]] \
  && (cd "$OUT" && shasum -a 256 -c tmux.sha256 >/dev/null 2>&1); then
  echo "$OUT"
  exit 0
fi

xcrun --find clang >/dev/null 2>&1 || { echo "error: the Xcode command line tools are needed (xcode-select --install)" >&2; exit 1; }

# Each source into the cache as exactly its pinned bytes: resumable, verified,
# never trusted on presence alone (scripts/fetch-pinned.sh).
"$SCRIPT_DIR/fetch-pinned.sh" "$TMUX_URL" "$TMUX_SHA256" "$SOURCES/tmux-$TMUX_VERSION.tar.gz"
"$SCRIPT_DIR/fetch-pinned.sh" "$LIBEVENT_URL" "$LIBEVENT_SHA256" "$SOURCES/libevent-$LIBEVENT_VERSION.tar.gz"
"$SCRIPT_DIR/fetch-pinned.sh" "$JEMALLOC_URL" "$JEMALLOC_SHA256" "$SOURCES/jemalloc-$JEMALLOC_VERSION.tar.bz2"
"$SCRIPT_DIR/fetch-pinned.sh" "$UTF8PROC_URL" "$UTF8PROC_SHA256" "$SOURCES/utf8proc-$UTF8PROC_VERSION.tar.gz"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
tar -xzf "$SOURCES/tmux-$TMUX_VERSION.tar.gz" -C "$work"
tar -xzf "$SOURCES/libevent-$LIBEVENT_VERSION.tar.gz" -C "$work"
tar -xjf "$SOURCES/jemalloc-$JEMALLOC_VERSION.tar.bz2" -C "$work"
tar -xzf "$SOURCES/utf8proc-$UTF8PROC_VERSION.tar.gz" -C "$work"
tmux_src="$work/tmux-$TMUX_VERSION"
libevent_src="$work/libevent-$LIBEVENT_VERSION"
jemalloc_src="$work/jemalloc-$JEMALLOC_VERSION"
utf8proc_src="$work/utf8proc-$UTF8PROC_VERSION"

# The licences that travel with the binary are checked in beside its notice
# (mac-app/third-party/tmux); they must be the pinned sources' own, word for word.
for pair in "$tmux_src/COPYING:COPYING" "$libevent_src/LICENSE:LICENSE.libevent" \
  "$jemalloc_src/COPYING:COPYING.jemalloc" "$utf8proc_src/LICENSE.md:LICENSE.utf8proc.md"; do
  cmp -s "${pair%%:*}" "$NOTICES/${pair#*:}" || {
    echo "error: $NOTICES/${pair#*:} is not ${pair%%:*} from the pinned source; update the notice" >&2
    exit 1
  }
done

# The same clean environment for every step: no Xcode build settings, no
# Homebrew include paths or pkg-config, only the tools named here.
# SOURCE_DATE_EPOCH pins __DATE__/__TIME__; ZERO_AR_DATE keeps dates out of
# the static archives and the link; LC_ALL=C keeps every sort the same.
clean_env=(env -i "HOME=$HOME" "PATH=/usr/bin:/bin:/usr/sbin:/sbin" "MACOSX_DEPLOYMENT_TARGET=$MACOS_MIN"
  "SOURCE_DATE_EPOCH=1767225600" "ZERO_AR_DATE=1" "LC_ALL=C")
[[ -n "${DEVELOPER_DIR:-}" ]] && clean_env+=("DEVELOPER_DIR=$DEVELOPER_DIR")
jobs="$(sysctl -n hw.ncpu)"
deps="$work/deps"
# Build paths out of the binary, so the same inputs give the same outputs.
# jemalloc brings its own optimisation flags (-O3); the rest get -O2.
arch_cflags="-arch $ARCH -mmacosx-version-min=$MACOS_MIN -ffile-prefix-map=$work=."
cflags="-O2 $arch_cflags"
# -S: no debug map (it names every object file by its temporary path).
ldflags="-arch $ARCH -mmacosx-version-min=$MACOS_MIN -Wl,-S"
triple="$([[ "$ARCH" == arm64 ]] && echo aarch64 || echo x86_64)-apple-darwin"
# configure finds a function by linking against the SDK, which knows functions
# newer than the oldest macOS conch runs on: pipe2 and dup3 are macOS 27. Found
# anyway, libevent calls pipe2 through a weak import that is NULL on macOS 26
# and older, and tmux crashed on its first command (measured). So these are
# "not found", and the weak-import check below catches the next one.
too_new=(ac_cv_func_pipe2=no ac_cv_func_dup3=no)
host=()
[[ "$ARCH" != "$(uname -m)" ]] && host=(--host="$triple")

step() { # <name> <dir> <command…>: run in <dir>, the log shown only on failure
  local name="$1" dir="$2"
  shift 2
  (cd "$dir" && "${clean_env[@]}" "$@") >"$work/$name.log" 2>&1 || { tail -40 "$work/$name.log" >&2; exit 1; }
}

echo "building libevent $LIBEVENT_VERSION ($ARCH)" >&2
step libevent-configure "$libevent_src" ./configure ${host[@]+"${host[@]}"} --prefix="$deps" "${too_new[@]}" \
  --disable-shared --enable-static --disable-openssl --disable-mbedtls --disable-samples \
  --disable-libevent-regress --disable-debug-mode --disable-dependency-tracking \
  CFLAGS="$cflags" LDFLAGS="$ldflags"
step libevent-build "$libevent_src" make -j"$jobs"
step libevent-install "$libevent_src" make install

# Page size and address bits pinned per architecture rather than probed on
# the build machine: 16 KiB pages on Apple silicon, 4 KiB on Intel (and under
# Rosetta); 48 address bits covers both.
echo "building jemalloc $JEMALLOC_VERSION ($ARCH)" >&2
lg_page=$([[ "$ARCH" == arm64 ]] && echo 14 || echo 12)
step jemalloc-configure "$jemalloc_src" ./configure --host="$triple" --prefix="$deps" "${too_new[@]}" \
  --with-jemalloc-prefix=je_ --with-lg-page="$lg_page" --with-lg-vaddr=48 \
  --disable-cxx --disable-debug \
  CFLAGS="$arch_cflags" LDFLAGS="$ldflags"
step jemalloc-build "$jemalloc_src" make -j"$jobs" build_lib_static
step jemalloc-install "$jemalloc_src" make install_include install_lib_static

echo "building utf8proc $UTF8PROC_VERSION ($ARCH)" >&2
step utf8proc-build "$utf8proc_src" make libutf8proc.a CFLAGS="$cflags -DUTF8PROC_STATIC"
mkdir -p "$deps/include" "$deps/lib"
install -m 0644 "$utf8proc_src/utf8proc.h" "$deps/include/"
install -m 0644 "$utf8proc_src/libutf8proc.a" "$deps/lib/"

# tmux, as Homebrew's formula configures it on macOS, against those archives
# (named by path, so no .dylib of the same name can win) and the system's
# ncurses. The *_CFLAGS/*_LIBS pairs are pkg-config's own override variables:
# nothing is looked up. jemalloc's zone registers itself in a constructor that
# nothing calls, so the link is told to keep it (-u); its one public call in
# tmux, mallctl, carries the je_ prefix.
echo "building tmux $TMUX_VERSION ($ARCH)" >&2
step tmux-configure "$tmux_src" ./configure ${host[@]+"${host[@]}"} --prefix=/usr/local --sysconfdir=/etc "${too_new[@]}" \
  --disable-dependency-tracking --enable-utf8proc --enable-jemalloc --enable-sixel --with-TERM="$DEFAULT_TERM" \
  LIBEVENT_CORE_CFLAGS="-I$deps/include" LIBEVENT_CORE_LIBS="$deps/lib/libevent_core.a" \
  LIBUTF8PROC_CFLAGS="-I$deps/include -DUTF8PROC_STATIC" LIBUTF8PROC_LIBS="$deps/lib/libutf8proc.a" \
  JEMALLOC_CFLAGS="-I$deps/include -Dmallctl=je_mallctl" JEMALLOC_LIBS="$deps/lib/libjemalloc.a -Wl,-u,_je_zone_register" \
  CFLAGS="$cflags" LDFLAGS="$ldflags"
for feature in "utf8proc: $UTF8PROC_VERSION|utf8proc: on" "jemalloc: on" "ncurses: on"; do
  grep -Eq "$feature" "$work/tmux-configure.log" || {
    tail -40 "$work/tmux-configure.log" >&2
    echo "error: tmux configured without ${feature%%:*}" >&2
    exit 1
  }
done
step tmux-build "$tmux_src" make -j"$jobs"
binary="$tmux_src/tmux"

# What tmux compiles from its compat/ directory depends on what configure found
# macOS lacks — OpenBSD's imsg, vis and tree.h, BSD's queue.h and daemon()
# among them, each under its own ISC or BSD notice — and differs by slice: the
# Intel one, configured as a cross build, cannot run tmux's strtonum probe and
# compiles the compat copy. The checked-in LICENSE.compat must hold, verbatim,
# the notice of every file this build compiled in.
notice_block() { # <file>: its first comment block that states a copyright or a dedication
  awk '/\/\*/ && !done { inb = 1; buf = "" }
    inb { buf = buf $0 "\n" }
    /\*\// && inb { inb = 0; if (buf ~ /Copyright|[Pp]ublic [Dd]omain/) { printf "%s", buf; done = 1 } }' "$1"
}
compat=()
for object in "$tmux_src"/compat/*.o; do compat+=("compat/$(basename "${object%.o}").c"); done
defs="$(grep '^DEFS' "$tmux_src/Makefile")"
for pair in HAVE_QUEUE_H:queue HAVE_TREE_H:tree HAVE_BITSTRING_H:bitstring HAVE_VIS:vis; do
  grep -q -- "-D${pair%%:*}=1" <<<"$defs" || compat+=("compat/${pair#*:}.h")
done
shipped="$(cat "$NOTICES/LICENSE.compat")"
unlisted=()
for file in "${compat[@]}"; do
  block="$(printf '==> %s <==\n' "$file"; notice_block "$tmux_src/$file")"
  [[ "$shipped" == *"$block"* ]] || unlisted+=("$file")
done
[[ "${#unlisted[@]}" -eq 0 ]] || {
  echo "error: $NOTICES/LICENSE.compat lacks the notice of ${unlisted[*]}, which this $ARCH build compiled in; add it" >&2
  exit 1
}

# Only the system may be linked dynamically: anything else would be a library
# the user's Mac does not have. The build directory must not be in the binary
# (it would differ between two builds of the same pins). Tool output is read
# whole before it is searched: a grep -q closing a pipe early would fail it
# under pipefail.
[[ "$(lipo -archs "$binary")" == "$ARCH" ]] || { echo "error: $binary is not $ARCH-only" >&2; exit 1; }
links="$(otool -L "$binary" | tail -n +2 | awk '{print $1}')"
outside="$(grep -vE '^(/System/Library/Frameworks/|/usr/lib/)' <<<"$links" || true)"
[[ -z "$outside" ]] || { echo "error: $binary links a library outside the system: $outside" >&2; exit 1; }
grep -qx '/usr/lib/libncurses.5.4.dylib' <<<"$links" || { echo "error: $binary does not use the system's ncurses" >&2; exit 1; }
# A weak import is a function newer than MACOS_MIN: NULL on an older macOS,
# so calling it crashes. The one allowed is the one jemalloc checks for NULL.
weak="$(nm -m "$binary" | grep '(undefined) weak external' | grep -v ' _malloc_default_purgeable_zone ' || true)"
[[ -z "$weak" ]] || { echo "error: $binary imports functions newer than macOS $MACOS_MIN:" >&2; echo "$weak" >&2; exit 1; }
# Linked in, not merely configured: jemalloc's zone and its one public call,
# utf8proc's widths, libevent's loop.
symbols="$(nm "$binary")"
for symbol in _je_zone_register _je_mallctl _utf8proc_charwidth _event_base_loop; do
  grep -Eq " [Tt] $symbol\$" <<<"$symbols" || { echo "error: $binary does not carry $symbol" >&2; exit 1; }
done
if grep -aq "$work" "$binary"; then
  echo "error: $binary names its build directory ($work)" >&2
  exit 1
fi
# Run it when this Mac can (its own architecture, or Intel under Rosetta).
if reported="$(arch "-$ARCH" "$binary" -V 2>/dev/null)"; then
  [[ "$reported" == "tmux $TMUX_VERSION" ]] || { echo "error: $binary reports '$reported', not tmux $TMUX_VERSION" >&2; exit 1; }
fi

stage="$work/out"
mkdir -p "$stage"
install -m 0755 "$binary" "$stage/tmux"
(cd "$stage" && shasum -a 256 tmux > tmux.sha256)
echo "$RECIPE" > "$stage/recipe"
mkdir -p "$CACHE_ROOT"
rm -rf "$OUT.partial" "$OUT"
mv "$stage" "$OUT.partial"
mv "$OUT.partial" "$OUT"
echo "$OUT"
