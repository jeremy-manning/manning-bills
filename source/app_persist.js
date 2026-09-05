
/* ===== PERSISTENCE =====
 * This artifact's host does not support the files-form of publish (saving
 * just a small data file separately from the page) for this artifact — a
 * platform-side limitation, confirmed via a persistent capability_disabled
 * rejection. So instead the whole page republishes ITSELF on every save.
 *
 * To avoid re-embedding the whole ~100KB+ codebase as a duplicate string on
 * every save (which used to roughly double the page size and tripped the
 * platform's publish size limit — "too_large"), buildPublishHtml() instead:
 *   1) reads the running <script id="appscript"> element's own .textContent
 *      live — that's the exact source it was served with, already sitting
 *      there as executing code, so it costs nothing to read back out;
 *   2) swaps out just the SAVED_STATE_EMBEDDED statement within that text,
 *      found via unique comment markers, for one holding the current STATE;
 *   3) wraps the result in HEAD_SHELL_PRE/POST — two small static strings
 *      baked in at build time (see build.py) — to form a complete document.
 * A successful whole-document publish reloads every open view, including
 * this one, to the new version — so saving here is not silent; the page
 * briefly reloads a couple seconds after you stop editing to confirm it.
 */
const LS_KEY = 'manning-bills-mirror-v1';
const SS_PENDING_KEY = 'manning-bills-pending-edit';
const STATE_MARK_START = '/*@@STATE_START@@*/';
const STATE_MARK_END = '/*@@STATE_END@@*/';
const STATE_MARK_RE = /\/\*@@STATE_START@@\*\/[\s\S]*?\/\*@@STATE_END@@\*\//;

function escSlashesForInlineScript(s){
  // Mirrors build.py's esc_slashes: breaks up any literal script-closing
  // byte sequence (which could appear inside arbitrary user-entered text in
  // STATE) that would otherwise end our <script> block early once this
  // JSON gets embedded back into the page. \/ parses identically to / in
  // both JSON and JS string literals, so this is a no-op for the value.
  return s.replace(/\//g, '\\/');
}
function buildPublishHtml(){
  const liveScript = document.getElementById('appscript').textContent;
  if(!STATE_MARK_RE.test(liveScript)){
    throw new Error('state markers not found in the running script — refusing to publish an unsafe document');
  }
  const stateJson = escSlashesForInlineScript(JSON.stringify(STATE));
  const newStateStmt = STATE_MARK_START + 'var SAVED_STATE_EMBEDDED = ' + stateJson + ';' + STATE_MARK_END;
  const newScript = liveScript.replace(STATE_MARK_RE, newStateStmt);
  return HEAD_SHELL_PRE + newScript + HEAD_SHELL_POST;
}

async function initCapabilities(){
  try{
    if(window.claude && typeof window.claude.use === 'function'){
      artifactCap = await window.claude.use('artifact');
      console.log('[Manning Bills] artifact capability resolved:', artifactCap ? 'available' : 'null (unavailable)');
    } else {
      console.warn('[Manning Bills] window.claude.use is not a function — no capability runtime detected');
    }
  }catch(e){ artifactCap = null; console.error('[Manning Bills] claude.use("artifact") threw', e); }
  try{
    if(window.claude && typeof window.claude.use === 'function'){
      downloadsCap = await window.claude.use('downloads');
    }
  }catch(e){ downloadsCap = null; }
}

async function loadInitialState(){
  // 1) the live state is embedded directly in the page we were served —
  // no fetch needed, and it's always exactly what was last published.
  try{
    if(typeof SAVED_STATE_EMBEDDED !== 'undefined' && SAVED_STATE_EMBEDDED && SAVED_STATE_EMBEDDED.years){
      STATE = SAVED_STATE_EMBEDDED;
      VIEW_VERSION_TOKEN = (STATE.savedAt||'') + ':' + (STATE.savedSeq||0);
      mirrorToLocal();
      return;
    }
  }catch(e){ console.error('[Manning Bills] reading embedded saved state failed', e); }
  // 2) try localStorage mirror (e.g. a never-published-yet artifact opened
  // again in the same browser before its first save went through)
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(raw){
      const json = JSON.parse(raw);
      if(json && json.years){
        STATE = json;
        VIEW_VERSION_TOKEN = (json.savedAt||'') + ':' + (json.savedSeq||0);
        toast('Loaded your last local backup.');
        return;
      }
    }
  }catch(e){}
  // 3) seed from the imported spreadsheet
  STATE = seedState();
  VIEW_VERSION_TOKEN = STATE.savedAt + ':' + STATE.savedSeq;
}

function mirrorToLocal(){
  try{ localStorage.setItem(LS_KEY, JSON.stringify(STATE)); }catch(e){}
}

function rotateBackup(prevState){
  if(!prevState) return;
  // Strip any backups the snapshot itself was carrying before storing it —
  // otherwise each new snapshot embeds every earlier one nested inside it,
  // and repeated saves make this array's total size grow exponentially
  // (this was a major contributor to the "too_large" publish failures).
  // Snapshots are only taken around genuinely destructive actions (delete
  // month/year, import), not on every routine edit-save.
  delete prevState.backups;
  const snap = {savedAt: prevState.savedAt, snapshot: prevState};
  STATE.backups = STATE.backups || [];
  STATE.backups.push(snap);
  if(STATE.backups.length>5) STATE.backups = STATE.backups.slice(-5);
}

var editSeq = 0;        // bumped on every edit that needs saving
var saveInFlight = false;
var resaveNeeded = false;
// How long to wait, after the MOST RECENT keystroke or field change anywhere
// on the page, before saving. Every call to scheduleSave() — including the
// one onMoneyInput makes on each keystroke — resets this timer, so a save
// (and the reload that comes with it) only happens once you actually stop
// typing everywhere, not just in the field you last left. That matters
// because a save force-commits whatever's in the currently focused field
// (see stashPendingEdit in app_events.js) — if the timer fired while you'd
// already moved on to typing a new value, it would grab that value
// mid-keystroke and save an unfinished number.
const SAVE_DEBOUNCE_MS = 3000;
function scheduleSave(immediate){
  editSeq++;
  UI.dirty = true;
  renderSaveIndicator();
  if(saveTimer) clearTimeout(saveTimer);
  if(immediate){ doSave(); return; }
  saveTimer = setTimeout(doSave, SAVE_DEBOUNCE_MS);
}
// Force a save right now, bypassing the debounce — used when the page is
// about to go away (refresh, close, tab hidden) so an edit that hasn't hit
// its 2.2s debounce yet doesn't get silently dropped.
function flushPendingSave(){
  if(!UI.dirty) return;
  if(saveTimer) clearTimeout(saveTimer);
  doSave();
}

async function doSave(){
  if(!STATE) return;
  // Never run two publishes at once: if one is already in flight, remember
  // to save again once it settles instead of racing it (a race here is
  // exactly how an edit made mid-save could get marked "Saved" without
  // ever having been included in the published payload).
  if(saveInFlight){ resaveNeeded = true; return; }
  saveInFlight = true;
  const mySeq = editSeq;
  STATE.savedAt = new Date().toISOString();
  STATE.savedSeq = (STATE.savedSeq||0) + 1;
  mirrorToLocal();
  UI.saving = true; renderSaveIndicator();

  const finish = (savedOk)=>{
    saveInFlight = false;
    UI.saving = false;
    // Only clear "dirty" if nothing else was edited while this save was in
    // flight — the payload we just sent was captured before that edit, so
    // it isn't actually persisted yet, and the indicator must not claim it is.
    if(savedOk && editSeq===mySeq){
      UI.dirty = false;
      UI.lastSavedAt = STATE.savedAt;
    }
    renderSaveIndicator();
    // Only auto-follow-up on a SUCCESSFUL save that still left something
    // unsaved (a newer edit landed mid-flight). On failure, leave retry
    // timing entirely to handleSaveError — some failures (conflict,
    // not_writer) must never auto-retry.
    const needsFollowup = savedOk && (resaveNeeded || editSeq!==mySeq);
    resaveNeeded = false;
    if(needsFollowup){
      if(saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(doSave, 400);
    }
  };

  if(!artifactCap){
    // no shared capability available — local mirror only
    finish(true);
    return;
  }
  try{
    // A successful publish reloads this view, so stash whatever's still
    // being actively typed (not yet blurred) before that happens.
    stashPendingEdit();
    const html = buildPublishHtml();
    await artifactCap.publish(html);
    VIEW_VERSION_TOKEN = STATE.savedAt + ':' + STATE.savedSeq;
    finish(true);
    // NOTE: the platform reloads this view on success, so code after this
    // point may not get a chance to run — that's expected.
  }catch(err){
    handleSaveError(err);
    finish(false);
  }
}

function handleSaveError(err){
  const code = err && err.code;
  console.error('[Manning Bills] shared save failed', {code, message: err && err.message, err});
  if(code === 'conflict'){
    // Whole-document publish: on conflict the platform is already reloading
    // every open view (including this one) to whichever version won — there
    // is nothing for us to do beyond letting the user know why the page is
    // about to jump.
    toast('Someone else saved changes just now — reloading to the latest version.');
  } else if(code === 'not_writer' || code === 'not_granted'){
    UI.unlocked = false;
    toast('This view is read-only right now. (code: '+code+')');
  } else if(code === 'rate_limited'){
    toast('Saving too often — slowing down.');
    saveTimer = setTimeout(doSave, 6000);
  } else if(code === 'not_declared' || code === 'capability_disabled' || code === 'capability_removed'){
    artifactCap = null;
    toast('Shared sync is unavailable here — saving to this browser only. (code: '+code+')');
  } else {
    toast('Could not sync just now — will retry, and your changes are kept in this browser. (code: '+(code||'unknown')+')');
    saveTimer = setTimeout(doSave, 8000);
  }
}

function renderSaveIndicator(){
  const el = document.getElementById('saveindicator');
  if(!el) return;
  if(UI.saving){ el.textContent = 'Saving…'; el.className='savestate saving'; }
  else if(UI.dirty){ el.textContent = 'Unsaved changes'; el.className='savestate dirty'; }
  else if(UI.lastSavedAt){ el.textContent = 'Saved'; el.className='savestate ok'; }
  else { el.textContent=''; }
}

/* ===== AUTH ===== */
async function sha256Hex(text){
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function randomSalt(){
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function isLocallyUnlocked(){
  try{ return sessionStorage.getItem('manning-bills-unlocked')==='1'; }catch(e){ return false; }
}
function setLocallyUnlocked(v){
  try{ if(v) sessionStorage.setItem('manning-bills-unlocked','1'); else sessionStorage.removeItem('manning-bills-unlocked'); }catch(e){}
}

function requestEdit(){
  if(UI.unlocked){ return; }
  if(!STATE.auth.passwordHash){
    openModal({
      title:'Set an editing password',
      body:'<p>No password is set yet. Choose one now — you and your partner will both use it to make edits. Viewing never requires a password.</p>'
        +'<div class="field"><label for="pw1">New password</label><input type="password" id="pw1" autocomplete="new-password"></div>'
        +'<div class="field" style="margin-top:10px;"><label for="pw2">Confirm password</label><input type="password" id="pw2" autocomplete="new-password"></div>',
      confirmLabel:'Set password & unlock',
      onConfirm: async ()=>{
        const p1 = document.getElementById('pw1').value;
        const p2 = document.getElementById('pw2').value;
        if(!p1 || p1.length<4){ toast('Use at least 4 characters.'); return false; }
        if(p1!==p2){ toast('Passwords do not match.'); return false; }
        const salt = randomSalt();
        const hash = await sha256Hex(salt+':'+p1);
        STATE.auth = {passwordHash:hash, salt};
        UI.unlocked = true; setLocallyUnlocked(true);
        scheduleSave(true);
        renderAll();
        toast('Password set. Editing unlocked.');
        return true;
      }
    });
  } else {
    openModal({
      title:'Enter the shared password',
      body:'<div class="field"><label for="pw1">Password</label><input type="password" id="pw1" autocomplete="current-password"></div>',
      confirmLabel:'Unlock',
      onConfirm: async ()=>{
        const p1 = document.getElementById('pw1').value;
        const hash = await sha256Hex(STATE.auth.salt+':'+p1);
        if(hash !== STATE.auth.passwordHash){ toast('Incorrect password.'); return false; }
        UI.unlocked = true; setLocallyUnlocked(true);
        renderAll();
        toast('Editing unlocked.');
        return true;
      }
    });
  }
}
function lockEditing(){
  UI.unlocked = false; setLocallyUnlocked(false);
  renderAll();
}
function requireUnlock(){
  if(!UI.unlocked){ requestEdit(); return false; }
  return true;
}
function changePassword(){
  if(!requireUnlock()) return;
  openModal({
    title:'Change editing password',
    body:'<p>Enter the current password, then choose a new one. You and your partner will both need the new password to edit afterward.</p>'
      +'<div class="field"><label for="pwcur">Current password</label><input type="password" id="pwcur" autocomplete="current-password"></div>'
      +'<div class="field" style="margin-top:10px;"><label for="pw1">New password</label><input type="password" id="pw1" autocomplete="new-password"></div>'
      +'<div class="field" style="margin-top:10px;"><label for="pw2">Confirm new password</label><input type="password" id="pw2" autocomplete="new-password"></div>',
    confirmLabel:'Change password',
    onConfirm: async ()=>{
      const cur = document.getElementById('pwcur').value;
      const p1 = document.getElementById('pw1').value;
      const p2 = document.getElementById('pw2').value;
      const curHash = await sha256Hex(STATE.auth.salt+':'+cur);
      if(curHash !== STATE.auth.passwordHash){ toast('Current password is incorrect.'); return false; }
      if(!p1 || p1.length<4){ toast('Use at least 4 characters.'); return false; }
      if(p1!==p2){ toast('New passwords do not match.'); return false; }
      const salt = randomSalt();
      const hash = await sha256Hex(salt+':'+p1);
      STATE.auth = {passwordHash:hash, salt};
      scheduleSave(true);
      toast('Password changed.');
      return true;
    }
  });
}

/* ===== MODAL / TOAST ===== */
function openModal({title, body, confirmLabel, cancelLabel, onConfirm, danger}){
  const host = document.getElementById('modalhost');
  host.innerHTML = `<div class="modal-backdrop" id="modalbackdrop">
    <div class="modal" role="dialog" aria-modal="true">
      <h3>${esc(title)}</h3>
      <div>${body}</div>
      <div class="actions">
        <button class="btn" id="modalcancel">${esc(cancelLabel||'Cancel')}</button>
        <button class="btn ${danger?'danger':'primary'}" id="modalconfirm">${esc(confirmLabel||'Confirm')}</button>
      </div>
    </div>
  </div>`;
  const close = ()=>{ host.innerHTML=''; };
  document.getElementById('modalcancel').onclick = close;
  document.getElementById('modalbackdrop').addEventListener('mousedown', (e)=>{ if(e.target.id==='modalbackdrop') close(); });
  document.getElementById('modalconfirm').onclick = async ()=>{
    const ok = await onConfirm();
    if(ok!==false) close();
  };
  const firstInput = host.querySelector('input');
  if(firstInput) setTimeout(()=>firstInput.focus(), 30);
}
function confirmDanger(title, message, onConfirm){
  openModal({title, body:`<p>${esc(message)}</p>`, confirmLabel:'Delete', danger:true, onConfirm: ()=>{ onConfirm(); return true; }});
}
function closeModal(){ document.getElementById('modalhost').innerHTML=''; }

let toastTimer=null;
function toast(msg){
  const stack = document.getElementById('toaststack');
  const el = document.createElement('div');
  el.className='toast'; el.textContent = msg;
  stack.appendChild(el);
  requestAnimationFrame(()=> el.classList.add('show'));
  setTimeout(()=>{ el.classList.remove('show'); setTimeout(()=> el.remove(), 300); }, 3200);
}
