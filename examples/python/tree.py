# A fractal tree grown by a recursive generator. Click to grow another.
import math
import scratch


def branch(x, y, angle, length, depth):
    if depth == 0:
        return
    x2 = x + length * math.cos(angle)
    y2 = y + length * math.sin(angle)
    # Brown trunk fading to green leaves.
    t = (9 - depth) / 8
    scratch.pen_color(int(110 - 60 * t), int(70 + 130 * t), int(30 + 10 * t))
    scratch.pen_size(depth * 1.5)
    scratch.line(x, y, x2, y2)
    yield
    spread = 0.35 + scratch.randint(0, 20) / 100
    yield from branch(x2, y2, angle + spread, length * 0.75, depth - 1)
    yield from branch(x2, y2, angle - spread, length * 0.72, depth - 1)


def forest():
    while True:
        scratch.clear()
        yield from branch(0, -170, math.pi / 2, 85, 9)
        print("Click the stage to grow another tree")
        while not scratch.mouse_down():
            yield


growing = forest()


def frame(clock=scratch.clock, next=next, gen=growing):
    # About 30 ms of work per frame, so the drawing appears as it grows.
    # (Hot names are bound as defaults: MicroPython looks those up fastest.)
    end = clock() + 0.03
    while clock() < end:
        next(gen)


scratch.on_frame(frame)
