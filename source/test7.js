// Regression test for the reported bug: "It was trying to save before I was
// finished typing and would enter an unfinished amount." Root cause: only
// blur (not each keystroke) reset the save debounce timer, so blurring one
// field started a countdown that could elapse while the user was already
// mid-keystroke in the NEXT field — doSave() force-commits whatever's in
// the currently focused field before publishing, so it grabbed a partial,
// not-yet-finished number. Fix: every keystroke (oninput) now also resets
// the debounce, so a save only fires after genuine inactivity everywhere.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');

(async () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'https://example.test/artifact/', pretendToBeVisual: true });
  const { window } = dom;
  window.fetch = () => Promise.reject(new Error('no net'));
  let publishedHtml = null;
  let publishCount = 0;
  window.claude = { use: async (name) => {
    if (name === 'artifact') return { publish: async (h) => { publishCount++; publishedHtml = h; return {version:'v'+publishCount}; } };
    return null;
  }};
  const nodeCrypto = require('crypto');
  Object.defineProperty(window, 'crypto', { value: nodeCrypto.webcrypto, configurable: true });
  window.scrollTo = () => {};
  await new Promise(r => setTimeout(r, 250));

  const doc = window.document;
  const assert = (c,m) => { if(!c){ console.error('FAIL:',m); process.exitCode=1; } else console.log('ok  :', m); };

  window.UI.unlocked = true;
  window.STATE.auth = {passwordHash:'x', salt:'y'};
  window.selectYear('2026'); window.selectMonth('01');
  const mo = window.getMonth('2026','01');
  const acctA = mo.accounts[0].id, acctB = mo.accounts[1] ? mo.accounts[1].id : mo.accounts[0].id;
  const weekId = mo.weeks[0].id;
  const inputAId = 'm-acct-'+acctA+'-'+weekId;
  const inputBId = 'm-acct-'+(mo.accounts[1]?acctB:mo.accounts[0].id)+'-'+(mo.accounts[1]?weekId:mo.weeks[1].id);
  const elA = doc.getElementById(inputAId);
  const elB = doc.getElementById(inputBId);
  assert(!!elA && !!elB && elA!==elB, 'found two distinct money inputs to simulate tabbing between');

  // Step 1: type and blur field A (like moving on to the next field) — this
  // schedules a save (the debounce interval, currently 3s).
  elA.focus();
  elA.value = '150';
  elA.dispatchEvent(new window.Event('input', {bubbles:true}));
  elA.dispatchEvent(new window.Event('blur', {bubbles:true}));

  // Step 2: shortly after, start typing a NEW value into field B, slowly
  // enough (500ms between keystrokes) that the whole entry spans past
  // field A's original debounce deadline — exactly the scenario that
  // exposed the bug: a background timer armed by an earlier field's blur
  // elapsing while the user is still actively, continuously typing a
  // DIFFERENT field.
  await new Promise(r => setTimeout(r, 100));
  elB.focus();
  const finalValue = '2847.63';
  for(let i=1; i<=finalValue.length; i++){
    elB.value = finalValue.slice(0, i);
    elB.dispatchEvent(new window.Event('input', {bubbles:true}));
    await new Promise(r => setTimeout(r, 500));
  }
  // ~100ms + 7*500ms ≈ 3.6s has now elapsed since field A's blur — past
  // field A's original debounce deadline — while field B was mid-typing
  // for almost all of that window. No save should have fired yet.
  assert(publishCount === 0, 'no save has fired yet while actively typing field B, even though the time since field A\'s blur has passed its own original debounce window');

  // Step 3: stop typing (do NOT blur) and wait for genuine inactivity to
  // trigger the debounced save.
  await new Promise(r => setTimeout(r, 3500));
  assert(publishCount >= 1, 'a save eventually fires after real inactivity');

  const m2 = publishedHtml.match(/var SAVED_STATE_EMBEDDED = (\{[\s\S]*?\});\/\*@@STATE_END@@\*\//);
  const savedState = JSON.parse(m2[1]);
  const savedMo = savedState.years['2026'].months['01'];
  const savedAcctB = savedMo.accounts.find(a=>a.id===(mo.accounts[1]?acctB:mo.accounts[0].id));
  const savedVal = savedMo.accounts[1] ? savedAcctB.balances[weekId] : savedAcctB.balances[mo.weeks[1].id];
  assert(savedVal === 2847.63, 'the saved value is the FULL, finished number the user typed (2847.63), not a partial one truncated mid-keystroke — got '+savedVal);

  console.log('\nALL GOOD 7 — DONE');
  process.exit(process.exitCode||0);
})().catch(e=>{ console.error('CRASH', e); process.exit(1); });
