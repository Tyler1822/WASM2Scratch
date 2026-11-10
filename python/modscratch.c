// The `scratch` Python module: Scratch blocks callable from MicroPython.
//
//   import scratch
//   scratch.goto(0, 0); scratch.pen_down(); scratch.goto(100, 50)
//   scratch.on_frame(fn)    # call fn() once per Scratch frame (30 fps)
//
// The module is built at runtime (no generated qstrs needed), so this file
// does not take part in MicroPython's build-time qstr extraction.

#include <string.h>
#include "py/objmodule.h"
#include "py/objstr.h"
#include "py/runtime.h"
#include "scratch.h"

static mp_obj_t module;

static const char *cstr(mp_obj_t o, char *buf, size_t size) {
    if (!mp_obj_is_str(o)) {
        o = mp_call_function_1(MP_OBJ_FROM_PTR(&mp_type_str), o);
    }
    size_t len;
    const char *s = mp_obj_str_get_data(o, &len);
    if (len >= size) {
        len = size - 1;
    }
    memcpy(buf, s, len);
    buf[len] = 0;
    return buf;
}

// ---- pen and motion ---------------------------------------------------------

static mp_obj_t s_pen_down(void) { pen_down(); return mp_const_none; }
static mp_obj_t s_pen_up(void) { pen_up(); return mp_const_none; }
static mp_obj_t s_clear(void) { pen_clear(); return mp_const_none; }
static mp_obj_t s_stamp(void) { pen_stamp(); return mp_const_none; }
static MP_DEFINE_CONST_FUN_OBJ_0(s_pen_down_obj, s_pen_down);
static MP_DEFINE_CONST_FUN_OBJ_0(s_pen_up_obj, s_pen_up);
static MP_DEFINE_CONST_FUN_OBJ_0(s_clear_obj, s_clear);
static MP_DEFINE_CONST_FUN_OBJ_0(s_stamp_obj, s_stamp);

// pen_color(0xRRGGBB) or pen_color(r, g, b)
static mp_obj_t s_pen_color(size_t n, const mp_obj_t *args) {
    int rgb;
    if (n == 3) {
        rgb = ((mp_obj_get_int(args[0]) & 255) << 16) | ((mp_obj_get_int(args[1]) & 255) << 8) | (mp_obj_get_int(args[2]) & 255);
    } else {
        rgb = mp_obj_get_int(args[0]) & 0xffffff;
    }
    pen_color(rgb);
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_VAR_BETWEEN(s_pen_color_obj, 1, 3, s_pen_color);

static mp_obj_t s_pen_hue(mp_obj_t h) { pen_hue(mp_obj_get_float(h)); return mp_const_none; }
static mp_obj_t s_pen_size(mp_obj_t s) { pen_size(mp_obj_get_float(s)); return mp_const_none; }
static mp_obj_t s_goto(mp_obj_t x, mp_obj_t y) { goto_xy(mp_obj_get_float(x), mp_obj_get_float(y)); return mp_const_none; }
static MP_DEFINE_CONST_FUN_OBJ_1(s_pen_hue_obj, s_pen_hue);
static MP_DEFINE_CONST_FUN_OBJ_1(s_pen_size_obj, s_pen_size);
static MP_DEFINE_CONST_FUN_OBJ_2(s_goto_obj, s_goto);

// dot(x, y): a single pen dot (pen size sets its diameter)
static mp_obj_t s_dot(mp_obj_t x, mp_obj_t y) {
    pen_up();
    goto_xy(mp_obj_get_float(x), mp_obj_get_float(y));
    pen_down();
    pen_up();
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_2(s_dot_obj, s_dot);

// line(x1, y1, x2, y2)
static mp_obj_t s_line(size_t n, const mp_obj_t *a) {
    (void)n;
    pen_up();
    goto_xy(mp_obj_get_float(a[0]), mp_obj_get_float(a[1]));
    pen_down();
    goto_xy(mp_obj_get_float(a[2]), mp_obj_get_float(a[3]));
    pen_up();
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_VAR_BETWEEN(s_line_obj, 4, 4, s_line);

// ---- looks ------------------------------------------------------------------

static mp_obj_t s_say(size_t n, const mp_obj_t *args) {
    static char buf[256];
    say(n ? cstr(args[0], buf, sizeof buf) : "");
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_VAR_BETWEEN(s_say_obj, 0, 1, s_say);

// ---- sensing ----------------------------------------------------------------

static mp_obj_t s_mouse_x(void) { return mp_obj_new_float(mouse_x()); }
static mp_obj_t s_mouse_y(void) { return mp_obj_new_float(mouse_y()); }
static mp_obj_t s_mouse_down(void) { return mp_obj_new_bool(mouse_down()); }
static mp_obj_t s_timer(void) { return mp_obj_new_float(timer()); }
static mp_obj_t s_clock(void) { return mp_obj_new_float(wall_clock()); }
static MP_DEFINE_CONST_FUN_OBJ_0(s_clock_obj, s_clock);
static mp_obj_t s_reset_timer(void) { reset_timer(); return mp_const_none; }
static MP_DEFINE_CONST_FUN_OBJ_0(s_mouse_x_obj, s_mouse_x);
static MP_DEFINE_CONST_FUN_OBJ_0(s_mouse_y_obj, s_mouse_y);
static MP_DEFINE_CONST_FUN_OBJ_0(s_mouse_down_obj, s_mouse_down);
static MP_DEFINE_CONST_FUN_OBJ_0(s_timer_obj, s_timer);
static MP_DEFINE_CONST_FUN_OBJ_0(s_reset_timer_obj, s_reset_timer);

// key_pressed("a"), key_pressed("space"), key_pressed("left"), ...
static mp_obj_t s_key_pressed(mp_obj_t k) {
    int code;
    if (mp_obj_is_int(k)) {
        code = mp_obj_get_int(k);
    } else {
        size_t len;
        const char *s = mp_obj_str_get_data(k, &len);
        if (len == 1) {
            code = (unsigned char)s[0];
        } else if (!strncmp(s, "left", len) || !strncmp(s, "left arrow", len)) {
            code = KEY_LEFT;
        } else if (!strncmp(s, "right", len) || !strncmp(s, "right arrow", len)) {
            code = KEY_RIGHT;
        } else if (!strncmp(s, "up", len) || !strncmp(s, "up arrow", len)) {
            code = KEY_UP;
        } else if (!strncmp(s, "down", len) || !strncmp(s, "down arrow", len)) {
            code = KEY_DOWN;
        } else if (!strncmp(s, "space", len)) {
            code = KEY_SPACE;
        } else if (!strncmp(s, "enter", len)) {
            code = KEY_ENTER;
        } else {
            mp_raise_ValueError(MP_ERROR_TEXT("unknown key"));
        }
    }
    return mp_obj_new_bool(key_pressed(code));
}
static MP_DEFINE_CONST_FUN_OBJ_1(s_key_pressed_obj, s_key_pressed);

// ---- misc -------------------------------------------------------------------

static mp_obj_t s_randint(mp_obj_t lo, mp_obj_t hi) {
    return mp_obj_new_int(random_int(mp_obj_get_int(lo), mp_obj_get_int(hi)));
}
static MP_DEFINE_CONST_FUN_OBJ_2(s_randint_obj, s_randint);

static mp_obj_t s_on_frame(mp_obj_t fn) {
    mp_obj_dict_store(MP_OBJ_FROM_PTR(mp_obj_module_get_globals(module)), MP_OBJ_NEW_QSTR(qstr_from_str("_frame")), fn);
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_1(s_on_frame_obj, s_on_frame);

// The registered frame callback, or MP_OBJ_NULL.
mp_obj_t scratch_frame_callback(void) {
    if (module == MP_OBJ_NULL) {
        return MP_OBJ_NULL;
    }
    mp_map_elem_t *e = mp_map_lookup(&mp_obj_module_get_globals(module)->map,
        MP_OBJ_NEW_QSTR(qstr_from_str("_frame")), MP_MAP_LOOKUP);
    return e && e->value != mp_const_none ? e->value : MP_OBJ_NULL;
}

void scratch_clear_frame_callback(void) {
    s_on_frame(mp_const_none);
}

void scratch_module_init(void) {
    module = mp_obj_new_module(qstr_from_str("scratch"));
    mp_obj_dict_t *g = mp_obj_module_get_globals(module);
    static const struct { const char *name; const mp_obj_base_t *fn; } funcs[] = {
        {"pen_down", &s_pen_down_obj.base}, {"pen_up", &s_pen_up_obj.base},
        {"clear", &s_clear_obj.base}, {"stamp", &s_stamp_obj.base},
        {"pen_color", &s_pen_color_obj.base}, {"pen_hue", &s_pen_hue_obj.base},
        {"pen_size", &s_pen_size_obj.base}, {"goto", &s_goto_obj.base},
        {"dot", &s_dot_obj.base}, {"line", &s_line_obj.base}, {"say", &s_say_obj.base},
        {"mouse_x", &s_mouse_x_obj.base}, {"mouse_y", &s_mouse_y_obj.base},
        {"mouse_down", &s_mouse_down_obj.base}, {"key_pressed", &s_key_pressed_obj.base},
        {"timer", &s_timer_obj.base}, {"clock", &s_clock_obj.base}, {"reset_timer", &s_reset_timer_obj.base},
        {"randint", &s_randint_obj.base}, {"on_frame", &s_on_frame_obj.base},
    };
    for (size_t i = 0; i < MP_ARRAY_SIZE(funcs); i++) {
        mp_obj_dict_store(MP_OBJ_FROM_PTR(g), MP_OBJ_NEW_QSTR(qstr_from_str(funcs[i].name)), MP_OBJ_FROM_PTR(funcs[i].fn));
    }
}
