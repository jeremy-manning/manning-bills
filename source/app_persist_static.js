
/* ===== PERSISTENCE (Supabase-backed static build) =====
 * This is the self-hosted variant of the persistence layer: instead of
 * publishing the whole page to Claude's Artifact platform on every save
 * (see the Claude-hosted build's app_persist.js), the shared state is a
 * single JSON row in a Supabase table, read on load and upserted on save.
 * A Supabase Realtime subscription pushes the other person's saves into
 * this page live, without a full reload, which is what keeps "both of you
 * see each other's edits" working the same way it did on the Claude
 * artifact.
 *
 * Everything below is written to expose the exact same functions/globals
 * that app_render.js and app_events.js already call (scheduleSave,
 * doSave, requestEdit, changePassword, openModal, toast, etc.) — those two
 * files, and app_core.js, are IDENTICAL to the Claude-hosted build. Only
 * this file (the transport) is different.
 */
const LS_KEY = 'manning-bills-mirror-v1';
const SS_PENDING_KEY = 'manning-bills-pending-edit';

var sb = null;                 // the Supabase client, or null if not configured/reachable
var lastWrittenSeq = 0;        // savedSeq of our own most recent successful write, so the
                                // realtime handler can ignore the echo of our own save

function supabaseConfigured(){
  return typeof SUPABASE_URL === 'string' && typeof SUPABASE_ANON_KEY === 'string'
    && SUPABASE_URL && SUPABASE_ANON_KEY
    && SUPABASE_URL.indexOf('YOUR_') === -1 && SUPABASE_ANON_KEY.indexOf('YOUR_') === -1;
}

async function initCapabilities(){
  // No Claude-artifact runtime capabilities exist in this build.
  // downloadsCap stays null on purpose — exportBackup() in app_events.js
  // already falls back to a plain Blob + <a download>, which works fine in
  // a real, non-sandboxed browser.
  if(!supabaseConfigured()){
    console.warn('[Manning Bills] Supabase is not configured yet — edit supabase-config.js with your project URL and anon key.');
    sb = null;
    return;
  }
  try{
    sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }catch(e){
    console.error('[Manning Bills] failed to create the Supabase client', e);
    sb = null;
  }
}

async function loadInitialState(){
  if(sb){
    try{
      const {data, error} = await sb.from(SUPABASE_TABLE).select('data').eq('id', SUPABASE_ROW_ID).maybeSingle();
      if(error) throw error;
      if(data && data.data && data.data.years){
        STATE = data.data;
        VIEW_VERSION_TOKEN = (STATE.savedAt||'') + ':' + (STATE.savedSeq||0);
        lastWrittenSeq = STATE.savedSeq || 0;
        mirrorToLocal();
        setupRealtime();
        return;
      }
      // Table reachable but the row doesn't exist yet — fall through to
      // seed from whatever's available and push it up as the first row.
    }catch(e){
      console.error('[Manning Bills] loading from Supabase failed', e);
      toast('Could not reach the shared database — showing your last local copy for now.');
    }
  }
  // Fallback chain, same shape as the Claude-hosted build: local mirror,
  // then the bundled seed data.
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(raw){
      const json = JSON.parse(raw);
      if(json && json.years){
        STATE = json;
        VIEW_VERSION_TOKEN = (json.savedAt||'') + ':' + (json.savedSeq||0);
        if(sb) scheduleSave(true);
        else toast('Loaded your last local backup.');
        return;
      }
    }
  }catch(e){}
  STATE = seedState();
  VIEW_VERSION_TOKEN = STATE.savedAt + ':' + STATE.savedSeq;
  if(sb) scheduleSave(true);
}

function setupRealtime(){
  if(!sb || typeof sb.channel !== 'function') return;
  try{
    sb.channel('bills_state_changes')
      .on('postgres_changes',
        {event:'*', schema:'public', table:SUPABASE_TABLE, filter:'id=eq.'+SUPABASE_ROW_ID},
        (payload)=>{
          const incoming = payload.new && payload.new.data;
          if(!incoming || !incoming.years) return;
          if(incoming.savedSeq === lastWrittenSeq) return; // our own echoed write
          if(UI.dirty || saveInFlight) return;              // don't clobber an in-progress edit
          if((incoming.savedSeq||0) <= (STATE.savedSeq||0)) return; // not actually newer
          STATE = incoming;
          VIEW_VERSION_TOKEN = (STATE.savedAt||'') + ':' + (STATE.savedSeq||0);
          UI.lastSavedAt = STATE.savedAt;
          lastWrittenSeq = STATE.savedSeq || 0;
          mirrorToLocal();
          renderAll();
          toast("Updated with your partner's latest changes.");
        })
      .subscribe((status)=>{
        if(status === 'CHANNEL_ERROR' || status === 'TIMED_OUT'){
          console.warn('[Manning Bills] realtime subscription problem:', status);
        }
      });
  }catch(e){
    console.error('[Manning Bills] could not set up realtime updates', e);
  }
}

function mirrorToLocal(){
  try{ localStorage.setItem(LS_KEY, JSON.stringify(STATE)); }catch(e){}
}

function rotateBackup(prevState){
  if(!prevState) return;
  delete prevState.backups;
  const snap = {savedAt: prevState.savedAt, snapshot: prevState};
  STATE.backups = STATE.backups || [];
  STATE.backups.push(snap);
  if(STATE.backups.length>5) STATE.backups = STATE.backups.slice(-5);
}

var editSeq = 0;
var saveInFlight = false;
var resaveNeeded = false;
const SAVE_DEBOUNCE_MS = 3000;
function scheduleSave(immediate){
  editSeq++;
  UI.dirty = true;
  renderSaveIndicator();
  if(saveTimer) clearTimeout(saveTimer);
  if(immediate){ doSave(); return; }
  saveTimer = setTimeout(doSave, SAVE_DEBOUNCE_MS);
}
function flushPendingSave(){
  if(!UI.dirty) return;
  if(saveTimer) clearTimeout(saveTimer);
  doSave();
}

async function doSave(){
  if(!STATE) return;
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
    if(savedOk && editSeq===mySeq){
      UI.dirty = false;
      UI.lastSavedAt = STATE.savedAt;
    }
    renderSaveIndicator();
    const needsFollowup = savedOk && (resaveNeeded || editSeq!==mySeq);
    resaveNeeded = false;
    if(needsFollowup){
      if(saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(doSave, 400);
    }
  };

  if(!sb){
    // No shared database configured/reachable — local mirror only, same as
    // the Claude-hosted build's "no capability" fallback.
    finish(true);
    return;
  }
  try{
    stashPendingEdit();
    lastWrittenSeq = STATE.savedSeq;
    const {error} = await sb.from(SUPABASE_TABLE).upsert({
      id: SUPABASE_ROW_ID, data: STATE, updated_at: new Date().toISOString()
    });
    if(error) throw error;
    VIEW_VERSION_TOKEN = STATE.savedAt + ':' + STATE.savedSeq;
    finish(true);
  }catch(err){
    handleSaveError(err);
    finish(false);
  }
}

function handleSaveError(err){
  console.error('[Manning Bills] shared save failed', err);
  const msg = (err && err.message) || 'unknown error';
  toast('Could not sync to the shared database just now — will retry, and your changes are kept in this browser. ('+msg+')');
  if(saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 8000);
}

function renderSaveIndicator(){
  const el = document.getElementById('saveindicator');
  if(!el) return;
  if(UI.saving){ el.textContent = 'Saving…'; el.className='savestate saving'; }
  else if(UI.dirty){ el.textContent = 'Unsaved changes'; el.className='savestate dirty'; }
  else if(UI.lastSavedAt){ el.textContent = 'Saved'; el.className='savestate ok'; }
  else { el.textContent=''; }
}

/* ===== AUTH (identical to the Claude-hosted build) ===== */
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

/* ===== MODAL / TOAST (identical to the Claude-hosted build) ===== */
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
