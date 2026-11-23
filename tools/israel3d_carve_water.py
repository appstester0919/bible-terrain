#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Carve the terrain below the water surface, so the shoreline is the VECTOR
outline instead of wherever the stepped DEM happens to cross the water plane.

Why this exists
---------------
The water surface is a flat plane at the authoritative level (Dead Sea -401 m,
Sea of Galilee -209 m, Mediterranean 0 m). The DEM is a 153 m/px stepped grid,
so the plane intersects it in visible staircase steps and pokes through the
smooth vector outline. Fixing it in the data is the correct fix: lower every
terrain sample that lies INSIDE the water polygon to just below the water
level. Then the water plane fully covers the carved basin and the visible
shoreline IS the vector outline.

Reads
  data/heightmap.png    16-bit DEM (R = high byte, G = low byte)
  data/water_shore.json   DEM-derived shoreline rings (preferred)
  data/water_vector.json  fallback rings
Writes
  data/heightmap_water.png  same encoding, carved
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

DATA = os.path.expanduser("~/work/israel3d/data")
CARVE_DEPTH = 6.0     # metres below the water surface
BEACH_PX = 10         # width of the graded beach band, in pixels (~1.5 km)
PAD = 1               # pixels of margin so the bank still meets the water

log_lines = []


def log(msg):
    print(msg)
    log_lines.append(msg)


def distance_outside(mask, radius):
    """Chamfer distance (in pixels) from every OUTSIDE pixel to the mask.

    Iterative min-plus propagation: distance 0 inside the mask, growing by one
    per pixel step outwards.
    """
    H, W = mask.shape
    INF = np.float32(1e6)
    dist = np.where(mask, 0.0, INF).astype(np.float32)
    for _ in range(radius):
        prev = dist.copy()
        np.minimum(dist, np.roll(prev, 1, axis=0) + 1.0, out=dist)
        np.minimum(dist, np.roll(prev, -1, axis=0) + 1.0, out=dist)
        np.minimum(dist, np.roll(prev, 1, axis=1) + 1.0, out=dist)
        np.minimum(dist, np.roll(prev, -1, axis=1) + 1.0, out=dist)
        dist[0, :] = np.minimum(dist[0, :], prev[0, :] + 1.0)
        dist[-1, :] = np.minimum(dist[-1, :], prev[-1, :] + 1.0)
        dist[:, 0] = np.minimum(dist[:, 0], prev[:, 0] + 1.0)
        dist[:, -1] = np.minimum(dist[:, -1], prev[:, -1] + 1.0)
    dist[mask] = 0.0
    return dist


def main():
    hm = Image.open(os.path.join(DATA, "heightmap.png")).convert("RGB")
    ha = np.asarray(hm).astype(np.float64)
    H, W = ha.shape[0], ha.shape[1]
    em = json.load(open(os.path.join(DATA, "elev.json")))
    vmin, vmax = em["min"], em["max"]
    v = (ha[:, :, 0] * 256.0 + ha[:, :, 1]) / 65535.0
    dem = vmin + v * (vmax - vmin)
    log("DEM %dx%d  min %.1f max %.1f" % (W, H, dem.min(), dem.max()))

    geo = json.load(open(os.path.join(DATA, "geo.json")))
    lon0, lon1 = geo["lon_min"], geo["lon_max"]
    latT, latB = geo["lat_top"], geo["lat_bottom"]

    def my(lat):
        return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))

    def to_px(lon, lat):
        x = (lon - lon0) / (lon1 - lon0) * (W - 1)
        y = (my(latT) - my(lat)) / (my(latT) - my(latB)) * (H - 1)
        return x, y

    # Use the Natural Earth outlines: their AREA is the published figure
    # (Dead Sea ~850 km2 at -401 m, which includes the southern basin that SRTM
    # fills at -398 m and a DEM contour therefore cannot draw). The DEM-derived
    # shoreline in water_shore.json is only -15.6% on Dead Sea area.
    wv = json.load(open(os.path.join(DATA, "water_vector.json")))
    bodies = wv.get("bodies", [])
    log("carving from water_vector.json (Natural Earth outlines, published area)")
    if not bodies:
        log("water_vector.json has no bodies; nothing to carve")
        return 1

    # Site pads (see the site-pad block below): documented absolute heights
    # for archaeological sites that the 153 m DEM cannot resolve.
    # (lat, lon, ref_elev_m, radius_px)
    PADS = []
    sites_path = os.path.join(DATA, "sites.json")
    if os.path.exists(sites_path):
        sj = json.load(open(sites_path))
        for st in sj.get("sites", []):
            if st.get("ref_elev_m") is not None and st.get("pad", False):
                PADS.append((st["lat"], st["lon"], float(st["ref_elev_m"]),
                             int(st.get("pad_radius_px", 3))))
    pad_mask = np.zeros((H, W), dtype=bool)

    carved = dem.copy()
    for body in bodies:
        level = body["level_m"]
        target = level - CARVE_DEPTH
        mask = Image.new("L", (W, H), 0)
        dr = ImageDraw.Draw(mask)
        for part in body["parts"]:
            ring = [to_px(p[0], p[1]) for p in part["ring"]]
            if len(ring) >= 3:
                dr.polygon(ring, fill=255)
            for hole in part.get("holes", []):
                hring = [to_px(p[0], p[1]) for p in hole]
                if len(hring) >= 3:
                    dr.polygon(hring, fill=0)
        m = np.asarray(mask) > 128
        if not m.any():
            log("  %-20s level %7.1f m: polygon covers no pixel, skipped"
                % (body["name"], level))
            continue
        # Graded beach. The DEM is a 153 m grid, so just outside the outline the
        # terrain can jump tens of metres in one pixel; that step is what the
        # renderer showed as a staircase shoreline. Instead of a hard edge, the
        # terrain in a band OUTSIDE the outline is blended linearly from 1 m
        # below the water surface back to its real elevation, producing a
        # continuous beach slope and a clean waterline.
        dist = distance_outside(m, BEACH_PX)
        band = (dist >= 1) & (dist <= BEACH_PX)
        if band.any():
            shallow = level - 1.0
            t = (dist[band].astype(np.float64) - 1.0) / float(BEACH_PX - 1)
            blended = shallow + t * (dem[band] - shallow)
            carved[band] = np.minimum(dem[band], blended)
            n_ramp = int(band.sum())
        else:
            n_ramp = 0
        # Only lower terrain that pokes ABOVE the water surface. Terrain that
        # is already deeper stays as it is (real bathymetry).
        above = m & (dem > level)
        n_above = int(above.sum())
        carved[above] = target
        log("  %-20s level %7.1f m: %d px inside polygon, %d px lowered to %.1f m, "
            "%d px beach ramp at %.1f m"
            % (body["name"], level, int(m.sum()), n_above, target, n_ramp, level - 1.0))

    # ------------------------------------------------------------------
    # Site pads. A 153 m DEM pixel cannot resolve a lakeshore village: the
    # pixel that contains Capernaum averages the town (-207 m) with the
    # harbour water (-212 m), and the Natural Earth lake outline over-covers
    # the shore, so the DEM reports it as lake floor and the carve pushes it
    # under the water surface. Archaeological sites have a documented
    # absolute height (data/sites.json ref_elev_m: Capernaum -207 m, Tiberias
    # -200 m, Qumran terrace -330 m), so raise the terrain locally to that
    # height: the town then stands on its own terrace above the lake, which
    # is also how it looked in antiquity, when the lake ran 1-2 m lower and
    # the shoreline lay up to 150 ft further out.
    # ------------------------------------------------------------------
    for (lat, lon, ref, r) in PADS:
        px, py = to_px(lon, lat)
        xi, yi = int(round(px)), int(round(py))
        x0, x1 = max(0, xi - r), min(W, xi + r + 1)
        y0, y1 = max(0, yi - r), min(H, yi + r + 1)
        yy, xx = np.mgrid[y0:y1, x0:x1]
        d = np.sqrt((xx - px) ** 2 + (yy - py) ** 2)
        wgt = np.clip(1.0 - d / float(r), 0.0, 1.0)
        patch = carved[y0:y1, x0:x1]
        carved[y0:y1, x0:x1] = patch + wgt * (ref - patch)
        pad_mask[y0:y1, x0:x1] |= (wgt > 0.02)
        log("  site pad ref %.1f m at px (%.0f, %.0f) r=%d px" % (ref, px, py, r))

    changed = int((carved != dem).sum())
    log("  total pixels changed: %d (%.3f%% of the map)" % (changed, 100.0 * changed / dem.size))
    # Write back in the same 16-bit encoding: R = high byte, G = low byte.
    nv = (carved - vmin) / (vmax - vmin)
    nv = np.clip(nv, 0.0, 1.0)
    hi = np.floor(nv * 255.0 + 0.5).astype(np.uint8)
    lo = np.floor((nv * 255.0 - hi) * 256.0 + 0.5).astype(np.uint8)
    out = np.zeros((H, W, 3), dtype=np.uint8)
    out[:, :, 0] = hi
    out[:, :, 1] = lo
    out[:, :, 2] = 0
    Image.fromarray(out, "RGB").save(os.path.join(DATA, "heightmap_water.png"))
    log("  heightmap_water.png written: %dx%d" % (W, H))

    # Sanity: the carved DEM must still be inside the original range, and the
    # water surface must now sit strictly ABOVE the terrain everywhere inside
    # the polygon (that is the whole point).
    assert carved.min() >= vmin - 1e-6 and carved.max() <= vmax + 1e-6, \
        "carved DEM left the elevation range"
    for body in bodies:
        level = body["level_m"]
        mask = Image.new("L", (W, H), 0)
        dr = ImageDraw.Draw(mask)
        for part in body["parts"]:
            ring = [to_px(p[0], p[1]) for p in part["ring"]]
            if len(ring) >= 3:
                dr.polygon(ring, fill=255)
        m = np.asarray(mask) > 128
        if not m.any():
            continue
        mm = m & (~pad_mask)
        worst = float(carved[mm].max()) if mm.any() else -1e9
        ok = worst <= level + 1e-6
        log("  check %-20s max terrain inside polygon %.1f m vs water %.1f m -> %s"
            % (body["name"], worst, level, "OK" if ok else "STILL ABOVE WATER"))
        if not ok:
            return 1
    log("DONE_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
