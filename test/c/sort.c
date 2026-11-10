#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { char name[12]; int score; } Player;

static int by_score(const void *a, const void *b) {
    const Player *x = a, *y = b;
    if (x->score != y->score) return y->score - x->score;
    return strcmp(x->name, y->name);
}
static int by_int(const void *a, const void *b) {
    int x = *(const int *)a, y = *(const int *)b;
    return (x > y) - (x < y);
}

int main(void) {
    unsigned seed = 12345;
    int n = 300;
    int *v = malloc(n * sizeof(int));
    for (int i = 0; i < n; i++) { seed = seed * 1103515245u + 12345u; v[i] = (int)(seed >> 8) % 10000 - 5000; }
    qsort(v, n, sizeof(int), by_int);
    long sum = 0;
    for (int i = 0; i < n; i++) sum += v[i];
    printf("min %d max %d median %d sum %ld\n", v[0], v[n - 1], v[n / 2], sum);
    int sorted = 1;
    for (int i = 1; i < n; i++) if (v[i - 1] > v[i]) sorted = 0;
    printf("sorted: %s\n", sorted ? "yes" : "no");
    free(v);

    Player p[] = {{"cat", 50}, {"sprite", 90}, {"stage", 50}, {"block", 75}, {"pen", 90}};
    qsort(p, 5, sizeof(Player), by_score);
    for (int i = 0; i < 5; i++) printf("%d. %-8s %3d\n", i + 1, p[i].name, p[i].score);

    char *buf = calloc(64, 1);
    strcpy(buf, "linked lists:");
    struct node { int v; struct node *next; } *head = NULL;
    for (int i = 1; i <= 5; i++) { struct node *nd = malloc(sizeof *nd); nd->v = i * i; nd->next = head; head = nd; }
    for (struct node *it = head; it; it = it->next) sprintf(buf + strlen(buf), " %d", it->v);
    puts(buf);
    return 0;
}
