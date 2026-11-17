# Edge cases for the hybrid build: exceptions crossing native/interpreted
# code, generators, closures, deep recursion, big ints, uncaught errors.
def deep(n):
    return 0 if n == 0 else 1 + deep(n - 1)
print(deep(30))
def g():
    try:
        yield 1
        yield 2
    finally:
        print("gen finally")
for x in g():
    print("gen", x)
it = g(); next(it); it.close()
def mk(k):
    def f(x):
        return x * k
    return f
print([mk(i)(3) for i in range(5)])
class E(Exception):
    pass
def thrower(i):
    if i % 2:
        raise E("odd %d" % i)
    return i
out = []
for i in range(6):
    try:
        out.append(thrower(i))
    except E as e:
        out.append(str(e))
    finally:
        out.append("f")
print(out)
try:
    try:
        1 / 0
    except ZeroDivisionError:
        raise KeyError("inner")
except KeyError as e:
    print("chained", e)
print(2 ** 200 % 1000003, (-7) // 2, -7 % 3, 7.5 // 2, int("123456789012345678901234567890") * 3)
print(sorted([3, 1, 2], reverse=True), {1, 2} | {3}, dict(a=1, b=2))
print("%08.3f|%-5s|%x|%o|%e" % (3.14159, "ab", 255, 8, 12345.678))
import math
print(math.floor(-2.5), math.ceil(2.1), math.isnan(float("nan")), float("inf") > 1e308, round(2.675, 2))
print(int(3.99), float(7), 1e100, 0.1 + 0.2, 1 / 3)
s = "Hello, World"
print(s.lower(), s.find("World"), s.replace("l", "L"), s.split(", "), s.startswith("He"), len(s * 3))
l = [5, 3, 8]
l.insert(1, 9); l.remove(3); l.reverse()
print(l, l.index(9), l.count(5), [x for x in l if x > 4])
print(list(map(lambda x: x * x, range(5))), list(zip("ab", [1, 2])), any([0, 1]), all([]))
x = undefined_name
