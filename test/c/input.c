#include <stdio.h>
#include <string.h>
#include <ctype.h>

int main(void) {
    char name[64];
    printf("What's your name?\n");
    if (!fgets(name, sizeof name, stdin)) return 1;
    name[strcspn(name, "\n")] = 0;
    for (char *p = name; *p; p++) *p = toupper((unsigned char)*p);
    printf("HELLO, %s!\n", name);
    int a, b;
    printf("Two numbers?\n");
    if (scanf("%d %d", &a, &b) != 2) return 2;
    printf("%d + %d = %d, %d * %d = %d\n", a, b, a + b, a, b, a * b);
    return 0;
}
