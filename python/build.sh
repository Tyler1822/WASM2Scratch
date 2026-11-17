#!/bin/sh
# Builds MicroPython for Scratch.
#
#   ./build.sh                 the REPL:   build/micropython.wasm (+ .sb3 with --sb3)
#   ./build.sh app.py          a program:  build/app.wasm and build/app.sb3
#   ./build.sh --list [d.py]   generic runner whose program is an editable
#                              Scratch list (starting with d.py): build/python_runner.sb3
#   ./build.sh --hybrid        that runner as an interpreter/native hybrid small
#                              enough to save online: build/python_runner_hybrid.sb3
#
# Needs wasi-sdk in ../toolchain/ (or $WASI_SDK_PATH) and the MicroPython
# source in ../toolchain/micropython-*/.
set -e
cd "$(dirname "$0")"
ROOT=$(cd .. && pwd)
SDK=${WASI_SDK_PATH:-$(ls -d "$ROOT"/toolchain/wasi-sdk-* | head -1)}
MP=$(ls -d "$ROOT"/toolchain/micropython-* | head -1)
# Make cannot cope with spaces in paths, so build through a space-free link.
LINKDIR=$(mktemp -d)
trap 'rm -rf "$LINKDIR"' EXIT
ln -s "$SDK" "$LINKDIR/sdk"
ln -s "$MP" "$LINKDIR/mp"
CC="$LINKDIR/sdk/bin/clang"
SJLJ="-mllvm -wasm-enable-sjlj"
OPT=${OPT:--Oz}

if [ ! -d build/micropython_embed ] || [ mpconfigport.h -nt build/micropython_embed ]; then
  rm -rf build/micropython_embed build-embed
  make -s -f Makefile.embed MICROPYTHON_TOP="$LINKDIR/mp" CC="$CC $SJLJ"
fi

SRCS=$(find build/micropython_embed -name '*.c' ! -name embed_util.c ! -name gchelper_generic.c ! -name mphalport.c)
CFLAGS="$SJLJ $OPT -DNDEBUG -I. -I../include -Ibuild/micropython_embed -Wno-unused-command-line-argument"
LDFLAGS="-Wl,-z,stack-size=65536 -Wl,--strip-debug -lsetjmp -lm"

case "$1" in
  --list)
    # Generic runner: the program lives in an editable Scratch list.
    DEFAULT=${2:-../examples/python/runner_default.py}
    "$CC" $CFLAGS -DSCRATCH_LIST_SCRIPT -mexec-model=reactor -o build/python_runner.wasm main.c modscratch.c $SRCS $LDFLAGS
    ls -l build/python_runner.wasm
    node "$ROOT/bin/wasm2sb3.js" build/python_runner.wasm --entry start --script-list "$DEFAULT" -o build/python_runner.sb3
    ;;
  --hybrid)
    # The list runner as a hybrid: interpreted MicroPython with its hottest
    # functions (interp/python_native.txt) compiled to Scratch blocks.
    "$CC" $CFLAGS -DSCRATCH_LIST_SCRIPT -mexec-model=reactor -o build/python_runner.wasm main.c modscratch.c $SRCS $LDFLAGS
    SB3=1 "$ROOT/interp/hybrid.sh" build/python_runner.wasm "$ROOT/interp/python_native.txt" python_runner_hybrid
    cp "$ROOT/interp/build/python_runner_hybrid.sb3" build/
    ;;
  *.py)
    NAME=$(basename "$1" .py)
    python3 - "$1" "$NAME" > build/script.h <<'PY'
import json, sys
src = open(sys.argv[1], encoding='utf-8').read()
print('static const char script_name[] = %s;' % json.dumps(sys.argv[2] + '.py'))
print('static const char script_src[] = %s;' % json.dumps(src))
PY
    "$CC" $CFLAGS -DSCRATCH_SCRIPT -Ibuild -mexec-model=reactor -o "build/$NAME.wasm" main.c modscratch.c $SRCS $LDFLAGS
    ls -l "build/$NAME.wasm"
    node "$ROOT/bin/wasm2sb3.js" "build/$NAME.wasm" --entry start -o "build/$NAME.sb3"
    ;;
  *)
    "$CC" $CFLAGS -o build/micropython.wasm main.c modscratch.c $SRCS $LDFLAGS
    ls -l build/micropython.wasm
    if [ "$1" = "--sb3" ]; then
      node "$ROOT/bin/wasm2sb3.js" build/micropython.wasm -o build/micropython.sb3
    fi
    ;;
esac
