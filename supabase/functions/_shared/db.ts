import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

let _svc: SupabaseClient | null = null;

// Service-role client. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected
// into every edge function automatically — no manual secret management.
export function svc(): SupabaseClient {
  if (!_svc) {
    _svc = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );
  }
  return _svc;
}

// Mutating functions are deployed with verify_jwt=false so pg_cron can call
// them; this shared check makes the cron secret (app_secrets.cron_secret)
// the actual gate.
export async function requireCronSecret(req: Request): Promise<Response | null> {
  const given = req.headers.get("x-cron-secret") ?? "";
  const { data, error } = await svc()
    .from("app_secrets").select("value").eq("key", "cron_secret").maybeSingle();
  if (error || !data) {
    return json({ error: "cron secret not provisioned" }, 500);
  }
  if (given !== data.value) return json({ error: "forbidden" }, 403);
  return null;
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      ...extra,
    },
  });
}

export async function logRun(
  job: string, startedAt: string, ok: boolean, detail: Record<string, unknown>,
): Promise<void> {
  try {
    await svc().from("ingest_runs").insert({
      job, started_at: startedAt, finished_at: new Date().toISOString(), ok, detail,
    });
  } catch (_e) { /* observability must never break the job */ }
}

export async function upsertChunked(
  table: string, rows: Record<string, unknown>[], onConflict: string, chunk = 500,
): Promise<number> {
  let n = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const { error } = await svc().from(table).upsert(slice, { onConflict });
    if (error) throw new Error(`${table} upsert failed: ${error.message}`);
    n += slice.length;
  }
  return n;
}
