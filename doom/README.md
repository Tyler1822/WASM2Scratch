# Doom in Scratch

[doomgeneric](https://github.com/ozkl/doomgeneric) plus the shareware
`doom1.wad`, compiled by wasm2sb3 into ordinary Scratch blocks and drawn with
the Pen extension.

```
doom/build.sh            # -> doom/build/doom.wasm and doom/build/doom.sb3
NOSB3=1 doom/build.sh    # only the .wasm
node doom/native.mjs 400 out.png "50:q:down,52:q:up"   # run natively, save the pen canvas
```

The vendored source and the WAD are not checked in. Clone doomgeneric into
`doom/vendor/doomgeneric` and put the v1.9 shareware `doom1.wad`
(md5 `f0cefca49926d00903cf57551d901abe`) in `doom/wad/`.

The project is far beyond scratch.mit.edu's 5 MB limit (project.json is
about 55 MB), so load it from a file in TurboWarp.

## Controls

Scratch can only detect letters, digits, space, enter and the arrow keys.

| Key | Action |
|---|---|
| arrows, W/S | move and turn |
| A / D | strafe |
| Z or X | fire |
| space or E | use (open doors, switches) |
| Q | menu (Escape) |
| enter | select in menus |
| Y / N | answer prompts |
| 1-7 | weapons |
| M | automap |

## How it works

- **Platform layer** ([scratch_doom.c](scratch_doom.c)). Exports `frame`. The
  first frame boots Doom and later frames run one game tic each. A virtual
  35 Hz clock makes the game slow down instead of skipping tics when Scratch
  can't keep up.
- **WAD.** It is embedded with `#embed` and exposed as a memory-mapped file,
  so lumps are used in place and never copied into the zone. The zone is
  2 MiB and linear memory is 7 MiB in total (1.8M list items).
- **Display.** Doom runs in low-detail mode. [r_lowres.c](r_lowres.c)
  replaces the low-detail column and span drawers so they write only the
  pixels the pen shows: even columns of even rows, which is 160×100. The pen
  draws each changed horizontal run of one colour as a line of 3×3 stage
  pixels. Unchanged pixels are skipped, since the pen layer keeps them.
- **No sound, saves or config files.** `fopen` only finds the WAD.

---

Written by Claude (Anthropic) in Claude Code, as part of [wasm2sb3](../README.md).
