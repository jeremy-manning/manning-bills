const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('index.html', 'utf8');

(async () => {
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: 'usable',
    url: 'https://example.test/artifact/',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // Stub things not available / not wanted in this offline test
  window.fetch = () => Promise.reject(new Error('no network in test'));
  window.claude = undefined; // simulate no capability -> local-only save path
  window.Chart = function(ctx, cfg){ this.destroy = ()=>{}; this._cfg = cfg; };
  window.scrollTo = () => {};
  const nodeCrypto = require('crypto');
  if (!window.crypto || !window.crypto.subtle) {
    Object.defineProperty(window, 'crypto', { value: nodeCrypto.webcrypto, configurable: true });
  }
  // localStorage/sessionStorage are provided by jsdom automatically

  window.addEventListener('error', (e) => {
    console.error('WINDOW ERROR:', e.error ? e.error.stack : e.message);
  });

  // wait for DOMContentLoaded-driven init() to run
  await new Promise(r => setTimeout(r, 300));

  const doc = window.document;
  const assert = (cond, msg) => { if(!cond){ console.error('FAIL:', msg); process.exitCode = 1; } else { console.log('ok  :', msg); } };

  // basic render checks
  assert(doc.getElementById('topnav').children.length === 3, 'topnav has 3 tabs');
  assert(doc.querySelectorAll('.tab.year').length >= 1, 'year tabs rendered');
  assert(window.STATE && window.STATE.years['2026'], 'seed state loaded for 2026');
  assert(Object.keys(window.STATE.years['2026'].months).length === 8, '8 months seeded (Jan-Aug)');

  // check grand total computation for Jan 2026 matches spreadsheet-derived value
  const mo = window.getMonth('2026','01');
  const grand = window.grandMonthlyTotal(mo);
  console.log('Jan 2026 grand monthly total =', grand.toFixed(2));
  // Computed live from weekly amounts (Tithe 1300 + Housing 4000 + Utilities 194 + CreditCards 9350.53 + Cars 1577.47).
  // Note: the source workbook's own cached "Tithe" total cell (1000) was stale vs its own weekly cells (350+300+350+300=1300) -
  // this app always derives totals live from weekly amounts rather than trusting a stored total, which is the correct behavior.
  assert(Math.abs(grand - 16422.00) < 0.01, 'Jan grand total matches live-computed 16422.00');

  // primary / vacation account detection
  const primary = window.getPrimaryAccount(mo);
  const vac = window.getVacationAccount(mo);
  assert(primary && primary.name === 'AFCU Checking', 'primary account is AFCU Checking');
  assert(vac && vac.name === 'B of A Checking', 'vacation account is B of A Checking');

  // running balance check: week[1] (Jan 9) has no PRIOR recorded balance (week[0]'s AFCU balance is null in the
  // source data), so the check should correctly abstain (null) rather than guess.
  const weeks = mo.weeks;
  const chkNoPrior = window.runningCheck('2026','01', weeks[1].id);
  assert(chkNoPrior === null, 'runningCheck abstains when the prior week has no recorded balance');
  // week[2] (Jan 16) has a real prior balance (week[1]) and a real actual balance -> should produce a status
  const chk = window.runningCheck('2026','01', weeks[2].id);
  console.log('check week3 (Jan16)', chk);
  assert(chk && chk.status, 'runningCheck returns a status once prior + actual balances exist');

  // vacation totals
  const vt = window.vacationMonthlyTotal(mo);
  console.log('Jan vacation monthly total =', vt);

  // Friday generation sanity: April 2026 should have Fridays only, none in 2024
  const fridays = window.generateFridays('2026','04');
  console.log('April 2026 Fridays:', fridays);
  fridays.forEach(d => assert(d.startsWith('2026-04'), 'April friday date in 2026: '+d));

  // password flow
  await window.sha256Hex('test').then(h => console.log('sha256 sample ok, len', h.length));

  // simulate unlocking without a password set (should open a modal)
  window.requestEdit();
  let modal = doc.getElementById('modalhost').innerHTML;
  assert(modal.includes('Set an editing password'), 'first-time edit opens set-password modal');

  // fill in password fields and confirm
  doc.getElementById('pw1').value = 'sunshine';
  doc.getElementById('pw2').value = 'sunshine';
  await doc.getElementById('modalconfirm').onclick();
  assert(window.UI.unlocked === true, 'editing unlocks after setting password');
  assert(!!window.STATE.auth.passwordHash, 'password hash stored (not plaintext)');
  assert(window.STATE.auth.passwordHash !== 'sunshine', 'raw password never stored');

  // lock again, then unlock with correct password
  window.lockEditing();
  assert(window.UI.unlocked === false, 'lockEditing relocks');
  window.requestEdit();
  modal = doc.getElementById('modalhost').innerHTML;
  assert(modal.includes('Enter the shared password'), 'second unlock asks for existing password');
  doc.getElementById('pw1').value = 'wrong-password';
  const badResult = await window.STATE.auth; // noop just to keep flow linear
  await doc.getElementById('modalconfirm').onclick();
  assert(window.UI.unlocked === false, 'wrong password does not unlock');
  doc.getElementById('pw1').value = 'sunshine';
  await doc.getElementById('modalconfirm').onclick();
  assert(window.UI.unlocked === true, 'correct password unlocks');

  // re-render so inputs are enabled, then simulate typing a weekly bill amount and check live column patch
  window.selectYear('2026');
  window.selectMonth('01');
  const mo2 = window.getMonth('2026','01');
  const someItemId = mo2.groups[0].items[0].id;
  const weekId = mo2.weeks[2].id;
  const inputId = 'm-item-' + someItemId + '-' + weekId;
  let moneyInput = doc.getElementById(inputId);
  assert(!!moneyInput && !moneyInput.disabled, 'money input exists and is enabled while unlocked');
  const totalCellBefore = doc.getElementById('itot-' + someItemId).textContent;
  moneyInput.value = '77';
  moneyInput.dispatchEvent(new window.Event('input', {bubbles:true}));
  const totalCellAfter = doc.getElementById('itot-' + someItemId).textContent;
  assert(totalCellBefore !== totalCellAfter, 'item monthly total live-patches on input without full rerender');
  assert(doc.getElementById(inputId) === moneyInput, 'input DOM node identity preserved after patch (no focus loss)');
  moneyInput.dispatchEvent(new window.Event('blur', {bubbles:true}));
  assert(moneyInput.value === '77.00', 'blur formats whole number to two decimals');

  // keyboard nav: ArrowDown moves focus to the next row in the same week column
  const navWrap = moneyInput.closest('[data-nav]');
  const colInputs = Array.from(navWrap.querySelectorAll('input.money[data-week="'+weekId+'"]'));
  if (colInputs.length > 1) {
    moneyInput.focus();
    const evt = new window.KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true, cancelable:true});
    moneyInput.dispatchEvent(evt);
    assert(doc.activeElement === colInputs[1], 'ArrowDown moves focus down within the same week column');
  } else {
    console.log('(skipped ArrowDown test — only one row in this column)');
  }

  // A fresh render (e.g. what happens on every page load/reload, including
  // the auto-reload after a save) must show the same two-decimal formatting
  // directly from STATE, not just right after a blur event in this session.
  window.renderAll();
  const reRenderedInput = doc.getElementById(inputId);
  assert(reRenderedInput.value === '77.00', 'a freshly-rendered cell shows two decimals for a whole-number balance, not just after blur');

  // add month / add year flows
  const beforeMonths = Object.keys(window.STATE.years['2026'].months).length;
  window.onAddMonth('2026');
  doc.getElementById('addmonthsel').value = '09';
  await doc.getElementById('modalconfirm').onclick();
  assert(Object.keys(window.STATE.years['2026'].months).length === beforeMonths + 1, 'onAddMonth adds a new month');
  assert(window.STATE.years['2026'].months['09'].weeks.length > 0, 'new month has Friday weeks pre-filled');
  assert(window.STATE.years['2026'].months['09'].groups.length === window.STATE.years['2026'].months['08'].groups.length, 'new month copies groups forward from most recent month');

  window.onAddYear();
  doc.getElementById('addyearinput').value = '2027';
  await doc.getElementById('modalconfirm').onclick();
  assert(!!window.STATE.years['2027'], 'onAddYear creates a new year');

  // destructive action requires confirmation modal (not native confirm)
  window.selectYear('2026'); window.selectMonth('01');
  const grpId = window.getMonth('2026','01').groups[0].id;
  window.onDeleteGroup(grpId);
  const delModal = doc.getElementById('modalhost').innerHTML;
  assert(delModal.includes('Delete group'), 'delete group opens custom confirmation modal, not native confirm()');
  window.closeModal();

  // reference tab + trends tab render without throwing
  window.setTab('reference');
  assert(doc.getElementById('main').innerHTML.includes('Bills Reference'), 'reference tab renders');
  window.setTab('trends');
  assert(doc.getElementById('main').innerHTML.includes('Utilities'), 'trends tab renders');
  window.setTab('tracker');

  console.log('\nALL GOOD — DONE');
  process.exit(process.exitCode || 0);
})().catch(e => { console.error('TEST CRASHED', e); process.exit(1); });
