// MicroPython configuration for running inside Scratch via wasm2sb3.
#include <port/mpconfigport_common.h>

#define MICROPY_CONFIG_ROM_LEVEL                (MICROPY_CONFIG_ROM_LEVEL_BASIC_FEATURES)

#define MICROPY_ENABLE_COMPILER                 (1)
#define MICROPY_ENABLE_GC                       (1)
#define MICROPY_HELPER_REPL                     (1)
#define MICROPY_REPL_AUTO_INDENT                (0)
#define MICROPY_LONGINT_IMPL                    (MICROPY_LONGINT_IMPL_MPZ)
#define MICROPY_FLOAT_IMPL                      (MICROPY_FLOAT_IMPL_DOUBLE)
#define MICROPY_ERROR_REPORTING                 (MICROPY_ERROR_REPORTING_NORMAL)
#define MICROPY_PY_GC                           (1)
#define MICROPY_PY_SYS                          (1)
#define MICROPY_PY_MATH                         (1)
#define MICROPY_PY_BUILTINS_INPUT               (1)
#define MICROPY_PY_BUILTINS_HELP                (0)
#define MICROPY_PY_IO                           (0)
#define MICROPY_PY_STRUCT                       (0)
#define MICROPY_PY_COLLECTIONS                  (1)
#define MICROPY_KBD_EXCEPTION                   (0)
#define MICROPY_PY_MICROPYTHON                  (1)
#define MICROPY_NLR_SETJMP                      (1)
#define MICROPY_STACK_CHECK                     (0)
#define MICROPY_ENABLE_SOURCE_LINE              (1)
#define MICROPY_USE_INTERNAL_PRINTF             (0)
#define MICROPY_HW_BOARD_NAME                   "Scratch"
#define MICROPY_HW_MCU_NAME                     "wasm2sb3"

// Our HAL header adds line input on top of the embed port's.
#undef MICROPY_MPHALPORT_H
#define MICROPY_MPHALPORT_H "scratch_hal.h"

// The exact float formatter needs `long double`, i.e. software 128-bit floats.
#define MICROPY_FLOAT_FORMAT_IMPL               (MICROPY_FLOAT_FORMAT_IMPL_APPROX)

// Lets main.c see how much was allocated since the last collection.
#define MICROPY_GC_ALLOC_THRESHOLD              (1)
