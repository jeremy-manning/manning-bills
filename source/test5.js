// Regression test for the exponential backup-growth bug: rotateBackup() used
// to be called on EVERY save (even a routine balance edit) and stored a full
// deep clone of the previous STATE *including that state's own .backups
// array*, so repeated destructive actions caused each new snapshot to nest
// every earlier one inside it — ballooning STATE (and therefore every
// published document) far beyond what "too_large" would tolerate after just
// a handful of saves. Fix: backups are only taken around genuinely
// destructive actions (delete month/year, import), and each stored snapshot
// has its own .backups stripped first so nesting can never compound.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');

(async () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'https://example.test/artifact/', pretendToBeVisual: true });
  const { window } = dom;
  window.fetch = () => Promise.reject(new Error('no net'));
  window.claude = { use: async (name) => {
    if (name === 'artifact') return { publish: async (h) => ({version:'v1'}) };
    return null;
  }};
  const nodeCrypto = require('crypto');
  Object.defineProperty(window, 'crypto', { value: nodeCrypto.webcrypto, configurable: true });
  window.scrollTo = () => {};
  await new Promise(r => setTimeout(r, 250));

  const assert = (c,m) => { if(!c){ console.error('FAIL:',m); process.exitCode=1; } else console.log('ok  :', m); };

  window.UI.unlocked = true;
  window.STATE.auth = {passwordHash:'x', salt:'y'};

  // 1) A plain balance edit + save must NOT create a backup snapshot at all
  // — only genuinely destructive actions do.
  window.selectYear('2026'); window.selectMonth('01');
  const mo = window.getMonth('2026','01');
  window.setMoneyValue('acct', mo.accounts[0].id, mo.weeks[0].id, 42);
  window.scheduleSave(true);
  await new Promise(r => setTimeout(r, 50));
  assert((window.STATE.backups||[]).length === 0, 'a routine edit-save creates no backup snapshot');

  // 2) Simulate 8 destructive actions in a row (what onDeleteMonth/
  // onDeleteYear/onImportFile each do: rotateBackup(deepClone(STATE)) right
  // before mutating). The backups array must stay capped at 5, and — the
  // key regression check — each stored snapshot's size must stay roughly
  // constant rather than growing with every additional backup taken (which
  // is what nesting each snapshot's own prior backups would produce).
  for(let i=0;i<8;i++){
    window.rotateBackup(window.deepClone(window.STATE));
  }
  const backups = window.STATE.backups || [];
  assert(backups.length === 5, 'backups array stays capped at 5 entries ('+backups.length+' found)');
  const sizes = backups.map(b => JSON.stringify(b).length);
  console.log('backup snapshot sizes (bytes):', sizes);
  const maxSize = Math.max(...sizes);
  const minSize = Math.min(...sizes);
  assert(maxSize < minSize * 1.5 + 2000, 'backup snapshot sizes stay in the same ballpark, not exponentially growing ('+minSize+' .. '+maxSize+')');
  const anyNested = backups.some(b => b.snapshot && b.snapshot.backups && b.snapshot.backups.length > 0);
  assert(!anyNested, 'no stored backup snapshot carries its own nested backups');

  // 3) Confirm a real destructive action (delete month) still actually
  // takes a snapshot, as the UI's own copy promises ("A backup snapshot is
  // kept in shared storage").
  window.STATE.backups = [];
  const beforeCount = Object.keys(window.STATE.years['2026'].months).length;
  window.onDeleteMonth('2026','01');
  const confirmBtn = window.document.getElementById('modalconfirm');
  assert(!!confirmBtn, 'delete month opens the confirmation modal');
  await confirmBtn.onclick();
  assert(Object.keys(window.STATE.years['2026'].months).length === beforeCount - 1, 'the month was actually deleted');
  assert((window.STATE.backups||[]).length === 1, 'deleting a month takes exactly one backup snapshot');
  const restoredMonth = window.STATE.backups[0].snapshot.years['2026'].months['01'];
  assert(restoredMonth && restoredMonth.weeks && restoredMonth.weeks.length > 0, 'the backup snapshot actually contains the deleted month\'s data');

  console.log('\nALL GOOD 5 — DONE');
  process.exit(process.exitCode||0);
})().catch(e=>{ console.error('CRASH', e); process.exit(1); });
