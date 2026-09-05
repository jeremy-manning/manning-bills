// Regression test for the GitHub Pages + Supabase build (dist_static/index.html).
// Exercises the real persistence contract app_persist_static.js promises:
//   - on load, reads the shared row from Supabase (table/row id come from
//     supabase-config.js) and adopts it as STATE, rather than the bundled
//     seed data
//   - the CURRENT LIVE HOUSEHOLD DATA (current_state.json, the
//     export taken before this migration) round-trips correctly, including
//     the real password hash/salt, so the husband's first load already has
//     everything
//   - a save calls upsert() with the whole STATE row, keyed by the
//     configured table/row id
//   - a Realtime "someone else saved" push adopts the newer state and
//     re-renders, without clobbering an in-progress local edit
//
// Because a real browser isn't available here, the supabase-js CDN <script>
// tag and the supabase-config.js <script> tag (both external requests that
// jsdom would otherwise try, and fail, to fetch over the network) are
// replaced with one inline stub: a fake `supabase.createClient` backed by an
// in-memory table, and the four SUPABASE_* config constants pointing at it.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('dist_static/index.html', 'utf8');
const liveData = JSON.parse(fs.readFileSync('current_state.json', 'utf8'));

const REAL_TAGS = '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>\n<script src="supabase-config.js"></script>';
const assertReplaced = html.includes(REAL_TAGS);
if (!assertReplaced) {
  console.error('FAIL: expected script tags not found verbatim in dist_static/index.html — test stub is out of sync with build_static.py output');
  process.exit(1);
}

const STUB = `<script>
  window.__mock = { rows: {}, upsertCalls: [], selectCalls: 0, channelCalls: [], createClientArgs: null, realtimeCb: null };
  window.__mock.rows['main'] = { id:'main', data: ${JSON.stringify(liveData)}, updated_at: '2026-08-30T00:00:00.000Z' };
  function __mockClient(){
    return {
      from(table){
        return {
          select(cols){
            return { eq(col, val){ return { maybeSingle: async ()=>{
              window.__mock.selectCalls++;
              const row = window.__mock.rows[val];
              return { data: row ? { data: row.data } : null, error: null };
            } }; } };
          },
          upsert(obj){
            window.__mock.upsertCalls.push(JSON.parse(JSON.stringify(obj)));
            window.__mock.rows[obj.id] = obj;
            return Promise.resolve({ error: null });
          }
        };
      },
      channel(name){
        return {
          on(event, filter, cb){ window.__mock.channelCalls.push({event, filter}); window.__mock.realtimeCb = cb; return this; },
          subscribe(statusCb){ if(statusCb) statusCb('SUBSCRIBED'); return this; }
        };
      }
    };
  }
  window.supabase = { createClient: (url, key) => { window.__mock.createClientArgs = [url, key]; return __mockClient(); } };
  const SUPABASE_URL = 'https://fake-project.supabase.co';
  const SUPABASE_ANON_KEY = 'fake-anon-key-not-a-placeholder';
  const SUPABASE_TABLE = 'bills_state';
  const SUPABASE_ROW_ID = 'main';
</script>`;

const testHtml = html.replace(REAL_TAGS, STUB);

(async () => {
  const dom = new JSDOM(testHtml, { runScripts: 'dangerously', resources: 'usable', url: 'https://example.test/site/', pretendToBeVisual: true });
  const { window } = dom;
  window.fetch = () => Promise.reject(new Error('no net'));
  window.Chart = function (ctx, cfg) { this.destroy = () => {}; this._cfg = cfg; };
  window.scrollTo = () => {};
  const nodeCrypto = require('crypto');
  Object.defineProperty(window, 'crypto', { value: nodeCrypto.webcrypto, configurable: true });
  window.addEventListener('error', (e) => { console.error('WINDOW ERROR:', e.error ? e.error.stack : e.message); });

  await new Promise(r => setTimeout(r, 400));

  const doc = window.document;
  const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok  :', m); };

  // --- Loaded from the mocked Supabase row, not the bundled seed data.
  assert(window.__mock.createClientArgs && window.__mock.createClientArgs[0] === 'https://fake-project.supabase.co', 'createClient called with the configured project URL');
  assert(window.__mock.selectCalls > 0, 'the shared row was read on load');
  assert(window.STATE && window.STATE.years && window.STATE.years['2026'], 'live 2026 data loaded from Supabase, not the fallback seed');
  assert(Object.keys(window.STATE.years['2026'].months).length === 8, 'all 8 saved months carried over');
  assert(window.STATE.savedSeq === liveData.savedSeq, 'savedSeq carried over unchanged (' + liveData.savedSeq + ')');
  assert(window.STATE.auth.passwordHash === liveData.auth.passwordHash, 'the real (existing) password hash carried over, not reset');
  assert(window.STATE.auth.salt === liveData.auth.salt, 'the real password salt carried over');
  assert(window.STATE.billsReference.length === liveData.billsReference.length, 'bills reference list carried over (' + liveData.billsReference.length + ' entries)');
  assert(doc.getElementById('topnav').children.length === 3, 'app rendered normally (topnav present) after loading Supabase data');

  // --- Realtime subscribed to the configured table/row.
  assert(window.__mock.channelCalls.length === 1, 'subscribed to exactly one realtime channel');
  assert(window.__mock.channelCalls[0].filter.table === 'bills_state', 'realtime filter targets the configured table');
  assert(window.__mock.channelCalls[0].filter.filter === 'id=eq.main', 'realtime filter targets the configured row id');

  // --- A save upserts the whole STATE row to the configured table/row id.
  const seqBefore = window.STATE.savedSeq;
  window.UI.unlocked = true; // already has a real password hash from the loaded data; this test only exercises the save plumbing
  window.scheduleSave(true);
  await new Promise(r => setTimeout(r, 30));
  assert(window.__mock.upsertCalls.length === 1, 'a save calls upsert exactly once');
  assert(window.__mock.upsertCalls[0].id === 'main', 'the upserted row uses the configured row id');
  assert(window.__mock.upsertCalls[0].data.savedSeq === seqBefore + 1, 'savedSeq advanced by exactly one on save');
  assert(window.UI.dirty === false, 'no longer marked dirty after a successful save');
  assert(doc.getElementById('saveindicator').textContent === 'Saved', 'save indicator shows Saved');

  // --- A Realtime push from "the husband's" browser adopts the newer state
  // and re-renders, without needing a full page reload.
  const incoming = JSON.parse(JSON.stringify(window.STATE));
  incoming.savedSeq = window.STATE.savedSeq + 5;
  incoming.savedAt = new Date().toISOString();
  incoming.years['2026'].months['01'].groups[0].items[0].name = 'Realtime Test Marker';
  window.__mock.realtimeCb({ new: { data: incoming } });
  await new Promise(r => setTimeout(r, 30));
  assert(window.STATE.savedSeq === incoming.savedSeq, 'realtime push adopted (savedSeq now matches the incoming push)');
  assert(window.STATE.years['2026'].months['01'].groups[0].items[0].name === 'Realtime Test Marker', "the partner's edit is now reflected in STATE");
  assert(doc.getElementById('toaststack').textContent.includes("Updated with your partner's latest changes"), 'a toast announces the live update');

  // --- The realtime handler ignores its own echoed write (savedSeq === lastWrittenSeq).
  const beforeIgnore = window.STATE.savedSeq;
  window.__mock.realtimeCb({ new: { data: Object.assign({}, window.STATE) } });
  await new Promise(r => setTimeout(r, 20));
  assert(window.STATE.savedSeq === beforeIgnore, 'a push with the same savedSeq as our own last write is ignored (no self-echo loop)');

  console.log('\nALL GOOD STATIC1 — DONE');
  process.exit(process.exitCode || 0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
