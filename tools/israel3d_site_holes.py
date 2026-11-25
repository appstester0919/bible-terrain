#!/usr/bin/env python3
"""Deterministic site holes in the water vector (2026-11-24).

WHY THIS SCRIPT EXISTS
----------------------
The 250 m "site holes" that keep the lakeside towns (Capernaum, Tiberias,
Qumran) out of the water polygon were originally injected by an ad-hoc
one-off command.  That means re-running `israel3d_water_v12.py` SILENTLY
DROPPED the holes and the markers slid back into the lake - exactly the
failure that cost hours on 2026-11-23.  The holes are now a deterministic,
re-runnable build step driven by `data/sites.json`, so a full rebuild
reproduces them exactly.

WHAT IT DOES
------------
For every site in `sites.json` that carries a `water_hole` block:
  * build a closed ring of radius `water_hole.radius_m` around the site's
    canonical lon/lat (longitude degrees are scaled by cos(lat) so the circle
    is round on the ground, not stretched);
  * drop it into the water body whose polygon contains the site.

Idempotent: existing synthetic holes are removed before the new ones are
added, so running it twice gives byte-identical output.

Usage:
    python3 israel3d_site_holes.py            # rewrite data/water_vector.json
    python3 israel3d_site_holes.py --check    # verify only, no write
"""
import json
import os, math, os, sys

DATA = os.environ.get("ISRAEL3D_DATA", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data"))
SEGMENTS = 48                      # 48 segments -> 49 points incl. closing point
M_PER_DEG_LAT = 111320.0


def log(*a):
    print(' '.join(str(x) for x in a), flush=True)


def circle_ring(lon, lat, radius_m, segments=SEGMENTS):
    """Closed ring (first point repeated at the end) of a circle on the ground."""
    dlat = radius_m / M_PER_DEG_LAT
    dlon = radius_m / (M_PER_DEG_LAT * math.cos(math.radians(lat)))
    pts = []
    for i in range(segments + 1):
        a = 2.0 * math.pi * i / segments
        pts.append([round(lon + dlon * math.cos(a), 6),
                    round(lat + dlat * math.sin(a), 6)])
    return pts


def pip(ring, x, y):
    """Point in polygon on lon/lat (ray casting)."""
    inside = False
    n = len(ring)
    for i in range(n - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        if (y1 > y) != (y2 > y):
            xi = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < xi:
                inside = not inside
    return inside


def ring_area_km2(ring):
    if len(ring) < 4:
        return 0.0
    s = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        s += x1 * y2 - x2 * y1
    la = sum(p[1] for p in ring) / len(ring)
    s = abs(s) / 2.0
    return s * (111.32 * math.cos(math.radians(la))) * 110.57


def main():
    check = '--check' in sys.argv
    sites_doc = json.load(open(os.path.join(DATA, 'sites.json')))
    sites = sites_doc['sites'] if isinstance(sites_doc, dict) else sites_doc
    vec_path = os.path.join(DATA, 'water_vector.json')
    doc = json.load(open(vec_path))

    wanted = []
    for s in sites:
        wh = s.get('water_hole')
        if wh:
            wanted.append((s['id'], s['lon'], s['lat'],
                           float(wh.get('radius_m', 250)), wh.get('body')))

    added = []
    for body in doc['bodies']:
        parts = body.get('parts', [])
        for part in parts:
            # drop previously injected synthetic holes (they are circular and
            # small; a real island hole from Natural Earth is much larger)
            part['holes'] = [h for h in part.get('holes', [])
                             if ring_area_km2(h) > 0.5]
        for sid, lon, lat, radius, forced_body in wanted:
            if forced_body and forced_body != body['name']:
                continue
            host = None
            for part in parts:
                if pip(part['ring'], lon, lat):
                    host = part
                    break
            if host is None:
                continue
            ring = circle_ring(lon, lat, radius)
            host.setdefault('holes', []).append(ring)
            added.append((sid, body['name'], radius, round(ring_area_km2(ring), 4)))

    # report the area cost of the holes per body
    log('--- site holes ---')
    for sid, bname, radius, a in added:
        log('  %-10s %-18s r=%3.0f m  area=%s km2' % (sid, bname, radius, a))
    if not added:
        log('  (none)')

    out = json.dumps(doc, separators=(',', ':'))
    if check:
        cur = open(vec_path).read()
        log('CHECK: matches current file' if cur == out else 'CHECK: DIFFERS')
        return 0 if cur == out else 1
    with open(vec_path, 'w') as f:
        f.write(out)
    log('DONE_OK ->', vec_path)
    return 0


if __name__ == '__main__':
    sys.exit(main())
