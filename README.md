# Manning Household Bills

Weekly bill-payment tracker. Static page on GitHub Pages, data in Supabase
behind email sign-in.

| Path | What it is |
|---|---|
| `dist_static/` | The published site. `index.html` is generated — don't hand-edit it. |
| `source/` | The app source and the build script that produces `dist_static/`. |
| `supabase/` | One-time database migrations, applied in order. |
| `.github/workflows/pages.yml` | Publishes `dist_static/` on every push to `main`. |

## Rebuilding after a code change

```bash
cd source && python3 build_static.py
```

That regenerates `dist_static/`. Commit and push; the workflow publishes it.
The build **fails** if live household data ends up in the page, and the
workflow re-checks the same thing before publishing.

## How access works

Nothing is baked into the page. It asks Supabase for the ledger, and Supabase
answers only for a signed-in user whose address is in `bills.allowed_emails`.
Signed out, the page is a sign-in form and nothing more.

Sign-in is a one-time emailed link — no password anywhere in the system.

## What must never be committed

The household data itself. `.gitignore` covers all of it:
`source/current_state.json`, `source/seed_months.json`, `source/seed_refs.json`,
`supabase/03_seed.sql`, `supabase/seed_state.json`, and
`supabase/EXTRACTED-LOGINS.txt`.

Those last three exist only on the machine that ran the migrations.
`EXTRACTED-LOGINS.txt` holds biller usernames pulled out of the ledger — they
belong in a password manager, and the file should be deleted once they are there.

## Provenance

The app was built in Claude chat and handed off as a bundle. Claude (Opus 5)
then reworked authentication, data handling, and the build for self-hosting;
the commit history records what changed and why. Jeremy Manning commissioned,
scoped, and reviewed the work.
