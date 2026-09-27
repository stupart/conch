#!/bin/bash
# Build the speech engine conch.app carries, for one architecture, verify it,
# cache it, print the directory.
#
#   scripts/fetch-engine.sh arm64     -> /…/build/vendor/engine-<key>-arm64
#   scripts/fetch-engine.sh x86_64
#
# The directory holds whisper-cli and whisper-server (whisper.cpp at the
# revision seashell pins, static, Metal on Apple silicon), sox (SoX 14.4.2,
# static, CoreAudio and its built-in formats only), the Silero VAD model, and
# the verified SoX source tarball that ships beside its binary. It is
# seashell's engine: the same whisper.cpp revision and build flags its formula
# uses, the same model pins, and SoX for capture, as seashell captures.
#
# Pinned by revision/version AND by the sha256 of every download: a changed or
# substituted source fails here, before anything is built or copied into a
# signed app. Built under `env -i` with explicit flags, so neither Xcode's
# build environment nor a Homebrew prefix leaks in. The cache key is the hash
# of this script, so changing a pin or a flag rebuilds.
#
# Needs cmake (brew install cmake) and the Xcode command line tools.
# Test seam: CONCH_ENGINE_CACHE (the cache root).
set -euo pipefail

ARCH="${1:-}"
case "$ARCH" in
  arm64 | x86_64) ;;
  *) echo "usage: scripts/fetch-engine.sh arm64|x86_64" >&2; exit 2 ;;
esac

WHISPER_REV=927cfce34f31707e17f2bff35c349632fb9e2c3a
WHISPER_SHA256=41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde
SOX_VERSION=14.4.2
SOX_SHA256=b45f598643ffbd8e363ff24d61166ccec4836fea6d3888881b8df53e3bb55f6c
VAD_FILE=ggml-silero-v6.2.0.bin
VAD_SHA256=2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987
MACOS_MIN=14.0

WHISPER_URL="https://github.com/ggml-org/whisper.cpp/archive/$WHISPER_REV.tar.gz"
SOX_URL="https://downloads.sourceforge.net/project/sox/sox/$SOX_VERSION/sox-$SOX_VERSION.tar.gz"
VAD_URL="https://huggingface.co/ggml-org/whisper-vad/resolve/main/$VAD_FILE"

SCRIPT="${BASH_SOURCE[0]}"
REPO_ROOT="$(cd "$(dirname "$SCRIPT")/.." && pwd)"
KEY="$(shasum -a 256 "$SCRIPT" | cut -c1-12)"
CACHE_ROOT="${CONCH_ENGINE_CACHE:-$REPO_ROOT/build/vendor}"
OUT="$CACHE_ROOT/engine-$KEY-$ARCH"
SOX_TARBALL="sox-$SOX_VERSION.tar.gz"
FILES=(whisper-cli whisper-server sox "$VAD_FILE" "$SOX_TARBALL")

# A cached build is reused only while it is still the exact bytes this recipe
# produced: the digests recorded at build time must match.
if [[ -f "$OUT/engine.sha256" ]] && (cd "$OUT" && shasum -a 256 -c engine.sha256 >/dev/null 2>&1); then
  echo "$OUT"
  exit 0
fi

CMAKE="${CMAKE:-$(command -v cmake || true)}"
for candidate in /opt/homebrew/bin/cmake /usr/local/bin/cmake; do
  [[ -n "$CMAKE" ]] && break
  [[ -x "$candidate" ]] && CMAKE="$candidate"
done
[[ -n "$CMAKE" ]] || { echo "error: cmake is needed to build whisper.cpp (brew install cmake)" >&2; exit 1; }
xcrun --find clang >/dev/null 2>&1 || { echo "error: the Xcode command line tools are needed (xcode-select --install)" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fetch() { # <url> <sha256> <dest>
  echo "fetching $1" >&2
  curl -fsSL --retry 3 --connect-timeout 30 --max-time 900 -o "$3" "$1"
  echo "$2  $3" | shasum -a 256 -c - >&2
}

fetch "$WHISPER_URL" "$WHISPER_SHA256" "$work/whisper.tar.gz"
fetch "$SOX_URL" "$SOX_SHA256" "$work/$SOX_TARBALL"
fetch "$VAD_URL" "$VAD_SHA256" "$work/$VAD_FILE"
tar -xzf "$work/whisper.tar.gz" -C "$work"
tar -xzf "$work/$SOX_TARBALL" -C "$work"

# The same clean environment for every step: no Xcode build settings, no
# Homebrew include paths, only the tools named here.
# SOURCE_DATE_EPOCH pins __DATE__/__TIME__ (SoX stamps its build time into the
# binary), so two builds of the same pins are the same bytes.
clean_env=(env -i "HOME=$HOME" "PATH=/usr/bin:/bin:/usr/sbin:/sbin" "MACOSX_DEPLOYMENT_TARGET=$MACOS_MIN"
  "SOURCE_DATE_EPOCH=1767225600")
[[ -n "${DEVELOPER_DIR:-}" ]] && clean_env+=("DEVELOPER_DIR=$DEVELOPER_DIR")
jobs="$(sysctl -n hw.ncpu)"
# Build paths out of the binaries, so the same inputs give the same outputs.
prefix_map="-ffile-prefix-map=$work=."

# whisper.cpp, as seashell's formula builds it: static, no native tuning,
# Metal compiled into the binary on Apple silicon. Intel has no Metal path in
# ggml's Homebrew build either; it gets the Haswell baseline instead.
if [[ "$ARCH" == arm64 ]]; then
  arch_flags=(-DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON)
else
  arch_flags=(-DGGML_METAL=OFF -DGGML_SSE42=ON -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_BMI2=ON -DGGML_FMA=ON -DGGML_F16C=ON)
fi
whisper_src="$work/whisper.cpp-$WHISPER_REV"
echo "building whisper.cpp ($ARCH)" >&2
"${clean_env[@]}" "$CMAKE" -S "$whisper_src" -B "$work/whisper-build" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES="$ARCH" -DCMAKE_OSX_DEPLOYMENT_TARGET="$MACOS_MIN" \
  -DCMAKE_C_FLAGS="$prefix_map" -DCMAKE_CXX_FLAGS="$prefix_map" \
  -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_SERVER=ON \
  -DWHISPER_CURL=OFF -DWHISPER_SDL2=OFF "${arch_flags[@]}" >"$work/whisper-configure.log" 2>&1 \
  || { tail -40 "$work/whisper-configure.log" >&2; exit 1; }
"${clean_env[@]}" "$CMAKE" --build "$work/whisper-build" --config Release --parallel "$jobs" \
  --target whisper-cli whisper-server >"$work/whisper-build.log" 2>&1 \
  || { tail -40 "$work/whisper-build.log" >&2; exit 1; }

# SoX: a static program with the CoreAudio driver and its built-in formats
# (raw and wav are all conch records), every optional library off so nothing
# from the build machine is linked. -d (the default device) is all conch opens.
host_triple=()
[[ "$ARCH" != "$(uname -m)" ]] && host_triple=(--host="$([[ "$ARCH" == arm64 ]] && echo aarch64 || echo x86_64)-apple-darwin")
sox_src="$work/sox-$SOX_VERSION"
echo "building sox ($ARCH)" >&2
(
  cd "$sox_src"
  "${clean_env[@]}" ./configure ${host_triple[@]+"${host_triple[@]}"} --disable-shared --enable-static --disable-openmp \
    --without-libltdl --without-magic --without-png --without-ladspa --without-mad --without-id3tag \
    --without-lame --without-twolame --with-oggvorbis=no --with-opus=no --with-flac=no --with-amrwb=no \
    --with-amrnb=no --with-wavpack=no --with-sndio=no --with-coreaudio=yes --with-alsa=no --with-ao=no \
    --with-pulseaudio=no --with-waveaudio=no --with-sndfile=no --with-oss=no --with-sunaudio=no \
    --with-mp3=no --with-gsm=no --with-lpc10=no \
    CFLAGS="-O2 -arch $ARCH -mmacosx-version-min=$MACOS_MIN -Wno-incompatible-function-pointer-types $prefix_map" \
    LDFLAGS="-arch $ARCH -mmacosx-version-min=$MACOS_MIN" >"$work/sox-configure.log" 2>&1 \
    || { tail -40 "$work/sox-configure.log" >&2; exit 1; }
  "${clean_env[@]}" make -j"$jobs" >"$work/sox-build.log" 2>&1 || { tail -40 "$work/sox-build.log" >&2; exit 1; }
)

# Only system frameworks and libSystem may be linked: anything else would be a
# library the user's Mac does not have.
for binary in "$work/whisper-build/bin/whisper-cli" "$work/whisper-build/bin/whisper-server" "$sox_src/src/sox"; do
  lipo -info "$binary" | grep -q "architecture: $ARCH\$" || { echo "error: $binary is not $ARCH-only" >&2; exit 1; }
  if otool -L "$binary" | tail -n +2 | awk '{print $1}' | grep -vE '^(/System/Library/Frameworks/|/usr/lib/)' | grep -q .; then
    echo "error: $binary links a library outside the system:" >&2
    otool -L "$binary" >&2
    exit 1
  fi
done

stage="$work/out"
mkdir -p "$stage"
install -m 0755 "$work/whisper-build/bin/whisper-cli" "$work/whisper-build/bin/whisper-server" "$sox_src/src/sox" "$stage/"
install -m 0644 "$work/$VAD_FILE" "$work/$SOX_TARBALL" "$stage/"
(cd "$stage" && shasum -a 256 "${FILES[@]}" > engine.sha256)
mkdir -p "$CACHE_ROOT"
rm -rf "$OUT.partial" "$OUT"
mv "$stage" "$OUT.partial"
mv "$OUT.partial" "$OUT"
echo "$OUT"
