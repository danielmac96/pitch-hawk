// Deployment config — loaded before the app scripts.
//
// PITCH_EDGE_API points the frontend at the public read API. In production
// that's the Supabase `api` edge function (no auth needed — it serves only
// public data); for local dev against the FastAPI backend, change it to
// "http://localhost:8080".
//
// This value is filled in by the provisioning step (see docs/DEPLOY.md).
window.PITCH_EDGE_API = window.PITCH_EDGE_API
  || "{{SUPABASE_FUNCTIONS_URL}}/api";
