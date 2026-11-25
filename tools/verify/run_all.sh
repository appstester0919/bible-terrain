#!/usr/bin/env bash
# israel3d_verify.sh — run the browser regression suites for the Israel 3D map.
#
#   bash tools/verify/run_all.sh              # against the local repo (starts a server)
#   PAGE_URL=https://.../bash tools/verify/run_all.sh   # against a deployed URL
#   bash tools/verify/run_all.sh landscape    # one suite only
#
# Each suite gets its OWN headless Chrome on its OWN port and profile:
#
#   landscape   9334   /tmp/chrome-israel3d-landscape
#   hermon      9335   /tmp/chrome-israel3d-hermon
#   gyro        9336   /tmp/chrome-israel3d-gyro
#
# This script NEVER touches port 9222 (the user's own Chrome) or port 9333
# (another agent's instance), and it only ever kills the Chrome processes it
# started itself.  The harnesses also refuse to run on a reserved port.
#
# Exit status: 0 only if every requested suite passed.
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
cd "$REPO"

SUITES=("${@:-all}")
if [ "${SUITES[0]}" = "all" ]; then
  SUITES=(landscape hermon gyro)
fi

PORT_LANDSCAPE=9334
PORT_HERMON=9335
PORT_GYRO=9336

SERVER_PORT=8765
STARTED_SERVER=""
SERVER_PID=""
cleanup() {
  # Only ever kill what THIS script started.
  if [ -n "$STARTED_SERVER" ] && [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# --- static server, only if we are testing the local checkout ----------------
if [ -z "${PAGE_URL:-}" ]; then
  if ! curl -s -o /dev/null --max-time 3 "http://127.0.0.1:${SERVER_PORT}/index.html"; then
    echo "starting static server on ${SERVER_PORT}"
    python3 -m http.server "$SERVER_PORT" >/tmp/israel3d-verify-server.log 2>&1 &
    SERVER_PID=$!
    STARTED_SERVER=1
    sleep 2
  else
    echo "reusing the static server already on ${SERVER_PORT}"
  fi
  export PAGE_URL="http://127.0.0.1:${SERVER_PORT}/"
fi

# --- find a free Chrome binary ----------------------------------------------
CHROME=""
for c in "${CHROME_BIN:-}" /opt/google/chrome/chrome /usr/bin/google-chrome \
         /usr/bin/google-chrome-stable /usr/bin/chromium /usr/bin/chromium-browser; do
  [ -n "$c" ] && [ -x "$c" ] && { CHROME="$c"; break; }
done
if [ -z "$CHROME" ]; then
  echo "FAIL: no Chrome binary found (set \$CHROME_BIN)"
  exit 2
fi

start_chrome() {          # $1 = port, $2 = profile dir
  local port="$1" profile="$2"
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${port}/json/version"; then
    echo "  reusing the Chrome already on port ${port}"
    return 0
  fi
  mkdir -p "$profile"
  "$CHROME" --headless=new --remote-debugging-port="$port" --user-data-dir="$profile" \
    --use-gl=swiftshader --enable-unsafe-swiftshader --no-sandbox \
    --window-size=1440,900 --no-first-run --no-default-browser-check \
    >"/tmp/israel3d-chrome-${port}.log" 2>&1 &
  echo $! > "/tmp/israel3d-chrome-${port}.pid"
  for _ in $(seq 1 40); do
    sleep 0.5
    curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${port}/json/version" && return 0
  done
  echo "  FAIL: Chrome did not come up on port ${port}"
  return 1
}

stop_chrome() {           # $1 = port  (only the PID this script recorded)
  local port="$1" pidfile="/tmp/israel3d-chrome-${port}.pid"
  [ -f "$pidfile" ] || return 0
  local pid; pid="$(cat "$pidfile")"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
}

FAILED=0
run_suite() {             # $1 = suite name, $2 = port, $3 = profile, $4 = script
  local name="$1" port="$2" profile="$3" script="$4"
  echo ""
  echo "=============================================================="
  echo ">>> ${name} (chrome on port ${port})"
  echo "=============================================================="
  start_chrome "$port" "$profile" || { FAILED=1; return; }
  ISRAEL3D_CDP_PORT="$port" ISRAEL3D_CHROME_PROFILE="$profile" \
    node "$HERE/$script"
  local rc=$?
  [ $rc -ne 0 ] && FAILED=1
  stop_chrome "$port"
  return $rc
}

for suite in "${SUITES[@]}"; do
  case "$suite" in
    landscape)
      run_suite landscape "$PORT_LANDSCAPE" /tmp/chrome-israel3d-landscape \
        verify_landscape_layout.js ;;
    hermon)
      run_suite hermon "$PORT_HERMON" /tmp/chrome-israel3d-hermon \
        verify_hermon_dem_rebuild.js ;;
    gyro)
      run_suite gyro "$PORT_GYRO" /tmp/chrome-israel3d-gyro \
        verify_gyro_position_fixed.js ;;
    *)
      echo "unknown suite: $suite (landscape | hermon | gyro | all)"
      exit 2 ;;
  esac
done

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "VERIFY_OK"
else
  echo "VERIFY_FAILED"
fi
exit $FAILED
