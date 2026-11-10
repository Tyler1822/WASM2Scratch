# Snake! Arrow keys to steer, eat the red apples, don't bite yourself.
import scratch

CELL = 20
W, H = 22, 14            # grid size in cells
SPEED = 0.18             # seconds per move


def to_stage(cx, cy):
    return (cx - W // 2) * CELL + CELL / 2, (cy - H // 2) * CELL + CELL / 2 + 40


def paint(cell, rgb, size=CELL - 2):
    scratch.pen_color(rgb)
    scratch.pen_size(size)
    x, y = to_stage(*cell)
    scratch.dot(x, y)


class Game:
    def __init__(self):
        scratch.clear()
        # Board background.
        scratch.pen_color(0x203040)
        scratch.pen_size(CELL)
        for row in range(H):
            x0, y = to_stage(0, row)
            x1, _ = to_stage(W - 1, row)
            scratch.line(x0, y, x1, y)
        self.body = [(5, 7), (4, 7), (3, 7)]
        self.dir = (1, 0)
        self.next_dir = self.dir
        self.score = 0
        self.alive = True
        self.last_move = scratch.timer()
        for cell in self.body:
            paint(cell, 0x40E060)
        self.place_food()

    def place_food(self):
        while True:
            self.food = (scratch.randint(0, W - 1), scratch.randint(0, H - 1))
            if self.food not in self.body:
                break
        paint(self.food, 0xFF3030, CELL - 6)

    def steer(self):
        for key, d in (("left", (-1, 0)), ("right", (1, 0)), ("up", (0, 1)), ("down", (0, -1))):
            if scratch.key_pressed(key) and (d[0] != -self.dir[0] or d[1] != -self.dir[1]):
                self.next_dir = d

    def step(self):
        self.dir = self.next_dir
        hx, hy = self.body[0]
        head = ((hx + self.dir[0]) % W, (hy + self.dir[1]) % H)
        if head in self.body[:-1]:
            self.alive = False
            print("Game over! Score:", self.score, "- press space to play again")
            scratch.say("Score: %d" % self.score)
            return
        self.body.insert(0, head)
        paint(head, 0x40E060)
        if head == self.food:
            self.score += 1
            print("Yum! Score:", self.score)
            self.place_food()
        else:
            paint(self.body.pop(), 0x203040, CELL)


game = Game()


def frame():
    global game
    if not game.alive:
        if scratch.key_pressed("space"):
            scratch.say()
            game = Game()
        return
    game.steer()
    if scratch.timer() - game.last_move >= SPEED:
        game.last_move = scratch.timer()
        game.step()


print("Snake: steer with the arrow keys")
scratch.on_frame(frame)
