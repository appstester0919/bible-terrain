#!/usr/bin/env python3
"""Deterministic writer: data/tiles/*.png -> data/heightmap.png + data/elev.json.

This is the ONLY thing in this repo that produces data/heightmap.png and
data/elev.json. Before it existed, the official builder (israel3d_build_v4.py)
only VERIFIED the heightmap against the tiles, so a fresh checkout could not
rebuild it - the PNG was a hand-made artifact with no reproducible origin.

Inputs (all committed):
  data/tiles/<x>_<y>.png   Web Mercator z=10 terrarium tiles, 256x256 RGB,
                           elevation_m = (R*256 + G + B/256) - 32768
  --tiles x0 x1 y0 y1      the tile window to stitch

Outputs:
  data/heightmap.png       16-bit normalized DEM, R = high byte, G = low byte,
                           B = 0.  v = (elev - min) / (max - min),
                           q = round(v * 65535).  Decoded by app.js as
                           elev_m = min + ((R*256 + G) / 65535) * (max - min).
  data/elev.json           min/max used for that encoding, the tile window, the
                           bbox and the derived world dimensions.

`min`/`max` are written as the TRUE grid extremes, so the PNG round-trips with
no extra rounding error beyond the 16-bit quantization itself.

Regression contract (verified 2026-11-25): running this writer over the old
window 610..614 / 412..418 reproduces the previously shipped data/heightmap.png
byte-for-byte (100.0000%), which is what proves the encoding contract below is
the same one the app already decodes.

Usage:
  python3 tools/israel3d_write_heightmap.py --tiles 610 614 410 418 [--dry-run]
"""
import argparse
import json
import math
import os
import sys

import numpy as np
from PIL import Image

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(APP, "data")
TILES = os.path.join(DATA, "tiles")

TILE_PX = 256
WORLD_Z = 10
WORLD_TILES = 1 << WORLD_Z           # 1024 tiles across at z=10
EQUATOR_M = 40075016.686             # Web Mercator full circumference


def tile_lon(x):
    return x * 360.0 / WORLD_TILES - 180.0


def tile2lat(ty):
    """Latitude of the top edge of mercator tile row ty."""
    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * ty / WORLD_TILES))))


def decode_tile(path):
    a = np.asarray(Image.open(path).convert("RGB"), dtype=np.uint8)
    if a.shape[0] != TILE_PX or a.shape[1] != TILE_PX:
        raise SystemExit("TILE_NOT_256 %s -> %dx%d" % (path, a.shape[1], a.shape[0]))
    return (a[:, :, 0].astype(np.float64) * 256.0
            + a[:, :, 1].astype(np.float64)
            + a[:, :, 2].astype(np.float64) / 256.0) - 32768.0


def stitch(x0, x1, y0, y1):
    nx, ny = x1 - x0 + 1, y1 - y0 + 1
    grid = np.zeros((ny * TILE_PX, nx * TILE_PX), dtype=np.float64)
    missing = []
    for tx in range(x0, x1 + 1):
        for ty in range(y0, y1 + 1):
            path = os.path.join(TILES, "%d_%d.png" % (tx, ty))
            if not os.path.exists(path):
                missing.append(path)
                continue
            e = decode_tile(path)
            grid[(ty - y0) * TILE_PX:(ty - y0 + 1) * TILE_PX,
                 (tx - x0) * TILE_PX:(tx - x0 + 1) * TILE_PX] = e
    if missing:
        raise SystemExit("MISSING_TILES (%d): %s" % (len(missing), ", ".join(missing[:8])))
    return grid, nx * ny


def encode_png(grid):
    """16-bit normalized DEM -> RGB. Must match what app.js decodes."""
    lo, hi = float(grid.min()), float(grid.max())
    if not (hi > lo):
        raise SystemExit("DEGNERATE_GRID min %.4f max %.4f" % (lo, hi))
    v = (grid - lo) / (hi - lo)
    q = np.rint(v * 65535.0).astype(np.uint16)     # round(), not floor()
    rgb = np.zeros((grid.shape[0], grid.shape[1], 3), dtype=np.uint8)
    rgb[:, :, 0] = (q >> 8).astype(np.uint8)
    rgb[:, :, 1] = (q & 0xFF).astype(np.uint8)
    return rgb, lo, hi


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tiles", type=int, nargs=4, metavar=("X0", "X1", "Y0", "Y1"),
                    help="tile window to stitch (default: read data/tiles/meta.json)")
    ap.add_argument("--dry-run", action="store_true",
                    help="compute and report everything, write nothing")
    args = ap.parse_args()

    if args.tiles:
        x0, x1, y0, y1 = args.tiles
    else:
        meta_path = os.path.join(TILES, "meta.json")
        m = json.load(open(meta_path, encoding="utf-8"))
        x0, x1, y0, y1 = m["x0"], m["x1"], m["y0"], m["y1"]

    if not (x1 >= x0 and y1 >= y0):
        raise SystemExit("BAD_TILE_WINDOW %d..%d / %d..%d" % (x0, x1, y0, y1))

    grid, n_tiles = stitch(x0, x1, y0, y1)
    H, W = grid.shape
    rgb, lo, hi = encode_png(grid)

    lon_min, lon_max = tile_lon(x0), tile_lon(x1 + 1)
    lat_top, lat_bot = tile2lat(y0), tile2lat(y1 + 1)
    mpp = EQUATOR_M / (TILE_PX * WORLD_TILES)
    world_w = (lon_max - lon_min) / 360.0 * EQUATOR_M
    world_h = mpp * H

    # Quantization floor: the largest error the 16-bit encoding can introduce.
    qstep = (hi - lo) / 65535.0

    elev = {
        "min": lo,
        "max": hi,
        "scale": 1.0,
        "offset": 0.0,
        "decode": "(R*256 + G + B/256) - 32768 (applies to the source tiles)",
        "heightmap_encoding": ("16-bit normalized: v=(elev-min)/(max-min); "
                               "q=round(v*65535); R=q>>8; G=q&255; B=0; "
                               "elev_m = min + ((R*256+G)/65535)*(max-min)"),
        "quantization_step_m": round(qstep, 6),
        "z": WORLD_Z,
        "tiles": {"x0": x0, "x1": x1, "y0": y0, "y1": y1, "count": n_tiles},
        "bbox": {
            "lon_min": lon_min,
            "lon_max": lon_max,
            "lat_min": lat_bot,
            "lat_max": lat_top,
        },
        "image": {"width": W, "height": H},
        "meters_per_pixel": mpp,
        "centre_lat": (lat_top + lat_bot) / 2.0,
        "world_metres": {"width": world_w, "height": world_h},
        "source": ("tools/israel3d_write_heightmap.py over data/tiles/"
                   "%d..%d_%d..%d.png" % (x0, x1, y0, y1)),
    }

    print("tiles  : x %d..%d  y %d..%d  (%d tiles)" % (x0, x1, y0, y1, n_tiles))
    print("grid   : %dx%d px" % (W, H))
    print("elev   : min %.6f m   max %.6f m   quantization step %.4f m" % (lo, hi, qstep))
    print("bbox   : lon %.8f..%.8f  lat %.8f..%.8f" % (lon_min, lon_max, lat_bot, lat_top))
    print("merc   : lat_top %.10f  lat_bottom %.10f" % (lat_top, lat_bot))
    print("world  : %.6f x %.6f m   metres_per_pixel %.8f" % (world_w, world_h, mpp))
    print("centre_lat: %.10f" % elev["centre_lat"])

    iy, ix = np.unravel_index(np.argmax(grid), grid.shape)
    peak_lon = lon_min + (ix + 0.5) / W * (lon_max - lon_min)
    peak_lat = tile2lat(y0 + (iy + 0.5) / TILE_PX)
    print("grid peak: %.1f m at px(%d,%d)  lon %.6f  lat %.6f" % (hi, ix, iy, peak_lon, peak_lat))

    if args.dry_run:
        print("DRY_RUN - nothing written")
        return 0

    png_path = os.path.join(DATA, "heightmap.png")
    Image.fromarray(rgb, "RGB").save(png_path)
    with open(os.path.join(DATA, "elev.json"), "w", encoding="utf-8") as f:
        json.dump(elev, f, indent=2)
    with open(os.path.join(TILES, "meta.json"), "w", encoding="utf-8") as f:
        json.dump({"z": WORLD_Z, "x0": x0, "x1": x1, "y0": y0, "y1": y1}, f)

    # Read back and prove the PNG decodes to the grid we stitched.
    back = np.asarray(Image.open(png_path).convert("RGB")).astype(np.float64)
    hv = (back[:, :, 0] * 256.0 + back[:, :, 1]) / 65535.0
    dem = lo + hv * (hi - lo)
    err = np.abs(dem - grid)
    print("WROTE %s (%d bytes)" % (png_path, os.path.getsize(png_path)))
    print("WROTE %s" % os.path.join(DATA, "elev.json"))
    print("WROTE %s" % os.path.join(TILES, "meta.json"))
    print("ROUNDTRIP max|decoded - stitched| = %.6f m  (quantization floor %.6f m)"
          % (err.max(), qstep / 2.0))
    if err.max() > qstep * 0.5 + 1e-9:
        raise SystemExit("ROUNDTRIP_ERROR_ABOVE_QUANTIZATION")
    print("WRITE_HEIGHTMAP_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
