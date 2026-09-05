// End-to-end test of the new whole-document "self-republish" save mechanism:
// buildPublishHtml() must produce a COMPLETE, VALID, independently-loadable
// page that, when loaded fresh, shows the just-saved data AND can itself be
// saved again (the quine must reproduce, not just work once).
const { JSDOM } = require('jsdom');
const fs = require('fs');
const assert = (c,m) => { if(!c){ console.error('FAIL:',m); process.exitCode=1; } else console.log('ok  :', m); };

function makeDom(html, publishSpy){
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'https://example.test/artifact/', pretendToBeVisual: true });
  const { window } = dom;
  window.fetch = () => Promise.reject(new Error('no net'));
  window.claude = { use: async (name) => {
    if (name === 'artifact') return { publish: async (html2) => { await publishSpy(html2); return {version:'v1'}; } };
    if (name === 'downloads') return null;
    return null;
  }};
  const nodeCrypto = require('crypto');
  Object.defineProperty(window, 'crypto', { value: nodeCrypto.webcrypto, configurable: true });
  window.scrollTo = () => {};
  return dom;
}

(async () => {
  const originalHtml = fs.readFileSync('index.html', 'utf8');
  assert(originalHtml.includes('var SAVED_STATE_EMBEDDED = null;'), 'fresh build has no live state yet (falls back to seed)');

  // ---- Round 1: load the original (seeded) page, make an edit, save ----
  let publishedHtml1 = null;
  const dom1 = makeDom(originalHtml, async (html)=>{ publishedHtml1 = html; });
  await new Promise(r => setTimeout(r, 250));
  const w1 = dom1.window;
  w1.UI.unlocked = true;
  w1.STATE.auth = {passwordHash:'x', salt:'y'};
  w1.selectYear('2026'); w1.selectMonth('01');
  const mo1 = w1.getMonth('2026','01');
  const acctId = mo1.accounts[0].id;
  const weekId = mo1.weeks[0].id;
  w1.setMoneyValue('acct', acctId, weekId, 54321.98);
  w1.scheduleSave(true);
  await new Promise(r => setTimeout(r, 100));

  assert(publishedHtml1 !== null, 'a whole-document publish happened');
  assert(/^<!doctype html>/i.test(publishedHtml1), 'published content is a complete HTML document starting with <!doctype html> (required by the runtime publish contract)');

  // Count real </script> closes — must match the original page's count
  // (proves HEAD_SHELL_PRE/POST's escaped strings didn't leak an unescaped
  // </script> and corrupt the page).
  const countCloses = (s) => (s.match(/<\/script/gi) || []).length;
  assert(countCloses(publishedHtml1) === countCloses(originalHtml), 'published page has the same real </script> tag count as the original (no leakage)');

  // Regression guard for the too_large crash: the published document must
  // NOT be anywhere close to double the original size (the old bug came
  // from embedding a full duplicate copy of the page inside itself). The
  // live-captured script plus the small static shell should stay close to
  // the original page's own size.
  const origBytes = Buffer.byteLength(originalHtml, 'utf8');
  const pubBytes = Buffer.byteLength(publishedHtml1, 'utf8');
  console.log('original bytes:', origBytes, ' published bytes:', pubBytes, ' ratio:', (pubBytes/origBytes).toFixed(3));
  assert(pubBytes < origBytes * 1.3, 'published document stays close to the original size, not ~2x (no full-page duplication)');

  // ---- Round 2: load THAT published page fresh (simulating a reload / a ----
  // ---- different browser opening the artifact) and verify the edit is there ----
  let publishedHtml2 = null;
  const dom2 = makeDom(publishedHtml1, async (html)=>{ publishedHtml2 = html; });
  await new Promise(r => setTimeout(r, 250));
  const w2 = dom2.window;
  w2.selectYear('2026'); w2.selectMonth('01');
  const mo2 = w2.getMonth('2026','01');
  const acct2 = mo2.accounts.find(a=>a.id===acctId);
  assert(acct2 && acct2.balances[weekId] === 54321.98, 'a freshly-loaded copy of the published page shows the saved edit');
  assert(w2.UI.dirty === false, 'freshly loaded page is not marked dirty');
  assert(w2.document.getElementById('saveindicator').textContent === 'Saved', 'freshly loaded page shows Saved (no false "unavailable" banners)');

  // ---- Round 3: prove the quine reproduces — save AGAIN from this second ----
  // ---- generation, and confirm a THIRD generation still loads correctly ----
  w2.UI.unlocked = true;
  w2.setMoneyValue('acct', acctId, mo2.weeks[1].id, 11.11);
  w2.scheduleSave(true);
  await new Promise(r => setTimeout(r, 100));
  assert(publishedHtml2 !== null, 'second-generation save also produced a whole-document publish');
  assert(countCloses(publishedHtml2) === countCloses(originalHtml), 'second-generation published page still has correct </script> count');

  const dom3 = makeDom(publishedHtml2, async ()=>{});
  await new Promise(r => setTimeout(r, 250));
  const w3 = dom3.window;
  const mo3 = w3.getMonth('2026','01');
  const acct3 = mo3.accounts.find(a=>a.id===acctId);
  assert(acct3 && acct3.balances[weekId] === 54321.98, 'third-generation page still has the first edit');
  assert(acct3 && acct3.balances[mo2.weeks[1].id] === 11.11, 'third-generation page has the second edit too');

  console.log('\nALL GOOD 4 — DONE');
  process.exit(process.exitCode||0);
})().catch(e=>{ console.error('CRASH', e); process.exit(1); });
