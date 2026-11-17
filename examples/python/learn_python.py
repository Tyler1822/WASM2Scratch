# Learn Python: a tiny interactive tutorial that runs inside Scratch.
# Each lesson explains one idea, shows an example, then asks you to type
# real Python. Your code really runs (this is MicroPython compiled to
# Scratch blocks), and the lesson checks what it did.

ns = {}            # your variables live here between lessons
score = [0]


def say(*lines):
    for line in lines:
        print(line)


def read_code(prompt=">>> "):
    """One line of code, or a block: a line ending in ':' keeps reading
    indented lines until you enter an empty line."""
    first = input(prompt)
    lines = [first]
    if first.rstrip().endswith(":"):
        while True:
            more = input("... ")
            if not more.strip():
                break
            lines.append(more if more.startswith(" ") else "    " + more)
    return "\n".join(lines)


def run(code):
    """Runs code in the shared namespace. Returns True if it worked."""
    try:
        try:
            # Expressions show their value, like the real Python prompt.
            value = eval(code, ns)
            if value is not None:
                print(repr(value))
        except SyntaxError:
            exec(code, ns)
        return True
    except Exception as e:
        print("Oops:", type(e).__name__ + ":", e)
        return False


def lesson(number, title, text, example, task, check, hint):
    say("", "=== Lesson %d: %s ===" % (number, title))
    say(*text)
    say("Example:  " + example)
    say("", "YOUR TURN: " + task)
    say("(type hint for help, skip to move on)")
    while True:
        code = read_code()
        word = code.strip().lower()
        if word == "skip":
            say("Skipped. You can come back any time!")
            return
        if word == "hint":
            say("Hint: " + hint)
            continue
        if not code.strip():
            continue
        if run(code):
            try:
                ok = check(code)
            except Exception:
                ok = False
            if ok:
                score[0] += 1
                say("Correct! Great job.")
                return
            say("That ran, but it is not quite it. Try again!")


say("*** LEARN PYTHON IN SCRATCH ***",
    "Python is a real programming language.",
    "You type it, and this project runs it.",
    "Type your answers in the box below.")

lesson(1, "print",
       ["print() shows a message.",
        "Text goes inside quotes: a string."],
       "print('Hello!')",
       "print the message Hi Scratch",
       lambda code: "print" in code and "Hi Scratch" in code,
       "print('Hi Scratch')")

lesson(2, "Variables",
       ["A variable is a named box for a value.",
        "Use = to put a value in the box."],
       "lives = 3",
       "make a variable named age holding a number",
       lambda code: isinstance(ns.get("age"), (int, float)),
       "age = 12")

lesson(3, "Maths",
       ["Python can calculate: + - * /",
        "** is power, // drops the remainder,",
        "and % gives the remainder."],
       "2 ** 10      (that is 1024)",
       "type a calculation that equals 42",
       lambda code: eval(code, ns) == 42,
       "6 * 7")

lesson(4, "Strings",
       ["Strings can be joined with +",
        "and repeated with *.",
        "len() tells you how long one is."],
       "'ab' * 3 + '!'",
       "make greeting = 'Hello, ' + a name",
       lambda code: str(ns.get("greeting", "")).startswith("Hello, ") and len(ns["greeting"]) > 7,
       "greeting = 'Hello, ' + 'Ada'")

lesson(5, "Lists",
       ["A list holds many values in order,",
        "inside square brackets.",
        "Count from 0: pets[0] is the first."],
       "colors = ['red', 'green', 'blue']",
       "make a list named pets with 3 items",
       lambda code: isinstance(ns.get("pets"), list) and len(ns["pets"]) == 3,
       "pets = ['cat', 'dog', 'fish']")

ns["x"] = 8
lesson(6, "if",
       ["if runs code only when something is True.",
        "End the if line with a colon : and indent",
        "the next line. Enter an empty line to run.",
        "Compare with == != < > <= >="],
       "if lives > 0: print('still playing')",
       "x is 8. If x > 5, print big",
       lambda code: code.lstrip().startswith("if") and "big" in code,
       "if x > 5: print('big')")

ns["total"] = 0
lesson(7, "Loops",
       ["for repeats code for each value.",
        "range(1, 4) counts 1, 2, 3.",
        "total is 0. Add 1 to 10 into it."],
       "for i in range(3): print(i)",
       "make total equal 1 + 2 + ... + 10",
       lambda code: ns.get("total") == 55 and "for" in code,
       "for i in range(1, 11): total = total + i")

lesson(8, "Functions",
       ["def makes your own command.",
        "return sends a value back."],
       "def add(a, b): return a + b",
       "write a function double(n) that returns n * 2",
       lambda code: ns["double"](21) == 42 and ns["double"](5) == 10,
       "def double(n): return n * 2")

say("", "*** ALL DONE! You got %d of 8 right. ***" % score[0],
    "You can keep typing Python below.",
    "Try: for i in range(5): print('*' * i)")
while True:
    run(read_code())
