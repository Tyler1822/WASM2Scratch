#!/bin/sh
# Builds the interpreter with an embedded guest module:
#   interp/build.sh guest.wasm [name]   -> interp/build/<name>.wasm (and .sb3 with SB3=1)
# Extra clang flags via CFLAGS (e.g. CFLAGS=-DCOUNT_INSTRUCTIONS).
set -e
GUEST=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
cd "$(dirname "$0")"
ROOT=$(cd .. && pwd)
SDK=${WASI_SDK_PATH:-$(ls -d "$ROOT"/toolchain/wasi-sdk-* | head -1)}
NAME=${2:-$(basename "$GUEST" .wasm)}
mkdir -p build
node embed.mjs "$GUEST" build/guest.h
"$SDK/bin/clang" -Oz ${CFLAGS} -I build -I ../include -o "build/$NAME.wasm" wasmi.c -lm
WASM2SB3_FLAGS=""
if echo "$CFLAGS" | grep -q REACTOR; then WASM2SB3_FLAGS="--entry start"; fi
ls -l "build/$NAME.wasm"
if [ -n "$SB3" ]; then
  node "$ROOT/bin/wasm2sb3.js" "build/$NAME.wasm" $WASM2SB3_FLAGS $SB3_FLAGS -o "build/$NAME.sb3"
fi
