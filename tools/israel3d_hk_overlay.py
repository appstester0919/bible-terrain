#!/usr/bin/env python3
"""Rasterise the HK 18-district GeoJSON into an ASPECT-CORRECT tiling PNG + metadata.

Inputs (read-only):
  data/cache/hk_districts.geojson   HK 18-district boundary source
                                    (gist howawong/487f3cfe98d8ec4b5df73aa8b73f4121, hkg.json)

Outputs:
  data/hk_overlay.png        RGBA. alpha=0 outside Hong Kong; inside HK the union of all
                             18 districts (incl. every outlying-island part) filled
                             rgb(120,190,255) at alpha 200, with every district boundary
                             stroked opaque white ~3 px.
                             Size is ASPECT-CORRECT: img_w = 1024 and
                             img_h = round(1024 * hk_real_height_m / hk_real_width_m),
                             so one pixel is square in ground metres and Hong Kong is not
                             stretched -- the tile is genuinely 同比例 / true scale.
  data/hk_overlay_meta.json  bbox + img_w/img_h + the tiling numbers the app needs to
                             tile this one tile across the whole map plane.

Pixel mapping (linear over the geographic bbox; one pixel square in ground metres):
  x_px = (lon - lon_min) / (lon_max - lon_min) * img_w
  y_px = (lat_max - lat) / (lat_max - lat_min) * img_h

Mapping convention (matches app.js geoToWorld):
  X: world metres per degree of longitude = 111320 exactly
     (195678.79241210935 m / (36.2109375 - 34.453125 deg)).
  Tile ground size is computed FROM the geojson bbox, never hard-coded:
     hk_real_width_m  = dlon * 111320 * cos(radians(22.357644))   # HK's own mid-lat
     hk_real_height_m = dlat * 110574
  then converted to the Israel map plane by dividing by cos_il,
     cos_il = cos(radians(32.09524)).

No shapely needed: the source has no interior rings (verified), but holes are still
handled generically if they ever appear. stdlib + numpy + Pillow only.

Usage:
  /usr/bin/python3 ~/.hermes/scripts/israel3d_hk_overlay.py [--dry-run]
"""

import argparse
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

# ---------------------------------------------------------------- paths
PROJECT = "/home/appstester0919/work/israel3d"
SRC_GEOJSON = os.path.join(PROJECT, "data", "cache", "hk_districts.geojson")
OUT_PNG = os.path.join(PROJECT, "data", "hk_overlay.png")
OUT_META = os.path.join(PROJECT, "data", "hk_overlay_meta.json")

# ---------------------------------------------------------------- constants
IMG_W = 1024                       # tile width in px (height derived from true aspect)
STROKE_PX = 3                      # district boundary width in tile pixels
FILL_RGB = (120, 190, 255)         # flat district fill
FILL_ALPHA = 200
STROKE_RGB = (255, 255, 255)       # opaque white boundary

# App world frame (do not change; mirrors app.js geoToWorld).
WORLD_WIDTH_M = 195678.79241210935
WORLD_HEIGHT_M = 273950.3093769531
MAP_MID_LAT_DEG = 32.09524         # mid-latitude of the Israel map frame

M_PER_DEG_LON_EQUIRECT = 111320.0  # app's equirectangular X spacing per degree
M_PER_DEG_LAT_GROUND = 110574.0    # real ground metres per degree of latitude

# Latitude used for the HK bbox's real ground *width* (its own mid-latitude).
HK_MID_LAT_DEG = 22.357644

SRC_NOTE = "HK 18-district boundary (gist howawong/487f3cfe98d8ec4b5df73aa8b73f4121, hkg.json)"
TILE_NOTE = ("one texture tile = the Hong Kong bounding box; "
             "the app tiles it across the whole map plane")


def load_features(path):
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if data.get("type") != "FeatureCollection" or not data.get("features"):
        raise SystemExit(f"unexpected geojson in {path}: {data.get('type')}")

    # bbox straight off the coordinates (authoritative, not from a properties field).
    lon_min = lat_min = math.inf
    lon_max = lat_max = -math.inf
    district_rings = []  # list of (name, outer_ring, [hole_rings...]) in lon/lat

    for feat in data["features"]:
        geom = feat.get("geometry") or {}
        gtype = geom.get("type")
        if gtype == "Polygon":
            polygons = [geom["coordinates"]]
        elif gtype == "MultiPolygon":
            polygons = geom["coordinates"]
        else:
            raise SystemExit(f"unsupported geometry type {gtype!r} for "
                             f"{feat.get('properties', {}).get('name')!r}")

        name = feat.get("properties", {}).get("name")
        for poly in polygons:
            if not poly:
                continue
            outer = poly[0]
            holes = poly[1:]
            district_rings.append((name, outer, holes))
            for ring in (outer, *holes):
                for lon, lat in ring:
                    lon_min = min(lon_min, lon)
                    lon_max = max(lon_max, lon)
                    lat_min = min(lat_min, lat)
                    lat_max = max(lat_max, lat)

    if not district_rings:
        raise SystemExit("no rings found in geojson")
    return district_rings, (lon_min, lon_max, lat_min, lat_max)


def real_ground_size(bbox):
    """hk_real_width_m / hk_real_height_m computed FROM the bbox (never hard-coded)."""
    lon_min, lon_max, lat_min, lat_max = bbox
    hk_real_width_m = (lon_max - lon_min) * M_PER_DEG_LON_EQUIRECT * math.cos(math.radians(HK_MID_LAT_DEG))
    hk_real_height_m = (lat_max - lat_min) * M_PER_DEG_LAT_GROUND
    return hk_real_width_m, hk_real_height_m


def tile_dims(hk_real_width_m, hk_real_height_m):
    """Aspect-correct pixel grid: 1 px square in ground metres."""
    img_w = IMG_W
    img_h = int(round(IMG_W * hk_real_height_m / hk_real_width_m))
    return img_w, img_h


def build_tile(district_rings, bbox, img_w, img_h):
    """Render the aspect-correct RGBA tile.

    Two layers so overlapping district fills never stack alpha: the fill is composited
    as a union on its own mask, then opaque white strokes are painted over it.
    Every polygon part of every MultiPolygon is drawn, so outlying islands are included.
    """
    lon_min, lon_max, lat_min, lat_max = bbox
    dlon = lon_max - lon_min
    dlat = lat_max - lat_min

    def px(lon):
        return (lon - lon_min) / dlon * img_w

    def py(lat):
        # x scales by img_w and y by img_h; since img_h/img_w == dlat_m/dlon_m, the x
        # and y ground scale per pixel are identical -> square pixels, no stretching.
        return (lat_max - lat) / dlat * img_h

    fill_mask = Image.new("L", (img_w, img_h), 0)
    fd = ImageDraw.Draw(fill_mask)
    stroke_layer = Image.new("RGBA", (img_w, img_h), (0, 0, 0, 0))
    sd = ImageDraw.Draw(stroke_layer)

    n_polys = 0
    for name, outer, holes in district_rings:
        outer_pts = [(px(lon), py(lat)) for lon, lat in outer]
        hole_pts = [[(px(lon), py(lat)) for lon, lat in h] for h in holes]

        # Union of all districts (holes subtracted) on the mask layer.
        fd.polygon(outer_pts, fill=255)
        for h in hole_pts:
            fd.polygon(h, fill=0)
        n_polys += 1

        # Every district boundary stroked opaque white.
        sd.polygon(outer_pts, outline=STROKE_RGB + (255,), width=STROKE_PX)
        for h in hole_pts:
            sd.polygon(h, outline=STROKE_RGB + (255,), width=STROKE_PX)

    mask = np.asarray(fill_mask, dtype=np.uint8)
    out = np.zeros((img_h, img_w, 4), dtype=np.uint8)
    inside = mask > 0
    out[inside, 0] = FILL_RGB[0]
    out[inside, 1] = FILL_RGB[1]
    out[inside, 2] = FILL_RGB[2]
    out[inside, 3] = FILL_ALPHA

    strokes = np.asarray(stroke_layer, dtype=np.uint8)
    s_on = strokes[:, :, 3] > 0
    # Opaque white boundary wins over the fill wherever it is drawn.
    out[s_on, 0] = STROKE_RGB[0]
    out[s_on, 1] = STROKE_RGB[1]
    out[s_on, 2] = STROKE_RGB[2]
    out[s_on, 3] = 255

    return Image.fromarray(out), n_polys


def compute_meta(bbox, img_w, img_h):
    cos_il = math.cos(math.radians(MAP_MID_LAT_DEG))
    hk_real_width_m, hk_real_height_m = real_ground_size(bbox)
    tile_world_w = hk_real_width_m / cos_il
    tile_world_h = hk_real_height_m / cos_il
    repeat_x = WORLD_WIDTH_M / tile_world_w
    repeat_y = WORLD_HEIGHT_M / tile_world_h
    offset_x = 0.5 - 0.5 * repeat_x
    offset_y = 0.5 - 0.5 * repeat_y

    def r6(v):
        return round(v, 6)

    lon_min, lon_max, lat_min, lat_max = bbox
    return {
        "bbox": {
            "lon_min": lon_min,
            "lon_max": lon_max,
            "lat_min": lat_min,
            "lat_max": lat_max,
        },
        "img_w": img_w,
        "img_h": img_h,
        "src": SRC_NOTE,
        "note": TILE_NOTE,
        "cos_il": r6(cos_il),
        "hk_real_width_m": r6(hk_real_width_m),
        "hk_real_height_m": r6(hk_real_height_m),
        "tile_world_w": r6(tile_world_w),
        "tile_world_h": r6(tile_world_h),
        "repeat_x": r6(repeat_x),
        "repeat_y": r6(repeat_y),
        "offset_x": r6(offset_x),
        "offset_y": r6(offset_y),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="compute + print only, write nothing")
    args = ap.parse_args()

    if not os.path.isfile(SRC_GEOJSON):
        raise SystemExit(f"missing source geojson: {SRC_GEOJSON}")

    district_rings, bbox = load_features(SRC_GEOJSON)
    hk_real_width_m, hk_real_height_m = real_ground_size(bbox)
    img_w, img_h = tile_dims(hk_real_width_m, hk_real_height_m)
    img, n_polys = build_tile(district_rings, bbox, img_w, img_h)
    meta = compute_meta(bbox, img_w, img_h)

    alpha = np.asarray(img)[:, :, 3]
    coverage_px = int((alpha > 0).sum())
    print(f"districts          : {len({r[0] for r in district_rings})}")
    print(f"polygon parts      : {n_polys} (outlying islands included)")
    print(f"bbox               : lon {bbox[0]}..{bbox[1]}  lat {bbox[2]}..{bbox[3]}")
    print(f"tile dims          : img_w={img_w} img_h={img_h}")
    print(f"hk_real W x H (m)  : {hk_real_width_m:.6f} x {hk_real_height_m:.6f}")
    print(f"alpha>0 pixels     : {coverage_px} / {img_w * img_h}")

    if args.dry_run:
        print(json.dumps(meta, indent=1, ensure_ascii=False))
        return 0

    os.makedirs(os.path.dirname(OUT_PNG), exist_ok=True)
    img.save(OUT_PNG, format="PNG")
    with open(OUT_META, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    print(f"wrote {OUT_PNG}")
    print(f"wrote {OUT_META}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
