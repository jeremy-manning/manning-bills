// Verifies the reworked stat strip: AFCU (starting balance / this week's
// non-vacation bills / current balance) and Vacation (starting amount /
// spent this month / current balance using the latest entered balance minus
// that same week's vacation spending) compute correctly both on full render
// and via the live patchTotals() path, and stay in sync with each other.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');

(async () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'https://example.test/artifact/', pretendToBeVisual: true });
  const { window } = dom;
  window.fetch = () => Promise.reject(new Error('no net'));
  window.claude = undefined;
  const nodeCrypto = require('crypto');
  Object.defineProperty(window, 'crypto', { value: nodeCrypto.webcrypto, configurable: true });
  window.scrollTo = () => {};
  await new Promise(r => setTimeout(r, 300));

  const doc = window.document;
  const assert = (c,m) => { if(!c){ console.error('FAIL:',m); process.exitCode=1; } else console.log('ok  :', m); };

  window.UI.unlocked = true;
  window.STATE.auth = {passwordHash:'x', salt:'y'};
  window.selectYear('2026'); window.selectMonth('08'); // August has real vacation-flagged spending in the seed data
  const mo = window.getMonth('2026','08');

  // Layout: three separate row containers (Total Bills alone, then AFCU
  // trio, then Vacation trio), not one flat strip.
  const rows = doc.querySelectorAll('.statstrip-rows > .statstrip');
  assert(rows.length === 3, 'stat strip renders as three separate rows');
  assert(rows[0].querySelectorAll('.stattile').length === 1, 'row 1 has just the Total Bills tile');
  assert(rows[0].querySelector('#stat-totalbills'), 'row 1 contains the Total Bills tile');
  assert(rows[1].querySelectorAll('.stattile').length === 3, 'row 2 (AFCU) has 3 tiles');
  assert(rows[2].querySelectorAll('.stattile').length === 3, 'row 3 (Vacation) has 3 tiles');

  const primary = window.getPrimaryAccount(mo);
  const primaryInfo = window.mostRecentBalanceInfo(mo, primary);
  const vacAcc = window.getVacationAccount(mo);
  const vacRecentInfo = window.mostRecentBalanceInfo(mo, vacAcc);
  const firstWeek = mo.weeks[0];
  const vacStartRaw = vacAcc.balances[firstWeek.id];
  const vacSpentMonth = window.vacationMonthlyTotal(mo);

  // AFCU: bills field is now WEEKLY (the same week as the starting balance),
  // not the whole month's non-vacation total.
  const expectedNonVacWeek = window.grandWeekTotal(mo, primaryInfo.weekId) - window.vacationWeekTotal(mo, primaryInfo.weekId);
  assert(doc.getElementById('stat-afcu-start').textContent === window.fmtMoneyUSD(primaryInfo.value), 'AFCU starting balance tile shows the primary account\'s most recent balance');
  assert(doc.getElementById('stat-nonvac-bills').textContent === window.fmtMoneyUSD(expectedNonVacWeek), 'non-vacation bills tile is scoped to the starting balance\'s own week, not the whole month');
  const expectedAfcuCurrent = Number(primaryInfo.value) - expectedNonVacWeek;
  assert(doc.getElementById('stat-afcu-current').textContent === window.fmtMoneyUSD(expectedAfcuCurrent), 'AFCU current balance tile = starting balance minus that same week\'s non-vacation bills');

  // Vacation: starting amount (first week) and spent-this-month are
  // untouched; current balance now uses the account's LAST entered balance
  // minus vacation spending in that same week (money also gets added to
  // this account, so it isn't a simple monthly draw-down).
  const expectedVacStart = (vacStartRaw===null||vacStartRaw===undefined||vacStartRaw==='') ? null : Number(vacStartRaw);
  assert(doc.getElementById('stat-vac-start').textContent === (expectedVacStart===null?'—':window.fmtMoneyUSD(expectedVacStart)), 'vacation starting amount tile unchanged: B of A balance in the first week of the month');
  assert(doc.getElementById('stat-vacation-spent').textContent === window.fmtMoneyUSD(vacSpentMonth), 'vacation spent this month tile unchanged: whole-month total');
  const expectedVacCurrent = Number(vacRecentInfo.value) - window.vacationWeekTotal(mo, vacRecentInfo.weekId);
  assert(doc.getElementById('stat-vac-current').textContent === window.fmtMoneyUSD(expectedVacCurrent), 'vacation current balance tile = last entered B of A balance minus that same week\'s vacation spending');
  assert(doc.getElementById('stat-vac-current-asof').textContent === 'As of '+window.fmtDateAsOf(vacRecentInfo.date), 'vacation current balance shows an as-of date matching its own most-recent-balance week');

  // Live-patch check: editing a non-vacation bill in the AFCU starting
  // balance's own week must update the weekly (not monthly) bills tile and
  // cascade into the current-balance tile.
  const nonVacItem = (() => {
    for(const g of mo.groups) for(const it of g.items) if(!it.vacation) return it;
    return null;
  })();
  assert(!!nonVacItem, 'found a non-vacation item to edit for the live-patch check');
  const inputId = 'm-item-'+nonVacItem.id+'-'+primaryInfo.weekId;
  const input = doc.getElementById(inputId);
  const before = doc.getElementById('stat-nonvac-bills').textContent;
  input.value = '999999';
  input.dispatchEvent(new window.Event('input', {bubbles:true}));
  const after = doc.getElementById('stat-nonvac-bills').textContent;
  assert(before !== after, 'editing a non-vacation bill in the starting-balance week live-patches the weekly bills tile');
  const newExpectedNonVacWeek = window.grandWeekTotal(mo, primaryInfo.weekId) - window.vacationWeekTotal(mo, primaryInfo.weekId);
  const newExpectedAfcuCurrent = Number(primaryInfo.value) - newExpectedNonVacWeek;
  assert(doc.getElementById('stat-afcu-current').textContent === window.fmtMoneyUSD(newExpectedAfcuCurrent), 'AFCU current balance tile cascades from the weekly edit');

  console.log('\nALL GOOD 6 — DONE');
  process.exit(process.exitCode||0);
})().catch(e=>{ console.error('CRASH', e); process.exit(1); });
