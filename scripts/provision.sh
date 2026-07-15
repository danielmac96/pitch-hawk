#!/usr/bin/env bash
# One-command provisioning of the entire NextPitch pipeline onto Supabase.
#
# Prereqs:
#   * supabase CLI installed and logged in  (npm i -g supabase; supabase login)
#   * env: SUPABASE_PROJECT_REF   (e.g. abcdxyz)
#          SUPABASE_DB_PASSWORD   (project DB password, for migrations push)
#   * run from the repo root.
#
# What it does:
#   1. Links the project and pushes every migration in supabase/migrations
#      (the cron migration is ref-agnostic — it reads the functions URL and
#      cron secret from app_secrets at call time, so nothing is substituted).
#   2. Generates a cron secret and stores it in app_secrets.
#   3. Deploys all edge functions with verify_jwt disabled (they self-auth
#      via x-cron-secret; `api` is public read-only).
#   4. Seeds backfill_progress so the self-draining backfill starts.
#
# It is idempotent — safe to re-run.
set -euo pipefail

: "${SUPABASE_PROJECT_REF:?set SUPABASE_PROJECT_REF}"
REF="$SUPABASE_PROJECT_REF"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== Linking project $REF"
supabase link --project-ref "$REF"

echo "== Pushing migrations"
supabase db push

echo "== Storing cron secret + functions base URL"
CRON_SECRET="${CRON_SECRET:-$(openssl rand -hex 24)}"
FUNCTIONS_URL="https://$REF.supabase.co/functions/v1"
supabase db query "insert into app_secrets(key,value) values
  ('cron_secret','$CRON_SECRET'),
  ('functions_base_url','$FUNCTIONS_URL')
  on conflict (key) do update set value=excluded.value;" >/dev/null
echo "   cron secret stored (len=${#CRON_SECRET}); functions_base_url=$FUNCTIONS_URL"

echo "== Deploying edge functions"
for fn in api backfill daily-ingest live-poll odds-ingest settle; do
  echo "   -> $fn"
  supabase functions deploy "$fn" --no-verify-jwt --project-ref "$REF"
done

echo "== Seeding backfill window (2025-03-27 .. yesterday)"
supabase db query "insert into backfill_progress(id,start_date,end_date,cursor_date)
  values(1,'2025-03-27',current_date-1,current_date-1)
  on conflict (id) do update set start_date=excluded.start_date,
    end_date=excluded.end_date, cursor_date=excluded.cursor_date, done=false;" >/dev/null

if [ "${SEED_DEMO:-0}" = "1" ]; then
  echo "== Loading demo seed (SEED_DEMO=1)"
  supabase db query < supabase/seed_demo.sql >/dev/null
  echo "   demo rows loaded (source='demo'); remove with: delete from picks where source='demo';"
fi

echo
echo "== DONE. Pipeline is live."
echo "   Frontend: set PITCH_EDGE_API to https://$REF.supabase.co/functions/v1/api"
echo "   Monitor:  select * from ingest_runs order by id desc limit 20;"
echo "   Backfill: select * from backfill_progress;"
echo "   After backfill has data:  python scripts/train_models.py"
