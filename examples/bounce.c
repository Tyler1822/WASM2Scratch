/* Bouncing balls drawn with the Pen extension. Move the mouse to attract them.
 * Build: clang -O2 -mexec-model=reactor -Wl,--export=frame -Iinclude -o bounce.wasm examples/bounce.c
 */
#include "scratch.h"

#define N 12
static double x[N], y[N], vx[N], vy[N];
static int color[N];

__attribute__((export_name("_initialize"))) void init(void) {
    for (int i = 0; i < N; i++) {
        x[i] = random_int(-200, 200);
        y[i] = random_int(-150, 150);
        vx[i] = random_int(-60, 60) / 10.0;
        vy[i] = random_int(-60, 60) / 10.0;
        color[i] = (random_int(64, 255) << 16) | (random_int(64, 255) << 8) | random_int(64, 255);
    }
    pen_size(14);
}

void frame(void) {
    pen_clear();
    double mx = mouse_x(), my = mouse_y();
    for (int i = 0; i < N; i++) {
        vx[i] += (mx - x[i]) * 0.002;
        vy[i] += (my - y[i]) * 0.002 - 0.3;
        x[i] += vx[i];
        y[i] += vy[i];
        if (x[i] < -232 || x[i] > 232) { vx[i] = -vx[i] * 0.9; x[i] = x[i] < 0 ? -232 : 232; }
        if (y[i] < -172 || y[i] > 172) { vy[i] = -vy[i] * 0.9; y[i] = y[i] < 0 ? -172 : 172; }
        pen_color(color[i]);
        goto_xy(x[i], y[i]);
        pen_down();
        pen_up();
    }
}
