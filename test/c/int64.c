#include <stdio.h>
#include <stdint.h>

static uint64_t gcd(uint64_t a, uint64_t b) { while (b) { uint64_t t = a % b; a = b; b = t; } return a; }
static uint64_t fact(unsigned n) { return n <= 1 ? 1 : n * fact(n - 1); }
static uint64_t mulmod(uint64_t a, uint64_t b, uint64_t m) {
    uint64_t r = 0; a %= m;
    while (b) { if (b & 1) r = (r + a) % m; a = (a << 1) % m; b >>= 1; }
    return r;
}
static uint64_t fnv1a(const char *s) {
    uint64_t h = 0xcbf29ce484222325ULL;
    while (*s) { h ^= (unsigned char)*s++; h *= 0x100000001b3ULL; }
    return h;
}

int main(void) {
    for (unsigned i = 15; i <= 21; i += 3) printf("%u! = %llu\n", i, (unsigned long long)fact(i));
    printf("gcd = %llu\n", (unsigned long long)gcd(1071ULL * 1000000007ULL, 462ULL * 1000000007ULL));
    printf("mulmod = %llu\n", (unsigned long long)mulmod(0x123456789abcdefULL, 0xfedcba987654321ULL, 1000000000000000003ULL));
    printf("fnv1a = %016llx\n", (unsigned long long)fnv1a("Scratch is a block-based language"));
    int64_t x = -1234567890123LL;
    printf("signed: %lld / 7 = %lld rem %lld, >> 3 = %lld\n", (long long)x, (long long)(x / 7), (long long)(x % 7), (long long)(x >> 3));
    uint32_t steps = 0; uint64_t n = 837799;
    while (n != 1) { n = (n & 1) ? 3 * n + 1 : n / 2; steps++; }
    printf("collatz(837799) steps = %u\n", steps);
    uint32_t h = 2166136261u;
    for (int i = 0; i < 1000; i++) { h ^= (uint32_t)i; h *= 16777619u; h = (h << 7) | (h >> 25); }
    printf("hash32 = %08x\n", h);
    return 0;
}
