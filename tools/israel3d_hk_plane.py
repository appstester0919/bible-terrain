#!/usr/bin/env python3
"""Stamp a true-scale Hong Kong silhouette across the whole Israel 3D map plane.

Why this exists (2026-11-24)
----------------------------
Listeners cannot feel "Jerusalem to Capernaum is 28 km" from a 3D landscape.
The device that makes it tangible is Hong Kong: every listener knows its
shape, and roughly how big it is. So the map carries a semi-transparent,
TRUE-SCALE Hong Kong drawn repeatedly over the whole ground plane. Counting
the Hong Kong copies between two pins gives the distance without a number.

Two projections must be reconciled, and getting this wrong is exactly the
kind of error that produced the earlier "lake town" bug:

* The map plane is a Web-Mercator strip. Its world X advances 111320 m per
  degree of longitude and its world Y advances ~131.2 km per degree of
  latitude, i.e. BOTH axes are stretched by 1/cos(latitude) relative to
  true ground distance (1/cos(32.095 deg) = 1.18055). So a 152.874 m DEM
  pixel is 152.874 m of *world* distance but only 129.5 m of true ground.
* Hong Kong's real extent is 62.39 km E-W (0.606384 deg at its own latitude)
  and 45.21 km N-S.

To draw Hong Kong at TRUE ground scale on this plane, its true metres must
be divided by cos(32.095 deg) before being converted to plane pixels. The
app's scale bar is corrected by the same factor, so the silhouette on screen
and the distance the scale bar reports always agree.

Output
------
data/hk_overlay_plane.png   RGBA, 1280x1792, same pixel grid as the DEM.
                            Row 0 = north, column 0 = west.
data/hk_overlay_plane.json  metadata for the app (tile size, copy count,
                            true extent, source).

Usage:  python3 israel3d_hk_plane.py
"""
import json
import math
import os

from PIL import Image, ImageDraw

WORK = "/home/appstester0919/work/israel3d"
DATA = os.path.join(WORK, "data")
CACHE = os.path.join(DATA, "cache")

GEO = json.load(open(os.path.join(DATA, "geo.json")))
IMGW = int(GEO["width_px"])          # 1280
IMGH = int(GEO["height_px"])         # 1792
MPP = float(GEO["meters_per_pixel"]) # 152.874 world metres per pixel
WORLD_W = float(GEO["world_width_m"])
WORLD_H = float(GEO["world_height_m"])

LON_MIN, LON_MAX = float(GEO["lon_min"]), float(GEO["lon_max"])
LAT_TOP, LAT_BOT = float(GEO["lat_top"]), float(GEO["lat_bottom"])

MAP_MID_LAT = (LAT_TOP + LAT_BOT) / 2.0            # 32.09524
COS_IL = math.cos(math.radians(MAP_MID_LAT))      # 0.84711
M_PER_DEG_LAT = 110574.0

HK_LAT_MID = 22.357644
HK_COS = math.cos(math.radians(HK_LAT_MID))

# world metres per pixel -> plane pixels per degree of longitude / latitude
# for a shape that must appear at its TRUE ground size on this plane.
PX_PER_DEG_LON_TRUE = (111320.0 * HK_COS / COS_IL) / MPP
PX_PER_DEG_LAT_TRUE = (M_PER_DEG_LAT / COS_IL) / MPP

FILL = (120, 190, 255, 90)      # semi-transparent bluish land
STROKE = (255, 255, 255, 235)   # crisp district boundaries


def load_hk():
    for cand in (os.path.join(CACHE, "hk_districts.geojson"), "/tmp/hk.json"):
        if os.path.isfile(cand):
            doc = json.load(open(cand))
            if doc.get("features"):
                return doc, cand
    raise SystemExit("HK geojson not found (cache/hk_districts.geojson or /tmp/hk.json)")


def rings_of(geom):
    """Yield (outer, [holes]) for Polygon / MultiPolygon."""
    if geom["type"] == "Polygon":
        polys = [geom["coordinates"]]
    else:
        polys = geom["coordinates"]
    for poly in polys:
        if not poly:
            continue
        yield poly[0], poly[1:]


def main():
    doc, src = load_hk()

    lons, lats = [], []
    for feat in doc["features"]:
        for outer, _holes in rings_of(feat["geometry"]):
            for lon, lat in outer:
                lons.append(lon)
                lats.append(lat)
    hk_lon0, hk_lat0 = min(lons), min(lats)
    hk_lon1, hk_lat1 = max(lons), max(lats)

    span_x_px = (hk_lon1 - hk_lon0) * PX_PER_DEG_LON_TRUE
    span_y_px = (hk_lat1 - hk_lat0) * PX_PER_DEG_LAT_TRUE

    img = Image.new("RGBA", (IMGW, IMGH), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    def to_px(lon, lat, cell_x, cell_y):
        x = cell_x + (lon - hk_lon0) * PX_PER_DEG_LON_TRUE
        y = cell_y - (lat - hk_lat0) * PX_PER_DEG_LAT_TRUE   # row 0 = north
        return (x, y)

    # lattice of copies covering the whole plane; the spacing is the Hong
    # Kong bounding box, so copies tile without overlapping.
    margin = 0.35 * span_x_px
    nx = int(math.ceil((IMGW + 2 * margin) / span_x_px)) + 1
    ny = int(math.ceil((IMGH + 2 * margin) / span_y_px)) + 1

    for j in range(ny):
        for i in range(nx):
            cell_x = -margin + i * span_x_px
            cell_y = -margin + j * span_y_px
            for feat in doc["features"]:
                for outer, holes in rings_of(feat["geometry"]):
                    mask = Image.new("L", (IMGW, IMGH), 0)
                    md = ImageDraw.Draw(mask)
                    md.polygon([to_px(lo, la, cell_x, cell_y) for lo, la in outer], fill=255)
                    for hole in holes:
                        md.polygon([to_px(lo, la, cell_x, cell_y) for lo, la in hole], fill=0)
                    img.paste(Image.new("RGBA", (IMGW, IMGH), FILL), (0, 0), mask)
                    for ring in [outer] + list(holes):
                        pts = [to_px(lo, la, cell_x, cell_y) for lo, la in ring]
                        draw.line(pts + [pts[0]], fill=STROKE, width=3)

    out_png = os.path.join(DATA, "hk_overlay_plane.png")
    img.save(out_png)

    hk_true_w = (hk_lon1 - hk_lon0) * 111320.0 * HK_COS
    hk_true_h = (hk_lat1 - hk_lat0) * M_PER_DEG_LAT
    meta = {
        "img_w": IMGW,
        "img_h": IMGH,
        "meters_per_pixel_world": MPP,
        "world_width_m": WORLD_W,
        "world_height_m": WORLD_H,
        "lon_min": LON_MIN,
        "lon_max": LON_MAX,
        "lat_top": LAT_TOP,
        "lat_bottom": LAT_BOT,
        "cos_il": COS_IL,
        "map_mid_lat": MAP_MID_LAT,
        "hk_bbox": {"lon_min": hk_lon0, "lon_max": hk_lon1,
                    "lat_min": hk_lat0, "lat_max": hk_lat1},
        "hk_true_width_m": round(hk_true_w, 1),
        "hk_true_height_m": round(hk_true_h, 1),
        "hk_footprint_px": [round(span_x_px, 1), round(span_y_px, 1)],
        "copies": [nx, ny],
        "note": ("True-scale Hong Kong (18 districts) stamped over the whole map "
                 "plane. Row 0 = north, column 0 = west, same pixel grid as the DEM. "
                 "True metres are divided by cos(map mid-latitude) so the silhouette "
                 "matches the ground distance the app's scale bar reports."),
        "source": "HK 18-district boundary (gist howawong/487f3cfe98d8ec4b5df73aa8b73f4121, hkg.json)",
        "source_file": src,
    }
    out_json = os.path.join(DATA, "hk_overlay_plane.json")
    json.dump(meta, open(out_json, "w"), ensure_ascii=False, indent=1)

    print("PNG", out_png, img.size, os.path.getsize(out_png), "bytes")
    print("footprint px", meta["hk_footprint_px"], "copies", meta["copies"])
    print("HK true extent m:", meta["hk_true_width_m"], "x", meta["hk_true_height_m"])


if __name__ == "__main__":
    main()
