# Paint with the mouse. The colour cycles as you draw.
#   space: bigger brush    b: smaller brush    c: clear
import scratch

state = {"hue": 0, "size": 8, "last": None, "keys": set()}


def pressed(key):
    """True only on the frame a key goes down."""
    down = scratch.key_pressed(key)
    was = key in state["keys"]
    if down:
        state["keys"].add(key)
    else:
        state["keys"].discard(key)
    return down and not was


def frame():
    if pressed("c"):
        scratch.clear()
    if pressed("space"):
        state["size"] = min(state["size"] + 4, 60)
        print("brush size", state["size"])
    if pressed("b"):
        state["size"] = max(state["size"] - 4, 2)
        print("brush size", state["size"])
    if scratch.mouse_down():
        x, y = scratch.mouse_x(), scratch.mouse_y()
        state["hue"] = (state["hue"] + 1.5) % 100
        scratch.pen_hue(state["hue"])
        scratch.pen_size(state["size"])
        last = state["last"]
        if last:
            scratch.line(last[0], last[1], x, y)
        else:
            scratch.dot(x, y)
        state["last"] = (x, y)
    else:
        state["last"] = None


scratch.clear()
print("Drag on the stage to paint. space/b: brush size, c: clear")
scratch.on_frame(frame)
