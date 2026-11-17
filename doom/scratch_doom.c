/* scratch_doom.c - doomgeneric platform layer for wasm2sb3.
 *
 * Built as a reactor that exports `frame`. The first frame boots Doom; every
 * later frame runs exactly one game tic (a virtual 35 Hz clock, so the game
 * slows down rather than skipping when Scratch is slow) and draws the result
 * with the Pen extension.
 *
 * The IWAD is linked into linear memory and exposed as a memory-mapped file,
 * so lumps are used in place instead of being copied into the zone.
 */
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "doomgeneric.h"
#include "doomkeys.h"
#include "i_video.h"
#include "w_file.h"
#include "z_zone.h"
#include "scratch.h"

/* ---- The WAD, embedded ------------------------------------------------- */

__attribute__((aligned(16))) unsigned char doom_wad[] = {
#embed DOOM_WAD_PATH
};
#define WAD_LEN ((unsigned int)sizeof doom_wad)

static int is_wad(const char *path) {
    const char *slash = strrchr(path, '/');
    return strcasecmp(slash ? slash + 1 : path, "doom1.wad") == 0;
}

/* Only the IWAD exists. Config files, savegames etc. fail to open. */
FILE *fopen(const char *restrict path, const char *restrict mode) {
    if (mode[0] == 'r' && is_wad(path)) return fmemopen(doom_wad, WAD_LEN, "rb");
    errno = ENOENT;
    return NULL;
}


/* Replaces w_file_stdc.c. A non-NULL `mapped` makes w_wad.c hand out
 * pointers into the WAD instead of reading lumps into the zone. */
extern wad_file_class_t stdc_wad_file;

static wad_file_t *wad_open(char *path) {
    if (!is_wad(path)) return NULL;
    wad_file_t *f = Z_Malloc(sizeof *f, PU_STATIC, 0);
    f->file_class = &stdc_wad_file;
    f->mapped = doom_wad;
    f->length = WAD_LEN;
    return f;
}

static void wad_close(wad_file_t *f) { Z_Free(f); }

static size_t wad_read(wad_file_t *f, unsigned int off, void *buf, size_t len) {
    (void)f;
    if (off >= WAD_LEN) return 0;
    if (len > WAD_LEN - off) len = WAD_LEN - off;
    memcpy(buf, doom_wad + off, len);
    return len;
}

wad_file_class_t stdc_wad_file = { wad_open, wad_close, wad_read };

/* ---- Time --------------------------------------------------------------- */

/* Virtual milliseconds. Starts at 0 so i_timer.c's basetime stays 0. */
static uint32_t now_ms;

void DG_SleepMs(uint32_t ms) { now_ms += ms ? ms : 1; }
uint32_t DG_GetTicksMs(void) { return now_ms; }

/* Advance to the start of the next 35 Hz tic. */
static void next_tic(void) {
    uint32_t tic = now_ms * 35 / 1000 + 1;
    uint32_t ms = (tic * 1000 + 34) / 35;
    if (ms > now_ms) now_ms = ms;
}

/* ---- Display ------------------------------------------------------------ */

/* Doom renders 320x200. Drawing every pixel with the pen is too slow, so
 * by default every other pixel of every other row is drawn, as 160x100
 * blocks of 3x3 stage pixels (480x300). Only pixels that changed since the
 * last frame are redrawn: the pen layer keeps the rest. */
#ifndef DOOM_STEP
#define DOOM_STEP 2
#endif
#define OUT_W (SCREENWIDTH / DOOM_STEP)
#define OUT_H (SCREENHEIGHT / DOOM_STEP)
#define CELL (480.0 / OUT_W)

static uint16_t shown[OUT_W * OUT_H]; /* palette index on screen, 0x100 = unknown */
static uint32_t seen[OUT_H * SCREENWIDTH / 4]; /* each shown row as words, last frame */
static uint32_t rgb[256];
static int force;

static void invalidate(void) {
    for (int i = 0; i < OUT_W * OUT_H; i++) shown[i] = 0x100;
    force = 1;
}

void DG_Init(void) {
    invalidate();
    pen_clear();
    pen_size(CELL + 0.5);
}

/* i_video.c's version (renamed by build.sh) copies the frame into
 * DG_ScreenBuffer first; reading I_VideoBuffer directly saves that copy. */
void I_FinishUpdate(void) { DG_DrawFrame(); }

#define PIX(x) row8[(x) * DOOM_STEP]

void DG_DrawFrame(void) {
    if (palette_changed) {
        palette_changed = false;
        for (int i = 0; i < 256; i++) rgb[i] = (colors[i].r << 16) | (colors[i].g << 8) | colors[i].b;
        invalidate();
    }
    int pen = -1;
    for (int y = 0; y < OUT_H; y++) {
        const uint8_t *row8 = I_VideoBuffer + y * DOOM_STEP * SCREENWIDTH;
        const uint32_t *row32 = (const uint32_t *)row8;
        uint32_t *was = seen + y * (SCREENWIDTH / 4);
        uint16_t *old = shown + y * OUT_W;
        double sy = (OUT_H / 2 - y) * CELL - CELL / 2;
        int x = 0;
        while (x < OUT_W) {
#if DOOM_STEP == 2
            /* A word holds two shown pixels: skip both if it is unchanged. */
            if (!(x & 1)) {
                uint32_t w = row32[x >> 1];
                if (w == was[x >> 1] && !force) { x += 2; continue; }
                was[x >> 1] = w;
            }
#endif
            int c = PIX(x);
            if (c == old[x]) { x++; continue; }
            int x0 = x;
            old[x++] = c;
            while (x < OUT_W && PIX(x) == c && old[x] != c) {
#if DOOM_STEP == 2
                if (!(x & 1)) was[x >> 1] = row32[x >> 1];
#endif
                old[x++] = c;
            }
            if (c != pen) { pen_color(rgb[c]); pen = c; }
            goto_xy(-240 + x0 * CELL + CELL / 2, sy);
            pen_down();
            goto_xy(-240 + (x - 1) * CELL + CELL / 2, sy);
            pen_up();
        }
    }
    force = 0;
}

void DG_SetWindowTitle(const char *title) { (void)title; }

/* ---- Keyboard ----------------------------------------------------------- */

/* Scratch only reports letters, digits, space, enter and arrows, so:
 *   arrows / WASD   move and turn (A/D strafe)
 *   Z or Ctrl->Z    fire          space / E   use (open doors)
 *   enter           menu select   Q           menu (Escape)
 *   1-7             weapons       Y / N       answer prompts
 *   M               automap (Tab) */
static const struct { unsigned char scratch, doom; } keymap[] = {
    { KEY_LEFT, KEY_LEFTARROW }, { KEY_RIGHT, KEY_RIGHTARROW },
    { KEY_UP, KEY_UPARROW }, { KEY_DOWN, KEY_DOWNARROW },
    { 'w', KEY_UPARROW }, { 's', KEY_DOWNARROW },
    { 'a', KEY_STRAFE_L }, { 'd', KEY_STRAFE_R },
    { 'z', KEY_FIRE }, { 'x', KEY_FIRE },
    { KEY_SPACE, KEY_USE }, { 'e', KEY_USE },
    { 10 /* Scratch enter */, 13 /* Doom KEY_ENTER */ }, { 'q', KEY_ESCAPE }, { 'm', KEY_TAB },
    { 'y', 'y' }, { 'n', 'n' },
    { '1', '1' }, { '2', '2' }, { '3', '3' }, { '4', '4' },
    { '5', '5' }, { '6', '6' }, { '7', '7' },
};
#define NKEYS (sizeof keymap / sizeof keymap[0])

static unsigned char down[NKEYS];
static unsigned char queue[64][2];
static int qhead, qtail;

static void poll_keys(void) {
    for (unsigned i = 0; i < NKEYS; i++) {
        int now = key_pressed(keymap[i].scratch) != 0;
        if (now == down[i]) continue;
        down[i] = now;
        int next = (qtail + 1) % 64;
        if (next == qhead) continue;
        queue[qtail][0] = now;
        queue[qtail][1] = keymap[i].doom;
        qtail = next;
    }
}

int DG_GetKey(int *pressed, unsigned char *key) {
    if (qhead == qtail) return 0;
    *pressed = queue[qhead][0];
    *key = queue[qhead][1];
    qhead = (qhead + 1) % 64;
    return 1;
}

/* ---- Entry points ------------------------------------------------------- */

/* Zone size in MiB. Lumps are used in place from the WAD, so the zone
 * only holds level data, composite textures and the like. */
#ifndef DOOM_MB
#define DOOM_MB "2"
#endif

static int booted;

static void show_stdout(void) { stdout_visible(1); }

__attribute__((export_name("frame"))) void frame(void) {
    if (!booted) {
#ifdef DOOM_BENCH /* straight into E1M1, for timing */
        static char *argv[] = { "doom", "-iwad", "doom1.wad", "-mb", DOOM_MB, "-warp", "1", NULL };
#else
        static char *argv[] = { "doom", "-iwad", "doom1.wad", "-mb", DOOM_MB, NULL };
#endif
        extern int detailLevel;
        booted = 1;
        detailLevel = 1; /* low detail: 160 columns, see r_lowres.c */
        doomgeneric_Create(sizeof argv / sizeof *argv - 1, argv);
#ifndef DOOM_BENCH
        /* The boot log is done; the list would cover the status bar. Show it
         * again if Doom exits (I_Error), so the message can be read. */
        stdout_visible(0);
        atexit(show_stdout);
#endif
        return;
    }
    next_tic();
    poll_keys();
    doomgeneric_Tick();
#ifdef DOOM_BENCH
    static int n;
    printf("F%d\n", ++n);
#endif
}

/* i_system.c shows I_Error messages with `system` on some platforms. */
int system(const char *cmd) { (void)cmd; return -1; }
