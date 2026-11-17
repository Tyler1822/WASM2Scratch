# Edit these lines, then click the green flag!
# Each item in this list is one line of Python.
# Indent with spaces. Errors show the item number.
def stars(n):
    return "*" * n

name = input("What's your name? ")
print("Hello, " + name + "!")
for i in range(1, 6):
    print(i, stars(i))
squares = [n * n for n in range(8)]
print("squares:", squares)
print("sum:", sum(squares))
# To see pen drawings (import scratch),
# untick these lists in the Variables
# category to hide them from the stage.
