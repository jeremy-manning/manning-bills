import json, re

# ----------------------------------------------------------------------------
# Static/self-hosted variant of build.py, for GitHub Pages + Supabase instead
# of the Claude Artifact platform.
#
# Differences from build.py:
#  - No self-republish "quine" machinery (no SAVED_STATE_EMBEDDED / HEAD_SHELL
#    constants) — a real backend (Supabase) holds the shared state instead of
#    the page re-publishing its entire HTML on every save.
#  - Produces a COMPLETE standalone HTML document (doctype/html/head/body),
#    not a fragment, since there's no host platform wrapping it anymore.
#  - Adds the supabase-js CDN script tag and a separate, small
#    supabase-config.js file (NOT concatenated into the bundle) so the
#    project URL/anon key can be edited directly on GitHub with no rebuild.
#  - Uses app_persist_static.js instead of app_persist.js as the persistence
#    layer. app_core.js, app_render.js, and app_events.js are byte-identical
#    to the Claude-hosted build.
#
# Output goes to dist_static/ : index.html, supabase-config.js (copied
# as-is, so it stays a separately editable file on GitHub Pages).
# ----------------------------------------------------------------------------

# Seed the JS-bundled fallback (used only if Supabase is unreachable/not yet
# configured) from the CURRENT LIVE household data, not the original
# Excel-import snapshot (seed_months.json/seed_refs.json) — that snapshot
# predates several edits (account balances, notes) that are already in
# current_state.json, the export taken at the start of this
# migration. The primary path for real deployment is Supabase, seeded from
# this same file by supabase_setup.sql — this fallback just keeps the
# no-backend-yet experience showing real, current numbers instead of stale
# ones. The password hash/salt are deliberately excluded here (this constant
# ships in public page source); the real password lives only in the
# Supabase-seeded row.
live = json.load(open('current_state.json'))
seed = {"years": live["years"], "billsReference": live["billsReference"]}
seed_js = "\n/* ===== SEED (current household data as of the GitHub/Supabase migration; passwords excluded) ===== */\nconst SEED_DATA = " + json.dumps(seed, separators=(',', ':')) + ";\n"

skeleton = open('skeleton.html').read()

CHARTLIB_PLACEHOLDER = '<script id="chartlib">/*@@CHARTLIB@@*/</script>'
assert skeleton.count(CHARTLIB_PLACEHOLDER) == 1, 'expected exactly one chartlib placeholder in skeleton.html'
chartlib_src = open('chart.umd.local.js').read()
assert '</script' not in chartlib_src.lower(), 'chart.umd.local.js contains a literal </script sequence that would break inlining'
skeleton = skeleton.replace(CHARTLIB_PLACEHOLDER, '<script id="chartlib">' + chartlib_src + '</script>')

# Bring in supabase-js from a CDN (no CDN allowlist restriction on GitHub
# Pages, unlike the Claude Artifact sandbox — this is why the earlier bug
# with cdnjs required inlining Chart.js there, but is not a concern here).
# The unversioned "@2" major-version pin is Supabase's own documented CDN
# snippet (https://supabase.com/docs/reference/javascript/installing) — it
# always resolves to the latest compatible v2.x build.
SUPABASE_CDN_TAG = '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>'
CONFIG_TAG = '<script src="supabase-config.js"></script>'

SCRIPT_OPEN = '<script id="appscript">'
assert skeleton.count(SCRIPT_OPEN) == 1, 'expected exactly one <script id="appscript"> tag in skeleton.html'
skeleton = skeleton.replace(SCRIPT_OPEN, SUPABASE_CDN_TAG + '\n' + CONFIG_TAG + '\n' + SCRIPT_OPEN, 1)

open_idx = skeleton.index(SCRIPT_OPEN) + len(SCRIPT_OPEN)
close_idx = skeleton.rfind('</script>')
assert close_idx > open_idx

core = open('app_core.js').read()
persist_static = open('app_persist_static.js').read()
render = open('app_render.js').read()
events = open('app_events.js').read()

for f, name in [(core, 'app_core.js'), (render, 'app_render.js'), (events, 'app_events.js'), (persist_static, 'app_persist_static.js'), (seed_js, 'seed data')]:
    assert 'SAVED_STATE_EMBEDDED' not in f, "unexpected leftover Artifact-quine reference in " + name

full_js = seed_js + "\n" + core + "\n" + persist_static + "\n" + render + "\n" + events + "\n"

final_html = (
    "<!doctype html>\n<html><head>"
    "<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
    "</head><body>\n"
    + skeleton[:open_idx]
    + full_js
    + skeleton[close_idx:]
    + "\n</body></html>\n"
)

# Sanity checks mirroring build.py's.
assert 'SUPABASE_URL' in final_html and 'SUPABASE_ANON_KEY' not in core  # config constants come from the separate file, not baked in
real_script_opens = len(re.findall(r'<script[ >]', final_html, re.IGNORECASE))
# chartlib + supabase-js CDN + supabase-config.js + appscript = 4
assert real_script_opens == 4, "expected exactly 4 <script> tags, found " + str(real_script_opens)

import os
os.makedirs('dist_static', exist_ok=True)
open('dist_static/index.html', 'w').write(final_html)
import shutil
shutil.copyfile('supabase-config.js', 'dist_static/supabase-config.js')
print("built dist_static/index.html:", len(final_html.encode('utf-8')), "bytes")
print("copied dist_static/supabase-config.js")

# ----------------------------------------------------------------------------
# supabase_setup.sql: creates the table, RLS policies, and Realtime
# publication membership, then seeds the table with the real household data
# (the same `live` dict used for the JS fallback above) so the very first
# load of the deployed site already has everything that's on the site today.
# ----------------------------------------------------------------------------
data_json = json.dumps(live, separators=(',', ':'), ensure_ascii=True)
data_sql_literal = data_json.replace("'", "''")

sql = """-- ============================================================================
-- Manning Household Bills — Supabase setup
--
-- Run this ONCE in your Supabase project's SQL Editor (Dashboard -> SQL
-- Editor -> New query -> paste all of this -> Run) right after creating the
-- project, before you fill in supabase-config.js. It:
--   1. Creates the one table the site needs (a single JSON blob per "row",
--      really just one row for the whole household ledger).
--   2. Turns on Row Level Security and adds policies allowing the site's
--      public "anon" key to read and write that one row.
--   3. Turns on Realtime for the table, so when one of you saves a change,
--      the other person's already-open page updates live.
--   4. Seeds the table with the actual bills data that is on the site
--      today (as of the GitHub/Supabase migration), including the current
--      shared password, so you don't start over from a blank ledger.
--
-- Safe to run more than once by accident -- every step below either
-- replaces itself cleanly or checks first, so re-running this script does
-- not duplicate data or error out.
--
-- SECURITY NOTE (read this before you rely on it):
-- The policies below allow ANYONE who has your site's URL and the public
-- "anon" key (which is not a secret -- it is embedded in the page's own
-- source code, same as it would be for any client-only app like this one)
-- to read and write this table. That matches the site's existing security
-- model exactly: today, viewing the bills has never required a password,
-- and editing is only gated by a password check that happens in the
-- browser, not on a server. Moving to Supabase does not weaken or
-- strengthen that -- it is the same level of protection as before, just
-- self-hosted instead of running on Claude's platform. If you want real
-- server-enforced access control later, that would mean adding Supabase
-- Auth and rewriting these policies to require a signed-in user -- a bigger
-- change than this migration, and not something this script sets up.
-- ============================================================================

create table if not exists public.bills_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.bills_state enable row level security;

drop policy if exists "public read" on public.bills_state;
create policy "public read"
  on public.bills_state for select
  to anon
  using (true);

drop policy if exists "public insert" on public.bills_state;
create policy "public insert"
  on public.bills_state for insert
  to anon
  with check (true);

drop policy if exists "public update" on public.bills_state;
create policy "public update"
  on public.bills_state for update
  to anon
  using (true)
  with check (true);

-- Turns on live "postgres_changes" events for this table so the Realtime
-- subscription in the app (setupRealtime() in app_persist_static.js) gets
-- pushed the other person's saves without a page reload. Guarded so running
-- this script twice does not error the second time.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bills_state'
  ) then
    alter publication supabase_realtime add table public.bills_state;
  end if;
end $$;

-- Seed the table with the real household data as it exists today, so the
-- very first load of the deployed site already shows everything that was
-- on the Claude-hosted version -- same months, same balances, same shared
-- password (you and your partner keep using the password you already set;
-- it does not reset). Safe to re-run: if the "main" row already exists
-- (e.g. you already started using the live site), this does nothing rather
-- than overwriting your newer edits.
insert into public.bills_state (id, data, updated_at)
values ('main', '""" + data_sql_literal + """'::jsonb, now())
on conflict (id) do nothing;
"""

open('dist_static/supabase_setup.sql', 'w').write(sql)
print("wrote dist_static/supabase_setup.sql:", len(sql), "bytes")
