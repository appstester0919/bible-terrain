#!/usr/bin/env python3
"""Audit the biblical site markers against the water bodies.

For every site in data/sites.json:
  * raw DEM elevation at the site pixel (mercator mapping, same as the app)
  * carved DEM elevation (what the app actually reads)
  * whether the site pixel is inside the rendered water polygon
  * whether the site's own ground is below the local water level

A site is legitimately "in water" only when its GROUND is below the water
surface. A site that is inside the polygon but sits above the level is a
shoreline site (Capernaum, Masada, Qumran) and must stand on land.
"""
import json
import math
import os

import numpy as np
from PIL import Image, ImageDraw

DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
DATA = DATA + os.sep


def merc_y(lat):
    return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def main():
    em = json.load(open(DATA + "elev.json"))
    b = em["bbox"]
    W, H = em["image"]["width"], em["image"]["height"]
    emin, emax = em["min"], em["max"]

    def load(path):
        a = np.array(Image.open(DATA + path).convert("RGBA")).astype(np.int64)
        v = (a[:, :, 0] * 256 + a[:, :, 1]) / 65535.0
        return emin + v * (emax - emin)

    raw = load("heightmap.png")
    carved = load("heightmap_water.png")

    def to_px(lon, lat):
        x = (lon - b["lon_min"]) / (b["lon_max"] - b["lon_min"]) * (W - 1)
        y = (merc_y(b["lat_max"]) - merc_y(lat)) / \
            (merc_y(b["lat_max"]) - merc_y(b["lat_min"])) * (H - 1)
        return x, y

    wv = json.load(open(DATA + "water_vector.json"))

    def rast(body):
        im = Image.new("1", (W, H), 0)
        d = ImageDraw.Draw(im)
        for p in body["parts"]:
            d.polygon([to_px(x, y) for x, y in p["ring"]], fill=1)
            for h in p.get("holes", []):
                d.polygon([to_px(x, y) for x, y in h], fill=0)
        return np.array(im, bool)

    polys = [(body["name"], body["level_m"], rast(body)) for body in wv["bodies"]]

    sites = json.load(open(DATA + "sites.json"))
    if isinstance(sites, dict):
        sites = sites.get("sites", sites)

    print("%-12s %8s %8s %8s  %-18s %s" %
          ("site", "rawDEM", "carved", "water", "body", "verdict"))
    for s in sites:
        x, y = to_px(s["lon"], s["lat"])
        xi, yi = int(round(x)), int(round(y))
        if not (0 <= xi < W and 0 <= yi < H):
            print("%-12s OUT OF MAP" % s["id"])
            continue
        hit = None
        for name, lvl, m in polys:
            if m[yi, xi]:
                hit = (name, lvl)
                break
        r, c = raw[yi, xi], carved[yi, xi]
        if hit is None:
            verdict = "land"
            body = "-"
            wl = ""
        else:
            body, wl = hit[0], "%.0f m" % hit[1]
            if r < hit[1]:
                verdict = "IN WATER (ground %.0f < level %.0f)" % (r, hit[1])
            else:
                verdict = "SHORELINE! ground %.0f > level %.0f -> must be on land" % (r, hit[1])
        print("%-12s %8.1f %8.1f %8s  %-18s %s" %
              (s["id"], r, c, wl or "-", body, verdict))


if __name__ == "__main__":
    main()
