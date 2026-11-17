// A MicroPython REPL for Scratch, built with wasi-sdk and compiled by wasm2sb3.
//
// Input arrives a line at a time from WASI stdin, which the Scratch runtime
// implements with "ask and wait"; output goes to the stage's stdout list.
// Typed lines are echoed so the transcript reads like a terminal session.
// C stdio is avoided on purpose: printf alone would add megabytes of blocks.

#include <string.h>
#include <unistd.h>
#include "py/builtin.h"
#include "py/compile.h"
#include "py/gc.h"
#include "py/lexer.h"
#include "py/mperrno.h"
#include "py/mphal.h"
#include "py/repl.h"
#include "py/runtime.h"
#include "py/stackctrl.h"
#include "scratch.h"

void scratch_module_init(void);
mp_obj_t scratch_frame_callback(void);
void scratch_clear_frame_callback(void);

#ifndef HEAP_SIZE
#define HEAP_SIZE (192 * 1024)
#endif
static char heap[HEAP_SIZE];

// ---- HAL ----------------------------------------------------------------------

// Output is buffered until a newline or until input is requested, so a prompt
// becomes the question shown by "ask and wait".
static char outbuf[256];
static size_t outlen;

static void out_flush(void) {
    size_t off = 0;
    while (off < outlen) {
        ssize_t n = write(1, outbuf + off, outlen - off);
        if (n <= 0) {
            break;
        }
        off += (size_t)n;
    }
    outlen = 0;
}

void mp_hal_stdout_tx_strn_cooked(const char *str, size_t len) {
    for (size_t i = 0; i < len; i++) {
        if (outlen == sizeof outbuf) {
            out_flush();
        }
        outbuf[outlen++] = str[i];
        if (str[i] == '\n') {
            out_flush();
        }
    }
}

static void puts_raw(const char *s) {
    mp_hal_stdout_tx_strn_cooked(s, strlen(s));
}

// Reads one line (without the newline). Returns 0 at end of input.
static int read_line(char *buf, size_t size) {
    out_flush();
    size_t n = 0;
    for (;;) {
        char c;
        if (read(0, &c, 1) != 1) {
            if (n == 0) {
                return 0;
            }
            break;
        }
        if (c == '\n') {
            break;
        }
        if (c != '\r' && n + 1 < size) {
            buf[n++] = c;
        }
    }
    buf[n] = 0;
    puts_raw(buf); // echo what was typed
    puts_raw("\n");
    return 1;
}

int mp_hal_readline(vstr_t *line, const char *prompt) {
    char buf[256];
    puts_raw(prompt);
    if (!read_line(buf, sizeof buf)) {
        return CHAR_CTRL_D;
    }
    vstr_add_str(line, buf);
    return 0;
}

// MicroPython's GC finds roots by scanning the C stack, but wasm keeps most
// values in locals outside linear memory. Under wasm2sb3 every wasm local is
// a Scratch variable, so the compiled program can hand all of them to the GC
// (gc_roots_begin/gc_roots_copy) and collection is safe at any time. Hosts
// that cannot do this return -1; then we only collect at the REPL prompt,
// when no interpreter frames are active.
static int gc_at_top_level;

void gc_collect(void) {
    int n = gc_roots_begin();
    if (n < 0 && !gc_at_top_level) {
        return;
    }
    gc_collect_start();
    if (n >= 0) {
        // The shadow stack in linear memory (address-taken C locals).
        volatile uintptr_t marker = 0;
        uintptr_t top = (uintptr_t)MP_STATE_THREAD(stack_top);
        gc_collect_root((void **)&marker, (top - (uintptr_t)&marker) / sizeof(uintptr_t));
        // Everything held in Scratch variables.
        static uintptr_t buf[128];
        for (int i = 0; i < n; i += 128) {
            int k = n - i < 128 ? n - i : 128;
            gc_roots_copy(buf, i, k);
            gc_collect_root((void **)buf, (size_t)k);
        }
    }
    gc_collect_end();
}

void nlr_jump_fail(void *val) {
    (void)val;
    puts_raw("FATAL: uncaught exception\n");
    out_flush();
    __builtin_trap();
}

// There is no filesystem: only built-in modules can be imported.
mp_import_stat_t mp_import_stat(const char *path) {
    (void)path;
    return MP_IMPORT_STAT_NO_EXIST;
}

mp_lexer_t *mp_lexer_new_from_file(qstr filename) {
    (void)filename;
    mp_raise_OSError(MP_ENOENT);
}

enum { RUN_OK, RUN_ERROR, RUN_EXIT };

// Prints an uncaught exception; SystemExit just ends the program.
static int report(mp_obj_t exc) {
    if (mp_obj_is_subclass_fast(MP_OBJ_FROM_PTR(mp_obj_get_type(exc)), MP_OBJ_FROM_PTR(&mp_type_SystemExit))) {
        return RUN_EXIT;
    }
    mp_obj_print_exception(&mp_plat_print, exc);
    return RUN_ERROR;
}

// ---- running code ---------------------------------------------------------------

static int run_source(const char *src, mp_parse_input_kind_t kind, qstr name) {
    nlr_buf_t nlr;
    if (nlr_push(&nlr) == 0) {
        mp_lexer_t *lex = mp_lexer_new_from_str_len(name, src, strlen(src), 0);
        mp_parse_tree_t tree = mp_parse(lex, kind);
        mp_obj_t fun = mp_compile(&tree, name, kind == MP_PARSE_SINGLE_INPUT);
        mp_call_function_0(fun);
        nlr_pop();
        return RUN_OK;
    }
    return report((mp_obj_t)nlr.ret_val);
}

// Python's recursion limit, as bytes of C stack (the stack is 64 KB).
#ifndef PY_STACK_LIMIT
#define PY_STACK_LIMIT (40 * 1024)
#endif

static void start_python(void *stack_top) {
    mp_stack_set_top(stack_top);
    mp_stack_set_limit(PY_STACK_LIMIT);
    gc_init(heap, heap + sizeof heap);
    mp_init();
    scratch_module_init();
}

#if defined(SCRATCH_SCRIPT) || defined(SCRATCH_LIST_SCRIPT)

// ---- script modes: run a program, then its on_frame callback ---------------------

#ifdef SCRATCH_LIST_SCRIPT

// The program is whatever the "Python code" list holds when the green flag is
// clicked, one line per item; traceback line numbers are item numbers.
__attribute__((export_name("start"))) void start(void) {
    int top;
    start_python(&top);
    vstr_t src;
    vstr_init(&src, 512);
    static char line[1024];
    int n = script_lines();
    for (int i = 0; i < n; i++) {
        int len = script_line(i, line, sizeof line);
        vstr_add_strn(&src, line, (size_t)len);
        vstr_add_char(&src, '\n');
    }
    run_source(vstr_null_terminated_str(&src), MP_PARSE_FILE_INPUT, qstr_from_str("Python code"));
    vstr_clear(&src);
    out_flush();
}

#else

#include "script.h" // script_name, script_src: a bundled .py file

__attribute__((export_name("start"))) void start(void) {
    int top;
    start_python(&top);
    run_source(script_src, MP_PARSE_FILE_INPUT, qstr_from_str(script_name));
    out_flush();
}

#endif

// Called once per Scratch frame, with a screen refresh in between.
__attribute__((export_name("frame"))) void frame(void) {
    mp_obj_t fn = scratch_frame_callback();
    if (fn == MP_OBJ_NULL) {
        return;
    }
    int top;
    mp_stack_set_top(&top);
    nlr_buf_t nlr;
    if (nlr_push(&nlr) == 0) {
        mp_call_function_0(fn);
        nlr_pop();
    } else {
        scratch_clear_frame_callback();
        report((mp_obj_t)nlr.ret_val);
    }
    out_flush();
}

#else

// ---- REPL mode ------------------------------------------------------------------

int main(void) {
    int top;
    start_python(&top);
    puts_raw("MicroPython " MICROPY_VERSION_STRING " on " MICROPY_HW_BOARD_NAME "; type exit() to stop\n");

    static char src[4096], line[512];
    for (;;) {
        // Collecting sweeps the whole heap, which is slow in Scratch, so only
        // do it at the prompt once a quarter of the heap has been allocated.
        if (MP_STATE_MEM(gc_alloc_amount) * MICROPY_BYTES_PER_GC_BLOCK > HEAP_SIZE / 4) {
            gc_at_top_level = 1;
            gc_collect();
            gc_at_top_level = 0;
        }

        puts_raw(">>> ");
        if (!read_line(line, sizeof line)) {
            break;
        }
        if (line[0] == 0) {
            continue;
        }
        if (strcmp(line, "exit()") == 0 || strcmp(line, "quit()") == 0) {
            break;
        }
        strcpy(src, line);
        while (mp_repl_continue_with_input(src)) {
            puts_raw("... ");
            if (!read_line(line, sizeof line)) {
                break;
            }
            if (strlen(src) + strlen(line) + 2 >= sizeof src) {
                break;
            }
            strcat(src, "\n");
            strcat(src, line);
        }
        if (run_source(src, MP_PARSE_SINGLE_INPUT, MP_QSTR__lt_stdin_gt_) == RUN_EXIT) {
            break;
        }
    }
    out_flush();
    mp_deinit();
    return 0;
}

#endif
