/* r_lowres.c - cheaper low-detail drawers for the Scratch port.
 *
 * The pen only shows even pixels of even rows (see DOOM_STEP in
 * scratch_doom.c). Doom runs in low-detail mode (160 columns), and these
 * replacements for r_draw.c's low-detail column and span drawers write only
 * the pixels that will be shown: one pixel per column pair, on even rows.
 * build.sh compiles r_draw.c with the originals renamed to *_full, and
 * patches R_MapPlane to skip odd rows before computing a span.
 */
#include "doomdef.h"
#include "i_video.h"
#include "r_local.h"

extern byte *ylookup[];
extern int columnofs[];

void R_DrawColumnLow(void) {
    int yl = dc_yl, yh = dc_yh;
    if ((yl + viewwindowy) & 1) yl++;
    if (yh < yl) return;
    byte *dest = ylookup[yl] + columnofs[dc_x << 1];
    fixed_t step = dc_iscale;
    fixed_t frac = dc_texturemid + (yl - centery) * step;
    step <<= 1;
    for (int n = (yh - yl) >> 1; n >= 0; n--) {
        *dest = dc_colormap[dc_source[(frac >> FRACBITS) & 127]];
        dest += SCREENWIDTH * 2;
        frac += step;
    }
}

void R_DrawTranslatedColumnLow(void) {
    int yl = dc_yl, yh = dc_yh;
    if ((yl + viewwindowy) & 1) yl++;
    if (yh < yl) return;
    byte *dest = ylookup[yl] + columnofs[dc_x << 1];
    fixed_t step = dc_iscale;
    fixed_t frac = dc_texturemid + (yl - centery) * step;
    step <<= 1;
    for (int n = (yh - yl) >> 1; n >= 0; n--) {
        *dest = dc_colormap[dc_translation[dc_source[frac >> FRACBITS]]];
        dest += SCREENWIDTH * 2;
        frac += step;
    }
}

void R_DrawSpanLow(void) {
    unsigned position = ((ds_xfrac << 10) & 0xffff0000) | ((ds_yfrac >> 6) & 0x0000ffff);
    unsigned step = ((ds_xstep << 10) & 0xffff0000) | ((ds_ystep >> 6) & 0x0000ffff);
    byte *dest = ylookup[ds_y] + columnofs[ds_x1 << 1];
    for (int n = ds_x2 - ds_x1; n >= 0; n--) {
        unsigned spot = ((position >> 4) & 0x0fc0) | (position >> 26);
        *dest = ds_colormap[ds_source[spot]];
        dest += 2;
        position += step;
    }
}
