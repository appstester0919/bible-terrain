#!/usr/bin/env bash
# israel3d_build.sh -- THE canonical build chain for the Israel 3D map.
#
# One command, one order, one set of outputs.  Every formal artefact under
# data/ is produced by this script and by nothing else:
#
#   1. tools/israel3d_write_heightmap.py   data/tiles/*.png -> data/heightmap.png
#                                           + data/elev.json   (the DEM)
#   2. tools/israel3d_derive_geo.py        data/elev.json -> data/geo.json
#                                           + data/sites_pixel.json
#   3. tools/israel3d_water_v12.py         data/geo.json -> data/water.png,
#                                           water_meta.json, rivers.json,
#                                           coastline.json, water_vector.json
#   4. tools/israel3d_site_holes.py        punches the site pads into the DEM
#   5. tools/israel3d_carve_water.py       data/heightmap.png -> data/heightmap_water.png
#   6. tools/israel3d_water_shore.py       shoreline geometry
#   7. tools/israel3d_shore_local_fix.py   local shoreline repair
#   8. tools/israel3d_hk_overlay.py        Hong Kong overlay frame
#   9. tools/israel3d_align_check.py       geo<->pixel alignment diagnostic
#  10. tools/israel3d_site_audit.py        site markers vs water bodies
#
# The DEM grid is defined by the tile window below.  Change it here and
# everything downstream (world size, mesh resolution, water extent, HK
# overlay) follows from data/elev.json - there is no second place where the
# grid size is written down.
#
# Usage:
#   tools/israel3d_build.sh              full rebuild (needs network for water)
#   ISRAEL3D_OFFLINE=1 tools/israel3d_build.sh   reuse the cached vector data
#   tools/israel3d_build.sh --dry-run    print the stages and exit
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

# The DEM tile window: x = tile column, y = tile row (Web Mercator z=10).
# Rows 410-418 include Mount Hermon (lat 33.7243 N edge -> 31.0529 S edge).
TILE_X0=610; TILE_X1=614; TILE_Y0=410; TILE_Y1=418

PY="${PY:-python3}"

run() {
  local label="$1"; shift
  echo ""
  echo "=============================================================="
  echo ">>> ${label}"
  echo "=============================================================="
  "$@"
}

if [[ "${1:-}" == "--dry-run" ]]; then
  echo "would build tiles x=${TILE_X0}..${TILE_X1} y=${TILE_Y0}..${TILE_Y1}"
  echo "stages: write_heightmap derive_geo water_v12 site_holes carve_water water_shore shore_local_fix hk_overlay align_check site_audit"
  exit 0
fi

run "1/10  DEM from committed tiles  (tools/israel3d_write_heightmap.py)" \
  "$PY" -u tools/israel3d_write_heightmap.py --tiles "$TILE_X0" "$TILE_X1" "$TILE_Y0" "$TILE_Y1"

run "2/10  geo frame + site pixels  (tools/israel3d_derive_geo.py)" \
  "$PY" -u tools/israel3d_derive_geo.py

run "3/10  water / coastline / rivers  (tools/israel3d_water_v12.py)" \
  "$PY" -u tools/israel3d_water_v12.py

run "4/10  site pads  (tools/israel3d_site_holes.py)" \
  "$PY" -u tools/israel3d_site_holes.py

run "5/10  carve water into the DEM  (tools/israel3d_carve_water.py)" \
  "$PY" -u tools/israel3d_carve_water.py

run "6/10  shoreline geometry  (tools/israel3d_water_shore.py)" \
  "$PY" -u tools/israel3d_water_shore.py

run "7/10  local shoreline repair  (tools/israel3d_shore_local_fix.py)" \
  "$PY" -u tools/israel3d_shore_local_fix.py

run "8/10  Hong Kong overlay frame  (tools/israel3d_hk_overlay.py)" \
  "$PY" -u tools/israel3d_hk_overlay.py

run "9/10  alignment diagnostic  (tools/israel3d_align_check.py)" \
  "$PY" -u tools/israel3d_align_check.py

run "10/10 site marker audit  (tools/israel3d_site_audit.py)" \
  "$PY" -u tools/israel3d_site_audit.py

echo ""
echo "BUILD_OK"
