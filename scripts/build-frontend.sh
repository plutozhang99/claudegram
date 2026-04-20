#!/usr/bin/env bash
# Build the Flutter web bundle for claude-harbor.
#
# Produces `current/claude-harbor-frontend/build/web/` which the Bun server
# serves at `/` (see `claude-harbor-server/src/http-static.ts`).
#
# Usage: ./scripts/build-frontend.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FRONTEND_DIR="${REPO_ROOT}/current/claude-harbor-frontend"
BUILD_OUT="${FRONTEND_DIR}/build/web"

if [ ! -d "${FRONTEND_DIR}" ]; then
  echo "error: frontend dir not found: ${FRONTEND_DIR}" >&2
  exit 1
fi

if ! command -v flutter >/dev/null 2>&1; then
  echo "error: flutter not on PATH. Install Flutter 3.x first." >&2
  exit 1
fi

cd "${FRONTEND_DIR}"

echo "[build-frontend] flutter pub get"
flutter pub get

echo "[build-frontend] flutter build web --release"
# Flutter 3.41+ infers the renderer per-platform; --web-renderer was
# removed. We pass --base-href=/ for same-origin serving under the Bun
# server's root. --no-web-resources-cdn pins CanvasKit to same-origin (CSP).
flutter build web --release --base-href / --no-web-resources-cdn

if [ ! -f "${BUILD_OUT}/index.html" ]; then
  echo "error: build output missing: ${BUILD_OUT}/index.html" >&2
  exit 1
fi

FILE_COUNT="$(find "${BUILD_OUT}" -type f | wc -l | tr -d ' ')"

echo "[build-frontend] ok"
echo "[build-frontend] output:     ${BUILD_OUT}"
echo "[build-frontend] file count: ${FILE_COUNT}"
