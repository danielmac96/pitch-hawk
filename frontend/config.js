// Deployment config — loaded before the app scripts.
//
// PITCH_EDGE_API points the frontend at the public read API. In production
// that's the Supabase `api` edge function (no auth needed — it serves only
// public data); for local dev against the FastAPI backend, use
// "http://localhost:8080".
//
// The provisioning step (scripts/provision.sh / docs/DEPLOY.md) replaces the
// placeholder below with https://<ref>.supabase.co/functions/v1. Until then,
// we leave PITCH_EDGE_API unset so the app runs cleanly on bundled sample
// data instead of firing doomed fetches at an unresolved placeholder.
(function () {
  var base = "{{SUPABASE_FUNCTIONS_URL}}"; // substituted at deploy time
  if (base.indexOf("{{") === -1 && base) {
    window.PITCH_EDGE_API = window.PITCH_EDGE_API || base + "/api";
  }
  // else: leave window.PITCH_EDGE_API as-is (default sample-data mode).
})();
