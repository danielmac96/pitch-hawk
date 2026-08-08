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

// Call another edge function from inside one, with the cron secret those
// functions gate on. This is what makes scoring event-driven: live-poll chains
// settle the moment a result lands, instead of settle polling every 10 minutes
// hoping something has.
//
// The secret is read fresh every call and deliberately NOT cached in a module
// global. deploy-supabase.yml rotates cron_secret on every deploy, and a warm
// instance holding the old value would send 403s to a function that is working
// perfectly -- a failure that would look like a settle bug and reproduce on
// nobody's machine.
//
// Failures are returned, never thrown. A chained settle that does not land is a
// grading delay until the 03:00 ET sweep, which is a much smaller problem than
// live-poll dropping a pitch because the call after it failed.
export async function invokeFunction(
  name: string, timeoutMs = 20_000,
): Promise<{ ok: boolean; error?: string }> {
  const base = Deno.env.get("SUPABASE_URL");
  if (!base) return { ok: false, error: "SUPABASE_URL unset" };

  const { data, error } = await svc()
    .from("app_secrets").select("value").eq("key", "cron_secret").maybeSingle();
  if (error || !data?.value) return { ok: false, error: "cron secret not provisioned" };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/functions/v1/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cron-secret": data.value,
        // The functions deploy with verify_jwt=false, but the gateway still
        // needs a key to route the request at all.
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""}`,
      },
      body: "{}",
      signal: ctl.signal,
    });
    // Drain the body: an unread response holds the connection open, and this
    // runs on every new pitch.
    await res.text().catch(() => {});
    return res.ok ? { ok: true } : { ok: false, error: `${name} -> HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: `${name} -> ${String(e).slice(0, 120)}` };
  } finally {
    clearTimeout(timer);
  }
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
