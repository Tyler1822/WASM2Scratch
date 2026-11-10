/* Number guessing game: uses stdin ("ask and wait") and stdout (the list on stage). */
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

int main(void) {
    srand((unsigned)time(NULL));
    int secret = rand() % 100 + 1, tries = 0, guess = 0;
    printf("I'm thinking of a number from 1 to 100.\n");
    while (guess != secret) {
        printf("Your guess?\n");
        if (scanf("%d", &guess) != 1) { int c; while ((c = getchar()) != '\n' && c != EOF) {} continue; }
        tries++;
        if (guess < secret) printf("%d is too low.\n", guess);
        else if (guess > secret) printf("%d is too high.\n", guess);
    }
    printf("Correct! You took %d tries.\n", tries);
    return 0;
}
