# Spirograph: hypotrochoid curves, drawn a little more every frame.
import math
import scratch


def gcd(a, b):
    while b:
        a, b = b, a % b
    return a


def curve(R, r, d, hue):
    """Yields after each segment of the curve traced by a pen at distance d
    from the centre of a wheel of radius r rolling inside a ring of radius R."""
    turns = r // gcd(R, r)
    steps = 48 * turns
    k = (R - r) / r
    scratch.pen_up()
    for i in range(steps + 1):
        t = 2 * math.pi * turns * i / steps
        x = (R - r) * math.cos(t) + d * math.cos(k * t)
        y = (R - r) * math.sin(t) - d * math.sin(k * t)
        scratch.pen_hue(hue + 25 * i / steps)
        scratch.goto(x, y)
        scratch.pen_down()
        yield


def drawing():
    scratch.clear()
    for R, r, d, hue, size in [(160, 60, 95, 0, 3), (120, 45, 70, 35, 2), (70, 30, 40, 65, 2)]:
        scratch.pen_size(size)
        yield from curve(R, r, d, hue)
    print("Done! Click the stage for a random one.")
    while True:
        while not scratch.mouse_down():
            yield
        scratch.clear()
        scratch.pen_size(2)
        R = scratch.randint(80, 170)
        yield from curve(R, scratch.randint(15, R - 10), scratch.randint(20, 90), scratch.randint(0, 99))


steps = drawing()


def frame(clock=scratch.clock, next=next, gen=steps):
    # About 30 ms of work per frame, so the drawing appears as it grows.
    # (Hot names are bound as defaults: MicroPython looks those up fastest.)
    end = clock() + 0.03
    while clock() < end:
        next(gen)


print("Spirograph in Python, running inside Scratch")
scratch.on_frame(frame)
