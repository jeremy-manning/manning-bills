const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');

(async () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'https://example.test/artifact/', pretendToBeVisual: true });
  const { window } = dom;
  window.fetch = () => Promise.reject(new Error('no net'));
  let publishCalls = 0;
  window.claude = { use: async (name) => {
    if (name === 'artifact') return { publish: async (files) => { publishCalls++; const e = new Error('conflict'); e.code='conflict'; throw e; } };
    return null;
  }};
  const nodeCrypto = require('crypto');
  Object.defineProperty(window, 'crypto', { value: nodeCrypto.webcrypto, configurable: true });
  window.scrollTo = () => {};
  await new Promise(r => setTimeout(r, 400));
  const doc = window.document;
  const assert = (c,m) => { if(!c){ console.error('FAIL:',m); process.exitCode=1; } else console.log('ok  :', m); };

  // locked by default (no local unlock flag) -> money inputs disabled
  window.selectYear('2026'); window.selectMonth('01');
  const mo = window.getMonth('2026','01');
  const itemId = mo.groups[0].items[0].id, weekId = mo.weeks[1].id;
  const input = doc.getElementById('m-item-'+itemId+'-'+weekId);
  assert(input && input.disabled, 'money input is disabled while locked');

  // trigger a save conflict path
  window.UI.unlocked = true;
  window.STATE.auth = {passwordHash:'x', salt:'y'};
  window.scheduleSave(true);
  await new Promise(r => setTimeout(r, 50));
  assert(publishCalls > 0, 'artifact.publish was called');
  // Whole-document publish: on conflict the platform itself reloads every
  // open view to the winning version — there's no local banner/button to
  // manage, just a toast explaining why, and the edit must not be marked
  // as saved (no silent overwrite of the truth).
  const toastText = doc.getElementById('toaststack').textContent;
  assert(toastText.includes('reloading'), 'conflict surfaces a toast explaining the reload, not a silent overwrite');
  assert(window.UI.dirty === true, 'a rejected (conflict) save leaves the edit marked unsaved, never falsely "Saved"');

  console.log('\nALL GOOD 2 — DONE');
  process.exit(process.exitCode||0);
})().catch(e=>{ console.error('CRASH', e); process.exit(1); });
