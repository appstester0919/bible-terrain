#!/usr/bin/env python3
"""Stage 2 of the Israel 3D build chain: derive the map frame from data/elev.json.

Reads the elev.json written by tools/israel3d_write_heightmap.py (the single
source of truth for the DEM grid) and produces:

  data/geo.json          pixel <-> world mapping (Mercator-correct)
  data/sites_pixel.json  per-site px/py, DEM elevation and a local min/max window
  stdout                 tile/grid/elevation audit + per-site alignment table

It does NOT fetch tiles from S3 and it does NOT build water. Tiles come from the
committed data/tiles/ directory; water comes from tools/israel3d_build_water.sh.
Both of those used to be done here, which is why a rebuild could silently disagree
with what was shipped.

Run:  python3 tools/israel3d_derive_geo.py
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(APP, "data")
TILES = os.path.join(DATA, "tiles")

EQ = 40075016.686
TILE = 256


def merc_y(lat):
    lr = math.radians(lat)
    return math.log(math.tan(lr) + 1.0 / math.cos(lr))


def main():
    elev_meta = json.load(open(os.path.join(DATA, "elev.json"), encoding="utf-8"))
    T = elev_meta["tiles"]
    Z = elev_meta["z"]
    N = 1 << Z
    TILE_LON = 360.0 / N

    x0, x1, y0, y1 = T["x0"], T["x1"], T["y0"], T["y1"]
    LON0 = x0 * TILE_LON - 180.0
    LON1 = (x1 + 1) * TILE_LON - 180.0
    W = (x1 - x0 + 1) * TILE
    H = (y1 - y0 + 1) * TILE

    print("grid from elev.json: %dx%d  tiles x %d..%d y %d..%d" % (W, H, x0, x1, y0, y1))
    print("lon span: %.6f .. %.6f" % (LON0, LON1))

    MPP = EQ / (TILE * N)
    print("meters_per_pixel (equator, uniform): %.4f" % MPP)

    def ty2lat(ty):
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * ty / N))))

    LAT_TOP = ty2lat(y0)
    LAT_BOT = ty2lat(y1 + 1)
    MY_TOP, MY_BOT = merc_y(LAT_TOP), merc_y(LAT_BOT)

    print("mercator grid edges: lat %.6f (top) .. %.6f (bottom)" % (LAT_TOP, LAT_BOT))
    b = elev_meta["bbox"]
    for label, mine, theirs in (("lat_max", LAT_TOP, b["lat_max"]), ("lat_min", LAT_BOT, b["lat_min"])):
        ok = abs(mine - theirs) < 1e-6
        print("%s: derived %.8f vs elev.json %.8f  %s" % (label, mine, theirs, "OK" if ok else "MISMATCH"))
        if not ok:
            raise SystemExit("ELEV_JSON_BBOX_MISMATCH %s" % label)

    # ---------------------------------------------------------------- 1. tiles
    grid = np.zeros((H, W), dtype=np.float64)
    missing = []
    for tx in range(x0, x1 + 1):
        for ty in range(y0, y1 + 1):
            path = os.path.join(TILES, "%d_%d.png" % (tx, ty))
            if not os.path.exists(path):
                missing.append("%d_%d.png" % (tx, ty))
                continue
            a = np.asarray(Image.open(path).convert("RGB")).astype(np.float64)
            e = a[:, :, 0] * 256.0 + a[:, :, 1] + a[:, :, 2] / 256.0 - 32768.0
            grid[(ty - y0) * TILE:(ty - y0 + 1) * TILE, (tx - x0) * TILE:(tx - x0 + 1) * TILE] = e
    if missing:
        raise SystemExit("MISSING_TILES (%d): %s" % (len(missing), ", ".join(missing[:8])))
    n_expected = T.get("count", (x1 - x0 + 1) * (y1 - y0 + 1))
    print("tiles read from data/tiles: %d (expected %d)" % ((x1 - x0 + 1) * (y1 - y0 + 1), n_expected))
    print("stitched grid %dx%d  min %.1f  max %.1f" % (H, W, grid.min(), grid.max()))

    # The writer's own min/max must be the grid's real extremes.
    if abs(grid.min() - elev_meta["min"]) > 1e-6 or abs(grid.max() - elev_meta["max"]) > 1e-6:
        raise SystemExit("ELEV_MINMAX_STALE: grid %.6f..%.6f vs elev.json %.6f..%.6f"
                         % (grid.min(), grid.max(), elev_meta["min"], elev_meta["max"]))

    # ------------------------------------- compare against the shipped heightmap
    hm = Image.open(os.path.join(DATA, "heightmap.png")).convert("RGB")
    ha = np.asarray(hm).astype(np.float64)
    if (ha.shape[1], ha.shape[0]) != (W, H):
        raise SystemExit("HEIGHTMAP_SIZE_MISMATCH: png %dx%d vs grid %dx%d"
                         % (ha.shape[1], ha.shape[0], W, H))
    hv = (ha[:, :, 0] * 256.0 + ha[:, :, 1]) / 65535.0
    hm_elev = elev_meta["min"] + hv * (elev_meta["max"] - elev_meta["min"])
    diff = np.abs(hm_elev - grid)
    qstep = (elev_meta["max"] - elev_meta["min"]) / 65535.0
    print("heightmap vs re-stitched tiles: max|diff| %.4f m  mean %.4f m  (quantization floor %.4f m)"
          % (diff.max(), diff.mean(), qstep / 2.0))
    if diff.max() > qstep * 0.5 + 1e-9:
        fl = np.abs(hm_elev - grid[::-1, :])
        print("  flipped comparison: max|diff| %.4f mean %.4f" % (fl.max(), fl.mean()))
        if fl.mean() < diff.mean():
            raise SystemExit("DEM_ORIENTATION_MISMATCH")
        raise SystemExit("HEIGHTMAP_NOT_REPRODUCIBLE_FROM_TILES")
    print("  -> heightmap.png is reproducible from data/tiles/ and orientation OK")

    # ---------------------------------------------------------------- 2. mapping
    def lon_px(lon):
        return (lon - LON0) / (LON1 - LON0) * W

    def lat_py(lat):
        return (MY_TOP - merc_y(lat)) / (MY_TOP - MY_BOT) * H

    def elev_at_px(px, py):
        x = int(round(px)); y = int(round(py))
        if x < 0 or y < 0 or x >= W or y >= H:
            return None
        return float(grid[y, x])

    # ---------------------------------------------------------------- 3. geo.json
    geo = {
        "projection": "webmercator-3857-like (equirectangular spacing in X, mercator in Y)",
        "width_px": W, "height_px": H,
        "lon_min": LON0, "lon_max": LON1,
        "lat_top": LAT_TOP, "lat_bottom": LAT_BOT,
        "merc_y_top": MY_TOP, "merc_y_bot": MY_BOT,
        "meters_per_pixel": MPP,
        "world_width_m": W * MPP,
        "world_height_m": H * MPP,
        "centre_lat": (LAT_TOP + LAT_BOT) / 2.0,
        "z": Z, "tiles": T,
    }
    json.dump(geo, open(os.path.join(DATA, "geo.json"), "w"), indent=2)
    print("WROTE", os.path.join(DATA, "geo.json"))

    # ---------------------------------------------------------------- 4. sites
    sites = json.load(open(os.path.join(DATA, "sites.json"), encoding="utf-8"))["sites"]
    site_out = []
    print("\n%-22s %8s %8s %9s %9s  %s" % ("site", "px", "py", "dem_m", "ref", "note"))
    for s in sites:
        px, py = lon_px(s["lon"]), lat_py(s["lat"])
        e = elev_at_px(px, py)
        inside = (0 <= px < W and 0 <= py < H)
        r = 6
        xi, yi = int(round(px)), int(round(py))
        x_lo, x_hi = max(0, xi - r), min(W, xi + r + 1)
        y_lo, y_hi = max(0, yi - r), min(H, yi + r + 1)
        w = grid[y_lo:y_hi, x_lo:x_hi]
        lo, hi = float(w.min()), float(w.max())
        ref = s.get("ref_elev_m")
        notes = []
        if not inside:
            notes.append("OUTSIDE GRID")
        if ref is not None and e is not None:
            d = abs(ref - e)
            notes.append("ref-dem %.1f m %s" % (d, "OK" if d <= 15 else ">15 (app falls back to DEM)"))
        print("%-22s %8.1f %8.1f %9.1f %9s  %s" % (
            s["name"], px, py, e if e is not None else float("nan"),
            ("%.0f" % ref) if ref is not None else "-", "; ".join(notes)))
        site_out.append({"id": s["id"], "name": s["name"], "en": s["en"], "he": s["he"],
                         "lat": s["lat"], "lon": s["lon"], "px": px, "py": py,
                         "elev_m": e, "window_min": lo, "window_max": hi,
                         "ref_elev_m": ref})
    json.dump({"grid": {"width": W, "height": H}, "sites": site_out},
              open(os.path.join(DATA, "sites_pixel.json"), "w"), indent=2, ensure_ascii=False)
    print("WROTE", os.path.join(DATA, "sites_pixel.json"))

    iy, ix = np.unravel_index(np.argmax(grid), grid.shape)
    peak_lon = LON0 + (ix + 0.5) / W * (LON1 - LON0)
    peak_lat = ty2lat(y0 + (iy + 0.5) / TILE)
    print("grid peak: %.1f m at px(%d,%d) lon %.6f lat %.6f" % (grid.max(), ix, iy, peak_lon, peak_lat))
    print("DERIVE_GEO_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
