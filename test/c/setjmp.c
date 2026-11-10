// cflags: -mllvm -wasm-enable-sjlj -lsetjmp
#include <setjmp.h>
#include <stdio.h>

static jmp_buf env;
static int depth_reached;

static void dive(int n) {
    depth_reached = n;
    if (n == 7) longjmp(env, n * 6);
    dive(n + 1);
    printf("not printed\n");
}

static int try_parse(const char *s, int *out) {
    jmp_buf local;
    jmp_buf *saved = &local;
    int v = 0;
    if (setjmp(*saved)) return 0;
    for (; *s; s++) {
        if (*s < '0' || *s > '9') longjmp(*saved, 1);
        v = v * 10 + (*s - '0');
    }
    *out = v;
    return 1;
}

int main(void) {
    volatile int attempts = 0;
    int r = setjmp(env);
    attempts++;
    if (r == 0) dive(0);
    printf("longjmp returned %d after reaching depth %d (attempt %d)\n", r, depth_reached, attempts);
    const char *inputs[] = {"123", "4x5", "", "99999"};
    for (int i = 0; i < 4; i++) {
        int v = -1;
        int ok = try_parse(inputs[i], &v);
        printf("parse(\"%s\") -> %s %d\n", inputs[i], ok ? "ok" : "error", v);
    }
    return 0;
}
