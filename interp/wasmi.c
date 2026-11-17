// wasmi.c: a small WebAssembly interpreter, written to be compiled to
// WebAssembly and then to Scratch blocks by wasm2sb3.
//
// It runs one embedded guest module (guest.h) that uses WASI and/or the
// `scratch` imports, forwarding them to the host. Design choices for running
// inside Scratch, where memory is a list capped at ~780 KB and every C
// recursion costs a save/restore:
//   * the guest's bytecode is interpreted in place (no translation pass);
//     block ends are found by scanning when first needed and then cached
//   * guest calls, labels and exceptions use explicit stacks, never C recursion
//   * every stack slot is 64 bits; i32/f32 values are kept zero-extended
//
// Supported: the MVP plus sign extension, saturating truncation, bulk
// memory.copy/fill, multi-value blocks and legacy exception handling
// (try/catch/catch_all/throw/rethrow/delegate).

#include <stdint.h>
#include <string.h>
#include <math.h>
#include <unistd.h>
#include <time.h>
#include <stdlib.h>
#include "scratch.h"
#include "guest.h" // guest_wasm[], guest_wasm_len

typedef uint64_t V;
typedef uint32_t u32;
typedef uint64_t u64;
#ifdef HYBRID
// Under-aligned access types for natively compiled guest code (see w2c.mjs).
typedef uint16_t uint16_a1 __attribute__((aligned(1)));
typedef int16_t int16_a1 __attribute__((aligned(1)));
typedef uint32_t u32_a1 __attribute__((aligned(1)));
typedef uint32_t u32_a2 __attribute__((aligned(2)));
typedef int32_t int32_a1 __attribute__((aligned(1)));
typedef int32_t int32_a2 __attribute__((aligned(2)));
typedef uint64_t u64_a1 __attribute__((aligned(1)));
typedef uint64_t u64_a2 __attribute__((aligned(2)));
typedef uint64_t u64_a4 __attribute__((aligned(4)));
typedef float float_a1 __attribute__((aligned(1)));
typedef float float_a2 __attribute__((aligned(2)));
typedef double double_a1 __attribute__((aligned(1)));
typedef double double_a2 __attribute__((aligned(2)));
typedef double double_a4 __attribute__((aligned(4)));
#endif

#ifndef GUEST_MEM_PAGES
#define GUEST_MEM_PAGES 6
#endif
// Table sizes (all of these live in Scratch's memory list, which can only
// grow to 200,000 words, so the hybrid build shrinks them).
#ifndef MAX_TYPES
#define MAX_TYPES 256
#endif
#ifndef MAX_FUNCS
#define MAX_FUNCS 2048
#endif
#define MAX_GLOBALS 64
#ifndef MAX_TABLE
#define MAX_TABLE 1024
#endif
#define MAX_TAGS 8
#ifndef STACK_N
#define STACK_N 16384
#endif
#ifndef CTL_N
#define CTL_N 4096
#endif
#ifndef FRAME_N
#define FRAME_N 1024
#endif
#ifndef CACHE_N
#define CACHE_N 4096
#endif

// ---- output helpers (no stdio: printf would bloat the Scratch project) --------

static void out(const char *s) { write(1, s, strlen(s)); }
static void out_u(uint32_t x) {
    char b[12];
    int i = 11;
    b[i] = 0;
    do { b[--i] = (char)('0' + x % 10); x /= 10; } while (x);
    out(b + i);
}

__attribute__((noreturn)) static void trap(const char *msg) {
    out("wasm trap: ");
    out(msg);
    out("\n");
    exit(134);
}

// ---- module ---------------------------------------------------------------------

static const uint8_t *M;

typedef struct { uint8_t np, nr; uint8_t t[14]; } Type; // t: params then results
static Type types[MAX_TYPES];
static uint32_t ntypes;

enum { IMP_NONE, IMP_UNKNOWN };
typedef struct {
    uint16_t type;
    uint16_t host;      // host function id for imports, 0 for defined functions
    uint32_t code;      // pc of the first instruction
    uint32_t nlocals;   // non-parameter locals
    uint8_t native;     // compiled to C (HYBRID): called through native_dispatch
} Func;
static Func funcs[MAX_FUNCS];
static uint32_t nfuncs, nimports;

static V globals[MAX_GLOBALS];
static uint32_t nglobals;
static uint32_t table[MAX_TABLE];
static uint32_t table_size;
static uint16_t tag_type[MAX_TAGS];
static uint32_t ntags;

static uint8_t mem[GUEST_MEM_PAGES * 65536] __attribute__((aligned(8)));
static uint32_t mem_pages, mem_max_pages;
static uint32_t entry_func = 0xffffffff, init_func = 0xffffffff, start_func = 0xffffffff;

// LEB128 readers over M.
static uint32_t rd_u32(uint32_t *pc) {
    uint32_t r = 0;
    int shift = 0;
    for (;;) {
        uint8_t b = M[(*pc)++];
        r |= (uint32_t)(b & 0x7f) << shift;
        if (!(b & 0x80)) return r;
        shift += 7;
    }
}
static int32_t rd_s32(uint32_t *pc) {
    uint32_t r = 0;
    int shift = 0;
    uint8_t b;
    do {
        b = M[(*pc)++];
        r |= (uint32_t)(b & 0x7f) << shift;
        shift += 7;
    } while (b & 0x80);
    if (shift < 32 && (b & 0x40)) r |= ~0u << shift;
    return (int32_t)r;
}
static int64_t rd_s64(uint32_t *pc) {
    uint64_t r = 0;
    int shift = 0;
    uint8_t b;
    do {
        b = M[(*pc)++];
        r |= (uint64_t)(b & 0x7f) << shift;
        shift += 7;
    } while (b & 0x80);
    if (shift < 64 && (b & 0x40)) r |= ~(uint64_t)0 << shift;
    return (int64_t)r;
}

// ---- host functions ---------------------------------------------------------------

enum {
    H_NONE, H_UNKNOWN,
    H_FD_WRITE, H_FD_READ, H_PROC_EXIT, H_ARGS_SIZES, H_ARGS_GET, H_ENV_SIZES, H_ENV_GET,
    H_CLOCK, H_RANDOM, H_FDSTAT, H_FD_CLOSE, H_FD_SEEK, H_PRESTAT, H_PRESTAT_NAME, H_YIELD,
    H_PEN_DOWN, H_PEN_UP, H_PEN_CLEAR, H_PEN_STAMP, H_PEN_COLOR, H_PEN_HUE, H_PEN_SIZE, H_GOTO,
    H_SAY, H_SAY_INT, H_SAY_NUM, H_MOUSE_X, H_MOUSE_Y, H_MOUSE_DOWN, H_KEY, H_TIMER, H_CLOCK_S,
    H_RESET_TIMER, H_RANDINT, H_WAIT, H_GC_BEGIN, H_GC_COPY, H_SCRIPT_LINES, H_SCRIPT_LINE,
};
static const struct { const char *name; uint8_t id; } host_names[] = {
    {"fd_write", H_FD_WRITE}, {"fd_read", H_FD_READ}, {"proc_exit", H_PROC_EXIT},
    {"args_sizes_get", H_ARGS_SIZES}, {"args_get", H_ARGS_GET},
    {"environ_sizes_get", H_ENV_SIZES}, {"environ_get", H_ENV_GET},
    {"clock_time_get", H_CLOCK}, {"random_get", H_RANDOM}, {"fd_fdstat_get", H_FDSTAT},
    {"fd_close", H_FD_CLOSE}, {"fd_seek", H_FD_SEEK}, {"fd_prestat_get", H_PRESTAT},
    {"fd_prestat_dir_name", H_PRESTAT_NAME}, {"sched_yield", H_YIELD},
    {"pen_down", H_PEN_DOWN}, {"pen_up", H_PEN_UP}, {"pen_clear", H_PEN_CLEAR},
    {"pen_stamp", H_PEN_STAMP}, {"pen_color", H_PEN_COLOR}, {"pen_hue", H_PEN_HUE},
    {"pen_size", H_PEN_SIZE}, {"goto_xy", H_GOTO}, {"say", H_SAY}, {"say_int", H_SAY_INT},
    {"say_num", H_SAY_NUM}, {"mouse_x", H_MOUSE_X}, {"mouse_y", H_MOUSE_Y},
    {"mouse_down", H_MOUSE_DOWN}, {"key_pressed", H_KEY}, {"timer", H_TIMER},
    {"clock", H_CLOCK_S}, {"reset_timer", H_RESET_TIMER}, {"random_int", H_RANDINT},
    {"wait", H_WAIT}, {"gc_roots_begin", H_GC_BEGIN}, {"gc_roots_copy", H_GC_COPY},
    {"script_lines", H_SCRIPT_LINES}, {"script_line", H_SCRIPT_LINE},
};

static int name_eq(uint32_t pc, uint32_t len, const char *s) {
    return strlen(s) == len && memcmp(M + pc, s, len) == 0;
}

static double f64of(V v) { double d; memcpy(&d, &v, 8); return d; }
static V bitsf64(double d) { V v; memcpy(&v, &d, 8); return v; }
static float f32of(V v) { uint32_t u = (uint32_t)v; float f; memcpy(&f, &u, 4); return f; }
static V bitsf32(float f) { uint32_t u; memcpy(&u, &f, 4); return u; }

static uint32_t chk(uint32_t addr, uint32_t len) {
    if ((uint64_t)addr + len > (uint64_t)mem_pages * 65536) trap("out of bounds memory access");
    return addr;
}
// Guest memory access. Aligned addresses (almost all of them in compiled C)
// use typed loads, which wasm2sb3 turns into a single list read; memcpy would
// compile to an unaligned access, which is a byte-by-byte helper in Scratch.
static uint32_t ld32(uint32_t a) {
    if (!(a & 3)) return *(const uint32_t *)(mem + a);
    uint32_t v; memcpy(&v, mem + a, 4); return v;
}
static void st32(uint32_t a, uint32_t v) {
    if (!(a & 3)) { *(uint32_t *)(mem + a) = v; return; }
    memcpy(mem + a, &v, 4);
}
static V ld64(uint32_t a) {
    if (!(a & 3)) return (V)*(const uint32_t *)(mem + a) | (V)*(const uint32_t *)(mem + a + 4) << 32;
    V v; memcpy(&v, mem + a, 8); return v;
}
static void st64(uint32_t a, V v) {
    if (!(a & 3)) { *(uint32_t *)(mem + a) = (uint32_t)v; *(uint32_t *)(mem + a + 4) = (uint32_t)(v >> 32); return; }
    memcpy(mem + a, &v, 8);
}
static uint32_t ld16(uint32_t a) {
    if (!(a & 1)) return *(const uint16_t *)(mem + a);
    uint16_t v; memcpy(&v, mem + a, 2); return v;
}
static void st16(uint32_t a, uint32_t v) {
    if (!(a & 1)) { *(uint16_t *)(mem + a) = (uint16_t)v; return; }
    uint16_t x = (uint16_t)v; memcpy(mem + a, &x, 2);
}

static uint32_t gc_root_count(void);
static uint32_t gc_root(uint32_t i);
static uint32_t gc_interp_n, gc_host_n;

// Calls host function `id` with arguments a[0..]; returns the (single) result.
static V host_call(int id, V *a) {
    switch (id) {
    // PRUNE-BEGIN host
    case H_FD_WRITE: {
        uint32_t iov = chk((uint32_t)a[1], (uint32_t)a[2] * 8), total = 0;
        for (uint32_t i = 0; i < (uint32_t)a[2]; i++) {
            uint32_t p = ld32(iov + 8 * i), n = ld32(iov + 8 * i + 4);
            chk(p, n);
            write((uint32_t)a[0] == 2 ? 2 : 1, mem + p, n);
            total += n;
        }
        st32(chk((uint32_t)a[3], 4), total);
        return 0;
    }
    case H_FD_READ: {
        uint32_t iov = chk((uint32_t)a[1], (uint32_t)a[2] * 8), total = 0;
        for (uint32_t i = 0; i < (uint32_t)a[2]; i++) {
            uint32_t p = ld32(iov + 8 * i), n = ld32(iov + 8 * i + 4);
            chk(p, n);
            ssize_t r = read(0, mem + p, n);
            if (r <= 0) break;
            total += (uint32_t)r;
            if ((uint32_t)r < n) break;
        }
        st32(chk((uint32_t)a[3], 4), total);
        return 0;
    }
    case H_PROC_EXIT: exit((int)(uint32_t)a[0]);
    case H_ARGS_SIZES: st32(chk((uint32_t)a[0], 4), 1); st32(chk((uint32_t)a[1], 4), 5); return 0;
    case H_ARGS_GET:
        st32(chk((uint32_t)a[0], 4), (uint32_t)a[1]);
        memcpy(mem + chk((uint32_t)a[1], 5), "wasm", 5);
        return 0;
    case H_ENV_SIZES: st32(chk((uint32_t)a[0], 4), 0); st32(chk((uint32_t)a[1], 4), 0); return 0;
    case H_ENV_GET: return 0;
    case H_CLOCK: {
        struct timespec ts;
        clock_gettime((uint32_t)a[0] == 0 ? CLOCK_REALTIME : CLOCK_MONOTONIC, &ts);
        V ns = (V)ts.tv_sec * 1000000000u + (V)ts.tv_nsec;
        memcpy(mem + chk((uint32_t)a[2], 8), &ns, 8);
        return 0;
    }
    case H_RANDOM:
        for (uint32_t i = 0; i < (uint32_t)a[1]; i++) mem[chk((uint32_t)a[0] + i, 1)] = (uint8_t)(rand() >> 7);
        return 0;
    case H_FDSTAT: {
        uint32_t p = chk((uint32_t)a[1], 24);
        memset(mem + p, 0, 24);
        mem[p] = 2;
        memset(mem + p + 8, 0xff, 16);
        return 0;
    }
    case H_FD_CLOSE: case H_YIELD: return 0;
    case H_FD_SEEK: return 70;
    case H_PRESTAT: case H_PRESTAT_NAME: return 8;
    case H_PEN_DOWN: pen_down(); return 0;
    case H_PEN_UP: pen_up(); return 0;
    case H_PEN_CLEAR: pen_clear(); return 0;
    case H_PEN_STAMP: pen_stamp(); return 0;
    case H_PEN_COLOR: pen_color((int)(uint32_t)a[0]); return 0;
    case H_PEN_HUE: pen_hue(f64of(a[0])); return 0;
    case H_PEN_SIZE: pen_size(f64of(a[0])); return 0;
    case H_GOTO: goto_xy(f64of(a[0]), f64of(a[1])); return 0;
    case H_SAY: say((const char *)mem + chk((uint32_t)a[0], 1)); return 0;
    case H_SAY_INT: say_int((int)(uint32_t)a[0]); return 0;
    case H_SAY_NUM: say_num(f64of(a[0])); return 0;
    case H_MOUSE_X: return bitsf64(mouse_x());
    case H_MOUSE_Y: return bitsf64(mouse_y());
    case H_MOUSE_DOWN: return (uint32_t)mouse_down();
    case H_KEY: return (uint32_t)key_pressed((int)(uint32_t)a[0]);
    case H_TIMER: return bitsf64(timer());
    case H_CLOCK_S: return bitsf64(wall_clock());
    case H_RESET_TIMER: reset_timer(); return 0;
    case H_RANDINT: return (uint32_t)random_int((int)(uint32_t)a[0], (int)(uint32_t)a[1]);
    case H_WAIT: wait(f64of(a[0])); return 0;
    // Every guest value lives in the interpreter's stacks and globals, so the
    // guest's conservative GC can see them all (low 32 bits = guest pointers).
#ifdef HYBRID
    // Natively compiled guest functions keep guest values in the host's own
    // locals (Scratch variables), so the host's roots are guest roots too.
    case H_GC_BEGIN: {
        int h = gc_roots_begin();
        if (h < 0) return 0xffffffffu;
        gc_interp_n = gc_root_count();
        gc_host_n = (uint32_t)h;
        return gc_interp_n + gc_host_n;
    }
    case H_GC_COPY: {
        static uint32_t hb[128];
        uint32_t buf = chk((uint32_t)a[0], (uint32_t)a[2] * 4), start = (uint32_t)a[1], n = (uint32_t)a[2];
        for (uint32_t i = 0; i < n;) {
            uint32_t k = start + i;
            if (k < gc_interp_n) { st32(buf + 4 * i, gc_root(k)); i++; continue; }
            uint32_t m = n - i < 128 ? n - i : 128;
            if (k - gc_interp_n + m > gc_host_n) m = gc_host_n - (k - gc_interp_n);
            if (!m) { st32(buf + 4 * i, 0); i++; continue; }
            gc_roots_copy(hb, (int)(k - gc_interp_n), (int)m);
            for (uint32_t j = 0; j < m; j++) st32(buf + 4 * (i + j), hb[j]);
            i += m;
        }
        return n;
    }
#else
    case H_GC_BEGIN: return gc_root_count();
    case H_GC_COPY: {
        uint32_t buf = chk((uint32_t)a[0], (uint32_t)a[2] * 4), start = (uint32_t)a[1], n = (uint32_t)a[2];
        for (uint32_t i = 0; i < n; i++) st32(buf + 4 * i, gc_root(start + i));
        return n;
    }
#endif
    case H_SCRIPT_LINES: return (uint32_t)script_lines();
    case H_SCRIPT_LINE:
        return (uint32_t)script_line((int)(uint32_t)a[0], (char *)mem + chk((uint32_t)a[1], (uint32_t)a[2]), (int)(uint32_t)a[2]);
    // PRUNE-END
    default: trap("call to unsupported import");
    }
}

// ---- hybrid support ----------------------------------------------------------------

// An exception raised by native code (or escaping a nested interpreter run
// called from native code) is pending until a handler takes it.
static uint32_t exn_pending;
static uint32_t exn_tag;
static V exn_vals[4];
#ifdef HYBRID
static void native_mark(void);
static V native_dispatch(uint32_t f, V *a);
static V icall(uint32_t f, V *a);
static uint32_t mem_grow(uint32_t n) {
    uint32_t old = mem_pages;
    if (mem_pages + n > mem_max_pages) return 0xffffffffu;
    mem_pages += n;
    return old;
}
#define NOINLINE __attribute__((noinline))
static V cargs[16];
static V call_any(uint32_t f, V *a) {
    if (f >= nfuncs) trap("undefined element");
    if (funcs[f].native) return native_dispatch(f, a);
    if (funcs[f].host != H_NONE) return host_call(funcs[f].host, a);
    return icall(f, a);
}
#endif

// ---- loading ------------------------------------------------------------------------

static V const_expr(uint32_t *pc) {
    V v = 0;
    for (;;) {
        uint8_t op = M[(*pc)++];
        switch (op) {
        case 0x41: v = (uint32_t)rd_s32(pc); break;
        case 0x42: v = (V)rd_s64(pc); break;
        case 0x43: { uint32_t u; memcpy(&u, M + *pc, 4); v = u; *pc += 4; break; }
        case 0x44: memcpy(&v, M + *pc, 8); *pc += 8; break;
        case 0x23: v = globals[rd_u32(pc)]; break;
        case 0xd2: v = rd_u32(pc); break;
        case 0xd0: (*pc)++; v = 0xffffffff; break;
        case 0x0b: return v;
        default: trap("unsupported constant expression");
        }
    }
}

static void read_type(uint32_t *pc, Type *t) {
    if (M[(*pc)++] != 0x60) trap("bad type");
    uint32_t np = rd_u32(pc);
    if (np > 12) trap("too many parameters");
    for (uint32_t i = 0; i < np; i++) t->t[i] = M[(*pc)++];
    uint32_t nr = rd_u32(pc);
    if (np + nr > 14) trap("too many results");
    for (uint32_t i = 0; i < nr; i++) t->t[np + i] = M[(*pc)++];
    t->np = (uint8_t)np;
    t->nr = (uint8_t)nr;
}

static void load(void) {
    M = guest_wasm;
    uint32_t pc = 8, end = guest_wasm_len;
    uint32_t defined = 0;
    while (pc < end) {
        uint8_t id = M[pc++];
        uint32_t size = rd_u32(&pc), next = pc + size;
        switch (id) {
        case 1:
            ntypes = rd_u32(&pc);
            if (ntypes > MAX_TYPES) trap("too many types");
            for (uint32_t i = 0; i < ntypes; i++) read_type(&pc, &types[i]);
            break;
        case 2: {
            uint32_t n = rd_u32(&pc);
            for (uint32_t i = 0; i < n; i++) {
                uint32_t ml = rd_u32(&pc), mp = pc;
                pc += ml;
                uint32_t nl = rd_u32(&pc), np = pc;
                pc += nl;
                uint8_t kind = M[pc++];
                if (kind == 0) {
                    Func *f = &funcs[nfuncs++];
                    f->type = (uint16_t)rd_u32(&pc);
                    f->host = H_UNKNOWN;
                    for (uint32_t k = 0; k < sizeof host_names / sizeof host_names[0]; k++) {
                        if (name_eq(np, nl, host_names[k].name)) f->host = host_names[k].id;
                    }
                    (void)mp; (void)ml;
                    nimports++;
                } else if (kind == 4) {
                    pc++;
                    tag_type[ntags++] = (uint16_t)rd_u32(&pc);
                } else {
                    trap("only function and tag imports are supported");
                }
            }
            break;
        }
        case 3: {
            uint32_t n = rd_u32(&pc);
            if (nfuncs + n > MAX_FUNCS) trap("too many functions");
            for (uint32_t i = 0; i < n; i++) funcs[nfuncs + i].type = (uint16_t)rd_u32(&pc);
            break;
        }
        case 4: {
            rd_u32(&pc);
            pc++; // reftype
            uint8_t flags = M[pc++];
            table_size = rd_u32(&pc);
            if (flags & 1) rd_u32(&pc);
            if (table_size > MAX_TABLE) trap("table too large");
            memset(table, 0xff, sizeof table);
            break;
        }
        case 5: {
            rd_u32(&pc);
            uint8_t flags = M[pc++];
            mem_pages = rd_u32(&pc);
            mem_max_pages = flags & 1 ? rd_u32(&pc) : GUEST_MEM_PAGES;
            if (mem_max_pages > GUEST_MEM_PAGES) mem_max_pages = GUEST_MEM_PAGES;
            if (mem_pages > GUEST_MEM_PAGES) trap("guest needs more memory than GUEST_MEM_PAGES");
            break;
        }
        case 6: {
            nglobals = rd_u32(&pc);
            if (nglobals > MAX_GLOBALS) trap("too many globals");
            for (uint32_t i = 0; i < nglobals; i++) {
                pc += 2; // type, mutability
                globals[i] = const_expr(&pc);
            }
            break;
        }
        case 7: {
            uint32_t n = rd_u32(&pc);
            for (uint32_t i = 0; i < n; i++) {
                uint32_t nl = rd_u32(&pc), np = pc;
                pc += nl;
                uint8_t kind = M[pc++];
                uint32_t idx = rd_u32(&pc);
                if (kind != 0) continue;
                if (name_eq(np, nl, "_start") || name_eq(np, nl, "main") || name_eq(np, nl, "__main_argc_argv")) {
                    if (entry_func == 0xffffffff) entry_func = idx;
                }
                if (name_eq(np, nl, "_initialize")) init_func = idx;
            }
            break;
        }
        case 8: start_func = rd_u32(&pc); break;
        case 9: {
            uint32_t n = rd_u32(&pc);
            for (uint32_t i = 0; i < n; i++) {
                uint32_t flags = rd_u32(&pc);
                if (flags != 0 && flags != 2) trap("unsupported element segment");
                if (flags == 2) { rd_u32(&pc); }
                uint32_t off = (uint32_t)const_expr(&pc);
                if (flags == 2) pc++; // elemkind
                uint32_t cnt = rd_u32(&pc);
                for (uint32_t k = 0; k < cnt; k++) {
                    if (off + k >= MAX_TABLE) trap("element segment out of range");
                    table[off + k] = rd_u32(&pc);
                }
            }
            break;
        }
        case 10: {
            uint32_t n = rd_u32(&pc);
            for (uint32_t i = 0; i < n; i++) {
                uint32_t sz = rd_u32(&pc), body_end = pc + sz;
                Func *f = &funcs[nimports + defined++];
                uint32_t groups = rd_u32(&pc), nl = 0;
                for (uint32_t g = 0; g < groups; g++) { nl += rd_u32(&pc); pc++; }
                f->nlocals = nl;
                f->code = pc;
                f->host = H_NONE;
                pc = body_end;
            }
            nfuncs = nimports + defined;
            break;
        }
        case 11: {
            uint32_t n = rd_u32(&pc);
            for (uint32_t i = 0; i < n; i++) {
                uint32_t flags = rd_u32(&pc);
                if (flags == 1) { uint32_t sz = rd_u32(&pc); pc += sz; continue; }
                if (flags == 2) rd_u32(&pc);
                uint32_t off = (uint32_t)const_expr(&pc);
                uint32_t sz = rd_u32(&pc);
                memcpy(mem + chk(off, sz), M + pc, sz);
                pc += sz;
            }
            break;
        }
        case 13: {
            uint32_t n = rd_u32(&pc);
            for (uint32_t i = 0; i < n; i++) {
                pc++;
                tag_type[ntags++] = (uint16_t)rd_u32(&pc);
            }
            break;
        }
        default: break;
        }
        pc = next;
    }
#ifdef HYBRID
    native_mark();
#endif
}

// ---- structured control helpers ---------------------------------------------------------

// Skips the immediates of the instruction whose opcode was just read.
static uint32_t skip_imm(uint8_t op, uint32_t pc) {
    switch (op) {
    case 0x02: case 0x03: case 0x04: case 0x06: rd_s64(&pc); break; // blocktype (s33)
    case 0x07: case 0x08: case 0x09: case 0x18: case 0x0c: case 0x0d: case 0x10: case 0x12:
    case 0x20: case 0x21: case 0x22: case 0x23: case 0x24: case 0x25: case 0x26: case 0xd2:
        rd_u32(&pc); break;
    case 0x0e: { uint32_t n = rd_u32(&pc); for (uint32_t i = 0; i <= n; i++) rd_u32(&pc); break; }
    case 0x11: case 0x13: rd_u32(&pc); rd_u32(&pc); break;
    case 0x1c: { uint32_t n = rd_u32(&pc); pc += n; break; }
    case 0x3f: case 0x40: case 0xd0: pc++; break;
    case 0x41: rd_s32(&pc); break;
    case 0x42: rd_s64(&pc); break;
    case 0x43: pc += 4; break;
    case 0x44: pc += 8; break;
    case 0xfc: {
        uint32_t sub = rd_u32(&pc);
        if (sub == 8) { rd_u32(&pc); pc++; }
        else if (sub == 9 || sub == 13 || (sub >= 15 && sub <= 17)) rd_u32(&pc);
        else if (sub == 10) pc += 2;
        else if (sub == 11) pc++;
        else if (sub == 12 || sub == 14) { rd_u32(&pc); rd_u32(&pc); }
        break;
    }
    default:
        if (op >= 0x28 && op <= 0x3e) { rd_u32(&pc); rd_u32(&pc); }
        break;
    }
    return pc;
}

// Scans from the start of a block body. Returns the pc of the opcode that ends
// it (`end` or `delegate`) and, through *mid, the pc of its first `else`,
// `catch` or `catch_all` at the same depth (or 0).
typedef struct { uint32_t key, end, mid; } CacheEnt;
static CacheEnt cache[CACHE_N];

static uint32_t scan_from(uint32_t pc, int stop_at_mid, uint32_t *mid) {
    uint32_t depth = 0;
    if (mid) *mid = 0;
    for (;;) {
        uint32_t at = pc;
        uint8_t op = M[pc++];
        switch (op) {
        case 0x02: case 0x03: case 0x04: case 0x06: depth++; break;
        case 0x0b: if (depth == 0) return at; depth--; break;
        case 0x18: if (depth == 0) return at; depth--; break; // delegate closes a try
        case 0x05: case 0x07: case 0x19:
            if (depth == 0) {
                if (stop_at_mid) return at;
                if (mid && !*mid) *mid = at;
            }
            break;
        default: break;
        }
        pc = skip_imm(op, pc);
    }
}

static CacheEnt *block_info(uint32_t start) {
    CacheEnt *e = &cache[(start * 2654435761u) >> 20 & (CACHE_N - 1)];
    if (e->key != start + 1) {
        e->key = start + 1;
        e->end = scan_from(start, 0, &e->mid);
    }
    return e;
}

// Reads a blocktype; returns the number of params and results.
static void blocktype(uint32_t *pc, uint32_t *np, uint32_t *nr) {
    uint8_t b = M[*pc];
    if (b == 0x40) { (*pc)++; *np = 0; *nr = 0; return; }
    if (b == 0x7f || b == 0x7e || b == 0x7d || b == 0x7c || b == 0x70 || b == 0x6f || b == 0x69) {
        (*pc)++; *np = 0; *nr = 1; return;
    }
    int64_t idx = rd_s64(pc);
    *np = types[idx].np;
    *nr = types[idx].nr;
}

// ---- execution ------------------------------------------------------------------------------

enum { K_FUNC, K_BLOCK, K_LOOP, K_IF, K_TRY, K_CATCH };
typedef struct {
    uint8_t kind;
    uint8_t arity;     // values a branch to this label carries
    uint8_t results;   // values left when the construct ends
    uint32_t start;    // pc after the blocktype (loop: branch target)
    uint32_t height;   // stack height below the construct's values
} Ctl;
typedef struct { uint32_t func, ret_pc, base, ctl_base; } Frame;

static V stack[STACK_N];
static Ctl ctl[CTL_N];
static Frame frames[FRAME_N];
static uint32_t sp, csp, fsp;

// The exception in flight (above), and the one saved for each catch block (rethrow).
static uint32_t saved_tag[CTL_N];
static V saved_vals[CTL_N][4];

#ifdef COUNT_INSTRUCTIONS
static uint64_t executed;
#endif
#ifdef PROFILE_FUNCS
// Per-function instruction counts and call-edge counts, read by profile.mjs.
static uint64_t fcount[MAX_FUNCS];
#define EDGE_N 65536
static uint32_t edge_key[EDGE_N];
static uint64_t edge_val[EDGE_N];
static void prof_edge(uint32_t from, uint32_t to) {
    uint32_t k = from * 4096 + to + 1, h = (k * 2654435761u) >> 16;
    while (edge_key[h] && edge_key[h] != k) h = (h + 1) & (EDGE_N - 1);
    edge_key[h] = k;
    edge_val[h]++;
}
__attribute__((export_name("prof_fcount"))) double prof_fcount(uint32_t i) { return (double)fcount[i]; }
__attribute__((export_name("prof_edge_key"))) uint32_t prof_edge_key(uint32_t i) { return edge_key[i]; }
__attribute__((export_name("prof_edge_val"))) double prof_edge_val(uint32_t i) { return (double)edge_val[i]; }
#endif

// GC roots for the guest: the value stack, globals and in-flight exceptions.
static uint32_t gc_root_count(void) { return sp + nglobals + 4; }
static uint32_t gc_root(uint32_t i) {
    if (i < sp) return (uint32_t)stack[i];
    i -= sp;
    if (i < nglobals) return (uint32_t)globals[i];
    i -= nglobals;
    return i < 4 ? (uint32_t)exn_vals[i] : 0;
}

static int sig_eq(uint32_t a, uint32_t b) {
    return types[a].np == types[b].np && types[a].nr == types[b].nr &&
           memcmp(types[a].t, types[b].t, types[a].np + types[a].nr) == 0;
}

static double wasm_min(double a, double b) {
    if (a != a || b != b) return NAN;
    if (a == b) return signbit(a) ? a : b;
    return a < b ? a : b;
}
static double wasm_max(double a, double b) {
    if (a != a || b != b) return NAN;
    if (a == b) return signbit(a) ? b : a;
    return a > b ? a : b;
}
static double trunc_checked(double x, double lo, double hi) {
    if (x != x) trap("invalid conversion to integer");
    double t = trunc(x);
    if (t <= lo || t >= hi) trap("integer overflow");
    return t;
}

static void run(uint32_t entry) {
    uint32_t pc = 0;
    uint32_t base_fsp = fsp;
    V *L = 0;
    uint32_t fnidx = entry;

#define POP() (stack[--sp])
#define TOP() (stack[sp - 1])
#define PUSH(x) (stack[sp++] = (V)(x))
#define BIN32(expr) do { uint32_t b = (uint32_t)POP(), a = (uint32_t)TOP(); (void)a; (void)b; TOP() = (uint32_t)(expr); } while (0)
#define BIN64(expr) do { uint64_t b = POP(), a = TOP(); (void)a; (void)b; TOP() = (uint64_t)(expr); } while (0)
#define CMP64(expr) do { uint64_t b = POP(), a = TOP(); (void)a; (void)b; TOP() = (expr) ? 1 : 0; } while (0)
#define BINF64(expr) do { double b = f64of(POP()), a = f64of(TOP()); TOP() = bitsf64(expr); } while (0)
#define BINF32(expr) do { float b = f32of(POP()), a = f32of(TOP()); TOP() = bitsf32(expr); } while (0)
#define CMPF64(expr) do { double b = f64of(POP()), a = f64of(TOP()); TOP() = (expr) ? 1 : 0; } while (0)
#define CMPF32(expr) do { float b = f32of(POP()), a = f32of(TOP()); TOP() = (expr) ? 1 : 0; } while (0)
#define MEMARG(size) uint32_t align_ = rd_u32(&pc); (void)align_; uint32_t ea_ = (uint32_t)POP(); uint64_t eal_ = (uint64_t)ea_ + rd_u32(&pc); \
    if (eal_ + (size) > (uint64_t)mem_pages * 65536) trap("out of bounds memory access"); uint32_t ea = (uint32_t)eal_;

    // Enters function `f` with its arguments on the stack.
#define ENTER(f) do { \
        Func *fn_ = &funcs[f]; \
        if (fsp >= FRAME_N) trap("call stack exhausted"); \
        Type *ty_ = &types[fn_->type]; \
        Frame *fr_ = &frames[fsp++]; \
        fr_->func = (f); fr_->ret_pc = pc; fr_->base = sp - ty_->np; fr_->ctl_base = csp; \
        if (sp + fn_->nlocals + 64 > STACK_N) trap("value stack exhausted"); \
        for (uint32_t i_ = 0; i_ < fn_->nlocals; i_++) stack[sp++] = 0; \
        if (csp >= CTL_N) trap("control stack exhausted"); \
        ctl[csp++] = (Ctl){K_FUNC, ty_->nr, ty_->nr, 0, fr_->base}; \
        L = stack + fr_->base; pc = fn_->code; fnidx = (f); \
    } while (0)

    ENTER(entry);
    frames[fsp - 1].ret_pc = 0;

    for (;;) {
#ifdef COUNT_INSTRUCTIONS
        executed++;
#endif
#ifdef PROFILE_FUNCS
        fcount[fnidx]++;
#endif
        uint8_t op = M[pc++];
        switch (op) {
        // PRUNE-BEGIN op
        case 0x00: trap("unreachable");
        case 0x01: break;
        case 0x02: case 0x03: case 0x04: case 0x06: {
            uint32_t np, nr;
            blocktype(&pc, &np, &nr);
            if (csp >= CTL_N) trap("control stack exhausted");
            Ctl c = {K_BLOCK, (uint8_t)nr, (uint8_t)nr, pc, sp - np};
            if (op == 0x03) { c.kind = K_LOOP; c.arity = (uint8_t)np; }
            if (op == 0x06) c.kind = K_TRY;
            if (op == 0x04) {
                c.kind = K_IF;
                c.height--; // the condition is still on the stack
                uint32_t cond = (uint32_t)POP();
                if (!cond) {
                    CacheEnt *e = block_info(pc);
                    if (e->mid) { pc = e->mid + 1; }
                    else { pc = e->end + 1; break; } // no else: params become results
                }
            }
            ctl[csp++] = c;
            break;
        }
        case 0x05: case 0x07: case 0x19: {
            // Reaching else/catch/catch_all normally: the construct is done.
            pc = block_info(ctl[csp - 1].start)->end + 1;
            csp--;
            break;
        }
        case 0x18: rd_u32(&pc); csp--; break; // try ... delegate finished normally
        case 0x0b: {
            Ctl *c = &ctl[csp - 1];
            if (c->kind != K_FUNC) { csp--; break; }
            goto do_return;
        }
        case 0x0c: case 0x0d: case 0x0e: {
            uint32_t depth;
            if (op == 0x0c) depth = rd_u32(&pc);
            else if (op == 0x0d) {
                depth = rd_u32(&pc);
                if (!(uint32_t)POP()) break;
            } else {
                uint32_t n = rd_u32(&pc), idx = (uint32_t)POP();
                depth = 0;
                for (uint32_t i = 0; i <= n; i++) {
                    uint32_t d = rd_u32(&pc);
                    if (i == idx || i == n) { depth = d; if (i == idx) { break; } }
                }
            }
        {
            Ctl *t = &ctl[csp - 1 - depth];
            if (t->kind == K_FUNC) goto do_return;
            uint32_t n = t->arity;
            memmove(stack + t->height, stack + sp - n, n * sizeof(V));
            sp = t->height + n;
            if (t->kind == K_LOOP) { pc = t->start; csp = csp - depth; }
            else { pc = block_info(t->start)->end + 1; csp = csp - depth - 1; }
            break;
        }
        }
        case 0x0f:
        do_return: {
            Frame *fr = &frames[fsp - 1];
            Type *ty = &types[funcs[fr->func].type];
            memmove(stack + fr->base, stack + sp - ty->nr, ty->nr * sizeof(V));
            sp = fr->base + ty->nr;
            csp = fr->ctl_base;
            pc = fr->ret_pc;
            fsp--;
            if (fsp == base_fsp) return;
            fnidx = frames[fsp - 1].func;
            L = stack + frames[fsp - 1].base;
            break;
        }
        case 0x10: case 0x11: {
            uint32_t f;
            if (op == 0x10) f = rd_u32(&pc);
            else {
                uint32_t ty = rd_u32(&pc);
                rd_u32(&pc);
                uint32_t idx = (uint32_t)POP();
                if (idx >= table_size || table[idx] == 0xffffffff) trap("undefined element");
                f = table[idx];
                if (!sig_eq(funcs[f].type, ty)) trap("indirect call type mismatch");
            }
#ifdef PROFILE_FUNCS
            prof_edge(fnidx, f);
#endif
            if (funcs[f].host != H_NONE) {
                Type *ty = &types[funcs[f].type];
                sp -= ty->np;
                V r = host_call(funcs[f].host, stack + sp);
                if (ty->nr) PUSH(r);
                break;
            }
#ifdef HYBRID
            if (funcs[f].native) {
                Type *ty = &types[funcs[f].type];
                sp -= ty->np;
                V r = native_dispatch(f, stack + sp);
                if (exn_pending) { exn_pending = 0; goto unwind; }
                if (ty->nr) PUSH(r);
                break;
            }
#endif
            ENTER(f);
            break;
        }
        case 0x08: { // throw
            uint32_t tag = rd_u32(&pc), n = types[tag_type[tag]].np;
            exn_tag = tag;
            for (uint32_t i = 0; i < n && i < 4; i++) exn_vals[i] = stack[sp - n + i];
            sp -= n;
            goto unwind;
        }
        case 0x09: { // rethrow
            uint32_t depth = rd_u32(&pc), at = csp - 1 - depth;
            exn_tag = saved_tag[at];
            memcpy(exn_vals, saved_vals[at], sizeof exn_vals);
            goto unwind;
        }
        unwind:
            for (;;) {
                if (csp == 0 || fsp == base_fsp) trap("uncaught wasm exception");
                Ctl *c = &ctl[csp - 1];
                if (c->kind == K_FUNC) {
                    Frame *fr = &frames[fsp - 1];
                    csp = fr->ctl_base;
                    fsp--;
                    // Leaving this run: the caller (native code, or the
                    // top level, which traps) takes the exception.
                    if (fsp == base_fsp) { sp = fr->base; exn_pending = 1; return; }
                    fnidx = frames[fsp - 1].func;
                    L = stack + frames[fsp - 1].base;
                    continue;
                }
                if (c->kind != K_TRY) { csp--; continue; }
                // Look through this try's handlers.
                uint32_t cp = block_info(c->start)->mid;
                int handled = 0;
                if (!cp) { // no catch: maybe a delegate
                    uint32_t e = block_info(c->start)->end;
                    if (M[e] == 0x18) {
                        uint32_t q = e + 1, d = rd_u32(&q);
                        csp = csp - 1 - d; // continue unwinding from the target label
                        continue;
                    }
                }
                while (cp) {
                    uint8_t k = M[cp];
                    uint32_t q = cp + 1;
                    if (k == 0x07) {
                        uint32_t tag = rd_u32(&q);
                        if (tag == exn_tag) {
                            sp = c->height;
                            uint32_t n = types[tag_type[tag]].np;
                            for (uint32_t i = 0; i < n && i < 4; i++) PUSH(exn_vals[i]);
                            handled = 1;
                        }
                    } else if (k == 0x19) {
                        sp = c->height;
                        handled = 1;
                    } else {
                        break; // end
                    }
                    if (handled) {
                        c->kind = K_CATCH;
                        saved_tag[csp - 1] = exn_tag;
                        memcpy(saved_vals[csp - 1], exn_vals, sizeof exn_vals);
                        pc = q;
                        break;
                    }
                    cp = scan_from(q, 1, 0); // next clause of this try
                }
                if (handled) break;
                csp--;
            }
            break;
        case 0x1a: sp--; break;
        case 0x1b: case 0x1c: {
            if (op == 0x1c) { uint32_t n = rd_u32(&pc); pc += n; }
            uint32_t c = (uint32_t)POP();
            V b = POP();
            if (!c) TOP() = b;
            break;
        }
        case 0x20: PUSH(L[rd_u32(&pc)]); break;
        case 0x21: L[rd_u32(&pc)] = POP(); break;
        case 0x22: L[rd_u32(&pc)] = TOP(); break;
        case 0x23: PUSH(globals[rd_u32(&pc)]); break;
        case 0x24: globals[rd_u32(&pc)] = POP(); break;

        // ---- memory ----
        case 0x28: case 0x2a: { MEMARG(4) PUSH(ld32(ea)); break; }
        case 0x29: case 0x2b: { MEMARG(8) PUSH(ld64(ea)); break; }
        case 0x2c: { MEMARG(1) PUSH((uint32_t)(int32_t)(int8_t)mem[ea]); break; }
        case 0x2d: { MEMARG(1) PUSH(mem[ea]); break; }
        case 0x2e: { MEMARG(2) PUSH((uint32_t)(int32_t)(int16_t)ld16(ea)); break; }
        case 0x2f: { MEMARG(2) PUSH(ld16(ea)); break; }
        case 0x30: { MEMARG(1) PUSH((V)(int64_t)(int8_t)mem[ea]); break; }
        case 0x31: { MEMARG(1) PUSH(mem[ea]); break; }
        case 0x32: { MEMARG(2) PUSH((V)(int64_t)(int16_t)ld16(ea)); break; }
        case 0x33: { MEMARG(2) PUSH(ld16(ea)); break; }
        case 0x34: { MEMARG(4) PUSH((V)(int64_t)(int32_t)ld32(ea)); break; }
        case 0x35: { MEMARG(4) PUSH(ld32(ea)); break; }
        case 0x36: case 0x38: { V x = POP(); MEMARG(4) st32(ea, (uint32_t)x); break; }
        case 0x37: case 0x39: { V x = POP(); MEMARG(8) st64(ea, x); break; }
        case 0x3a: case 0x3c: { V x = POP(); MEMARG(1) mem[ea] = (uint8_t)x; break; }
        case 0x3b: case 0x3d: { V x = POP(); MEMARG(2) st16(ea, (uint32_t)x); break; }
        case 0x3e: { V x = POP(); MEMARG(4) st32(ea, (uint32_t)x); break; }
        case 0x3f: pc++; PUSH(mem_pages); break;
        case 0x40: {
            pc++;
            uint32_t n = (uint32_t)TOP(), old = mem_pages;
            if (mem_pages + n > mem_max_pages) TOP() = 0xffffffffu;
            else { mem_pages += n; TOP() = old; }
            break;
        }

        // ---- constants ----
        case 0x41: PUSH((uint32_t)rd_s32(&pc)); break;
        case 0x42: PUSH((V)rd_s64(&pc)); break;
        case 0x43: { uint32_t v; memcpy(&v, M + pc, 4); pc += 4; PUSH(v); break; }
        case 0x44: { V v; memcpy(&v, M + pc, 8); pc += 8; PUSH(v); break; }

        // ---- i32 ----
        case 0x45: TOP() = (uint32_t)TOP() == 0; break;
        case 0x46: BIN32(a == b); break;
        case 0x47: BIN32(a != b); break;
        case 0x48: BIN32((int32_t)a < (int32_t)b); break;
        case 0x49: BIN32(a < b); break;
        case 0x4a: BIN32((int32_t)a > (int32_t)b); break;
        case 0x4b: BIN32(a > b); break;
        case 0x4c: BIN32((int32_t)a <= (int32_t)b); break;
        case 0x4d: BIN32(a <= b); break;
        case 0x4e: BIN32((int32_t)a >= (int32_t)b); break;
        case 0x4f: BIN32(a >= b); break;
        // ---- i64 comparisons ----
        case 0x50: TOP() = TOP() == 0; break;
        case 0x51: CMP64(a == b); break;
        case 0x52: CMP64(a != b); break;
        case 0x53: CMP64((int64_t)a < (int64_t)b); break;
        case 0x54: CMP64(a < b); break;
        case 0x55: CMP64((int64_t)a > (int64_t)b); break;
        case 0x56: CMP64(a > b); break;
        case 0x57: CMP64((int64_t)a <= (int64_t)b); break;
        case 0x58: CMP64(a <= b); break;
        case 0x59: CMP64((int64_t)a >= (int64_t)b); break;
        case 0x5a: CMP64(a >= b); break;
        // ---- float comparisons ----
        case 0x5b: CMPF32(a == b); break;
        case 0x5c: CMPF32(a != b); break;
        case 0x5d: CMPF32(a < b); break;
        case 0x5e: CMPF32(a > b); break;
        case 0x5f: CMPF32(a <= b); break;
        case 0x60: CMPF32(a >= b); break;
        case 0x61: CMPF64(a == b); break;
        case 0x62: CMPF64(a != b); break;
        case 0x63: CMPF64(a < b); break;
        case 0x64: CMPF64(a > b); break;
        case 0x65: CMPF64(a <= b); break;
        case 0x66: CMPF64(a >= b); break;
        // ---- i32 arithmetic ----
        case 0x67: { uint32_t a = (uint32_t)TOP(); TOP() = a ? (uint32_t)__builtin_clz(a) : 32; break; }
        case 0x68: { uint32_t a = (uint32_t)TOP(); TOP() = a ? (uint32_t)__builtin_ctz(a) : 32; break; }
        case 0x69: TOP() = (uint32_t)__builtin_popcount((uint32_t)TOP()); break;
        case 0x6a: BIN32(a + b); break;
        case 0x6b: BIN32(a - b); break;
        case 0x6c: BIN32(a * b); break;
        case 0x6d: {
            int32_t b = (int32_t)(uint32_t)POP(), a = (int32_t)(uint32_t)TOP();
            if (b == 0) trap("integer divide by zero");
            if (a == INT32_MIN && b == -1) trap("integer overflow");
            TOP() = (uint32_t)(a / b);
            break;
        }
        case 0x6e: { uint32_t b = (uint32_t)POP(); if (!b) trap("integer divide by zero"); TOP() = (uint32_t)TOP() / b; break; }
        case 0x6f: {
            int32_t b = (int32_t)(uint32_t)POP(), a = (int32_t)(uint32_t)TOP();
            if (b == 0) trap("integer divide by zero");
            TOP() = (b == -1) ? 0 : (uint32_t)(a % b);
            break;
        }
        case 0x70: { uint32_t b = (uint32_t)POP(); if (!b) trap("integer divide by zero"); TOP() = (uint32_t)TOP() % b; break; }
        case 0x71: BIN32(a & b); break;
        case 0x72: BIN32(a | b); break;
        case 0x73: BIN32(a ^ b); break;
        case 0x74: BIN32(a << (b & 31)); break;
        case 0x75: BIN32((uint32_t)((int32_t)a >> (b & 31))); break;
        case 0x76: BIN32(a >> (b & 31)); break;
        case 0x77: BIN32((a << (b & 31)) | (a >> ((32 - (b & 31)) & 31))); break;
        case 0x78: BIN32((a >> (b & 31)) | (a << ((32 - (b & 31)) & 31))); break;
        // ---- i64 arithmetic ----
        case 0x79: { uint64_t a = TOP(); TOP() = a ? (uint64_t)__builtin_clzll(a) : 64; break; }
        case 0x7a: { uint64_t a = TOP(); TOP() = a ? (uint64_t)__builtin_ctzll(a) : 64; break; }
        case 0x7b: TOP() = (uint64_t)__builtin_popcountll(TOP()); break;
        case 0x7c: BIN64(a + b); break;
        case 0x7d: BIN64(a - b); break;
        case 0x7e: BIN64(a * b); break;
        case 0x7f: {
            int64_t b = (int64_t)POP(), a = (int64_t)TOP();
            if (b == 0) trap("integer divide by zero");
            if (a == INT64_MIN && b == -1) trap("integer overflow");
            TOP() = (uint64_t)(a / b);
            break;
        }
        case 0x80: { uint64_t b = POP(); if (!b) trap("integer divide by zero"); TOP() = TOP() / b; break; }
        case 0x81: {
            int64_t b = (int64_t)POP(), a = (int64_t)TOP();
            if (b == 0) trap("integer divide by zero");
            TOP() = (b == -1) ? 0 : (uint64_t)(a % b);
            break;
        }
        case 0x82: { uint64_t b = POP(); if (!b) trap("integer divide by zero"); TOP() = TOP() % b; break; }
        case 0x83: BIN64(a & b); break;
        case 0x84: BIN64(a | b); break;
        case 0x85: BIN64(a ^ b); break;
        case 0x86: BIN64(a << (b & 63)); break;
        case 0x87: BIN64((uint64_t)((int64_t)a >> (b & 63))); break;
        case 0x88: BIN64(a >> (b & 63)); break;
        case 0x89: BIN64((a << (b & 63)) | (a >> ((64 - (b & 63)) & 63))); break;
        case 0x8a: BIN64((a >> (b & 63)) | (a << ((64 - (b & 63)) & 63))); break;
        // ---- f32 ----
        case 0x8b: TOP() = bitsf32(fabsf(f32of(TOP()))); break;
        case 0x8c: TOP() = (uint32_t)TOP() ^ 0x80000000u; break;
        case 0x8d: TOP() = bitsf32(ceilf(f32of(TOP()))); break;
        case 0x8e: TOP() = bitsf32(floorf(f32of(TOP()))); break;
        case 0x8f: TOP() = bitsf32(truncf(f32of(TOP()))); break;
        case 0x90: TOP() = bitsf32(rintf(f32of(TOP()))); break;
        case 0x91: TOP() = bitsf32(sqrtf(f32of(TOP()))); break;
        case 0x92: BINF32(a + b); break;
        case 0x93: BINF32(a - b); break;
        case 0x94: BINF32(a * b); break;
        case 0x95: BINF32(a / b); break;
        case 0x96: BINF32((float)wasm_min(a, b)); break;
        case 0x97: BINF32((float)wasm_max(a, b)); break;
        case 0x98: { uint32_t b = (uint32_t)POP(); TOP() = ((uint32_t)TOP() & 0x7fffffffu) | (b & 0x80000000u); break; }
        // ---- f64 ----
        case 0x99: TOP() = TOP() & 0x7fffffffffffffffull; break;
        case 0x9a: TOP() = TOP() ^ 0x8000000000000000ull; break;
        case 0x9b: TOP() = bitsf64(ceil(f64of(TOP()))); break;
        case 0x9c: TOP() = bitsf64(floor(f64of(TOP()))); break;
        case 0x9d: TOP() = bitsf64(trunc(f64of(TOP()))); break;
        case 0x9e: TOP() = bitsf64(rint(f64of(TOP()))); break;
        case 0x9f: TOP() = bitsf64(sqrt(f64of(TOP()))); break;
        case 0xa0: BINF64(a + b); break;
        case 0xa1: BINF64(a - b); break;
        case 0xa2: BINF64(a * b); break;
        case 0xa3: BINF64(a / b); break;
        case 0xa4: BINF64(wasm_min(a, b)); break;
        case 0xa5: BINF64(wasm_max(a, b)); break;
        case 0xa6: { V b = POP(); TOP() = (TOP() & 0x7fffffffffffffffull) | (b & 0x8000000000000000ull); break; }
        // ---- conversions ----
        case 0xa7: TOP() = (uint32_t)TOP(); break;
        case 0xa8: TOP() = (uint32_t)(int32_t)trunc_checked(f32of(TOP()), -2147483649.0, 2147483648.0); break;
        case 0xa9: TOP() = (uint32_t)trunc_checked(f32of(TOP()), -1.0, 4294967296.0); break;
        case 0xaa: TOP() = (uint32_t)(int32_t)trunc_checked(f64of(TOP()), -2147483649.0, 2147483648.0); break;
        case 0xab: TOP() = (uint32_t)trunc_checked(f64of(TOP()), -1.0, 4294967296.0); break;
        case 0xac: TOP() = (V)(int64_t)(int32_t)(uint32_t)TOP(); break;
        case 0xad: TOP() = (uint32_t)TOP(); break;
        case 0xae: TOP() = (V)(int64_t)trunc_checked(f32of(TOP()), -9223373136366403584.0, 9223372036854775808.0); break;
        case 0xaf: TOP() = (V)trunc_checked(f32of(TOP()), -1.0, 18446744073709551616.0); break;
        case 0xb0: TOP() = (V)(int64_t)trunc_checked(f64of(TOP()), -9223372036854777856.0, 9223372036854775808.0); break;
        case 0xb1: TOP() = (V)trunc_checked(f64of(TOP()), -1.0, 18446744073709551616.0); break;
        case 0xb2: TOP() = bitsf32((float)(int32_t)(uint32_t)TOP()); break;
        case 0xb3: TOP() = bitsf32((float)(uint32_t)TOP()); break;
        case 0xb4: TOP() = bitsf32((float)(int64_t)TOP()); break;
        case 0xb5: TOP() = bitsf32((float)TOP()); break;
        case 0xb6: TOP() = bitsf32((float)f64of(TOP())); break;
        case 0xb7: TOP() = bitsf64((double)(int32_t)(uint32_t)TOP()); break;
        case 0xb8: TOP() = bitsf64((double)(uint32_t)TOP()); break;
        case 0xb9: TOP() = bitsf64((double)(int64_t)TOP()); break;
        case 0xba: TOP() = bitsf64((double)TOP()); break;
        case 0xbb: TOP() = bitsf64((double)f32of(TOP())); break;
        case 0xbc: TOP() = (uint32_t)TOP(); break; // i32.reinterpret_f32: bits already
        case 0xbd: case 0xbe: case 0xbf: break;    // other reinterprets: same bits
        case 0xc0: TOP() = (uint32_t)(int32_t)(int8_t)TOP(); break;
        case 0xc1: TOP() = (uint32_t)(int32_t)(int16_t)TOP(); break;
        case 0xc2: TOP() = (V)(int64_t)(int8_t)TOP(); break;
        case 0xc3: TOP() = (V)(int64_t)(int16_t)TOP(); break;
        case 0xc4: TOP() = (V)(int64_t)(int32_t)TOP(); break;
        case 0xd0: pc++; PUSH(0xffffffffu); break; // ref.null
        case 0xd1: TOP() = (uint32_t)TOP() == 0xffffffffu; break;
        case 0xd2: PUSH(rd_u32(&pc)); break;
        case 0xfc: {
            uint32_t sub = rd_u32(&pc);
            switch (sub) {
            case 0: case 2: { double x = sub ? f64of(TOP()) : f32of(TOP());
                TOP() = x != x ? 0 : x <= -2147483648.0 ? 0x80000000u : x >= 2147483647.0 ? 0x7fffffffu : (uint32_t)(int32_t)x; break; }
            case 1: case 3: { double x = sub == 3 ? f64of(TOP()) : f32of(TOP());
                TOP() = x != x || x <= 0 ? 0 : x >= 4294967295.0 ? 0xffffffffu : (uint32_t)x; break; }
            case 4: case 6: { double x = sub == 6 ? f64of(TOP()) : f32of(TOP());
                TOP() = x != x ? 0 : x <= -9223372036854775808.0 ? 0x8000000000000000ull
                      : x >= 9223372036854775808.0 ? 0x7fffffffffffffffull : (V)(int64_t)x; break; }
            case 5: case 7: { double x = sub == 7 ? f64of(TOP()) : f32of(TOP());
                TOP() = x != x || x <= 0 ? 0 : x >= 18446744073709551616.0 ? ~(V)0 : (V)x; break; }
            case 10: { // memory.copy
                pc += 2;
                uint32_t n = (uint32_t)POP(), s = (uint32_t)POP(), d = (uint32_t)POP();
                chk(s, n); chk(d, n);
                memmove(mem + d, mem + s, n);
                break;
            }
            case 11: { // memory.fill
                pc++;
                uint32_t n = (uint32_t)POP(), v = (uint32_t)POP(), d = (uint32_t)POP();
                memset(mem + chk(d, n), (int)(v & 255), n);
                break;
            }
            default: trap("unsupported 0xfc instruction");
            }
            break;
        }
        // PRUNE-END
        default:
            out("unsupported opcode ");
            out_u(op);
            out("\n");
            trap("unsupported instruction");
        }
    }
#undef POP
#undef TOP
#undef PUSH
}

#ifdef HYBRID
// Native code calling an interpreted guest function.
static V icall(uint32_t f, V *a) {
    Type *ty = &types[funcs[f].type];
    if (sp + ty->np + 64 > STACK_N) trap("value stack exhausted");
    for (uint32_t i = 0; i < ty->np; i++) stack[sp++] = a[i];
    run(f);
    if (exn_pending) return 0;
    return ty->nr ? stack[--sp] : 0;
}
#include "native.c"
#endif

// Calls guest function f from the top level (arguments already on the stack).
static void call_top(uint32_t f) {
#ifdef HYBRID
    if (funcs[f].native) {
        Type *ty = &types[funcs[f].type];
        sp -= ty->np;
        V r = native_dispatch(f, stack + sp);
        if (!exn_pending && ty->nr) stack[sp++] = r;
    } else
#endif
    run(f);
    if (exn_pending) trap("uncaught wasm exception");
}

static uint32_t find_export(const char *want) {
    uint32_t pc = 8;
    while (pc < guest_wasm_len) {
        uint8_t id = M[pc++];
        uint32_t size = rd_u32(&pc), next = pc + size;
        if (id == 7) {
            uint32_t n = rd_u32(&pc);
            for (uint32_t i = 0; i < n; i++) {
                uint32_t nl = rd_u32(&pc), np = pc;
                pc += nl;
                uint8_t kind = M[pc++];
                uint32_t idx = rd_u32(&pc);
                if (kind == 0 && name_eq(np, nl, want)) return idx;
            }
        }
        pc = next;
    }
    return 0xffffffff;
}

#ifdef REACTOR

// For guests built as reactors with `start` and `frame` exports (like the
// MicroPython runner): the host is a reactor too and forwards both.
static uint32_t guest_frame = 0xffffffff;

__attribute__((export_name("start"))) void start(void) {
    load();
    if (start_func != 0xffffffff) call_top(start_func);
    if (init_func != 0xffffffff) call_top(init_func);
    uint32_t f = find_export("start");
    guest_frame = find_export("frame");
    if (f != 0xffffffff) call_top(f);
}

__attribute__((export_name("frame"))) void frame(void) {
    if (guest_frame != 0xffffffff) call_top(guest_frame);
}

#else

int main(void) {
    load();
    if (start_func != 0xffffffff) call_top(start_func);
    if (init_func != 0xffffffff) call_top(init_func);
    if (entry_func == 0xffffffff) trap("guest has no _start or main export");
    Type *t = &types[funcs[entry_func].type];
    for (uint32_t i = 0; i < t->np; i++) stack[sp++] = 0; // main(argc, argv) = main(0, 0)
    call_top(entry_func);
#ifdef COUNT_INSTRUCTIONS
    out("[executed ");
    out_u((uint32_t)(executed / 1000));
    out(" thousand guest instructions]\n");
#endif
    return t->nr ? (int)(uint32_t)stack[--sp] : 0;
}

#endif
