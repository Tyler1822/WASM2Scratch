/* scratch.h - Scratch blocks callable from C when compiling with wasm2sb3.
 *
 * Every function maps to one Scratch block (or a short sequence) running on
 * the project's sprite. Graphics use the Pen extension; the stage is 480x360
 * with (0, 0) in the centre.
 *
 * Programs that animate should be built as reactors and export `frame`:
 *   clang -O2 -mexec-model=reactor -Wl,--export=frame -o game.wasm game.c
 * The green flag then calls _initialize once and `frame` once per Scratch
 * frame (30 fps), with a screen refresh in between.
 */
#ifndef SCRATCH_H
#define SCRATCH_H

#define SCRATCH_IMPORT(name) __attribute__((import_module("scratch"), import_name(#name)))

/* Pen */
SCRATCH_IMPORT(pen_clear) void pen_clear(void);
SCRATCH_IMPORT(pen_down)  void pen_down(void);
SCRATCH_IMPORT(pen_up)    void pen_up(void);
SCRATCH_IMPORT(pen_stamp) void pen_stamp(void);
SCRATCH_IMPORT(pen_color) void pen_color(int rgb);      /* 0xRRGGBB */
SCRATCH_IMPORT(pen_size)  void pen_size(double size);
SCRATCH_IMPORT(pen_hue)   void pen_hue(double hue);       /* Scratch colour 0-100 */

/* Motion and looks */
SCRATCH_IMPORT(goto_xy) void goto_xy(double x, double y);
SCRATCH_IMPORT(say)     void say(const char *text);     /* ASCII / Latin-1 */
SCRATCH_IMPORT(say_int) void say_int(int value);
SCRATCH_IMPORT(say_num) void say_num(double value);

/* Sensing */
SCRATCH_IMPORT(mouse_x)     double mouse_x(void);
SCRATCH_IMPORT(mouse_y)     double mouse_y(void);
SCRATCH_IMPORT(mouse_down)  int mouse_down(void);
SCRATCH_IMPORT(key_pressed) int key_pressed(int key);   /* ASCII, or one of the KEY_* codes */
SCRATCH_IMPORT(timer)       double timer(void);       /* advances once per frame */
__attribute__((import_module("scratch"), import_name("clock")))
double wall_clock(void);   /* wall-clock seconds, always moving (unlike timer) */
SCRATCH_IMPORT(reset_timer) void reset_timer(void);

/* Show (1) or hide (0) the stdout list on stage. */
SCRATCH_IMPORT(stdout_visible) void stdout_visible(int show);

/* Control */
SCRATCH_IMPORT(wait)       void wait(double seconds);
SCRATCH_IMPORT(random_int) int random_int(int lo, int hi); /* inclusive */

/* Program text from the editable "Python code" list (one line per item). */
SCRATCH_IMPORT(script_lines) int script_lines(void);
SCRATCH_IMPORT(script_line)  int script_line(int index, char *buf, int cap); /* returns length */

/* Garbage-collector support (see python/main.c): every Scratch variable that
 * may hold a wasm value, as u32 words, for conservative root scanning. */
SCRATCH_IMPORT(gc_roots_begin) int gc_roots_begin(void);
SCRATCH_IMPORT(gc_roots_copy)  int gc_roots_copy(void *buf, int start, int count);

#define KEY_SPACE 32
#define KEY_ENTER 10
#define KEY_LEFT  28
#define KEY_RIGHT 29
#define KEY_UP    30
#define KEY_DOWN  31

#endif
