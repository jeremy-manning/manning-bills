// Regression/feature test for changePassword(): lets an already-unlocked
// editor change the shared editing password without needing to touch the
// STATE.auth object directly. Covers: the UI entry point only appears while
// unlocked, the current password must be verified before a change is
// accepted, the new password must be confirmed and meet the minimum length,
// a successful change actually rotates BOTH the salt and the hash (not just
// the hash — reusing the old salt with a new password would be a real
// crypto mistake), the change gets scheduled for save, and — the real
// end-to-end proof — the OLD password stops working and the NEW one unlocks
// afterward.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');

(async () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'https://example.test/artifact/', pretendToBeVisual: true });
  const { window } = dom;
  window.fetch = () => Promise.reject(new Error('no net'));
  window.claude = undefined; // local-only save path, no publish plumbing needed for this test
  const nodeCrypto = require('crypto');
  Object.defineProperty(window, 'crypto', { value: nodeCrypto.webcrypto, configurable: true });
  window.scrollTo = () => {};
  await new Promise(r => setTimeout(r, 350));

  const doc = window.document;
  const assert = (c,m) => { if(!c){ console.error('FAIL:',m); process.exitCode=1; } else console.log('ok  :', m); };

  // --- Set up an initial password the normal way (requestEdit's
  // no-password-yet branch), so this test exercises the real hashing code
  // path rather than poking STATE.auth by hand.
  window.requestEdit();
  await new Promise(r => setTimeout(r, 30));
  doc.getElementById('pw1').value = 'oldpass1';
  doc.getElementById('pw2').value = 'oldpass1';
  doc.getElementById('modalconfirm').click();
  await new Promise(r => setTimeout(r, 30));
  assert(window.UI.unlocked === true, 'initial password set and unlocked');
  const originalSalt = window.STATE.auth.salt;
  const originalHash = window.STATE.auth.passwordHash;

  // --- The "Change password" control only appears in the lockbar while
  // unlocked.
  assert(doc.getElementById('lockbar').innerHTML.includes('Change password'), 'Change password control is present while unlocked');
  window.lockEditing();
  assert(!doc.getElementById('lockbar').innerHTML.includes('Change password'), 'Change password control is hidden while locked');
  // re-unlock for the rest of the test (session already knows the password
  // locally, so this just flips UI.unlocked back on the same as tapping the
  // locked pill and re-entering it would)
  window.UI.unlocked = true; window.renderAll();

  // --- Wrong current password is rejected, and the stored hash/salt are
  // untouched.
  window.changePassword();
  await new Promise(r => setTimeout(r, 30));
  doc.getElementById('pwcur').value = 'totallywrong';
  doc.getElementById('pw1').value = 'newpass1';
  doc.getElementById('pw2').value = 'newpass1';
  doc.getElementById('modalconfirm').click();
  await new Promise(r => setTimeout(r, 30));
  assert(!!doc.getElementById('modalbackdrop'), 'modal stays open when the current password is wrong');
  assert(window.STATE.auth.passwordHash === originalHash, 'a wrong current password does not change the stored hash');
  assert(doc.getElementById('toaststack').textContent.includes('Current password is incorrect'), 'a clear error toast names the problem');
  window.closeModal();

  // --- Mismatched new-password confirmation is rejected.
  window.changePassword();
  await new Promise(r => setTimeout(r, 30));
  doc.getElementById('pwcur').value = 'oldpass1';
  doc.getElementById('pw1').value = 'newpass1';
  doc.getElementById('pw2').value = 'somethingelse';
  doc.getElementById('modalconfirm').click();
  await new Promise(r => setTimeout(r, 30));
  assert(!!doc.getElementById('modalbackdrop'), 'modal stays open when new password confirmation does not match');
  assert(window.STATE.auth.passwordHash === originalHash, 'a mismatched confirmation does not change the stored hash');
  window.closeModal();

  // --- Too-short new password is rejected (same >=4 char rule as initial
  // password setup).
  window.changePassword();
  await new Promise(r => setTimeout(r, 30));
  doc.getElementById('pwcur').value = 'oldpass1';
  doc.getElementById('pw1').value = 'abc';
  doc.getElementById('pw2').value = 'abc';
  doc.getElementById('modalconfirm').click();
  await new Promise(r => setTimeout(r, 30));
  assert(!!doc.getElementById('modalbackdrop'), 'modal stays open when the new password is too short');
  window.closeModal();

  // --- A correct, valid change succeeds: hash AND salt both rotate (a new
  // random salt, not the old one reused), the modal closes, the change is
  // actually persisted (scheduleSave(true) forces an immediate save — with
  // no shared capability configured in this test, that save completes
  // synchronously to the local mirror, which is why savedSeq is checked
  // rather than the transient "dirty" flag, which flips back to false
  // again within the same tick), and a confirming toast appears.
  const savedSeqBefore = window.STATE.savedSeq || 0;
  window.changePassword();
  await new Promise(r => setTimeout(r, 30));
  doc.getElementById('pwcur').value = 'oldpass1';
  doc.getElementById('pw1').value = 'newpass1';
  doc.getElementById('pw2').value = 'newpass1';
  doc.getElementById('modalconfirm').click();
  await new Promise(r => setTimeout(r, 30));
  assert(!doc.getElementById('modalbackdrop'), 'modal closes on a successful change');
  assert(window.STATE.auth.passwordHash !== originalHash, 'the stored password hash actually changed');
  assert(window.STATE.auth.salt !== originalSalt, 'the salt was also rotated, not reused with the new password');
  assert((window.STATE.savedSeq||0) > savedSeqBefore, 'the change was actually saved (savedSeq advanced), not just held in memory');
  assert(doc.getElementById('toaststack').textContent.includes('Password changed'), 'a confirming toast appears');

  // --- End-to-end proof: lock, then confirm the OLD password no longer
  // works and the NEW one does.
  window.lockEditing();
  assert(window.UI.unlocked === false, 'locked after the password change, as normal');
  window.requestEdit();
  await new Promise(r => setTimeout(r, 30));
  doc.getElementById('pw1').value = 'oldpass1';
  doc.getElementById('modalconfirm').click();
  await new Promise(r => setTimeout(r, 30));
  assert(window.UI.unlocked === false, 'the OLD password no longer unlocks editing');
  assert(doc.getElementById('toaststack').textContent.includes('Incorrect password'), 'trying the old password shows the normal incorrect-password toast');
  window.closeModal();

  window.requestEdit();
  await new Promise(r => setTimeout(r, 30));
  doc.getElementById('pw1').value = 'newpass1';
  doc.getElementById('modalconfirm').click();
  await new Promise(r => setTimeout(r, 30));
  assert(window.UI.unlocked === true, 'the NEW password unlocks editing');

  console.log('\nALL GOOD 10 — DONE');
  process.exit(process.exitCode||0);
})().catch(e=>{ console.error('CRASH', e); process.exit(1); });
