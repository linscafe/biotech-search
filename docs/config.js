// Public runtime configuration for the static frontend.
//
// Both values below are PUBLIC by design: the Supabase "publishable" key is
// meant to be shipped to browsers and is authorized only through Postgres
// Row Level Security + the RPC grants configured in supabase/migrations.
//
// NEVER put a database password, a service_role key, a Google OAuth client
// secret, or any other private credential in this file or anywhere else
// under docs/ — this directory is published as-is to a public static host.
//
// The SUPABASE_URL host below must exactly match the `connect-src` host in
// the Content-Security-Policy <meta> tag at the top of index.html.
window.APP_CONFIG = {
  SUPABASE_URL: "https://anktktwofftmbnogzjoa.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_UnlZMTWSNWrcrkz1zV2AuQ_E3KBJCor",
};
