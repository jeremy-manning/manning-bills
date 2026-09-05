# Manning Household Bills — deployable site

Two files, and that is the whole site:

- **`index.html`** — layout, styling, and all app logic in one file. Do not edit
  by hand; it is generated from `../source/` by `python3 build_static.py`.
- **`supabase-config.js`** — the project URL and publishable key. Already filled
  in for the `open-brain` Supabase project.

**There is no `supabase_setup.sql` here any more.** The database is provisioned
once from the reviewed migrations in `../supabase/` (`01` hardening, `02`
schema, `03` seed). The old file created a table that any visitor could read and
overwrite, and it embedded the ledger and 14 banking usernames in plain text —
it has been deleted, not moved.

## Where the data lives

Nothing is baked into this page. On load it asks Supabase for the ledger, and
Supabase answers only if the request carries a signed-in session whose email is
listed in `bills.allowed_emails`. Signed out, the page shows a sign-in form and
nothing else — no balances, no biller list.

## Signing in

Enter your email and a one-time link arrives; opening it returns you here,
signed in. No password. The session persists, so day to day neither of you
should have to do this often.

Who has access is listed in `bills.allowed_emails` in Supabase; edit it there
to add or remove someone. Anyone signing up with an address that is not on
that list gets an account that can see nothing.

## Publishing

The repo can be **public**. The publishable key in `supabase-config.js` is
designed to be visible and grants nothing on its own — every table it can reach
requires a signed-in allowlisted user. What must *never* be committed is the
household data: `source/current_state.json`, `supabase/03_seed.sql`,
`supabase/seed_state.json`, and `supabase/EXTRACTED-LOGINS.txt`. The repo's
`.gitignore` covers all four.

In **Settings → Pages**, deploy from your branch, `/ (root)` if this folder is
the repo root. Then, in Supabase under **Authentication → URL Configuration**,
set **Site URL** and **Redirect URLs** to the published address. Skip that step
and sign-in links will bounce to `localhost` and appear broken.

## Biller logins

The reference tab lists payment links only. The usernames that used to live
there were removed — they were readable by anyone who found the URL. They are in
`supabase/EXTRACTED-LOGINS.txt`; put them in a password manager and delete that
file. The column is gone from the UI so they cannot drift back in.

## Backups

The **Export** button downloads a JSON snapshot any time. Beyond that, every
save writes a full revision to `bills.state_history`, so a bad edit is
recoverable from the database even if nobody exported anything.

## If something looks wrong

- **Stuck on the sign-in form after clicking the link** — Site URL / Redirect
  URLs in Supabase do not match where the page is published.
- **No email arrives** — Supabase's built-in sender is rate-limited to a couple
  of messages an hour and is explicitly test-grade. Configure SMTP (Resend's
  free tier is enough) before relying on this.
- **"Not authorised"** — signed in with an address that is not on the allowlist.
- **Blank ledger for a signed-in member** — check the browser console; likely
  `supabase-config.js` is wrong or migration `03` never ran.
