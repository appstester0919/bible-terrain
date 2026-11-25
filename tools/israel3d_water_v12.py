#!/usr/bin/env python3
"""
israel3d_water_v12.py  --  water / coastline / river layers for the Israel 3D map.

Replaces v11. Three substantive corrections:

1. AREA SCALE.  geo.json's "meters_per_pixel" (152.874) is the EQUATORIAL
   resolution of a z=10 Web Mercator tile.  The ground scale at latitude phi is
   MPP*cos(phi), and the projected grid is stretched by 1/cos(phi) in X, so
   the projected area must be multiplied by cos^2(phi) to get true ground
   area.  v11 reported every area inflated by ~1.42x (Dead Sea 916.8 km2
   instead of ~605).

2. LAKE EXTENT.  Three independent estimates are computed for every lake and
   cross-checked:
     A) Natural Earth vector outline (rasterised), with the SPHERICAL area of
        the raw ring computed independently of the rasteriser.
     B) DEM contour at the authoritative surface level.
     C) DEM "flat lake bed" component: the SRTM water body is filled with a
        constant value, so the lake is the flat region around the centre.
        This is immune to the Jordan Valley leak that ruins (B).
   The estimate closest to the expected area wins; ties break to the vector
   outline.  Everything is logged so the choice can be audited.

3. RIVERS.  Natural Earth 10m rivers, CLIPPED to the map bbox.  v11 fell back
   to the unclipped global layer and delivered 400 world rivers (Amazon,
   Yangtze, Ganges) totalling 327,686 km.  After clipping, the bbox contains
   exactly the Jordan (5 reaches, 248 km - the real Jordan is ~251 km).

Outputs: data/water.png (RG=16-bit level, A=255 mask), data/water_meta.json,
data/water_preview.png, data/rivers.json, data/coastline.json
"""
import json
import os, math, os, sys, time, urllib.parse, urllib.request
from collections import deque
import numpy as np
from PIL import Image, ImageDraw

DATA = os.environ.get("ISRAEL3D_DATA", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data"))
CACHE = os.path.join(DATA, "cache")
os.makedirs(CACHE, exist_ok=True)
LOGF = open(os.path.join(DATA, "water_build_log.txt"), "w", encoding="utf-8")

def log(*a):
    s = " ".join(str(x) for x in a)
    print(s, flush=True)
    LOGF.write(s + "\n"); LOGF.flush()

log("=== israel3d water builder v12  %s ===" % time.strftime("%Y-%m-%d %H:%M:%S"))

# --------------------------------------------------------------- grid
geo = json.load(open(os.path.join(DATA, "geo.json")))
W, H = geo["width_px"], geo["height_px"]
LON0, LON1 = geo["lon_min"], geo["lon_max"]
MY_T, MY_B = geo["merc_y_top"], geo["merc_y_bot"]
MPP = geo["meters_per_pixel"]
# BBOX used to be hardcoded to (31.00, 34.40, 33.20, 36.30). That north limit of
# 33.20 sat BELOW the DEM's top edge once Mount Hermon was added (the grid now
# reaches lat 33.7243), so the Natural Earth coastlines and rivers were clipped
# short of the terrain they were being painted onto - the new northern strip had
# bare sea-floor with no water surface drawn on it. The bbox is now derived from
# geo.json, which is itself derived from data/tiles/, so the vector extent can no
# longer drift away from the DEM extent.
BBOX = (geo["lat_bottom"], geo["lon_min"], geo["lat_top"], geo["lon_max"])
log("  vector bbox from geo.json: s %.4f w %.4f n %.4f e %.4f" % BBOX)

def merc_y(lat):
    return math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat)))
def lon_px(lon): return (lon - LON0) / (LON1 - LON0) * W
def lat_py(lat): return (MY_T - merc_y(lat)) / (MY_T - MY_B) * H
def px_lon(x): return LON0 + (x / W) * (LON1 - LON0)
def py_lat(y):
    return math.degrees(math.atan(math.sinh(MY_T - (y / H) * (MY_T - MY_B))))

LAT_ROW = np.array([py_lat(y) for y in range(H)], dtype=np.float64)
COS2 = (np.cos(np.radians(LAT_ROW)) ** 2).reshape(H, 1)      # (H,1)
# projected pixel area in km2, and the same converted to TRUE GROUND area
PX_KM2_PROJ = MPP * MPP / 1e6
PX_KM2 = PX_KM2_PROJ * COS2                                  # (H,1) broadcastable

def area_km2(mask):
    """True ground area of a boolean mask, km2."""
    return float((mask * PX_KM2).sum())

log("grid %dx%d  MPP(equatorial) %.3f m/px  lat %.4f..%.4f  cos^2 %.4f..%.4f"
    % (W, H, MPP, LAT_ROW[-1], LAT_ROW[0], COS2.min(), COS2.max()))
log("1 px = %.5f km2 projected, %.5f km2 true ground (at mid-lat)"
    % (PX_KM2_PROJ, float(PX_KM2[H//2][0])))

def haversine(a, b):
    R = 6371000.0
    p1, p2 = math.radians(a[1]), math.radians(b[1])
    dp = p2 - p1
    dl = math.radians(b[0] - a[0])
    x = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2*R*math.asin(min(1.0, math.sqrt(x)))

def spherical_ring_area_km2(ring):
    """Area of a lon/lat polygon on the sphere, km2 - independent of any raster."""
    if len(ring) < 3:
        return 0.0
    R = 6371.0088
    total = 0.0
    n = len(ring)
    for i in range(n):
        lon1, lat1 = ring[i]
        lon2, lat2 = ring[(i+1) % n]
        total += math.radians(lon2-lon1) * (2 + math.sin(math.radians(lat1))
                                           + math.sin(math.radians(lat2)))
    return abs(total * R * R / 2.0)

def fetch(url, name, timeout=120):
    path = os.path.join(CACHE, name)
    if os.path.exists(path) and os.path.getsize(path) > 200:
        return path
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "israel3d/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
        with open(path, "wb") as f:
            f.write(data)
        log("  fetched %s (%d bytes)" % (name, len(data)))
        return path
    except Exception as e:
        log("  fetch FAILED %s: %s" % (name, e))
        return None

def ne(base):
    return ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
            "master/geojson/" + base)

def load_json(path):
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        log("  json load failed %s: %s" % (path, e))
        return None

WET_MIN_FRACTION = 0.35   # a basin must be at least this fraction
                            # below its surface level to count as water

# ================================================================ DEM
log("")
log("--- DEM ---")
hm = Image.open(os.path.join(DATA, "heightmap.png")).convert("RGB")
ha = np.asarray(hm).astype(np.float64)
hv = (ha[:, :, 0] * 256.0 + ha[:, :, 1]) / 65535.0
em = json.load(open(os.path.join(DATA, "elev.json")))
dem = em["min"] + hv * (em["max"] - em["min"])
log("DEM %dx%d  min %.1f max %.1f" % (W, H, dem.min(), dem.max()))

def flood_at_level(field, seed_xy, thr, roi_km):
    """Connected region where field <= thr, limited to a ROI disc."""
    sx, sy = seed_xy
    if not (0 <= sx < W and 0 <= sy < H) or field[sy, sx] > thr:
        return None
    yy, xx = np.ogrid[:H, :W]
    roi = ((xx - sx)**2 + (yy - sy)**2) <= (roi_km*1000.0/(MPP*float(np.cos(np.radians(LAT_ROW[sy])))))**2
    outm = np.zeros((H, W), dtype=bool)
    outm[sy, sx] = True
    q = deque([(sx, sy)])
    NB = [(-1,-1),(0,-1),(1,-1),(-1,0),(1,0),(-1,1),(0,1),(1,1)]
    while q:
        x, y = q.popleft()
        for dx, dy in NB:
            nx, ny = x+dx, y+dy
            if not (0 <= nx < W and 0 <= ny < H):
                continue
            if outm[ny, nx] or field[ny, nx] > thr:
                continue
            if not roi[ny, nx]:
                continue
            outm[ny, nx] = True
            q.append((nx, ny))
    return outm

def flat_bed_component(field, seed_xy, tol=1.5, roi_km=40.0):
    """The flat, constant-value region around the seed - SRTM fills water bodies
    with one constant, so this is the lake bed itself.  Immune to the leak."""
    sx, sy = seed_xy
    if not (0 <= sx < W and 0 <= sy < H):
        return None, None
    bed = float(np.median(field[sy-2:sy+3, sx-2:sx+3]))
    yy, xx = np.ogrid[:H, :W]
    roi = ((xx - sx)**2 + (yy - sy)**2) <= (roi_km*1000.0/(MPP*float(np.cos(np.radians(LAT_ROW[sy])))))**2
    band = (np.abs(field - bed) <= tol) & roi
    if not band[sy, sx]:
        return None, bed
    outm = np.zeros((H, W), dtype=bool)
    outm[sy, sx] = True
    q = deque([(sx, sy)])
    NB = [(-1,-1),(0,-1),(1,-1),(-1,0),(1,0),(-1,1),(0,1),(1,1)]
    while q:
        x, y = q.popleft()
        for dx, dy in NB:
            nx, ny = x+dx, y+dy
            if not (0 <= nx < W and 0 <= ny < H):
                continue
            if outm[ny, nx] or not band[ny, nx]:
                continue
            outm[ny, nx] = True
            q.append((nx, ny))
    return outm, bed

# ================================================================ rasterise
def ring_to_px(ring):
    return [(int(round(lon_px(lo))), int(round(lat_py(la)))) for lo, la in ring]

def rasterize(rings):
    mask = np.zeros((H, W), dtype=bool)
    for ext, holes in rings:
        if len(ext) < 3:
            continue
        e = Image.new("L", (W, H), 0)
        ImageDraw.Draw(e).polygon(ring_to_px(ext), fill=1, outline=1)
        em_ = np.asarray(e) > 0
        if holes:
            hh = Image.new("L", (W, H), 0)
            dh = ImageDraw.Draw(hh)
            for h in holes:
                if len(h) >= 3:
                    dh.polygon(ring_to_px(h), fill=1, outline=1)
            em_ &= ~(np.asarray(hh) > 0)
        mask |= em_
    return mask

def clip_ring(ring, step_m=250.0):
    """Clip a closed ring to the bbox, returning SEPARATE polyline runs.
    A ring that leaves and re-enters the bbox must not be joined by a false
    straight line across the map."""
    s, w, n, e = BBOX
    runs, cur = [], []
    for lon, lat in ring:
        if (s <= lat <= n) and (w <= lon <= e):
            if not cur or cur[-1] != (lon, lat):
                cur.append((lon, lat))
        else:
            if len(cur) >= 2:
                runs.append(cur)
            cur = []
    if len(cur) >= 2:
        runs.append(cur)
    out = []
    for r in runs:
        thin = []
        for p in r:
            if not thin or haversine(thin[-1], p) >= step_m:
                thin.append(p)
        if len(thin) >= 2:
            out.append(thin)
    return out

def clip_line(pts, step_m=400.0):
    s, w, n, e = BBOX
    runs, cur = [], []
    for lon, lat in pts:
        if (s <= lat <= n) and (w <= lon <= e):
            if not cur or cur[-1] != (lon, lat):
                cur.append((lon, lat))
        else:
            if len(cur) >= 2:
                runs.append(cur)
            cur = []
    if len(cur) >= 2:
        runs.append(cur)
    out = []
    for r in runs:
        thin = []
        for p in r:
            if not thin or haversine(thin[-1], p) >= step_m:
                thin.append(p)
        if len(thin) >= 2:
            out.append(thin)
    return out

# ================================================================ OCEAN
log("")
log("--- ocean: Natural Earth 10m ocean polygon ---")
ocean_doc = load_json(fetch(ne("ne_10m_ocean.geojson"), "ne_10m_ocean.geojson"))
ocean = np.zeros((H, W), dtype=bool)
sea_runs = []
sea_polys = []

def clip_convex(ring, bbox):
    """Sutherland-Hodgman clip of a polygon against a CONVEX rectangle.
    The bbox is a rectangle, so this is exact for the outer ring."""
    s, w, n, e = bbox
    def clip_half(pts, inside, intersect):
        out = []
        for i in range(len(pts)):
            cur, prv = pts[i], pts[i - 1]
            if inside(cur):
                if not inside(prv):
                    out.append(intersect(prv, cur))
                out.append(cur)
            elif inside(prv):
                out.append(intersect(prv, cur))
        return out
    def lerp(a, b, t):
        return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
    pts = list(ring)
    pts = clip_half(pts, lambda p: p[1] >= s,
                    lambda a, b: lerp(a, b, (s - a[1]) / (b[1] - a[1]) if b[1] != a[1] else 0))
    pts = clip_half(pts, lambda p: p[1] <= n,
                    lambda a, b: lerp(a, b, (n - a[1]) / (b[1] - a[1]) if b[1] != a[1] else 0))
    pts = clip_half(pts, lambda p: p[0] >= w,
                    lambda a, b: lerp(a, b, (w - a[0]) / (b[0] - a[0]) if b[0] != a[0] else 0))
    pts = clip_half(pts, lambda p: p[0] <= e,
                    lambda a, b: lerp(a, b, (e - a[0]) / (b[0] - a[0]) if b[0] != a[0] else 0))
    return pts

def fix_self_intersections(ring):
    """Remove the vertices that make a ring cross itself.

    earcut cannot triangulate a self-intersecting polygon: it emits stray
    triangles that appear in the render as isolated blue blocks on land. The
    Natural Earth lake outlines contain a couple of such crossings.
    """
    def cross(o, a, b):
        return ((a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]))
    def seg_cross(p1, p2, p3, p4):
        d1, d2 = cross(p3, p4, p1), cross(p3, p4, p2)
        d3, d4 = cross(p1, p2, p3), cross(p1, p2, p4)
        return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))
    pts = [(p[0], p[1]) for p in ring]
    changed = True
    guard = 0
    while changed and guard < 40:
        changed = False
        guard += 1
        n = len(pts)
        for i in range(n):
            a, b = pts[i], pts[(i + 1) % n]
            for j in range(i + 2, n):
                if i == 0 and j == n - 1:
                    continue
                c, d = pts[j], pts[(j + 1) % n]
                if seg_cross(a, b, c, d):
                    # drop vertex b (and its duplicate) to open the crossing
                    pts.pop((i + 1) % len(pts))
                    changed = True
                    break
            if changed:
                break
    return pts


def densify_ring(ring, chaikin=2, subdiv=4):
    """Smooth and densify a coarse vector ring.

    Natural Earth 10m lake outlines carry only ~28-39 vertices for the Dead Sea
    and the Sea of Galilee, which earcut then draws as visible straight chords.
    Chaikin corner-cutting makes the outline smooth without moving it far from
    the generalised dataset, and subdividing adds the vertices the renderer
    needs. Area changes by well under 1%.
    """
    pts = [(p[0], p[1]) for p in ring]
    for _ in range(chaikin):
        out = []
        n = len(pts)
        for i in range(n):
            p = pts[i]
            q = pts[(i + 1) % n]
            out.append((0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]))
            out.append((0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]))
        pts = out
    out = []
    n = len(pts)
    for i in range(n):
        p = pts[i]
        q = pts[(i + 1) % n]
        for k in range(subdiv):
            t = k / float(subdiv)
            out.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))
    # Repair AFTER smoothing: corner cutting can reintroduce a crossing that
    # the pre-smoothing repair had removed.
    return fix_self_intersections(out)



def clip_ring_to_bbox(ring, bbox, ocean_test=None):
    """Clip a NON-CONVEX ring to a rectangle, keeping the real coastline.

    Sutherland-Hodgman is only valid for a convex SUBJECT. The Natural Earth
    ocean layer is one global ring with 100k vertices and a wildly non-convex
    shape; clipping it with SH produces bridge segments and duplicated
    vertices, and earcut then emits stray triangles that render as blue blocks
    floating on land.

    Instead: find the contiguous run of ring vertices inside the bbox (the
    real coastline), extend both ends to the exact point where the coastline
    crosses the bbox edge, then close the polygon along the bbox perimeter.
    Four closures are possible (arc forward/reversed x perimeter direction);
    only one is right, so all are built and the one passing an ocean/land
    probe test wins.
    """
    s, w, n, e = bbox
    def inside(p):
        return s <= p[1] <= n and w <= p[0] <= e
    pts = list(ring)
    N = len(pts)
    ins = [inside(p) for p in pts]

    # maximal contiguous runs of inside vertices
    runs = []
    start_i = None
    for i in range(N):
        if ins[i] and not ins[(i - 1) % N]:
            start_i = i
        elif not ins[i] and ins[(i - 1) % N]:
            j = (i - 1) % N
            if start_i is not None:
                runs.append((start_i, j))
                start_i = None
    if start_i is not None:
        runs.append((start_i, (start_i - 1) % N))
    if not runs:
        return []

    def cross(i, j):
        """Point where the segment pts[i]->pts[j] crosses the bbox edge."""
        p1, p2 = pts[i], pts[j]
        lo, hi = 0.0, 1.0
        for _ in range(60):
            mid = (lo + hi) / 2.0
            q = (p1[0] + (p2[0] - p1[0]) * mid, p1[1] + (p2[1] - p1[1]) * mid)
            if inside(q) == inside(p1):
                lo = mid
            else:
                hi = mid
        return (p1[0] + (p2[0] - p1[0]) * hi, p1[1] + (p2[1] - p1[1]) * hi)

    # build the arcs, extended to the bbox edge at both ends
    arcs = []
    for (a, b) in runs:
        seg = [cross((a - 1) % N, a)]
        t = a
        while True:
            seg.append(pts[t])
            if t == b:
                break
            t = (t + 1) % N
        seg.append(cross(b, (b + 1) % N))
        if len(seg) >= 3:
            arcs.append(seg)
    if not arcs:
        return []
    arcs.sort(key=len, reverse=True)
    arc = arcs[0]

    Lx, Ly = e - w, n - s
    per = 2.0 * (Lx + Ly)
    def t_of(p):
        ds, dn = abs(p[1] - s), abs(p[1] - n)
        dw, de = abs(p[0] - w), abs(p[0] - e)
        m = min(ds, dn, dw, de)
        if m == ds:
            return (p[0] - w)
        if m == de:
            return Lx + (p[1] - s)
        if m == dn:
            return Lx + Ly + (e - p[0])
        return Lx + Ly + Lx + (n - p[1])

    def per_point(t):
        t = t % per
        if t <= Lx:
            return (w + t, s)
        t -= Lx
        if t <= Ly:
            return (e, s + t)
        t -= Ly
        if t <= Lx:
            return (e - t, n)
        t -= Lx
        return (w, n - t)

    def boundary_path(t0, t1, ccw):
        span = ((t1 - t0) % per) if ccw else -((t0 - t1) % per)
        steps = max(2, int(abs(span) / (min(Lx, Ly) / 8.0)) + 2)
        step = span / steps
        return [per_point(t0 + step * i) for i in range(steps + 1)]

    def pip(poly, pt):
        x, y = pt
        r = False
        m = len(poly)
        for i in range(m):
            p1, p2 = poly[i], poly[(i + 1) % m]
            if (p1[1] > y) != (p2[1] > y):
                xi = (p2[0] - p1[0]) * (y - p1[1]) / (p2[1] - p1[1]) + p1[0]
                if x < xi:
                    r = not r
        return r

    candidates = []
    for arc_rev in (False, True):
        a_pts = list(reversed(arc)) if arc_rev else list(arc)
        ta, tb = t_of(a_pts[0]), t_of(a_pts[-1])
        for ccw in (True, False):
            poly = a_pts + boundary_path(tb, ta, ccw)
            if len(poly) >= 3:
                candidates.append(poly)
    if not candidates:
        return []
    if ocean_test is not None:
        for poly in candidates:
            if ocean_test(poly):
                return poly
    return candidates[0]


if ocean_doc:
    for feat in ocean_doc.get("features", []):
        geom = feat.get("geometry") or {}
        gt, co = geom.get("type"), geom.get("coordinates") or []
        polys = co if gt == "MultiPolygon" else ([co] if gt == "Polygon" else [])
        for poly in polys:
            if not poly or len(poly[0]) < 3:
                continue
            ext = poly[0]
            los = [p[0] for p in ext]; las = [p[1] for p in ext]
            if max(los) < BBOX[1] or min(los) > BBOX[3] or max(las) < BBOX[0] or min(las) > BBOX[2]:
                continue
            ocean |= rasterize([(ext, poly[1:])])
            for run in clip_ring(ext, 300.0):
                sea_runs.append(run)
            # Vector surface polygon for the browser: clip the outer ring to the
            # bbox (a convex rectangle, so the clip is exact) and keep the
            # clipped holes. The browser triangulates this with earcut, which
            # gives a smooth coastline instead of a raster staircase.
            # Sutherland-Hodgman is invalid here: the Natural Earth ocean
            # layer is ONE global ring with 100k vertices and a wildly
            # non-convex shape, so a convex clip leaves bridge segments and
            # duplicated vertices, and earcut then emits stray triangles that
            # render as blue blocks floating on land. Use the arc-based
            # clipper instead and pick the closure with the ocean/land probe.
            def _ocean_probe(poly, _dem=dem, _geo=geo):
                def pip(p, pt):
                    x, y = pt
                    ins = False
                    m = len(p)
                    for i in range(m):
                        p1, p2 = p[i], p[(i + 1) % m]
                        if (p1[1] > y) != (p2[1] > y):
                            xi = (p2[0] - p1[0]) * (y - p1[1]) / (p2[1] - p1[1]) + p1[0]
                            if x < xi:
                                ins = not ins
                    return ins
                def wet(lon, lat):
                    x = int(round((lon - _geo["lon_min"]) / (_geo["lon_max"] - _geo["lon_min"]) * (W - 1)))
                    MY_T = math.log(math.tan(math.pi / 4 + math.radians(_geo["lat_top"]) / 2))
                    MY_B = math.log(math.tan(math.pi / 4 + math.radians(_geo["lat_bottom"]) / 2))
                    y = int(round((MY_T - math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)))
                                  / (MY_T - MY_B) * (H - 1)))
                    if not (0 <= x < W and 0 <= y < H):
                        return None
                    return _dem[y, x] <= 0.0
                sea = 0
                for lon, lat in ((34.55, 32.60), (34.80, 32.80), (34.45, 31.60)):
                    if pip(poly, (lon, lat)) and wet(lon, lat):
                        sea += 1
                # the Jordan valley is below sea level but is LAND
                land_ok = not pip(poly, (35.60, 32.30))
                return sea >= 2 and land_ok

            clipped = clip_ring_to_bbox(ext, BBOX, ocean_test=_ocean_probe)
            if len(clipped) >= 3:
                holes = []
                for h in poly[1:]:
                    ch = clip_convex(h, BBOX)
                    if len(ch) >= 3:
                        holes.append(ch)
                # Smooth and densify the clipped coastline: the Natural Earth
                # 10m ocean ring carries only ~71 vertices along the Israeli
                # coast, which earcut draws as long straight chords. Chaikin
                # corner-cutting plus subdivision fixes the shape and moves the
                # outline by well under 1% of its area.
                sea_polys.append({"name": "Mediterranean Sea", "level_m": 0.0,
                                  "ring": [[round(c[0], 6), round(c[1], 6)]
                                          for c in densify_ring(clipped)],
                                  "holes": [[[round(c[0], 6), round(c[1], 6)]
                                            for c in densify_ring(ch)]
                                            for ch in holes]})
    log("  ocean polygon area: %.1f km2 (true ground)" % area_km2(ocean))
    log("  sea coastline runs: %d" % len(sea_runs))
    log("  sea vector polygons: %d" % len(sea_polys))

# gap fill: a few DEM pixels inside the polygon may sit above 0 m (islands,
# coastal cliffs). Fill ocean cells that are within 3 px of an ocean cell and
# are below 0 m. This removes thin false land bridges.
if ocean.any():
    pad = np.zeros((H, W), dtype=bool)
    pad[:] = ocean
    for _ in range(3):
        p2 = pad.copy()
        p2[1:, :] |= pad[:-1, :]; p2[:-1, :] |= pad[1:, :]
        p2[:, 1:] |= pad[:, :-1]; p2[:, :-1] |= pad[:, 1:]
        pad = p2
    fill = pad & (dem <= 0.0) & ~ocean
    log("  DEM gap fill inside the coastal band: %.1f km2" % area_km2(fill))
    ocean |= fill

# ================================================================ LAKES
log("")
log("--- lakes ---")
level = np.full((H, W), np.nan, dtype=np.float64)
lakes_doc = load_json(fetch(ne("ne_10m_lakes.geojson"), "ne_10m_lakes.geojson"))
NE_LAKES = []
if lakes_doc:
    for feat in lakes_doc.get("features", []):
        pr = feat.get("properties") or {}
        nm = pr.get("name_en") or pr.get("name") or ""
        geom = feat.get("geometry") or {}
        gt, co = geom.get("type"), geom.get("coordinates") or []
        polys = co if gt == "MultiPolygon" else ([co] if gt == "Polygon" else [])
        for poly in polys:
            if not poly or len(poly[0]) < 3:
                continue
            los = [p[0] for p in poly[0]]; las = [p[1] for p in poly[0]]
            if max(los) < BBOX[1] or min(los) > BBOX[3] or max(las) < BBOX[0] or min(las) > BBOX[2]:
                continue
            NE_LAKES.append({"name": nm, "ring": poly[0], "holes": poly[1:]})

LAKES = [
    # name, surface level m, (lat, lon) centroid, ROI km, expected km2, keywords
    # Expected areas are TRUE GROUND areas at the stated water level, taken
    # from the published Dead Sea level-area table (Wikipedia):
    #     -390 m -> 1050 km2    -400 m -> 680 km2    -407 m -> 675 km2
    #     -417 m -> 662 km2     -423 m -> 655 km2    -430.5 m -> 605 km2
    # At -401 m the lake is ~678 km2 and consists of the NORTHERN BASIN ONLY:
    # the southern basin has been dry since 1976 and now holds evaporation
    # ponds, so it must not be rendered as open water.
    #   Sea of Galilee ~166 km2 (21 km long x 13 km wide, 43 m max depth).
    ("Dead Sea",      -401.0, (31.5000, 35.4736), 55.0, 678.0, ["Dead Sea"]),
    ("Sea of Galilee", -209.0, (32.8217, 35.5892), 25.0, 166.0, ["Tiberias", "Galilee", "Kinneret"]),
]

lake_any = np.zeros((H, W), dtype=bool)
lake_records = []

for name, lvl, (la, lo), roi_km, exp, kws in LAKES:
    seed_xy = (int(round(lon_px(lo))), int(round(lat_py(la))))
    log("")
    log("  == %s  level %.0f m  expected ~%.0f km2 ==" % (name, lvl, exp))
    cands = []

    # A) Natural Earth outline(s) for this lake. The Dead Sea is split into
    #    two NE polygons (north and south basin) and BOTH belong to the lake.
    ne_union = np.zeros((H, W), dtype=bool)
    ne_polys = []
    for L in NE_LAKES:
        if not any(k.lower() in (L["name"] or "").lower() for k in kws):
            continue
        sph = spherical_ring_area_km2(L["ring"])
        m = rasterize([(L["ring"], L["holes"])])
        a = area_km2(m)
        log("     NE outline %-22s spherical %8.1f km2 | raster %8.1f km2"
            % (L["name"], sph, a))
        ne_union |= m
        ne_polys.append({"name": L["name"], "ring": L["ring"], "holes": L["holes"]})
    if ne_union.any():
        a = area_km2(ne_union)
        log("     NE outline UNION           raster %8.1f km2" % a)
        cands.append(("NE outline", ne_union, a, "Natural Earth outline (union)"))
    else:
        ne_union = None

    # B) DEM contour at the surface level - this is literally "water at the
    #    local water level", but it can leak down the Jordan Valley.
    mb = flood_at_level(dem, seed_xy, lvl, roi_km)
    if mb is None:
        log("     DEM contour at %.0f m: seed is above this level -> none" % lvl)
        mb = np.zeros((H, W), dtype=bool)
    else:
        mb = mb & ~ocean
        a = area_km2(mb)
        log("     DEM contour at %6.0f m    raster %8.1f km2" % (lvl, a))
        cands.append(("DEM contour", mb, a, "DEM contour at %.0f m" % lvl))

    # C) flat lake-bed component (SRTM fills water bodies with one constant)
    mc, bed = flat_bed_component(dem, seed_xy, tol=1.5, roi_km=40.0)
    if mc is not None:
        mc = mc & ~ocean
        a = area_km2(mc)
        log("     DEM flat bed (%.1f m)  raster %8.1f km2" % (bed, a))
        cands.append(("DEM flat bed", mc, a, "DEM flat bed at %.1f m" % bed))

    if not cands:
        log("     NO CANDIDATE - skipping")
        continue

    # Selection. Natural Earth's polygon IS the surveyed shoreline of the lake
    # at its stated level, so it wins when it matches the expected area for
    # that level. Cross-check: the Dead Sea's two NE polygons total 853 km2,
    # which is exactly the pre-2013 (-401 m) extent; the modern shrunken lake
    # is 605 km2. The DEM contour is a fallback because SRTM is a 2000-era
    # snapshot and its shoreline is coarser than the vector.
    chosen = None
    ne_c = next((c for c in cands if c[0] == "NE outline"), None)
    prim = next((c for c in cands if c[0] == "DEM contour"), None)
    if ne_c is not None and abs(ne_c[2] - exp) / exp <= 0.25:
        chosen = (ne_c[1], ne_c[2],
                  "Natural Earth outline (union) - matches the %.0f m shoreline" % lvl)
    elif prim is not None and prim[2] > 0:
        m = prim[1]
        if ne_union is not None:
            trimmed = m & ne_union
            if area_km2(trimmed) >= 0.50 * prim[2]:
                log("     -> DEM contour TRIMMED by the NE outline: %.1f -> %.1f km2"
                    % (prim[2], area_km2(trimmed)))
                m = trimmed
            else:
                log("     -> NE outline would cut the contour by more than half;"
                    " keeping the raw DEM contour")
        chosen = (m, area_km2(m), "DEM contour at %.0f m, trimmed by the Natural Earth outline" % lvl)
    else:
        best = None
        for c in cands:
            if best is None or (abs(c[2]-exp), 0 if c[0]=="NE outline" else 1) < \
                               (abs(best[2]-exp), 0 if best[0]=="NE outline" else 1):
                best = c
        chosen = (best[1], best[2], best[3])

    m = chosen[0] & ~ocean
    area = chosen[1]
    log("     -> CHOSEN %.1f km2  (%s)" % (area, chosen[2]))
    if abs(area-exp)/exp > 0.30:
        log("     !! WARNING area deviates %.0f%% from the expected %.0f km2"
            % (abs(area-exp)/exp*100, exp))

    # Fraction of each Natural Earth part that lies BELOW the surface level in
    # the DEM. A part that is essentially dry at that level (the Dead Sea
    # southern basin, dry since 1976) must not be rendered as open water.
    wet_parts = []
    for p in ne_polys:
        pm = rasterize([(p["ring"], p["holes"])])
        if pm.any():
            wet = float((pm & (dem <= lvl)).sum()) / float(pm.sum())
        else:
            wet = 0.0
        wet_parts.append(wet)
        log("     part %-22s below level: %5.1f%% of the polygon"
            % (p["name"], 100.0 * wet))

    level[m] = lvl
    lake_any |= m
    lake_records.append({"name": name, "level_m": lvl, "area_km2": round(area, 1),
                          "expected_km2": exp, "source": chosen[2],
                          # Published level-area table (Wikipedia, Dead Sea):
                          # -400 m -> 680 km2, -407 m -> 675 km2, -417 m -> 662 km2.
                          # The southern basin has been dry since 1976.

                          "mask": m,
                          # Closed vector rings (lon/lat) for the natural-earth
                          # outline. The browser triangulates these with earcut
                          # to get a smooth, non-staircase water surface; the
                          # raster mask above is only a level lookup.
                          "poly": {"name": name, "level_m": lvl,
                                   "parts": [{"name": p["name"],
                                              "ring": [[round(q[0], 6), round(q[1], 6)]
                                                       for q in p["ring"]],
                                              "holes": [[[round(q[0], 6), round(q[1], 6)]
                                                        for q in h]
                                                       for h in p["holes"]]}
                                             for p in ne_polys]},
                          # How much of this basin is actually below the surface
                          # level in the DEM. The Dead Sea's southern basin has
                          # been dry since 1976 (it is now evaporation ponds), so
                          # at -401 m only the northern basin holds water.
                          "part_wet": wet_parts})

# ================================================================ rivers
log("")
log("--- rivers ---")
rivers = []
river_source = "none"

def osm_query(q, tag):
    """Overpass with POST first: a wide-bbox GET URL trips the front proxy's
    502; the same query as a POST body is handled normally."""
    mirrors = ["https://overpass-api.de/api/interpreter",
               "https://overpass.kumi.systems/api/interpreter",
               "https://overpass.private.coffee/api/interpreter"]
    body = q.encode("utf-8")
    # Offline mode (2026-11-24): go straight to the cached Overpass response.
    # The public mirrors are routinely down (502/504/timeout); retrying them
    # cost 15+ minutes per rebuild. The cache is written on every success and
    # holds the same query result, so a rebuild that does not need fresh
    # network data must not wait for it.
    if os.environ.get("ISRAEL3D_OFFLINE") == "1":
        cached = os.path.join(CACHE, "osm_%s.json" % tag)
        if os.path.isfile(cached):
            try:
                with open(cached, "r", encoding="utf-8") as f:
                    j = json.load(f)
                if j and j.get("elements"):
                    log("  OFFLINE: using cached overpass response %s (%d elements)"
                        % (os.path.basename(cached), len(j["elements"])))
                    return j
            except Exception as e:
                log("  OFFLINE: cached overpass response unusable: %s %s"
                    % (type(e).__name__, e))
        log("  OFFLINE requested but no usable cache for %s" % tag)
        return None
    for base in mirrors:
        host = base.split("//")[1].split("/")[0]
        for mode in ("post", "get"):
            try:
                if mode == "post":
                    req = urllib.request.Request(
                        base, data=body,
                        headers={"User-Agent": "israel3d/1.0 (biblical 3d map build)",
                                 "Content-Type": "application/x-www-form-urlencoded"})
                else:
                    req = urllib.request.Request(
                        base + "?" + urllib.parse.urlencode({"data": q}),
                        headers={"User-Agent": "israel3d/1.0 (biblical 3d map build)"})
                with urllib.request.urlopen(req, timeout=90) as r:
                    raw = r.read()
                j = json.loads(raw.decode("utf-8", "replace"))
                if j and j.get("elements"):
                    with open(os.path.join(CACHE, "osm_%s.json" % tag), "w",
                              encoding="utf-8") as f:
                        json.dump(j, f)
                    log("  OVERPASS OK %s %s: %d elements (%d bytes)"
                        % (host, mode, len(j["elements"]), len(raw)))
                    return j
                log("  overpass %s %s: 0 elements" % (host, mode))
            except Exception as e:
                log("  overpass %s %s failed: %s %s" % (host, mode, type(e).__name__, e))
                time.sleep(4)
    # Every mirror failed (Overpass returns 502/504 under load). Fall back to the
    # cached response from the last successful run instead of losing the rivers
    # entirely. The cache is written on every success, so it is the freshest
    # network data available. 2026-11-23.
    cached = os.path.join(CACHE, "osm_%s.json" % tag)
    if os.path.isfile(cached):
        try:
            with open(cached, "r", encoding="utf-8") as f:
                j = json.load(f)
            if j and j.get("elements"):
                log("  OVERPASS UNAVAILABLE - using cached response %s (%d elements, "
                    "cached %s)" % (os.path.basename(cached), len(j["elements"]),
                                    time.strftime("%H:%M", time.localtime(os.path.getmtime(cached)))))
                return j
        except Exception as e:
            log("  cached overpass response unusable: %s %s" % (type(e).__name__, e))
    return None

def collect_osm(doc, min_len):
    n = 0
    for el in doc.get("elements", []):
        if el.get("type") != "way":
            continue
        g = el.get("geometry") or []
        pts = [(p["lon"], p["lat"]) for p in g if p and "lon" in p]
        if len(pts) < 2:
            continue
        runs = clip_line(pts, 300.0)
        if not runs:
            continue
        t = el.get("tags") or {}
        nm = t.get("name") or t.get("name:en") or "river"
        ne_ = t.get("name:en") or t.get("name") or "river"
        for run in runs:
            L = sum(haversine(run[i], run[i+1]) for i in range(len(run)-1))
            if L < min_len:
                continue
            rivers.append({"name": nm, "name_en": ne_, "length_m": round(L, 1),
                           "real_width_m": 40 if L > 60000 else (25 if L > 20000 else 15),
                           "kind": "river",
                           "points": [[round(a, 6), round(b, 6)] for a, b in run]})
            n += 1
    return n

Q = ('[out:json][timeout:240];'
     '(way["waterway"="river"]["name"](%.2f,%.2f,%.2f,%.2f);'
     'way["waterway"="stream"]["name"](%.2f,%.2f,%.2f,%.2f););out geom;'
     % (BBOX[0],BBOX[1],BBOX[2],BBOX[3],BBOX[0],BBOX[1],BBOX[2],BBOX[3]))
doc = osm_query(Q, "rivers")
if doc:
    n = collect_osm(doc, 3000)
    log("  OSM ways kept: %d" % n)
    if n:
        river_source = "OSM Overpass waterway=river/stream"
if not rivers:
    log("  falling back to Natural Earth 10m rivers, CLIPPED to the bbox")
    ne_riv = load_json(fetch(ne("ne_10m_rivers_lake_centerlines.geojson"),
                             "ne_10m_rivers_lake_centerlines.geojson"))
    if ne_riv:
        for feat in ne_riv.get("features", []):
            pr = feat.get("properties") or {}
            sr = pr.get("scalerank")
            if sr is not None and sr > 8:
                continue
            geom = feat.get("geometry") or {}
            lines = geom.get("coordinates") or []
            if geom.get("type") == "LineString":
                lines = [lines]
            for ln in lines:
                pts = [(a[0], a[1]) for a in ln if isinstance(a, (list, tuple)) and len(a) >= 2]
                if len(pts) < 2:
                    continue
                nm = pr.get("name_en") or pr.get("name") or "river"
                for run in clip_line(pts, 400.0):
                    L = sum(haversine(run[i], run[i+1]) for i in range(len(run)-1))
                    if L < 2000:
                        continue
                    rivers.append({"name": nm, "name_en": nm, "length_m": round(L, 1),
                                   "real_width_m": 40 if L > 60000 else (25 if L > 20000 else 15),
                                   "kind": "river",
                                   "points": [[round(a, 6), round(b, 6)] for a, b in run]})
        if rivers:
            river_source = "Natural Earth 10m rivers (clipped to map bbox)"

rivers.sort(key=lambda r: -r["length_m"])
# Keep the map readable: the significant named rivers only. A 3,700 km
# network of every wadi is visual noise at map scale. The Jordan and the
# other named perennial rivers are what a biblical map actually needs.
MIN_KEEP = 8000.0
kept = []
for r in rivers:
    if r["length_m"] >= MIN_KEEP:
        kept.append(r)
    elif len(kept) >= 120:
        break
rivers = kept[:160]
log("  rivers: %d lines, %.0f km total, source=%s (min kept %.1f km)"
    % (len(rivers), sum(r["length_m"] for r in rivers)/1000.0, river_source, MIN_KEEP/1000))
for r in rivers[:20]:
    log("     %-38s %8.1f km  %4d pts" % (r["name"][:38], r["length_m"]/1000.0, len(r["points"])))
jordan = [r for r in rivers if "jordan" in (r.get("name_en") or "").lower()
          or "الأردن" in (r.get("name") or "") or "ירדן" in (r.get("name") or "")]
log("  Jordan reaches kept: %d, %.0f km"
    % (len(jordan), sum(r["length_m"] for r in jordan)/1000.0))
if not jordan:
    log("  !! no 'Jordan' in the network")

# ================================================================ assemble
log("")
log("--- assembling the water raster ---")
water = ocean | lake_any
# Every water pixel gets a level: the ocean is 0 m, each lake its own level.
level_full = np.zeros((H, W), dtype=np.float64)
for rec in lake_records:
    level_full[rec["mask"]] = rec["level_m"]
level_full[ocean] = 0.0
# LO/HI is the 16-bit level range used to encode water.png. It was hardcoded to
# -1600 m, which was fine while the DEM bottomed out at -1552 m but silently
# CLIPPED the Dead Sea floor once the grid reached -1985 m (a level below LO
# encodes to 0 and decodes back as LO). The range is now derived from the DEM
# actually being painted, rounded outward to whole metres so it stays stable.
LO = math.floor(min(dem.min(), -500.0) / 100.0) * 100.0
HI = 100.0
log("  water level encode range: LO %.1f HI %.1f (dem min %.1f)" % (LO, HI, dem.min()))
# Work on the FULL (H, W) grid. Indexing with a boolean mask flattens the array to
# 1-D, which then breaks np.dstack([R, G, A]) — the R/G arrays came back with one
# row and the A array with 1792 ("all the input array dimensions ... must match").
# Water pixels are selected with np.where instead, so every array stays 2-D.
lev_full = np.clip(level_full, LO, HI)
nlev_full = (lev_full - LO) / (HI - LO)
q16_full = np.rint(nlev_full * 65535.0).astype(np.uint16)
R = np.where(water, (q16_full >> 8).astype(np.uint8), 0).astype(np.uint8)
G = np.where(water, (q16_full & 255).astype(np.uint8), 0).astype(np.uint8)
A = np.where(water, 255, 0).astype(np.uint8)
# np.dstack of three (H, W) arrays yields 3 bands, but mode "RGBA" needs 4 — PIL raised
# "buffer is not large enough". Band layout: R,G = 16-bit depth code, B = constant,
# A = opacity (255 on water, 0 on land).
B = np.full((H, W), 255, dtype=np.uint8)
img = Image.fromarray(np.dstack([R, G, B, A]), "RGBA")
img.save(os.path.join(DATA, "water.png"))
log("  water.png written: %dx%d" % img.size)

# preview: land grey, water blue, lakes dark blue
prev = np.zeros((H, W, 3), dtype=np.uint8)
land = dem - dem.min()
prev[:, :, 0] = (200 - land * 90).astype(np.uint8)
prev[:, :, 1] = (200 - land * 90).astype(np.uint8)
prev[:, :, 2] = (190 - land * 90).astype(np.uint8)
prev[ocean] = [110, 165, 220]
prev[lake_any] = [40, 90, 175]
Image.fromarray(prev).resize((W//2, H//2), Image.Resampling.LANCZOS).save(
    os.path.join(DATA, "water_preview.png"))


def segments_to_rings(segments):
    """Rebuild closed lon/lat rings from unordered boundary segments.

    The NE lake polygons are stored twice: once as a heavily simplified ring
    (39 points for the Dead Sea - far too coarse to draw a shoreline with) and
    once as the full set of boundary segments. Rebuilding the ring from the
    segments restores the real outline resolution.
    """
    if not segments:
        return []
    adj = {}
    for a, b in segments:
        ka = (round(a[0], 6), round(a[1], 6))
        kb = (round(b[0], 6), round(b[1], 6))
        adj.setdefault(ka, []).append(kb)
        adj.setdefault(kb, []).append(ka)
    rings = []
    seen = set()
    for start in list(adj.keys()):
        if start in seen:
            continue
        ring = [start]
        seen.add(start)
        cur = start
        for _ in range(len(adj) + 5):
            opts = [n for n in adj.get(cur, []) if n not in seen]
            if not opts:
                break
            nxt = opts[0]
            seen.add(nxt)
            ring.append(nxt)
            cur = nxt
            if cur == start:
                break
        if len(ring) >= 4:
            rings.append([[p[0], p[1]] for p in ring])
    return rings


# coastline.json: sea runs + lake boundary segments
def mask_boundary(mask):
    segs = []
    m = mask
    er = m.copy()
    er[1:, :] &= m[:-1, :]; er[:-1, :] &= m[1:, :]
    er[:, 1:] &= m[:, :-1]; er[:, :-1] &= m[:, 1:]
    edge = m & ~er
    ys, xs = np.nonzero(edge)
    for y, x in zip(ys, xs):
        for dy, dx in ((0,1),(1,0),(0,-1),(-1,0)):
            ny, nx = y+dy, x+dx
            if 0 <= ny < H and 0 <= nx < W and not m[ny, nx]:
                segs.append([[round(px_lon(x+0.5), 6), round(py_lat(y+0.5), 6)],
                             [round(px_lon(nx+0.5), 6), round(py_lat(ny+0.5), 6)]])
                break
    return segs

lake_out = []
for rec in lake_records:
    lake_out.append({"name": rec["name"], "level_m": rec["level_m"],
                     "area_km2": rec["area_km2"],
                     "segments": mask_boundary(rec["mask"])})
coast = {"sea_runs": [[[round(a, 6), round(b, 6)] for a, b in r] for r in sea_runs],
         "lakes": lake_out}
with open(os.path.join(DATA, "coastline.json"), "w", encoding="utf-8") as f:
    json.dump(coast, f, separators=(",", ":"))
log("  coastline.json: %d sea runs, %d lakes" % (len(sea_runs), len(lake_out)))
for l in lake_out:
    log("     %-18s level %.0f m  %.1f km2  %d boundary segments"
        % (l["name"], l["level_m"], l["area_km2"], len(l["segments"])))

# water_vector.json: closed vector rings per water body, for the browser to
# triangulate with earcut. A raster-cell water surface gives a staircase
# shoreline and stray inland cells; the vector outline is the real boundary.
wv_bodies = []
for sp in sea_polys:
    wv_bodies.append({"name": sp["name"], "level_m": sp["level_m"],
                       "parts": [{"name": sp["name"], "ring": sp["ring"],
                                  "holes": sp["holes"]}]})
for rec in lake_records:
    poly = rec.get("poly")
    if not (poly and poly["parts"]):
        continue
    wet = rec.get("part_wet") or []
    # Drop basins that are dry at their surface level (the Dead Sea southern
    # basin has been dry since 1976; at -401 m it holds only evaporation
    # ponds). Rendering it as open water inflates the area by ~29%.
    keep = []
    for i, part in enumerate(poly["parts"]):
        frac = wet[i] if i < len(wet) else 1.0
        if frac >= WET_MIN_FRACTION:
            keep.append(part)
        else:
            log("  dropping dry basin part %-22s (%.1f%% below level)"
                % (part["name"], 100.0 * frac))
    if keep:
        # Smooth and densify FIRST, so the area is computed on the geometry
        # that is actually rendered.
        for part in keep:
            part["ring"] = [[round(c[0], 6), round(c[1], 6)]
                            for c in densify_ring(part["ring"])]
            part["holes"] = [[[round(c[0], 6), round(c[1], 6)]
                              for c in densify_ring(h)] for h in part.get("holes", [])]
        # Ground area from the vector rings on the sphere (the raster mask area
        # is distorted by the projection and by the 153 m pixel grid).
        vec_area = 0.0
        for part in keep:
            ring = part["ring"]
            tot = 0.0
            n = len(ring)
            for i in range(n):
                a, b = ring[i], ring[(i + 1) % n]
                tot += math.radians(b[0] - a[0]) * (math.sin(math.radians(a[1]))
                                                    + math.sin(math.radians(b[1])))
            vec_area += abs(tot) * 6371.0 ** 2 / 2.0
            for h in part.get("holes", []):
                tot = 0.0
                n = len(h)
                for i in range(n):
                    a, b = h[i], h[(i + 1) % n]
                    tot += math.radians(b[0] - a[0]) * (math.sin(math.radians(a[1]))
                                                        + math.sin(math.radians(b[1])))
                vec_area -= abs(tot) * 6371.0 ** 2 / 2.0
        wv_bodies.append({"name": rec["name"], "level_m": rec["level_m"],
                           "area_km2": round(vec_area, 1),
                           "parts": keep})
with open(os.path.join(DATA, "water_vector.json"), "w", encoding="utf-8") as f:
    json.dump({"bodies": wv_bodies}, f, separators=(",", ":"))
log("  water_vector.json: %d bodies" % len(wv_bodies))
for b in wv_bodies:
    nv = sum(len(p["ring"]) for p in b["parts"])
    nh = sum(len(h) for p in b["parts"] for h in p["holes"])
    log("     %-18s level %7.1f m  %d parts  %d ring pts  %d hole pts"
        % (b["name"], b["level_m"], len(b["parts"]), nv, nh))

# rivers.json
#
# Rivers must NOT be drawn across a water body. The browser drapes each river
# as a ribbon on the terrain surface, and inside the Dead Sea / Mediterranean
# polygon the terrain is BELOW the water surface, so the ribbon floats above the
# lake as an isolated blue shape - which reads as a stray blue triangle on the
# map. Clip every river against the water polygons and drop the inside parts.
def _pip(rings, pt):
    """Point in polygon (with holes) test on lon/lat."""
    x, y = pt
    def inside(ring):
        ins = False
        n = len(ring)
        for i in range(n):
            a, b = ring[i], ring[(i + 1) % n]
            if (a[1] > y) != (b[1] > y):
                xi = (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]
                if x < xi:
                    ins = not ins
        return ins
    for part in rings:
        if inside(part["ring"]):
            if any(inside(h) for h in part.get("holes", [])):
                return False
            return True
    return False

def _clip_river(pts, rings):
    """Split a river polyline at the water boundary; return the dry parts."""
    if not rings:
        return [pts]
    dry = []
    cur = []
    for i, p in enumerate(pts):
        wet = _pip(rings, p)
        if not wet:
            cur.append(p)
        else:
            if len(cur) >= 2:
                dry.append(cur)
            cur = []
    if len(cur) >= 2:
        dry.append(cur)
    return dry

water_rings = []
for b in wv_bodies:
    water_rings.extend(b["parts"])

rivers_out = []
n_clipped = 0
for r in rivers:
    parts = _clip_river(r["points"], water_rings)
    if len(parts) != 1 or len(parts[0]) != len(r["points"]):
        n_clipped += 1
    for seg in parts:
        if len(seg) < 2:
            continue
        seg_r = dict(r)
        seg_r["points"] = seg
        seg_r["length_m"] = sum(
            math.hypot((seg[i + 1][0] - seg[i][0]) * 101000.0,
                        (seg[i + 1][1] - seg[i][1]) * 111000.0)
            for i in range(len(seg) - 1))
        rivers_out.append(seg_r)
if n_clipped:
    log("  river clipping: %d rivers touched water, %d lines now" % (n_clipped, len(rivers_out)))
rivers = rivers_out
with open(os.path.join(DATA, "rivers.json"), "w", encoding="utf-8") as f:
    json.dump({"source": river_source, "rivers": rivers}, f, separators=(",", ":"))
log("  rivers.json: %d lines, %.0f km" % (len(rivers), sum(r["length_m"] for r in rivers)/1000.0))

# water_meta.json
bodies = []
if ocean.any():
    bodies.append({"name": "Mediterranean Sea", "level_m": 0.0,
                   "area_km2": round(area_km2(ocean), 1)})
# Report the AREA THAT IS ACTUALLY RENDERED, i.e. the ground area of the
# vector rings that go into water_vector.json (dry basins excluded), not the
# raster union mask (which included the desiccated southern basin).
wv_area = {b["name"]: b.get("area_km2") for b in wv_bodies}
for rec in lake_records:
    rendered = wv_area.get(rec["name"])
    bodies.append({"name": rec["name"], "level_m": rec["level_m"],
                   "area_km2": round(rendered, 1) if rendered else round(rec["area_km2"], 1),
                   "expected_km2": rec["expected_km2"],
                   "error_pct": (round(100.0 * (rendered - rec["expected_km2"]) / rec["expected_km2"], 1)
                                 if rendered else None),
                   "source": rec["source"]})
meta = {"width": W, "height": H, "min": LO, "max": HI,
        "meters_per_pixel": MPP,
        "meters_per_pixel_true_ground_at_midlat": MPP*float(np.cos(np.radians((LAT_ROW[0]+LAT_ROW[-1])/2))),
        "level_note": "Dead Sea -401 m, Sea of Galilee -209 m, Mediterranean 0 m",
        "bbox": {"lat_min": geo["lat_bottom"], "lat_max": geo["lat_top"],
                 "lon_min": geo["lon_min"], "lon_max": geo["lon_max"]},
        "bodies": bodies,
        "rivers": {"source": river_source, "count": len(rivers),
                   "total_km": round(sum(r["length_m"] for r in rivers)/1000.0, 1)}}
with open(os.path.join(DATA, "water_meta.json"), "w", encoding="utf-8") as f:
    json.dump(meta, f, indent=2)
log("  water_meta.json: %s" % json.dumps(bodies))
log("")
log("DONE_OK")
LOGF.close()
