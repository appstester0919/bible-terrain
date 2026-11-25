#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Derive the TRUE water shoreline from the DEM as a smooth vector outline.

Why
---
The Natural Earth 10m lake outlines are a coarse, generalised public dataset.
Measured against this DEM, 67% of the Dead Sea boundary samples and 47% of the
Sea of Galilee samples sit ON LAND (terrain above the water level). The flat
water plane therefore gets cut by the stepped DEM and the visible shoreline is
a staircase, not the vector outline.

The authoritative shoreline of a water body at a given level IS the contour of
the terrain at that level. So trace it directly: marching squares over the DEM
at the body's surface level, keeping only the contour of the connected water
component (the Lisan peninsula genuinely splits the Dead Sea into a north and a
south basin at -401 m; that separation is geography, not an artefact).

Output: data/water_shore.json  {bodies:[{name, level_m, parts:[{ring, holes}]}]}
"""
import json
import math
import os
import sys
from collections import deque

import numpy as np
from PIL import Image

DATA = os.environ.get("ISRAEL3D_DATA", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data"))
SIMPLIFY_TOL_M = 40.0     # Douglas-Peucker tolerance in metres (~1/4 pixel)


def log(*a):
    print(*a)


# ----------------------------------------------------------------- utilities
def dp_simplify(points, tol):
    """Douglas-Peucker on a polyline given as a list of (x, y)."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        ax, ay = points[i]
        bx, by = points[j]
        dx, dy = bx - ax, by - ay
        den = math.hypot(dx, dy)
        best, best_i = -1.0, -1
        for k in range(i + 1, j):
            px, py = points[k]
            if den == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (den * den)))
                d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if d > best:
                best, best_i = d, k
        if best > tol:
            keep[best_i] = True
            stack.append((i, best_i))
            stack.append((best_i, j))
    return [p for p, k in zip(points, keep) if k]


def chaikin(points, iterations=2, closed=True):
    """Corner-cutting smoothing: turns a polyline into a smooth curve."""
    pts = list(points)
    for _ in range(iterations):
        out = []
        n = len(pts)
        rng = range(n) if closed else range(n - 1)
        for i in rng:
            p = pts[i]
            q = pts[(i + 1) % n]
            out.append((0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]))
            out.append((0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]))
        pts = out
    return pts


def signed_area(pts):
    a = 0.0
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        a += x1 * y2 - x2 * y1
    return a / 2.0


def flood_mask(dem, seed, thr, W, H, roi_px):
    sx, sy = seed
    if not (0 <= sx < W and 0 <= sy < H) or dem[sy, sx] > thr:
        return None
    out = np.zeros((H, W), dtype=bool)
    out[sy, sx] = True
    q = deque([(sx, sy)])
    NB = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, -1), (-1, 1), (1, 1)]
    x0, y0 = sx - roi_px, sy - roi_px
    x1, y1 = sx + roi_px, sy + roi_px
    while q:
        x, y = q.popleft()
        for dx, dy in NB:
            nx, ny = x + dx, y + dy
            if not (0 <= nx < W and 0 <= ny < H) or out[ny, nx]:
                continue
            if not (x0 <= nx <= x1 and y0 <= ny <= y1):
                continue
            if dem[ny, nx] > thr:
                continue
            out[ny, nx] = True
            q.append((nx, ny))
    return out


def flood_mask_rect(dem, seed, thr, W, H, x0, x1, y0, y1):
    """Flood where dem <= thr, restricted to a rectangle (the polygon's own box)."""
    sx, sy = seed
    if not (0 <= sx < W and 0 <= sy < H) or dem[sy, sx] > thr:
        return None
    x0, x1 = max(0, x0), min(W - 1, x1)
    y0, y1 = max(0, y0), min(H - 1, y1)
    out = np.zeros((H, W), dtype=bool)
    out[sy, sx] = True
    q = deque([(sx, sy)])
    NB = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, -1), (-1, 1), (1, 1)]
    while q:
        x, y = q.popleft()
        for dx, dy in NB:
            nx, ny = x + dx, y + dy
            if not (x0 <= nx <= x1 and y0 <= ny <= y1) or out[ny, nx]:
                continue
            if dem[ny, nx] > thr:
                continue
            out[ny, nx] = True
            q.append((nx, ny))
    return out


def contour_from_mask(fm, W, H):
    """Trace closed boundary loops of a boolean mask by walking its edges.

    Each boundary pixel contributes directed edges so that the filled side is
    always on the LEFT; following those directed edges produces properly closed
    loops without the ambiguity of raw marching squares. Marching squares over a
    noisy 153 m DEM produced hundreds of tiny broken contours, which is why this
    edge-walking version is used instead.
    """
    # Directed unit edges on the pixel-corner lattice: (x, y) -> (nx, ny).
    edges = {}
    for y in range(H):
        row = fm[y]
        for x in range(W):
            if not row[x]:
                continue
            # up neighbour empty  -> edge (x, y)     -> (x+1, y)
            if y == 0 or not fm[y - 1][x]:
                edges.setdefault((x, y), []).append((x + 1, y))
            # right neighbour empty -> edge (x+1, y) -> (x+1, y+1)
            if x == W - 1 or not row[x + 1]:
                edges.setdefault((x + 1, y), []).append((x + 1, y + 1))
            # down neighbour empty  -> edge (x+1, y+1) -> (x, y+1)
            if y == H - 1 or not fm[y + 1][x]:
                edges.setdefault((x + 1, y + 1), []).append((x, y + 1))
            # left neighbour empty  -> edge (x, y+1)  -> (x, y)
            if x == 0 or not row[x - 1]:
                edges.setdefault((x, y + 1), []).append((x, y))

    loops = []
    used = set()
    for start in list(edges.keys()):
        while edges.get(start):
            nxt = edges[start].pop()
            if (start, nxt) in used:
                continue
            used.add((start, nxt))
            loop = [start]
            cur = nxt
            guard = 0
            while cur != start and guard < 2_000_000:
                guard += 1
                loop.append(cur)
                opts = edges.get(cur)
                if not opts:
                    break
                nxt = opts.pop()
                used.add((cur, nxt))
                cur = nxt
            if len(loop) >= 4 and cur == start:
                loops.append([(float(a), float(b)) for (a, b) in loop])
    return loops


def main():
    meta = json.load(open(os.path.join(DATA, "elev.json")))
    geo = json.load(open(os.path.join(DATA, "geo.json")))
    im = np.asarray(Image.open(os.path.join(DATA, "heightmap.png")).convert("RGB")).astype(np.float64)
    H, W = im.shape[0], im.shape[1]
    v = (im[:, :, 0] * 256.0 + im[:, :, 1]) / 65535.0
    dem = meta["min"] + v * (meta["max"] - meta["min"])
    log("DEM %dx%d  min %.1f max %.1f" % (W, H, dem.min(), dem.max()))

    lon0, lon1 = geo["lon_min"], geo["lon_max"]
    latT, latB = geo["lat_top"], geo["lat_bottom"]
    MY_T = math.log(math.tan(math.pi / 4 + math.radians(latT) / 2))
    MY_B = math.log(math.tan(math.pi / 4 + math.radians(latB) / 2))

    def to_px(lon, lat):
        x = (lon - lon0) / (lon1 - lon0) * (W - 1)
        y = (MY_T - math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))) / (MY_T - MY_B) * (H - 1)
        return x, y

    def to_lonlat(x, y):
        lon = lon0 + (x / (W - 1)) * (lon1 - lon0)
        my = MY_T - (y / (H - 1)) * (MY_T - MY_B)
        lat = math.degrees(math.atan(math.sinh(my)))
        return lon, lat

    mpp_x = abs(lon1 - lon0) * 111320.0 * math.cos(math.radians((latT + latB) / 2)) / (W - 1)
    mpp_y = (meta["max"] - meta["min"]) / 1.0
    mpp_m = geo.get("meters_per_pixel_y") or 152.87

    wv = json.load(open(os.path.join(DATA, "water_vector.json")))
    out_bodies = []

    for body in wv["bodies"]:
        name = body["name"]
        level = body["level_m"]
        if name == "Mediterranean Sea":
            # The offshore DEM is flat near 0 m, so a DEM contour is meaningless
            # there; the Natural Earth ocean polygon is the right source.
            out_bodies.append(body)
            log("  %-20s level %7.1f m: kept the Natural Earth ocean polygon"
                % (name, level))
            continue

        # Seed the flood at the deepest point of each Natural Earth part, so we
        # trace the real water body rather than any other basin at this level.
        parts_out = []
        for part in body["parts"]:
            ring = part["ring"]
            xs = [p[0] for p in ring]
            ys = [p[1] for p in ring]
            cx = sum(xs) / len(xs)
            cy = sum(ys) / len(ys)
            seed_px = to_px(cx, cy)
            si = int(round(seed_px[0]))
            sj = int(round(seed_px[1]))
            # Nudge the seed to the lowest DEM pixel inside the polygon.
            best = None
            for dy in range(-12, 13):
                for dx in range(-12, 13):
                    x, y = si + dx, sj + dy
                    if 0 <= x < W and 0 <= y < H:
                        if dem[y, x] <= level + 0.5:
                            if best is None or dem[y, x] < dem[best[1], best[0]]:
                                best = (x, y)
            if best is None:
                continue
            # ROI limited to this polygon's own bounding box plus a small margin.
            # A 60 km disc let the flood leak across the Lisan isthmus and merge
            # the north and south Dead Sea basins into one contour.
            roi_x = int((max(xs) - min(xs)) * (W - 1) / max(1e-9, (lon1 - lon0)) / 2 + 6)
            roi_y = int((max(ys) - min(ys)) * (H - 1) / max(1e-9, (latT - latB)) / 2 + 6)
            # SRTM fills the Dead Sea south basin at about -398..-399 m, which is
            # ABOVE the authoritative -401 m surface. A flood that insists on
            # <= level therefore finds no water at all and degenerates into an
            # 8-pixel blob. Flood from the basin floor instead: use the deepest
            # pixel found in the polygon plus a small rise, but never above the
            # reported surface level by more than 5 m.
            floor = dem[best[1], best[0]]
            thr = min(level + 5.0, floor + 3.0)
            if thr < level - 20.0:
                thr = level - 20.0
            fm = flood_mask_rect(dem, best, thr, W, H, si - roi_x, si + roi_x, sj - roi_y, sj + roi_y)
            log("      flood threshold %.1f m (basin floor %.1f m, surface %.1f m)"
                % (thr, floor, level))
            if fm is None or not fm.any():
                continue
            log("    %-20s part %-18s seed px (%d,%d) dem %.1f m, flood %d px"
                % (name, part["name"], best[0], best[1], dem[best[1], best[0]], int(fm.sum())))

            # Keep only marching-squares contours that touch this flood area.
            loops = contour_from_mask(fm, W, H)
            keep = []
            for lp in loops:
                inside = 0
                for (x, y) in lp:
                    xi, yi = int(round(x)), int(round(y))
                    if 0 <= xi < W and 0 <= yi < H and fm[yi, xi]:
                        inside += 1
                if inside > max(3, len(lp) * 0.05):
                    keep.append(lp)
            if not keep:
                log("      no DEM contour matched the flood area")
                continue
            def ring_area_km2(loop):
                a = 0.0
                n = len(loop)
                for i in range(n):
                    x1, y1 = loop[i]; x2, y2 = loop[(i + 1) % n]
                    a += x1 * y2 - x2 * y1
                return abs(a / 2.0) * (mpp_m / 1000.0) ** 2
            keep.sort(key=lambda L: -abs(ring_area_km2(L)))
            main_loop = keep[0]
            # DEM noise produces hundreds of tiny closed contours at this level.
            # A hole only matters if it is a real island (>= 0.5 km2).
            holes = [h for h in keep[1:] if ring_area_km2(h) >= 0.5]
            log("      DEM contour: %d pts (main), %d hole(s)" % (len(main_loop), len(holes)))

            def finish(loop):
                """Simplify, smooth, then pull the result back inside the water.

                Chaikin corner-cutting rounds every corner, which bows the curve
                OUTSIDE the flooded region by a pixel or two. Left alone, those
                pixels are dry land, and carving them would flatten real
                shoreline terrain - which is exactly what the carve script's
                self-check caught (terrain at -335 m inside a -401 m polygon).
                So every smoothed vertex is snapped back to the nearest point
                that is still water.
                """
                simp = dp_simplify(loop, SIMPLIFY_TOL_M / mpp_m)
                sm = chaikin(simp, 2, closed=True)
                out = []
                for (x, y) in sm:
                    xi, yi = int(round(x)), int(round(y))
                    if not (0 <= xi < W and 0 <= yi < H) or not fm[yi, xi]:
                        # search a small neighbourhood for the nearest water pixel
                        best = None
                        bd = 1e9
                        for dy in range(-4, 5):
                            for dx in range(-4, 5):
                                nx, ny = xi + dx, yi + dy
                                if not (0 <= nx < W and 0 <= ny < H) or not fm[ny, nx]:
                                    continue
                                d = dx * dx + dy * dy
                                if d < bd:
                                    bd, best = d, (nx, ny)
                        if best is None:
                            continue
                        x, y = float(best[0]), float(best[1])
                    lon, lat = to_lonlat(x, y)
                    out.append([round(lon, 6), round(lat, 6)])
                return out

            parts_out.append({"name": part["name"], "ring": finish(main_loop),
                              "holes": [finish(h) for h in holes]})

        if parts_out:
            out_bodies.append({"name": name, "level_m": level, "parts": parts_out})

    with open(os.path.join(DATA, "water_shore.json"), "w", encoding="utf-8") as f:
        json.dump({"bodies": out_bodies}, f, separators=(",", ":"))
    log("")
    log("  water_shore.json written: %d bodies" % len(out_bodies))
    for b in out_bodies:
        for p in b["parts"]:
            log("     %-20s level %7.1f m  ring %4d pts  %d holes"
                % (p["name"], b["level_m"], len(p["ring"]), len(p.get("holes", []))))
    log("DONE_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
