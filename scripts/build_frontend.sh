#!/usr/bin/env bash
# Build the static frontend for deploy: copy frontend/ to dist/ and inject the
# Supabase functions URL into config.js.
#
#   SUPABASE_FUNCTIONS_URL=https://<ref>.supabase.co/functions/v1 ./scripts/build_frontend.sh
#
# On Vercel/Netlify set SUPABASE_FUNCTIONS_URL as an env var and use this as
# the build command with output dir "dist". The app reads live data only -- it
# has no offline fallback, so an empty URL produces a board that cannot load.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/frontend"
OUT="$ROOT/dist"
# Default to this project's Supabase functions URL so a plain Vercel build wires
# to the live public API without any dashboard env var; SUPABASE_FUNCTIONS_URL
# overrides it to target another project.
URL="${SUPABASE_FUNCTIONS_URL-https://gfxpchtyncgsczqdvohr.supabase.co/functions/v1}"

rm -rf "$OUT"
mkdir -p "$OUT"
cp -r "$SRC"/. "$OUT"/

if [ -n "$URL" ]; then
  # Replace the placeholder in the copied config.js only.
  sed -i.bak "s#{{SUPABASE_FUNCTIONS_URL}}#${URL//#/\\#}#g" "$OUT/config.js"
  rm -f "$OUT/config.js.bak"
  echo "built dist/ with API base: $URL/api"
else
  echo "WARNING: SUPABASE_FUNCTIONS_URL is empty -- dist/ has no API base and" >&2
  echo "         the board will not load. Set it to a functions URL." >&2
fi

# Feature flag: odds/edge/picks surfaces. Off unless explicitly enabled —
# PITCHHAWK_FEATURE_WAGERING=true restores the wagering positioning.
WAGERING="${PITCHHAWK_FEATURE_WAGERING-false}"
sed -i.bak "s#{{FEATURE_WAGERING}}#${WAGERING}#g" "$OUT/config.js"
rm -f "$OUT/config.js.bak"
echo "built dist/ with wagering surfaces: $WAGERING"
