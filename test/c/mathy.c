#include <stdio.h>
#include <math.h>

int main(void) {
    double xs[] = {0.5, 1.0, 2.0, 3.14159265358979, 10.0, 100.25};
    for (int i = 0; i < 6; i++) {
        double x = xs[i];
        printf("x=%g sqrt=%.10f sin=%.10f cos=%.10f exp=%.6e log=%.10f pow=%.6f atan2=%.10f\n",
               x, sqrt(x), sin(x), cos(x), exp(x), log(x), pow(x, 1.5), atan2(x, 2.0));
    }
    float f = 0.1f;
    for (int i = 0; i < 10; i++) f = f * 1.1f + 0.01f;
    printf("float accumulate: %.9g\n", f);
    printf("floor/ceil/round: %g %g %g %g\n", floor(-2.5), ceil(-2.5), round(-2.5), trunc(2.7));
    printf("fmod: %g, hypot: %g, cbrt: %g\n", fmod(10.5, 3.0), hypot(3, 4), cbrt(27.0));
    double pi = 0;
    for (int k = 0; k < 2000; k++) pi += (k % 2 ? -4.0 : 4.0) / (2 * k + 1);
    printf("leibniz pi: %.12f\n", pi);
    printf("inf/nan text: %f %f\n", INFINITY, -INFINITY);
    printf("ints from floats: %d %d %lld\n", (int)-3.99, (int)1e9, (long long)-1e15);
    return 0;
}
