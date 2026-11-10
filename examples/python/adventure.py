# Escape the Stage: a tiny text adventure. Type commands at the prompt.
ROOMS = {
    "stage": {
        "desc": "You are on a bright white stage. A cat sprite stares at you.",
        "exits": {"north": "backpack", "east": "editor"},
        "items": ["green flag"],
    },
    "backpack": {
        "desc": "You are inside the Backpack. It smells like old costumes.",
        "exits": {"south": "stage"},
        "items": ["paintbrush"],
    },
    "editor": {
        "desc": "You are in the code editor. Blocks of every colour float by.",
        "exits": {"west": "stage", "north": "extensions"},
        "items": ["forever loop"],
    },
    "extensions": {
        "desc": "The Extensions room. A locked door glows with a pen icon.",
        "exits": {"south": "editor"},
        "items": [],
    },
}

here = "stage"
bag = []


def look():
    room = ROOMS[here]
    print(room["desc"])
    if room["items"]:
        print("You see:", ", ".join(room["items"]))
    print("Exits:", ", ".join(sorted(room["exits"])))


print("ESCAPE THE STAGE")
print("Commands: look, go <dir>, take <item>, use <item>, inventory, quit")
look()
while True:
    words = input("> ").strip().lower().split(" ", 1)
    verb, arg = words[0], (words[1] if len(words) > 1 else "")
    if verb in ("n", "s", "e", "w", "north", "south", "east", "west"):
        verb, arg = "go", {"n": "north", "s": "south", "e": "east", "w": "west"}.get(verb, verb)
    if verb == "look":
        look()
    elif verb == "go":
        if arg in ROOMS[here]["exits"]:
            here = ROOMS[here]["exits"][arg]
            look()
        else:
            print("You can't go that way.")
    elif verb == "take":
        if arg in ROOMS[here]["items"]:
            ROOMS[here]["items"].remove(arg)
            bag.append(arg)
            print("Taken:", arg)
        else:
            print("There is no", arg or "nothing", "here.")
    elif verb in ("inventory", "i"):
        print("You carry:", ", ".join(bag) if bag else "nothing")
    elif verb == "use":
        if arg not in bag:
            print("You don't have that.")
        elif here == "extensions" and arg == "paintbrush":
            print("The pen door swings open. You draw yourself a way out...")
            print("*** You escaped the stage carrying", len(bag), "items! ***")
            break
        elif arg == "green flag":
            print("You wave the green flag. Everything starts running!")
        else:
            print("Nothing happens.")
    elif verb == "quit":
        print("Bye!")
        break
    else:
        print("I don't understand", repr(verb))
