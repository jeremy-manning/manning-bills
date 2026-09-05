import json, re

months = json.load(open('seed_months.json'))
refs = json.load(open('seed_refs.json'))
seed = {"years": months["years"], "billsReference": refs}
seed_js = "\n/* ===== SEED (imported from 2026 Bills.xlsx; passwords excluded) ===== */\nconst SEED_DATA = " + json.dumps(seed, separators=(',',':')) + ";\n"

def esc_slashes(s):
    # Prevents a literal "</script" inside these embedded strings from
    # prematurely ending the <script id="appscript"> block that contains
    # them (the HTML parser looks for that byte sequence regardless of JS
    # string quoting). "\/" parses identically to "/" in JSON/JS string
    # literals, so this is a no-op for the resulting value.
    return s.replace('/', '\\/')

skeleton = open('skeleton.html').read()

# ----------------------------------------------------------------------------
# Chart.js is bundled inline (not loaded from the cdnjs CDN at runtime).
# Originally this was a plain <script src="https://cdnjs.../chart.umd.min.js">
# tag, but users reported the "Charts could not load (the chart library did
# not reach this browser)" fallback firing consistently on the published
# artifact — likely an ad blocker, corporate network policy, or CSP quirk in
# the artifact iframe blocking the third-party request. Inlining the library
# source removes that entire external-network dependency for something that
# should always work. chart.umd.local.js is the unmodified v4.4.4 UMD build
# (same version previously pinned via the CDN), vendored locally.
CHARTLIB_PLACEHOLDER = '<script id="chartlib">/*@@CHARTLIB@@*/</script>'
assert skeleton.count(CHARTLIB_PLACEHOLDER) == 1, 'expected exactly one chartlib placeholder in skeleton.html'
chartlib_src = open('chart.umd.local.js').read()
assert '</script' not in chartlib_src.lower(), 'chart.umd.local.js contains a literal </script sequence that would break inlining — needs escaping'
skeleton = skeleton.replace(CHARTLIB_PLACEHOLDER, '<script id="chartlib">' + chartlib_src + '</script>')

SCRIPT_OPEN = '<script id="appscript">'
assert skeleton.count(SCRIPT_OPEN) == 1, 'expected exactly one <script id="appscript"> tag in skeleton.html'
open_idx = skeleton.index(SCRIPT_OPEN) + len(SCRIPT_OPEN)
close_idx = skeleton.rfind('</script>')
assert close_idx > open_idx

# ----------------------------------------------------------------------------
# Live self-republish, WITHOUT duplicating the ~100KB+ codebase on every save.
#
# Earlier design (too_large / crash bug): the whole page embedded a full
# JSON-encoded copy of ITSELF as a string constant (PAGE_TEMPLATE), so it
# could always reconstruct a fresh copy to publish. That roughly doubled the
# page's size on every save and exceeded the platform's publish size limit.
#
# New design: the static shell around the app script never changes (only
# Claude's own code edits + a rebuild change it), so it doesn't need to be
# re-embedded as data on every save — it's hardcoded ONCE here, at build
# time, as two small string constants (~15KB total, not ~100KB+). The large,
# actual JS codebase is captured LIVE from the running page's own
# <script id="appscript"> element (its .textContent is the original,
# unmutated source text as served — reading it back out costs nothing, since
# it's already sitting there as executing code) and only the small
# SAVED_STATE_EMBEDDED statement within it is swapped out, via unique
# comment markers, rather than re-serializing the whole script.
# ----------------------------------------------------------------------------
head_shell_pre = (
    "<!doctype html>\n<html><head>"
    "<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
    "</head><body>\n" + skeleton[:open_idx]
)
head_shell_post = skeleton[close_idx:] + "\n</body></html>\n"

head_pre_json = esc_slashes(json.dumps(head_shell_pre))
head_post_json = esc_slashes(json.dumps(head_shell_post))

# SAVED_STATE_EMBEDDED is wrapped in unique comment markers so a live save
# can find-and-replace just this one statement inside the running script's
# own source text (see buildPublishHtml() in app_persist.js), instead of
# re-serializing the whole codebase.
embed_js = (
    "\n/* ===== LIVE-PUBLISHED STATE (swapped in at publish time; see buildPublishHtml in app_persist.js) ===== */\n"
    "/*@@STATE_START@@*/var SAVED_STATE_EMBEDDED = null;/*@@STATE_END@@*/\n"
    "var HEAD_SHELL_PRE = " + head_pre_json + ";\n"
    "var HEAD_SHELL_POST = " + head_post_json + ";\n"
)

core = open('app_core.js').read()
persist = open('app_persist.js').read()
render = open('app_render.js').read()
events = open('app_events.js').read()

# app_persist.js legitimately mentions the marker text a couple of times, as
# JS string/regex constants it uses to find the slot at runtime (its
# STATE_MARK_START/END string constants, and STATE_MARK_RE) — that's
# expected, not a slot itself. Everything else must have zero occurrences.
assert '@@STATE_START@@' in persist and '@@STATE_END@@' in persist
for f, name in [(core,'app_core.js'), (render,'app_render.js'), (events,'app_events.js'), (seed_js,'seed data')]:
    assert '@@STATE_START@@' not in f and '@@STATE_END@@' not in f, "unexpected state marker text in " + name

full_js = seed_js + embed_js + "\n" + core + "\n" + persist + "\n" + render + "\n" + events + "\n"
final_html = skeleton[:open_idx] + full_js + skeleton[close_idx:]

# Sanity: the one true state SLOT (marker immediately followed by the
# SAVED_STATE_EMBEDDED assignment) must appear exactly once. Note the marker
# TEXT itself also legitimately appears a second time, inertly, inside
# app_persist.js's own STATE_MARK_START/END string constant declarations —
# that's fine (mirrors the old STATE_TOKEN/TEMPLATE_TOKEN design) because
# embed_js is placed BEFORE app_persist.js in file order, so the runtime
# regex's non-greedy first-match always lands on the real slot below.
assert final_html.count('/*@@STATE_START@@*/var SAVED_STATE_EMBEDDED') == 1
assert final_html.index('/*@@STATE_START@@*/var SAVED_STATE_EMBEDDED') < final_html.index('STATE_MARK_START'), \
    'the real state slot must appear before app_persist.js\'s own marker-string constants, so the runtime regex matches the real slot first'

open('index.html', 'w').write(final_html)
print("built index.html:", len(final_html.encode('utf-8')), "bytes")

# Verify the escaping actually neutralized the literal "</script>" bytes
# inside HEAD_SHELL_PRE/POST (which include the inlined Chart.js <script>
# block's own closing tag, and our own appscript closing tag respectively) —
# a real unescaped "</script>" there would end our <script id="appscript">
# block early and corrupt the page. Exactly 2 REAL script tags should
# remain: the inlined Chart.js <script id="chartlib"> and our own
# <script id="appscript">.
real_script_closes = len(re.findall(r'</script', final_html, re.IGNORECASE))
assert real_script_closes == 2, "expected exactly 2 real </script> tags, found " + str(real_script_closes) + " — HEAD_SHELL escaping likely broke"
print("script-tag escaping check passed (2 real </script> tags)")
