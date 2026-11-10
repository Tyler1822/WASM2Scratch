#include <stdio.h>
#include <stdint.h>
#include <inttypes.h>

int main(void) {
    printf("Hello from C, running in Scratch!\n");
    printf("ints: %d %d %u %x %X %o\n", 42, -17, 4000000000u, 0xdeadbeef, 255, 8);
    printf("padded: [%5d] [%-5d] [%05d] [%+d]\n", 42, 42, 42, 42);
    printf("long long: %lld %llu %" PRIx64 "\n", -9007199254740993LL, 18446744073709551615ULL, (uint64_t)0x123456789abcdef0ULL);
    printf("chars: %c%c%c, string: %s, %.3s\n", 'S', 'B', '3', "scratch", "abcdef");
    printf("floats: %f %.2f %e %g %g\n", 3.14159265358979, -2.5, 12345.678, 0.0001, 1e20);
    printf("float32: %.6f\n", (double)(1.0f / 3.0f));
    printf("percent: 100%%\n");
    return 0;
}
