#!/bin/sh
# Builds Doom (doomgeneric + the shareware WAD) for wasm2sb3.
#   doom/build.sh            -> doom/build/doom.wasm and doom/build/doom.sb3
#   NOSB3=1 doom/build.sh    -> only the .wasm
# Needs: wasi-sdk in toolchain/, doomgeneric in doom/vendor/doomgeneric,
# doom1.wad in doom/wad/.
set -e
cd "$(dirname "$0")"
ROOT=$(cd .. && pwd)
SDK=${WASI_SDK_PATH:-$(ls -d "$ROOT"/toolchain/wasi-sdk-* | head -1)}
DG=vendor/doomgeneric/doomgeneric
OUT=build
mkdir -p "$OUT/obj"

SRCS="dummy am_map doomdef doomstat dstrings d_event d_items d_iwad d_loop d_main d_mode d_net
f_finale f_wipe g_game hu_lib hu_stuff info i_cdmus i_endoom i_joystick i_scale i_sound i_system
i_timer memio m_argv m_bbox m_cheat m_config m_controls m_fixed m_menu m_misc m_random p_ceilng
p_doors p_enemy p_floor p_inter p_lights p_map p_maputl p_mobj p_plats p_pspr p_saveg p_setup
p_sight p_spec p_switch p_telept p_tick p_user r_bsp r_data r_draw r_main r_plane r_segs r_sky
r_things sha1 sounds statdump st_lib st_stuff s_sound tables v_video wi_stuff w_checksum w_file
w_main w_wad z_zone i_input i_video doomgeneric"

CFLAGS="${OPT:--O2} $EXTRA -DCMAP256 -DDOOMGENERIC_RESX=320 -DDOOMGENERIC_RESY=200 -DNORMALUNIX -D_DEFAULT_SOURCE -D_WASI_EMULATED_SIGNAL -w"

# r_lowres.c replaces the low-detail drawers (the originals are renamed),
# and R_MapPlane skips the odd rows the pen never shows.
mkdir -p "$OUT/patched"
awk '{ print } prev == "R_MapPlane" && /^\(/ { inproto = 1 } inproto && /^{/ { print "    if ((y + viewwindowy) & 1) return;"; inproto = 0 } { prev = $0 }' \
  "$DG/r_plane.c" > "$OUT/patched/r_plane.c"
grep -q "viewwindowy) & 1" "$OUT/patched/r_plane.c" || { echo "r_plane.c patch failed" >&2; exit 1; }
RENAME="-DR_DrawColumnLow=R_DrawColumnLow_full -DR_DrawTranslatedColumnLow=R_DrawTranslatedColumnLow_full -DR_DrawSpanLow=R_DrawSpanLow_full"

OBJS=""
for s in $SRCS; do
  o="$OUT/obj/$s.o" src="$DG/$s.c" extra=""
  case $s in
    r_plane) src="$OUT/patched/r_plane.c" extra="-I$DG" ;;
    r_draw) extra="$RENAME" ;;
    i_video) extra="-DI_FinishUpdate=I_FinishUpdate_full" ;;
  esac
  if [ ! -f "$o" ] || [ "$src" -nt "$o" ] || [ build.sh -nt "$o" ]; then
    "$SDK/bin/clang" $CFLAGS $extra -c "$src" -o "$o" &
  fi
  OBJS="$OBJS $o"
done
for s in scratch_doom r_lowres; do
  "$SDK/bin/clang" $CFLAGS -std=c23 -I"$DG" -I"$ROOT/include" -DDOOM_WAD_PATH="\"$PWD/wad/doom1.wad\"" \
    -c $s.c -o "$OUT/obj/$s.o" &
  OBJS="$OBJS $OUT/obj/$s.o"
done
wait

"$SDK/bin/clang" $CFLAGS -mexec-model=reactor -o "$OUT/${NAME:-doom}.wasm" $OBJS \
  -Wl,--export=frame -Wl,--gc-sections -Wl,-z,stack-size=262144 \
  -Wl,--initial-memory=${MEMORY:-7340032} -Wl,--max-memory=${MEMORY:-7340032} \
  -lwasi-emulated-signal
ls -l "$OUT/${NAME:-doom}.wasm"
if [ -z "$NOSB3" ]; then
  node "$ROOT/bin/wasm2sb3.js" "$OUT/${NAME:-doom}.wasm" -o "$OUT/${NAME:-doom}.sb3"
fi
