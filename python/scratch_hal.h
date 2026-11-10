// HAL for MicroPython in Scratch: line-based input via WASI stdin (ask and wait).
#include <port/mphalport.h>
#include "py/misc.h"

#define CHAR_CTRL_C (3)
#define CHAR_CTRL_D (4)
int mp_hal_readline(vstr_t *line, const char *prompt);
#define mp_hal_readline mp_hal_readline
