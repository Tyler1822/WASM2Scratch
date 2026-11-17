#!/bin/sh
# Builds the hybrid: the interpreter with an embedded guest, plus the guest
# functions listed in funcs.txt translated to C (w2c.mjs) and compiled in.
#   interp/hybrid.sh guest.wasm funcs.txt name   -> interp/build/<name>.wasm (and .sb3 with SB3=1)
# Extra clang flags via CFLAGS; the guest is assumed to be a start/frame reactor.
set -e
GUEST=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
FUNCS=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
cd "$(dirname "$0")"
ROOT=$(cd .. && pwd)
SDK=${WASI_SDK_PATH:-$(ls -d "$ROOT"/toolchain/wasi-sdk-* | head -1)}
NAME=$3
mkdir -p build
node w2c.mjs "$GUEST" "$FUNCS" build/native.c
node embed.mjs "$GUEST" build/guest.h build/native.c
node prune.mjs "$GUEST" build/native.c wasmi.c build/wasmi_pruned.c
# Smaller interpreter tables: Scratch's memory list must stay under 200,000 words.
SIZES="-DSTACK_N=8192 -DCTL_N=1024 -DFRAME_N=512 -DCACHE_N=2048 -DMAX_FUNCS=1024 -DMAX_TABLE=512 -DGUEST_MEM_PAGES=${GUEST_MEM_PAGES:-5} -Wl,-z,stack-size=16384"
"$SDK/bin/clang" ${OPT:--Oz} -DHYBRID -DREACTOR -mexec-model=reactor $SIZES ${CFLAGS} -I . -I build -I ../include -o "build/$NAME.wasm" build/wasmi_pruned.c -lm
ls -l "build/$NAME.wasm"
if [ -n "$SB3" ]; then
  node "$ROOT/bin/wasm2sb3.js" "build/$NAME.wasm" --entry start --minify --gc-roots '^(n|ci)_[0-9]+[.]' --script-list ../examples/python/runner_default.py $SB3_FLAGS -o "build/$NAME.sb3"
fi
