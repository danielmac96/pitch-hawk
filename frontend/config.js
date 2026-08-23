// Deployment config — loaded before the app scripts.
//
// PITCH_EDGE_API points the frontend at the public read API: the Supabase
// `api` edge function. No auth needed — it serves only public data.
//
// The build step (scripts/build_frontend.sh, run by Vercel) replaces the
// placeholder below with https://<ref>.supabase.co/functions/v1. The guard
// keeps an unsubstituted placeholder from becoming a doomed fetch at every
// poll; the board then reports that it cannot reach the feed, which is the
// truth. There is no offline fallback.
(function () {
  var base = "{{SUPABASE_FUNCTIONS_URL}}"; // substituted at deploy time
  if (base.indexOf("{{") === -1 && base) {
    window.PITCH_EDGE_API = window.PITCH_EDGE_API || base + "/api";
  }
  // else: the placeholder was never substituted — leave the API unset.

  // Feature flags. `wageringInsights` gates every odds/edge/picks surface:
  // sportsbook source filters, edge highlighting and columns, settled-pick
  // tables, betting-compliance copy, and the /edge API calls themselves.
  // Off by default — the app positions as a live analytics board.
  //
  // To re-enable: set PITCHHAWK_FEATURE_WAGERING=true at build time
  // (scripts/build_frontend.sh substitutes the placeholder below), or in any
  // running browser set localStorage["ph-feature-wagering"]="true" and reload.
  var wagering = "{{FEATURE_WAGERING}}"; // substituted at deploy time
  var lsWagering = null;
  try { lsWagering = localStorage.getItem("ph-feature-wagering"); } catch (_e) {}
  window.PH_FEATURES = window.PH_FEATURES || {
    wageringInsights: lsWagering != null ? lsWagering === "true" : wagering === "true",
  };
})();
