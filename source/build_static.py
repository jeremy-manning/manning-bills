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
# ---------------------------------------------------------------------------
# SEED DATA: deliberately EMPTY.
#
# The original build inlined the live household ledger here, straight from
# current_state.json, as a "no backend yet" fallback. That put every account
# balance and all 14 banking usernames into dist_static/index.html — the file
# the deploy instructions tell you to upload to GitHub Pages. No amount of
# database access control helps when the page itself carries the data.
#
# Real data now comes from Supabase at runtime, only after a signed-in,
# allowlisted user is present. An empty seed is what a brand-new ledger should
# look like, and it is the only thing safe to ship in public page source.
# ---------------------------------------------------------------------------
seed = {"years": {}, "billsReference": []}
seed_js = "\n/* ===== SEED (empty on purpose — real data comes from Supabase after sign-in) ===== */\nconst SEED_DATA = " + json.dumps(seed, separators=(',', ':')) + ";\n"

skeleton = open('skeleton.html').read()

CHARTLIB_PLACEHOLDER = '<script id="chartlib">/*@@CHARTLIB@@*/</script>'
assert skeleton.count(CHARTLIB_PLACEHOLDER) == 1, 'expected exactly one chartlib placeholder in skeleton.html'
chartlib_src = open('chart.umd.local.js').read()
assert '</script' not in chartlib_src.lower(), 'chart.umd.local.js contains a literal </script sequence that would break inlining'
skeleton = skeleton.replace(CHARTLIB_PLACEHOLDER, '<script id="chartlib">' + chartlib_src + '</script>')

# ---------------------------------------------------------------------------
# supabase-js is INLINED from a vendored copy, not pulled from a CDN.
#
# The original build used <script src=".../@supabase/supabase-js@2">: an
# unpinned major-version tag, no subresource integrity, fetched at page load.
# For a page that reads and writes household financial records that means a
# third party can change the code running against the live session at any time,
# and the page simply breaks if the CDN is unreachable.
#
# supabase.umd.local.js is @supabase/supabase-js 2.115.0, fetched once from
# jsdelivr and committed. Refresh it deliberately:
#   curl -o supabase.umd.local.js \
#     https://cdn.jsdelivr.net/npm/@supabase/supabase-js@<version>/dist/umd/supabase.js
# and re-run this script. Same pattern already used for chart.umd.local.js.
# ---------------------------------------------------------------------------
supabase_src = open('supabase.umd.local.js').read()
assert '</script' not in supabase_src.lower(), 'supabase.umd.local.js contains a literal </script sequence that would break inlining'
assert 'createClient' in supabase_src, 'supabase.umd.local.js does not look like the supabase-js UMD bundle'
SUPABASE_TAG = '<script id="supabaselib">' + supabase_src + '</script>'
CONFIG_TAG = '<script src="supabase-config.js"></script>'

SCRIPT_OPEN = '<script id="appscript">'
assert skeleton.count(SCRIPT_OPEN) == 1, 'expected exactly one <script id="appscript"> tag in skeleton.html'
skeleton = skeleton.replace(SCRIPT_OPEN, SUPABASE_TAG + '\n' + CONFIG_TAG + '\n' + SCRIPT_OPEN, 1)

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
# chartlib + supabase-js (inlined) + supabase-config.js + appscript = 4
assert real_script_opens == 4, "expected exactly 4 <script> tags, found " + str(real_script_opens)

# Data-leak guard. These strings exist only in the real household ledger; if
# any of them appears in the built page, something has inlined live data again.
LEAK_MARKERS = ['"login"', 'passwordHash', 'AFCU Checking', 'billsReference":[{']
# No third-party code may be fetched at runtime. Google Fonts is a <link>, not
# a script, and degrades to system fonts if blocked; script sources must be none.
external_scripts = re.findall(r'<script[^>]*\ssrc="(https?:)?//[^"]*"', final_html, re.IGNORECASE)
assert not external_scripts, "page loads script(s) from outside itself: " + repr(external_scripts)

for marker in LEAK_MARKERS:
    assert marker not in final_html, (
        "SECURITY: built page contains %r — live household data must never be "
        "inlined into index.html. See the SEED DATA note above." % marker)

import os
os.makedirs('dist_static', exist_ok=True)
open('dist_static/index.html', 'w').write(final_html)
import shutil
shutil.copyfile('supabase-config.js', 'dist_static/supabase-config.js')
print("built dist_static/index.html:", len(final_html.encode('utf-8')), "bytes")
print("copied dist_static/supabase-config.js")

# ---------------------------------------------------------------------------
# The original build also emitted dist_static/supabase_setup.sql here: a script
# that created public.bills_state with `to anon using (true)` policies for
# select AND update, and seeded it with the full ledger including the banking
# usernames. Both the access model and the data handling have been replaced.
#
# The database is now provisioned from the reviewed, ordered migrations in
# ../supabase/ (01 hardening, 02 schema, 03 seed), which are applied once and
# are not a build artifact. Nothing about the database changes when you rebuild
# this page, so there is nothing to regenerate.
# ---------------------------------------------------------------------------
print("done. dist_static/ is ready to deploy.")
