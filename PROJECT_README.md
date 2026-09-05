# Manning Household Bills — full project

This is everything behind the household bills tracker that was running on
Claude, handed off so it can run on your own GitHub + Supabase accounts
instead. There are two folders here, for two different needs:

## `dist_static/` — deploy this

Everything needed to get the site live on GitHub Pages, with your current
bills data already baked in. Start with **`dist_static/README.md`** — it
walks through creating a Supabase project, loading in the data, and
publishing the site, in about 10 minutes with no coding.

You do not need anything from `source/` to deploy the site. Just upload
the contents of `dist_static/` to a GitHub repository.

## `source/` — for changing the app itself later

The original code the site is built from: `app_core.js` (data model),
`app_render.js` (all the screens), `app_events.js` (button/input handling,
also shared with the Claude-hosted version), and `app_persist_static.js`
(the Supabase save/load/live-sync logic — this is the one file that's
different from the Claude-hosted version, since it talks to Supabase
instead of Claude's platform).

`build_static.py` is the script that assembles all of those, plus the seed
data and the inlined chart library, into the single `dist_static/index.html`
file. If you ever want to change how the app works — add a feature, tweak
a calculation, fix something — you'd edit the relevant file in `source/`
and then regenerate the site:

```
python3 build_static.py
```

(needs Python 3; no other setup, run it from inside `source/`). That writes
a fresh `dist_static/` folder right there in `source/` — copy the
refreshed `index.html` over to wherever you deployed it (or back into your
GitHub repo) same as the first time. `supabase-config.js` and
`supabase_setup.sql` don't change when you rebuild, so there's nothing
extra to redo on the Supabase side.

There's also a full test suite (`test*.js` — run with `node test8.js`,
etc., after `npm install`) covering the app's behavior, including two
(`test_static1.js`, `test_static2.js`) written specifically for the
Supabase-backed build. Not required to deploy — just there if you want to
verify a change didn't break anything before shipping it.

`app_persist.js` and `build.py` are the Claude-hosted version's equivalents
of `app_persist_static.js` and `build_static.py` — kept here for reference
in case that version is ever revisited, but not part of the GitHub Pages
deployment.

## Where the numbers came from

`current_state.json` is a snapshot of the real household data (August
2026, savedSeq 175 at the time this was exported) taken right before this
migration — it's what `supabase_setup.sql` was generated from, and what's
already sitting in `dist_static/supabase_setup.sql`, ready to load into
your new Supabase project.
