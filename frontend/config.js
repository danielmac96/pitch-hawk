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

  // Feature flags. `wageringInsights` gates every odds/edge/picks surface:
  // sportsbook source filters, edge highlighting and columns, settled-pick
  // tables, betting-compliance copy, and the /edge API calls themselves.
  // Off by default — the app positions as a live analytics board.
  //
  // To re-enable: set NEXTPITCH_FEATURE_WAGERING=true at build time
  // (scripts/build_frontend.sh substitutes the placeholder below), or in any
  // running browser set localStorage["np-feature-wagering"]="true" and reload.
  var wagering = "{{FEATURE_WAGERING}}"; // substituted at deploy time
  var lsWagering = null;
  try { lsWagering = localStorage.getItem("np-feature-wagering"); } catch (_e) {}
  window.NP_FEATURES = window.NP_FEATURES || {
    wageringInsights: lsWagering != null ? lsWagering === "true" : wagering === "true",
  };
})();
