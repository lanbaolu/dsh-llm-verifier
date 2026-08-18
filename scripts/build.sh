#!/bin/bash
# Build: compile src/ → lib/, then copy the Python bridge into lib/bridge.
# Uses the local TypeScript from devDependencies (no DSH_CHECKOUT required).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -x "node_modules/.bin/tsc" ]; then
  TSC="node_modules/.bin/tsc"
elif command -v tsc >/dev/null 2>&1; then
  TSC="tsc"
else
  echo "build: tsc not found (run npm install first)" >&2
  exit 1
fi

echo "=== Compiling src → lib ==="
"$TSC" -p tsconfig.json

echo "=== Copying Python bridge → lib/bridge ==="
rm -rf lib/bridge
mkdir -p lib/bridge
cp -R bridge/*.py lib/bridge/

echo "=== Build complete ==="
