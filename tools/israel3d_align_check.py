#!/usr/bin/env python3
"""
Diagnostic: is the Israel 3D map's geo<->pixel mapping consistent with the DEM?

Two suspected alignment bugs:
  B1  The water raster was built on a 6x9 tile grid while the DEM heightmap is
      5x7 tiles, so the two rasters are mapped to world space with different
      scales -> water (and anything derived from it) shifts.
  B2  app.js geoToWorld() maps latitude LINEARLY to the Z axis, but the DEM
      tile grid is Web-Mercator, where latitude is NOT linear in pixel row.
      If so, even the biblical site pins are offset from the terrain.

This script decodes the actual data/heightmap.png and tests, for several
known landmarks, which mapping puts the sample where the elevation says it
should be:

  Dead Sea centre (31.50, 35.47)  -> must be well below -300 m
  Sea of Galilee  (32.82, 35.59)  -> must be around -200 m
  Jerusalem      (31.7683, 35.2137)-> about +790 m
  Hebron         (31.5326, 35.0998)-> about +900 m
  Tel Aviv       (32.0853, 34.7818)-> about 0 m

For each mapping (linear-lat vs web-mercator) it reports the sampled elevation
and the min/max elevation in a 10 km window around the point.
"""
import json, math, os, sys, subprocess

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def find_python():
    for c in [sys.executable, "/home/appstester0919/tools/rgvenv/bin/python"]:
        if c and os.path.exists(c):
            r = subprocess.run([c, "-c", "import PIL,numpy;print('OK')"],
                               capture_output=True, text=True)
            if r.stdout.strip() == "OK":
                return c
    return None

PY = find_python()
if not PY:
    print("NO_PYTHON_WITH_PIL_NUMPY"); sys.exit(1)
print("python:", PY)
import numpy as np
from PIL import Image

meta = json.load(open(os.path.join(APP, "data", "elev.json")))
B = meta["bbox"]
LON0, LON1, LAT0, LAT1 = B["lon_min"], B["lon_max"], B["lat_min"], B["lat_max"]
LO, HI = meta["min"], meta["max"]
print("elev.json: image %dx%d  bbox lon %.6f..%.6f  lat %.6f..%.6f  min %.1f max %.1f"
      % (meta["image"]["width"], meta["image"]["height"], LON0, LON1, LAT0, LAT1, LO, HI))
print("world_metres:", json.dumps(meta.get("world_metres")))

im = Image.open(os.path.join(APP, "data", "heightmap.png")).convert("RGB")
a = np.asarray(im).astype(np.float64)
H, W = a.shape[0], a.shape[1]
v = (a[:,:,0]*256.0 + a[:,:,1]) / 65535.0
grid = LO + v * (HI - LO)
print("heightmap.png actual size: %dx%d" % (W, H))

WATER_META = os.path.join(APP, "data", "water_meta.json")
if os.path.exists(WATER_META):
    wm = json.load(open(WATER_META))
    print("water_meta: %dx%d  bbox %s" % (wm["width"], wm["height"], json.dumps(wm["bbox"])))
    print("  -> GRID MISMATCH vs DEM: %s" % ("YES" if (wm["width"], wm["height"]) != (W, H) else "no"))

def merc_y(lat):
    lr = math.radians(lat)
    return math.log(math.tan(lr) + 1.0/math.cos(lr))

MY0, MY1 = merc_y(LAT0), merc_y(LAT1)

def px_linear(lat, lon):
    x = (lon - LON0) / (LON1 - LON0) * (W - 1)
    z = (LAT1 - lat) / (LAT1 - LAT0) * (H - 1)
    return x, z

def px_mercator(lat, lon):
    x = (lon - LON0) / (LON1 - LON0) * (W - 1)
    z = (merc_y(LAT1) - merc_y(lat)) / (MY1 - MY0) * (H - 1)
    return x, z

def sample(gx, gz):
    x = int(round(gx)); z = int(round(gz))
    if x < 0 or z < 0 or x >= W or z >= H: return None
    return float(grid[z, x])

def window_stats(gx, gz, radius_px):
    x0 = max(0, int(gx)-radius_px); x1 = min(W, int(gx)+radius_px+1)
    z0 = max(0, int(gz)-radius_px); z1 = min(H, int(gz)+radius_px+1)
    w = grid[z0:z1, x0:x1]
    return float(w.min()), float(w.max())

POINTS = [
    ("Dead Sea centre",   31.5000, 35.4700, "below -300 m"),
    ("Dead Sea NW shore", 31.6000, 35.4000, "below -300 m"),
    ("Sea of Galilee",    32.8200, 35.5900, "around -200 m"),
    ("Jerusalem",         31.7683, 35.2137, "about +790 m"),
    ("Hebron",            31.5326, 35.0998, "about +900 m"),
    ("Tel Aviv coast",    32.0853, 34.7818, "about 0 m"),
    ("Beer Sheva",        31.2500, 34.7900, "about +280 m"),
    ("Golan Hermon",      33.2000, 35.7000, "about +1200 m"),
]
# 10 km in pixels: meters_per_pixel_x is horizontal; vertical differs in mercator
MPP = meta["meters_per_pixel"]
R = max(2, int(round(5000.0 / MPP)))

for name, fn in (("LINEAR-LAT (current app.js)", px_linear),
                 ("WEB-MERCATOR (tile truth)", px_mercator)):
    print("\n=== mapping: %s ===" % name)
    for label, lat, lon, expect in POINTS:
        gx, gz = fn(lat, lon)
        s = sample(gx, gz)
        lo, hi = window_stats(gx, gz, R)
        print("  %-18s px(%.0f,%.0f)  sample %s   window[%7.1f .. %7.1f]   expect %s"
              % (label, gx, gz,
                 ("%8.1f" % s) if s is not None else "  n/a  ", lo, hi, expect))

# what does the DEM say globally?
print("\nglobal DEM: min %.1f max %.1f" % (grid.min(), grid.max()))
deep = grid <= -120
print("pixels <= -120 m: %d (%.2f%%)" % (deep.sum(), 100.0*deep.sum()/grid.size))
ys, xs = np.where(deep)
if len(xs):
    print("deep region lon range: %.4f .. %.4f" % (LON0 + xs.min()/(W-1)*(LON1-LON0),
                                                   LON0 + xs.max()/(W-1)*(LON1-LON0)))
    print("deep region lat range (linear): %.4f .. %.4f" % (LAT1 - ys.min()/(H-1)*(LAT1-LAT0),
                                                            LAT1 - ys.max()/(H-1)*(LAT1-LAT0)))
