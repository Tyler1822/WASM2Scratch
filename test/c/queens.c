#include <stdio.h>

static int n, count;
static int cols[16];

static int ok(int row, int c) {
    for (int r = 0; r < row; r++) {
        int d = cols[r] - c;
        if (d == 0 || d == row - r || d == r - row) return 0;
    }
    return 1;
}
static void solve(int row) {
    if (row == n) { count++; return; }
    for (int c = 0; c < n; c++) if (ok(row, c)) { cols[row] = c; solve(row + 1); }
}

int main(void) {
    for (n = 4; n <= 7; n++) { count = 0; solve(0); printf("%d-queens: %d solutions\n", n, count); }
    /* ASCII mandelbrot */
    for (int y = -6; y <= 6; y++) {
        char line[61];
        for (int x = 0; x < 60; x++) {
            double cr = -2.2 + x * 0.05, ci = y * 0.18, zr = 0, zi = 0;
            int it = 0;
            while (it < 40 && zr * zr + zi * zi < 4) { double t = zr * zr - zi * zi + cr; zi = 2 * zr * zi + ci; zr = t; it++; }
            line[x] = " .:-=+*#%@"[it % 10];
        }
        line[60] = 0;
        puts(line);
    }
    return 0;
}
