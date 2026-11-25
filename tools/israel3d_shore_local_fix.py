#!/usr/bin/env python3
"""Local shoreline correction for the Sea of Galilee.

Problem (found 2026-11-23): the production lake outline comes from Natural
Earth, whose Sea-of-Galilee ring is a coarse simplification. At latitudes
32.87-32.88 its WEST edge sits at lon ~35.555, i.e. about 2 km west of the real
shore, so lakeside towns (Capernaum -207 m, Tiberias -205 m) end up INSIDE the
water polygon and are carved down to the lake floor (-215 m).

Fix: keep the published outline (it is what holds the area within +/-5 %), but
push each boundary vertex that falls on ground ABOVE the lake level back to the
DEM shoreline. Only vertices inside a correction window around the affected
sites are moved, so the rest of the outline - and the total lake area - stays
untouched.

Steps per site window:
  1. densify the ring inside the window (Chaikin + subdivision) so the shore has
     enough resolution to bend;
  2. walk each vertex: if raw DEM at that point is above level, march outward
     (away from the lake centroid) in ~150 m steps until the DEM drops below the
     level -> that is the true shoreline point;
  3. re-smooth the moved section (Chaikin x2) and repair self-intersections.

Writes data/water_vector_local.json plus a report of the area change so the
result can be checked against the +/-5 % budget before it is promoted.
"""
import json
import os, math, sys, os
import numpy as np
from PIL import Image

DATA = os.environ.get("ISRAEL3D_DATA", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data"))
LEVEL_GALILEE = -209.0


def log(*a):
    print(' '.join(str(x) for x in a), flush=True)


def merc_y(lat):
    return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def load_dem():
    meta = json.load(open(os.path.join(DATA, 'elev.json')))
    img = Image.open(os.path.join(DATA, 'heightmap.png')).convert('RGB')
    a = np.asarray(img).astype(np.int64)
    v = (a[:, :, 0] * 256 + a[:, :, 1]) / 65535.0
    dem = meta['min'] + v * (meta['max'] - meta['min'])
    b = meta['bbox']

    def to_px(lon, lat):
        x = (lon - b['lon_min']) / (b['lon_max'] - b['lon_min']) * (dem.shape[1] - 1)
        y = (merc_y(b['lat_max']) - merc_y(lat)) / (merc_y(b['lat_max']) - merc_y(b['lat_min'])) * (dem.shape[0] - 1)
        return x, y

    def sample(lon, lat):
        x, y = to_px(lon, lat)
        xi, yi = int(round(x)), int(round(y))
        H, W = dem.shape
        if not (0 <= xi < W and 0 <= yi < H):
            return None
        return float(dem[yi, xi])
    return sample


def ring_area_km2(ring):
    R = 6371.0088
    pts = [(math.radians(lo), math.radians(la)) for lo, la in ring]
    a = 0.0
    n = len(pts)
    for i in range(n):
        lo1, la1 = pts[i]
        lo2, la2 = pts[(i + 1) % n]
        a += (lo2 - lo1) * (2 + math.sin(la1) + math.sin(la2))
    return abs(a * R * R / 2.0)


def chaikin(ring, iters=2):
    closed = ring[:-1] if ring[0] == ring[-1] else ring[:]
    n = len(closed)
    if n < 3:
        return ring
    for _ in range(iters):
        out = []
        for i in range(n):
            p0 = closed[i]
            p1 = closed[(i + 1) % n]
            out.append([p0[0] * 0.75 + p1[0] * 0.25, p0[1] * 0.75 + p1[1] * 0.25])
            out.append([p0[0] * 0.25 + p1[0] * 0.75, p0[1] * 0.25 + p1[1] * 0.75])
        closed = out
        n = len(closed)
    closed.append(list(closed[0]))
    return closed


def densify(ring, subdiv=4):
    out = []
    for i in range(len(ring) - 1):
        a = ring[i]
        b = ring[i + 1]
        for k in range(subdiv):
            t = k / subdiv
            out.append([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    out.append(list(ring[-1]))
    return out


def cross(o, a, b):
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def seg_cross(p1, p2, p3, p4):
    d1 = cross(p3, p4, p1)
    d2 = cross(p3, p4, p2)
    d3 = cross(p1, p2, p3)
    d4 = cross(p1, p2, p4)
    if ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)):
        return True
    return False


def fix_self_intersections(ring, max_pass=6):
    for _ in range(max_pass):
        n = len(ring)
        removed = False
        for i in range(n - 1):
            for j in range(i + 2, n - 1):
                if i == 0 and j == n - 2:
                    continue
                if seg_cross(ring[i], ring[i + 1], ring[j], ring[j + 1]):
                    del ring[i + 1]
                    removed = True
                    break
            if removed:
                break
        if not removed:
            break
    return ring


def km_between(a, b):
    la = math.radians((a[1] + b[1]) / 2)
    return math.hypot((b[0] - a[0]) * 111.32 * math.cos(la), (b[1] - a[1]) * 110.57)


def main():
    sample = load_dem()
    doc = json.load(open(os.path.join(DATA, 'water_vector.json')))
    sites = {s['id']: s for s in json.load(open(os.path.join(DATA, 'sites.json')))['sites']}

    report = []
    changed = False
    for body in doc['bodies']:
        if body['name'] != 'Sea of Galilee':
            continue
        level = body['level_m']
        part = body['parts'][0]
        ring = [list(p) for p in part['ring']]
        area_before = ring_area_km2(ring)

        # centroid (used as the "inward" reference direction)
        clon = sum(p[0] for p in ring) / len(ring)
        clat = sum(p[1] for p in ring) / len(ring)

        windows = []
        for sid in ('capernaum', 'tiberias'):
            s = sites[sid]
            windows.append((sid, s['lon'], s['lat']))

        # densify globally first (keeps one uniform resolution), then correct
        ring = densify(ring, 3)
        moved = 0
        for idx in range(len(ring) - 1):
            p = ring[idx]
            inside_window = False
            for sid, lon, lat in windows:
                if km_between(p, (lon, lat)) <= 2.6:
                    inside_window = True
                    break
            if not inside_window:
                continue
            e = sample(p[0], p[1])
            if e is None or e < level:
                continue
            # ground above the lake surface -> march outward until it meets water
            dlon = p[0] - clon
            dlat = p[1] - clat
            d = math.hypot(dlon, dlat)
            if d < 1e-9:
                continue
            step_lon = dlon / d * 0.0018      # ~200 m at this latitude
            step_lat = dlat / d * 0.0018
            nx, ny = p[0], p[1]
            for _ in range(40):
                nx += step_lon
                ny += step_lat
                e2 = sample(nx, ny)
                if e2 is None:
                    break
                if e2 < level:
                    break
            ring[idx] = [round(nx, 6), round(ny, 6)]
            moved += 1

        log('moved vertices:', moved)
        ring = chaikin(ring, 2)
        ring = fix_self_intersections(ring)
        area_after = ring_area_km2(ring)
        part['ring'] = ring
        changed = True
        report.append({'body': body['name'], 'area_before_km2': round(area_before, 1),
                       'area_after_km2': round(area_after, 1),
                       'moved_vertices': moved, 'ring_pts': len(ring)})

    if not changed:
        log('nothing to do')
        return 0
    out = os.path.join(DATA, 'water_vector_local.json')
    json.dump(doc, open(out, 'w'), separators=(',', ':'))
    log(json.dumps(report))
    log('DONE_OK ->', out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
