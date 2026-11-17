# Allocation-heavy (many GC cycles while native frames hold objects) and
# string-keyed dicts.
class Node:
    def __init__(self, v, nxt):
        self.v = v
        self.nxt = nxt
def build(n):
    head = None
    for i in range(n):
        head = Node([i, str(i), {"k": i}], head)
    return head
total = 0
for r in range(30):
    h = build(200)
    s = 0
    while h:
        s += h.v[0] + len(h.v[1]) + h.v[2]["k"]
        h = h.nxt
    total += s
print("gc total", total)
d = {}
for i in range(2000):
    d["key%d" % i] = [i] * 3
print(len(d), sum(v[0] for v in d.values()))
print(" ".join(str(x) for x in range(300))[-20:])
