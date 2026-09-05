/* ===== PERSISTENCE (Supabase-backed static build, authenticated) =====
 * Self-hosted variant of the persistence layer. The shared state is a single
 * JSON row in the Supabase `bills` schema, read on load and written on save,
 * with a Realtime subscription pushing the other person's saves into an open
 * page.
 *
 * Differs from the original handoff build in three ways:
 *
 *  1. AUTH IS REAL. The original gated editing behind a SHA-256 hash checked
 *     in the browser, with the hash and salt stored inside the very blob the
 *     anon key could read — so anyone with the URL could read the ledger and
 *     write to it. Access is now Supabase Auth (magic link) plus an RLS
 *     allowlist enforced in Postgres. `anon` has no grant on the schema at
 *     all; nothing loads until a signed-in allowlisted user is present.
 *
 *  2. SCHEMA IS `bills`, NOT `public`. Keeps the household ledger clearly
 *     separate from everything else living in this Supabase project.
 *
 *  3. WRITES ARE VERSION-CHECKED. The update is conditional on the version
 *     the tab loaded, so a stale tab (a phone left open since last week)
 *     reloads instead of silently overwriting newer work.
 *
 * The functions/globals app_render.js and app_events.js call are unchanged
 * (scheduleSave, doSave, requestEdit, requireUnlock, lockEditing, openModal,
 * toast, ...), so those two files and app_core.js are untouched.
 */
const LS_KEY = 'manning-bills-mirror-v1';
const SS_PENDING_KEY = 'manning-bills-pending-edit';

var sb = null;                 // the Supabase client, or null if not configured/reachable
var lastWrittenSeq = 0;        // savedSeq of our own most recent successful write, so the
                               // realtime handler can ignore the echo of our own save
var stateVersion = 0;          // bills.state.version this tab loaded; guards stale writes
var SESSION = null;            // the current Supabase auth session, or null
var IS_MEMBER = false;         // signed in AND on the bills.allowed_emails allowlist

function supabaseConfigured(){
  return typeof SUPABASE_URL === 'string' && typeof SUPABASE_ANON_KEY === 'string'
    && SUPABASE_URL && SUPABASE_ANON_KEY
    && SUPABASE_URL.indexOf('YOUR_') === -1 && SUPABASE_ANON_KEY.indexOf('YOUR_') === -1;
}

async function initCapabilities(){
  // No Claude-artifact runtime capabilities exist in this build. downloadsCap
  // stays null on purpose — exportBackup() in app_events.js already falls back
  // to a plain Blob + <a download>, which works in a real browser.
  if(!supabaseConfigured()){
    console.warn('[Manning Bills] Supabase is not configured yet — edit supabase-config.js with your project URL and key.');
    sb = null;
    return;
  }
  try{
    sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      // The ledger lives in the `bills` schema, not `public`.
      db: {schema: SUPABASE_SCHEMA},
      auth: {
        persistSession: true,       // stay signed in across visits
        autoRefreshToken: true,
        detectSessionInUrl: true    // completes the magic-link redirect
      }
    });
  }catch(e){
    console.error('[Manning Bills] failed to create the Supabase client', e);
    sb = null;
  }
}

/* ===== AUTH =====================================================
 * Magic link (email one-time link). There is no password anywhere in this
 * build: possession of the mailbox is the credential, and Postgres RLS —
 * not any browser-side check — decides what that identity can read.
 * ================================================================ */

async function refreshSession(){
  if(!sb){ SESSION = null; IS_MEMBER = false; return; }
  try{
    const {data} = await sb.auth.getSession();
    SESSION = (data && data.session) || null;
  }catch(e){
    console.error('[Manning Bills] could not read the auth session', e);
    SESSION = null;
  }
  IS_MEMBER = false;
  if(!SESSION) return;
  // Membership is decided server-side. We ask the allowlist for our own row;
  // RLS returns it only to an allowlisted user, so a hit IS the proof.
  try{
    const {data, error} = await sb.from('allowed_emails').select('email').limit(1);
    if(!error && data && data.length) IS_MEMBER = true;
  }catch(e){
    console.error('[Manning Bills] membership check failed', e);
  }
}

function signedInEmail(){
  return (SESSION && SESSION.user && SESSION.user.email) || '';
}

async function sendMagicLink(email){
  if(!sb) throw new Error('The database connection is not configured.');
  const {error} = await sb.auth.signInWithOtp({
    email: email,
    options: {emailRedirectTo: window.location.origin + window.location.pathname}
  });
  if(error) throw error;
}

async function signOut(){
  if(!sb) return;
  try{ await sb.auth.signOut(); }catch(e){}
  try{ localStorage.removeItem(LS_KEY); }catch(e){}   // don't leave the ledger behind
  window.location.reload();
}

/* Full-page gate shown whenever there is no usable signed-in member. */
function renderAuthGate(mode){
  const app = document.getElementById('app') || document.body;
  const who = signedInEmail();
  let inner;
  if(mode === 'not-allowed'){
    // Primary action is RETRY, not sign out. Access is granted by editing the
    // allowlist server-side, which can happen while this page sits open — and
    // signing out throws away a valid session that is about to become useful,
    // forcing another sign-in email against a tight rate limit. Sign out is
    // deliberately the secondary, quieter action.
    inner = `<h1>Not authorised yet</h1>
      <p>You are signed in as <strong>${esc(who)}</strong>, but that address is not on
         the access list for this ledger.</p>
      <p>If someone is adding you right now, stay on this page and press
         <strong>Check again</strong> — you do not need to sign in a second time.</p>
      <button class="btn primary" id="authretrycheck">Check again</button>
      <p class="authnote">Access is managed in Supabase
         (<code>bills.allowed_emails</code>). Wrong account?
         <a href="#" id="authsignout">Sign out</a>.</p>`;
  } else if(mode === 'sent'){
    inner = `<h1>Check your email</h1>
      <p>A sign-in link is on its way. Open it on this device and you will land
         back here, signed in.</p>
      <p class="authnote">Open the most recent link: requesting another one
         invalidates the previous email. If nothing arrives in a few minutes,
         check spam before requesting again — sending is rate limited.</p>
      <button class="btn" id="authretry">Use a different address</button>`;
  } else if(mode === 'unconfigured'){
    inner = `<h1>Not configured yet</h1>
      <p>This page has no database connection. Fill in
         <code>supabase-config.js</code> with the project URL and publishable key.</p>`;
  } else {
    inner = `<h1>Manning household bills</h1>
      <p>Sign in to view the ledger. We will email you a link — no password to remember.</p>
      <form id="authform" autocomplete="on">
        <input type="email" id="authemail" placeholder="you@example.com"
               autocomplete="username" required>
        <button class="btn primary" type="submit">Email me a sign-in link</button>
      </form>
      <p class="authnote">Only addresses on the household access list can open this.</p>`;
  }
  app.innerHTML = `<div class="authgate"><div class="authcard">${inner}</div></div>`;

  const form = document.getElementById('authform');
  if(form){
    form.onsubmit = async (e)=>{
      e.preventDefault();
      const email = document.getElementById('authemail').value.trim();
      if(!email) return;
      const btn = form.querySelector('button');
      btn.disabled = true; btn.textContent = 'Sending…';
      try{
        await sendMagicLink(email);
        renderAuthGate('sent');
      }catch(err){
        console.error(err);
        btn.disabled = false; btn.textContent = 'Email me a sign-in link';
        toast('Could not send the link: ' + ((err && err.message) || 'unknown error'));
      }
    };
  }
  const out = document.getElementById('authsignout');
  if(out) out.onclick = (e)=>{ if(e) e.preventDefault(); signOut(); };

  const recheck = document.getElementById('authretrycheck');
  if(recheck){
    recheck.onclick = async ()=>{
      recheck.disabled = true; recheck.textContent = 'Checking…';
      await refreshSession();
      if(IS_MEMBER){ init(); return; }          // access granted — load the ledger
      recheck.disabled = false; recheck.textContent = 'Check again';
      toast('Still not on the access list.');
    };
  }
  const retry = document.getElementById('authretry');
  if(retry) retry.onclick = ()=> renderAuthGate('signin');
}

async function loadInitialState(){
  if(!sb){
    renderAuthGate('unconfigured');
    return false;
  }
  await refreshSession();
  if(!SESSION){ renderAuthGate('signin'); return false; }
  if(!IS_MEMBER){ renderAuthGate('not-allowed'); return false; }

  try{
    const {data, error} = await sb.from(SUPABASE_TABLE)
      .select('data,version').eq('id', SUPABASE_ROW_ID).maybeSingle();
    if(error) throw error;
    if(data && data.data && data.data.years){
      STATE = data.data;
      stateVersion = data.version || 0;
      VIEW_VERSION_TOKEN = (STATE.savedAt||'') + ':' + (STATE.savedSeq||0);
      lastWrittenSeq = STATE.savedSeq || 0;
      mirrorToLocal();
      setupRealtime();
      return true;
    }
    // Reachable, but no row yet — start from the empty skeleton and create it.
    STATE = seedState();
    stateVersion = 0;
    VIEW_VERSION_TOKEN = STATE.savedAt + ':' + STATE.savedSeq;
    setupRealtime();
    scheduleSave(true);
    return true;
  }catch(e){
    console.error('[Manning Bills] loading from Supabase failed', e);
    toast('Could not reach the shared database — showing your last local copy for now.');
  }

  // Offline fallback: the local mirror from this browser, if there is one.
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(raw){
      const json = JSON.parse(raw);
      if(json && json.years){
        STATE = json;
        VIEW_VERSION_TOKEN = (json.savedAt||'') + ':' + (json.savedSeq||0);
        toast('Loaded your last local backup — not yet synced.');
        return true;
      }
    }
  }catch(e){}
  STATE = seedState();
  VIEW_VERSION_TOKEN = STATE.savedAt + ':' + STATE.savedSeq;
  return true;
}

function setupRealtime(){
  if(!sb || typeof sb.channel !== 'function') return;
  try{
    sb.channel('bills_state_changes')
      .on('postgres_changes',
        {event:'*', schema:SUPABASE_SCHEMA, table:SUPABASE_TABLE, filter:'id=eq.'+SUPABASE_ROW_ID},
        (payload)=>{
          const incoming = payload.new && payload.new.data;
          if(!incoming || !incoming.years) return;
          if(incoming.savedSeq === lastWrittenSeq) return; // our own echoed write
          if(UI.dirty || saveInFlight) return;              // don't clobber an in-progress edit
          if((incoming.savedSeq||0) <= (STATE.savedSeq||0)) return; // not actually newer
          STATE = incoming;
          stateVersion = payload.new.version || stateVersion;
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
var uncommittedInput = false;  // characters typed since the last commit/blur
var saveInFlight = false;
var resaveNeeded = false;
const SAVE_DEBOUNCE_MS = 3000;
function scheduleSave(immediate){
  // Every caller of scheduleSave is a commit point — a blur, an add, a
  // delete — so whatever was being typed has now landed in STATE.
  uncommittedInput = false;
  editSeq++;
  UI.dirty = true;
  renderSaveIndicator();
  if(saveTimer) clearTimeout(saveTimer);
  if(immediate){ doSave(); return; }
  saveTimer = setTimeout(doSave, SAVE_DEBOUNCE_MS);
}
/* Mark the ledger as having unsaved edits WITHOUT scheduling a write.
 *
 * Typing used to call scheduleSave() on every keystroke. The 3-second debounce
 * would then elapse mid-field, so the indicator cycled
 * "Unsaved changes" -> "Saving..." -> "Saved" -> "Unsaved changes" while the
 * cursor never left the box, and each change of that text nudged the toolbar
 * beside it. Keystrokes now only mark state dirty; the actual write is
 * scheduled when the field is left (blur), which is also when the value is
 * committed for text fields anyway.
 *
 * Dirty state still matters on its own: beforeunload and visibilitychange both
 * consult UI.dirty, so a tab closed mid-edit still flushes.
 */
function markDirty(){
  // Deliberately does NOT touch editSeq. That counter means "a save-worthy
  // change was committed"; doSave()'s completion path compares it against the
  // value captured when the save began and re-arms a 400ms follow-up if they
  // differ. Bumping it per keystroke made every character re-arm that
  // follow-up, firing a save about twice a second while typing.
  uncommittedInput = true;
  UI.dirty = true;
  renderSaveIndicator();
}

function flushPendingSave(){
  if(!UI.dirty) return;
  if(saveTimer) clearTimeout(saveTimer);
  doSave(true);   // force: the page is going away, write even mid-edit
}

async function doSave(force){
  if(!STATE) return;
  // Hold off while the cursor is still in a field with unsaved keystrokes.
  // A timer armed by the previous field's blur would otherwise elapse
  // mid-entry and flip the indicator through Saving.../Saved while you type.
  // The blur handler schedules the real save, so nothing is lost; `force` is
  // for the unload and tab-hidden flushes, which must write regardless.
  if(uncommittedInput && !force) return;
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
    if(savedOk && editSeq===mySeq && !uncommittedInput){
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
    // NOTE: stashPendingEdit() is deliberately NOT called here.
    //
    // It commits the focused money cell by calling onMoneyBlur(), which calls
    // scheduleSave() -- so calling it from inside doSave() advanced editSeq
    // past the mySeq captured above. finish() reads that as "more edits
    // arrived during the save" and arms a 400ms follow-up, which saves, which
    // stashes again: an endless save loop for as long as the cursor stays in
    // an amount cell. That was the "indicator fires over and over" report.
    //
    // Nothing is lost by dropping it: onMoneyInput() already writes each
    // keystroke into STATE via setMoneyValue(), so the in-progress value is
    // in the payload regardless. stashPendingEdit() still runs on the paths
    // it was written for -- beforeunload and visibilitychange -- where its
    // sessionStorage snapshot is what actually matters.
    lastWrittenSeq = STATE.savedSeq;
    const nowIso = new Date().toISOString();

    if(stateVersion > 0){
      // Conditional update: only succeeds if nobody has written since this tab
      // loaded. `select()` makes PostgREST return the affected rows, so an
      // empty array means the guard caught a stale write.
      const {data, error} = await sb.from(SUPABASE_TABLE)
        .update({data: STATE, updated_at: nowIso})
        .eq('id', SUPABASE_ROW_ID)
        .eq('version', stateVersion)
        .select('version');
      if(error) throw error;
      if(!data || !data.length){
        await handleStaleWrite();
        finish(false);
        return;
      }
      stateVersion = data[0].version;
    } else {
      const {data, error} = await sb.from(SUPABASE_TABLE)
        .insert({id: SUPABASE_ROW_ID, data: STATE, updated_at: nowIso})
        .select('version');
      if(error) throw error;
      if(data && data.length) stateVersion = data[0].version;
    }

    VIEW_VERSION_TOKEN = STATE.savedAt + ':' + STATE.savedSeq;
    finish(true);
  }catch(err){
    handleSaveError(err);
    finish(false);
  }
}

/* Someone (or some other tab) wrote after this page loaded. Rather than
 * overwrite their work, take the newer row and tell the user plainly. This is
 * the stale-tab case — a phone left open since last week — not a live
 * two-person collision. */
async function handleStaleWrite(){
  console.warn('[Manning Bills] save rejected: this page is out of date');
  try{
    const {data, error} = await sb.from(SUPABASE_TABLE)
      .select('data,version').eq('id', SUPABASE_ROW_ID).maybeSingle();
    if(error) throw error;
    if(data && data.data && data.data.years){
      STATE = data.data;
      stateVersion = data.version || 0;
      lastWrittenSeq = STATE.savedSeq || 0;
      VIEW_VERSION_TOKEN = (STATE.savedAt||'') + ':' + (STATE.savedSeq||0);
      UI.dirty = false;
      UI.lastSavedAt = STATE.savedAt;
      mirrorToLocal();
      renderAll();
      toast('This page was out of date, so your change was not saved. The current ledger is now shown — please redo that edit.');
      return;
    }
  }catch(e){
    console.error('[Manning Bills] could not reload after a stale write', e);
  }
  toast('This page is out of date and could not refresh. Reload before editing.');
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

/* ===== EDIT LOCK =====
 * The old build hashed a shared password in the browser and stored the hash
 * in the synced blob — decorative, since the blob was readable by anyone with
 * the URL. Now the real gate is Supabase Auth + RLS, and reaching this code at
 * all means the server already authorised this user.
 *
 * The lock that remains is a deliberate-action guard, not a security control:
 * it keeps a stray tap on a phone from editing the ledger. That is why it is
 * plain sessionStorage with no secret involved.
 */
function isLocallyUnlocked(){
  try{ return sessionStorage.getItem('manning-bills-unlocked')==='1'; }catch(e){ return false; }
}
function setLocallyUnlocked(v){
  try{ if(v) sessionStorage.setItem('manning-bills-unlocked','1'); else sessionStorage.removeItem('manning-bills-unlocked'); }catch(e){}
}

function requestEdit(){
  if(UI.unlocked) return;
  if(!IS_MEMBER){
    // Should be unreachable: the auth gate runs before the app renders.
    toast('Sign in to edit.');
    return;
  }
  UI.unlocked = true;
  setLocallyUnlocked(true);
  renderAll();
  toast('Editing unlocked.');
}

function lockEditing(){
  UI.unlocked = false; setLocallyUnlocked(false);
  renderAll();
}

function requireUnlock(){
  if(!UI.unlocked){ requestEdit(); return UI.unlocked; }
  return true;
}

/* app_render.js's lockbar calls this where the old build offered "Change
 * password". There is no password to change any more, so it explains the new
 * model and offers the one action that still makes sense. */
function changePassword(){
  openModal({
    title: 'Account',
    body: `<p>Signed in as <strong>${esc(signedInEmail())}</strong>.</p>
      <p>This ledger no longer uses a shared password. Access is by emailed
         sign-in link, and who may open it is enforced by the database, not by
         this page.</p>
      <p>To add or remove someone, edit <code>bills.allowed_emails</code> in
         Supabase.</p>`,
    confirmLabel: 'Sign out',
    cancelLabel: 'Close',
    onConfirm: async ()=>{ await signOut(); return true; }
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
