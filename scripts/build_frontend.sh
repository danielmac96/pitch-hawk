#!/usr/bin/env bash
# Build the static frontend for deploy: copy frontend/ to dist/ and inject the
# Supabase functions URL into config.js.
#
#   SUPABASE_FUNCTIONS_URL=https://<ref>.supabase.co/functions/v1 ./scripts/build_frontend.sh
#
# On Vercel/Netlify set SUPABASE_FUNCTIONS_URL as an env var and use this as
# the build command with output dir "dist". If the var is unset the app ships
# in bundled sample-data mode (still a working demo).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/frontend"
OUT="$ROOT/dist"
URL="${SUPABASE_FUNCTIONS_URL:-}"

rm -rf "$OUT"
mkdir -p "$OUT"
cp -r "$SRC"/. "$OUT"/

if [ -n "$URL" ]; then
  # Replace the placeholder in the copied config.js only.
  sed -i.bak "s#{{SUPABASE_FUNCTIONS_URL}}#${URL//#/\\#}#g" "$OUT/config.js"
  rm -f "$OUT/config.js.bak"
  echo "built dist/ with API base: $URL/api"
else
  echo "built dist/ in sample-data mode (SUPABASE_FUNCTIONS_URL unset)"
fi
