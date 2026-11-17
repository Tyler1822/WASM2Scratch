# Benchmark workload for profiling the hybrid build: a mix of typical
# beginner-to-intermediate Python (calls, loops, ints, floats, strings,
# lists, dicts, classes, exceptions, generators).
def fib(n):
    return n if n < 2 else fib(n - 1) + fib(n - 2)
print("fib", fib(16))

total = 0
for i in range(3000):
    total += i * i % 7
print("loop", total)

words = "the quick brown fox jumps over the lazy dog".split()
counts = {}
for k in range(40):
    for w in words:
        counts[w] = counts.get(w, 0) + 1
print(sorted(counts.items())[:3])
print(", ".join(w.upper() for w in words), len("-".join(words) * 10))
print("%s has %d letters, %.3f" % ("scratch", 7, 3.14159))
print("{} {} {:.5f}".format(12345, 2**70, 1/3))

import math
acc = 0.0
for i in range(1, 600):
    acc += math.sin(i) * math.sqrt(i) / (1 + i)
print("float", round(acc, 6))

class Vec:
    def __init__(self, x, y):
        self.x = x
        self.y = y
    def __add__(self, o):
        return Vec(self.x + o.x, self.y + o.y)
    def __repr__(self):
        return "Vec(%r, %r)" % (self.x, self.y)
v = Vec(0, 0)
for i in range(300):
    v = v + Vec(i, -i)
print(v)

def gen(n):
    for i in range(n):
        yield i * 2
print(sum(gen(1000)), [x for x in gen(10) if x % 3])

errs = 0
for i in range(200):
    try:
        if i % 3 == 0:
            raise ValueError(i)
        d = {}[i]
    except ValueError:
        errs += 1
    except KeyError:
        errs += 2
print("errs", errs)
lst = list(range(500, 0, -1))
lst.sort()
print(lst[:5], max(lst), min(lst), sum(lst))
s = set()
for i in range(500):
    s.add(i * 7 % 101)
print(len(s), 2 ** 100 // 3 ** 20)
