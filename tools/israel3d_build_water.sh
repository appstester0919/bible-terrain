#!/usr/bin/env bash
# Full water rebuild for the Israel 3D map - ONE command, reproducible.
#
# Why this wrapper exists (2026-11-24): the 250 m "site holes" that keep
# Capernaum and Tiberias out of the water polygon were originally injected by
# an ad-hoc one-off command.  Re-running the v12 builder SILENTLY dropped
# them and the markers slid back into the lake.  A build step that is not in
# the pipeline is not a build step.  This wrapper runs the three stages in the
# only correct order:
#
#   1. israel3d_water_v12.py  -> data/water_vector.json (+ water.png, rivers…)
#   2. israel3d_site_holes.py -> re-inserts the site holes (idempotent)
#   3. israel3d_carve_water.py-> carves the terrain against the final vectors
#
# Stage 2 must sit between 1 and 3: the carve step reads the holes from
# water_vector.json, so carving before the holes are back would carve the
# towns down to the lake floor.
#
# Usage: bash tools/israel3d_build_water.sh
#
# NOTE: the canonical chain for the whole map is tools/israel3d_build.sh;
# this wrapper rebuilds only the water half of it.
set -u
# ISRAEL3D_OFFLINE=1 -> skip the Overpass network calls and use the cached
# response. Public Overpass mirrors are routinely 502/504/timeout; a rebuild
# that does not need fresh river data must not burn 15 minutes waiting.
export ISRAEL3D_OFFLINE="${ISRAEL3D_OFFLINE:-1}"
WORK=/home/appstester0919/work/israel3d
LOG="$WORK/data/water_build.log"
S="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # this repo's tools/ dir

PY=""
for cand in /usr/bin/python3 \
            /home/appstester0919/tools/rgvenv/bin/python \
            /home/appstester0919/.venv/bin/python \
            python3 python ; do
  if command -v "$cand" >/dev/null 2>&1 || [ -x "$cand" ]; then
    if "$cand" -c 'import numpy, PIL' >/dev/null 2>&1; then PY="$cand"; break; fi
  fi
done
[ -z "$PY" ] && { echo "FAILED: no python with numpy+PIL" | tee "$LOG"; exit 1; }

{
  echo "=== rebuild start $(date -Is) python=$PY"
  echo "--- stage 1/3 water_v12 (vector outlines, rivers, masks)"
  "$PY" -u "$S/israel3d_water_v12.py" 2>&1
  rc1=$?
  echo "stage1 rc=$rc1"
  [ $rc1 -ne 0 ] && { echo "FAILED at stage 1" | tee -a "$LOG"; exit $rc1; }

  echo "--- stage 2/3 site holes (idempotent, sites.json-driven)"
  "$PY" -u "$S/israel3d_site_holes.py" 2>&1
  rc2=$?
  echo "stage2 rc=$rc2"
  [ $rc2 -ne 0 ] && { echo "FAILED at stage 2" | tee -a "$LOG"; exit $rc2; }

  echo "--- stage 2b verify idempotence"
  "$PY" -u "$S/israel3d_site_holes.py" --check 2>&1
  rc2b=$?
  echo "stage2b rc=$rc2b (0 = holes are deterministic)"
  [ $rc2b -ne 0 ] && { echo "FAILED: site holes not deterministic" | tee -a "$LOG"; exit $rc2b; }

  echo "--- stage 3/3 carve water (terrain against final vectors)"
  "$PY" -u "$S/israel3d_carve_water.py" 2>&1
  rc3=$?
  echo "stage3 rc=$rc3"
  [ $rc3 -ne 0 ] && { echo "FAILED at stage 3" | tee -a "$LOG"; exit $rc3; }
  echo "=== rebuild DONE_OK"
} 2>&1 | tee "$LOG"

rc=${PIPESTATUS[0]}
echo "EXIT_CODE=$rc" | tee -a "$LOG"
exit $rc
