const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');

(async () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'https://example.test/artifact/', pretendToBeVisual: true });
  const { window } = dom;
  window.fetch = () => Promise.reject(new Error('no net'));

  // Extracts the live STATE object from a published whole-document HTML
  // string (mirrors what a fresh page load of that document would see).
  function parseStateFromHtml(html){
    const m = html.match(/var SAVED_STATE_EMBEDDED = (\{[\s\S]*?\});\/\*@@STATE_END@@\*\//);
    if(!m) throw new Error('could not find SAVED_STATE_EMBEDDED in published html');
    return JSON.parse(m[1]);
  }

  // simulate a shared "server" copy of the artifact (whole-document publish),
  // and a slow publish that takes real time to resolve — long enough for a
  // second edit to land while the first save is still in flight.
  let serverCopy = null;
  let publishCount = 0;
  window.claude = { use: async (name) => {
    if (name === 'artifact') return {
      publish: async (html) => {
        publishCount++;
        await new Promise(r => setTimeout(r, 150)); // simulate network latency
        serverCopy = html;
        return { version: 'v'+publishCount };
      }
    };
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
  const acctId = mo.accounts[0].id;
  const weekIds = mo.weeks.map(w=>w.id);

  // Edit #1: triggers a debounced save (2.2s) — force it to fire NOW via scheduleSave(true)
  window.setMoneyValue('acct', acctId, weekIds[0], 1111.11);
  window.scheduleSave(true); // starts an in-flight publish that takes 150ms

  // While that save is still in flight (well under 150ms later), make edit #2.
  await new Promise(r => setTimeout(r, 30));
  window.setMoneyValue('acct', acctId, weekIds[1], 2222.22);
  window.scheduleSave(); // debounced — but the *bug* was doSave() #1 clearing "dirty" for this too

  // Right after edit #2, before its own debounce would ever fire, check the
  // indicator. If the old bug were present, doSave() #1 (still in flight)
  // would soon resolve and blindly mark everything "Saved" here.
  await new Promise(r => setTimeout(r, 200)); // let save #1 resolve
  const indicatorAfterFirstSave = doc.getElementById('saveindicator').textContent;
  console.log('indicator right after save #1 resolves (edit #2 still unsaved-on-server):', indicatorAfterFirstSave);

  const serverAfterFirstSave = parseStateFromHtml(serverCopy);
  const acctAfterFirstSave = serverAfterFirstSave.years['2026'].months['01'].accounts.find(a=>a.id===acctId);
  const edit2InServerAfterSave1 = acctAfterFirstSave.balances[weekIds[1]] === 2222.22;
  console.log('was edit #2 actually in the published payload after save #1 resolved?', edit2InServerAfterSave1);

  // The critical assertion: the indicator must NOT falsely say "Saved" while
  // edit #2 is not yet reflected on the server.
  if(!edit2InServerAfterSave1){
    assert(indicatorAfterFirstSave !== 'Saved', 'indicator does not falsely claim "Saved" while a concurrent edit is still unpersisted');
  } else {
    console.log('(edit #2 happened to make it into save #1\'s payload — race window missed; not a useful check this run)');
  }

  // Now wait for the follow-up save (auto-scheduled by the fix) to complete,
  // and confirm edit #2 eventually does land on the "server".
  await new Promise(r => setTimeout(r, 700));
  const serverFinal = parseStateFromHtml(serverCopy);
  const acctFinal = serverFinal.years['2026'].months['01'].accounts.find(a=>a.id===acctId);
  assert(acctFinal.balances[weekIds[0]] === 1111.11, 'edit #1 present in final published state');
  assert(acctFinal.balances[weekIds[1]] === 2222.22, 'edit #2 present in final published state (auto-follow-up save picked it up)');
  assert(doc.getElementById('saveindicator').textContent === 'Saved', 'indicator eventually settles on Saved once everything is truly persisted');
  assert(publishCount >= 2, 'a follow-up publish call happened to actually save edit #2 ('+publishCount+' calls)');

  // ===== Mutex: doSave() must never have two publishes in flight at once =====
  let concurrentPublishes = 0, maxConcurrent = 0, publishCount2 = 0;
  window.claude = { use: async (name) => {
    if (name === 'artifact') return {
      publish: async (html) => {
        publishCount2++;
        concurrentPublishes++;
        maxConcurrent = Math.max(maxConcurrent, concurrentPublishes);
        await new Promise(r => setTimeout(r, 60));
        concurrentPublishes--;
        return { version: 'x'+publishCount2 };
      }
    };
    return null;
  }};
  window.artifactCap = await window.claude.use('artifact');
  window.setMoneyValue('acct', acctId, weekIds[2], 10);
  window.scheduleSave(true);
  await new Promise(r => setTimeout(r, 10));
  window.setMoneyValue('acct', acctId, weekIds[2], 20);
  window.scheduleSave(true); // would have raced the first publish pre-fix
  await new Promise(r => setTimeout(r, 10));
  window.setMoneyValue('acct', acctId, weekIds[2], 30);
  window.scheduleSave(true);
  await new Promise(r => setTimeout(r, 400));
  assert(maxConcurrent <= 1, 'never more than one publish() in flight at a time (no overlapping saves)');

  console.log('\nALL GOOD 3 — DONE');
  process.exit(process.exitCode||0);
})().catch(e=>{ console.error('CRASH', e); process.exit(1); });
