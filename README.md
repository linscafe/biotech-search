# biotech-search

Static frontend for a private biotech company database.

The page is public; **the data is not**. Every record is served from Supabase and
requires a Google sign-in whose user ID an administrator has added to an
allowlist. Row Level Security authorises each request in the database — signing
in is not enough, and an unapproved account sees nothing.

`config.js` holds only the Supabase project URL and the *publishable* key. Both
are public by design; the publishable key grants no access on its own.

Built as a single page with no framework, no build step and no CDN: the Supabase
JS client is vendored and version-pinned under `docs/vendor/`, and a strict
Content-Security-Policy (`script-src 'self'`) blocks anything else from loading.

## Deployment

GitHub Pages serves `/docs` from `main`. Contents are published from a reviewed
snapshot in the private data repository — do not edit files here directly, and
never add data files, credentials, or source records.
