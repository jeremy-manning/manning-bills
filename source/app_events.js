
/* ===== MONEY FIELD HANDLERS ===== */
function findGroupInMonth(mo, groupId){ return mo.groups.find(g=>g.id===groupId); }
function findItemInMonth(mo, itemId){ for(const g of mo.groups){ const it=g.items.find(x=>x.id===itemId); if(it) return {group:g, item:it}; } return null; }
function findAccountInMonth(mo, accId){ return mo.accounts.find(a=>a.id===accId); }

function setMoneyValue(kind, ownerId, weekId, num){
  const mo = getMonth(UI.year, UI.month);
  if(!mo) return;
  if(kind==='acct'){ const a=findAccountInMonth(mo,ownerId); if(a) a.balances[weekId]=num; }
  else if(kind==='item'){ const r=findItemInMonth(mo,ownerId); if(r) r.item.weekly[weekId]=num; }
}
function onMoneyInput(el){
  if(!UI.unlocked) return;
  const v = el.value.trim();
  const num = v===''? null : parseFloat(v);
  if(v!=='' && isNaN(num)) return;
  setMoneyValue(el.dataset.kind, el.dataset.owner, el.dataset.week, num);
  patchTotals(UI.year, UI.month);
  // Reset the save debounce on every keystroke (not just on blur) — without
  // this, a save scheduled by leaving an earlier field could fire while
  // you're still actively typing a new one, since nothing was resetting its
  // timer. See the comment on SAVE_DEBOUNCE_MS in app_persist.js.
  scheduleSave();
}
function onMoneyBlur(el){
  if(!UI.unlocked) return;
  const num = parseMoney(el.value);
  setMoneyValue(el.dataset.kind, el.dataset.owner, el.dataset.week, num);
  el.value = num===null? '' : num.toFixed(2);
  patchTotals(UI.year, UI.month);
  scheduleSave();
}
function onMoneyKeydown(e, el){
  const key = e.key;
  if(key!=='ArrowDown' && key!=='ArrowUp' && key!=='Tab') return;
  const nav = el.closest('[data-nav]');
  if(!nav) return;
  const week = el.dataset.week;
  const group = Array.from(nav.querySelectorAll('input.money[data-week="'+CSS.escape(week)+'"]'));
  const idx = group.indexOf(el);
  if(idx===-1) return;
  let dir;
  if(key==='ArrowUp') dir=-1; else if(key==='ArrowDown') dir=1; else dir = e.shiftKey?-1:1;
  const nextIdx = idx+dir;
  if(nextIdx<0 || nextIdx>=group.length) return;
  e.preventDefault();
  group[nextIdx].focus();
  group[nextIdx].select();
}

/* ===== ACCOUNTS ===== */
function addAccount(y,m){
  if(!requireUnlock()) return;
  const mo = getMonth(y,m);
  mo.accounts.push({id:nextId('acc'), name:'New account', primary: mo.accounts.length===0, vacation:false, balances:{}, note:null});
  rerenderWorkspace(); scheduleSave();
}
function toggleAccountPrimary(id){
  if(!requireUnlock()) return;
  const mo = getMonth(UI.year, UI.month);
  mo.accounts.forEach(a=> a.primary = (a.id===id) ? !a.primary : false);
  rerenderWorkspace(); scheduleSave();
}
function toggleAccountVacation(id){
  if(!requireUnlock()) return;
  const mo = getMonth(UI.year, UI.month);
  mo.accounts.forEach(a=> a.vacation = (a.id===id) ? !a.vacation : false);
  rerenderWorkspace(); scheduleSave();
}
function renameAccount(id, field, val){
  if(!requireUnlock()){ rerenderWorkspace(); return; }
  const mo = getMonth(UI.year, UI.month);
  const a = findAccountInMonth(mo,id);
  if(!a) return;
  if(field==='name'){ a.name = val.trim() || a.name; }
  else if(field==='note'){ a.note = val.trim() || null; }
  rerenderWorkspace(); scheduleSave();
}
function onDeleteAccount(id){
  if(!requireUnlock()) return;
  const mo = getMonth(UI.year, UI.month);
  const a = findAccountInMonth(mo,id);
  confirmDanger('Delete account', `Delete "${a?a.name:'this account'}" from ${monthLabel(UI.year,UI.month)}? This does not affect other months.`, ()=>{
    mo.accounts = mo.accounts.filter(x=>x.id!==id);
    rerenderWorkspace(); scheduleSave(); toast('Account deleted.');
  });
}

/* ===== GROUPS / ITEMS ===== */
function addGroup(y,m){
  if(!requireUnlock()) return;
  const mo = getMonth(y,m);
  mo.groups.push({id:nextId('grp'), name:'New group', items:[]});
  rerenderWorkspace(); scheduleSave();
}
function renameGroup(id, val){
  if(!requireUnlock()){ rerenderWorkspace(); return; }
  const mo = getMonth(UI.year, UI.month);
  const g = findGroupInMonth(mo,id);
  if(g) g.name = val.trim() || g.name;
  rerenderWorkspace(); scheduleSave();
}
function onDeleteGroup(id){
  if(!requireUnlock()) return;
  const mo = getMonth(UI.year, UI.month);
  const g = findGroupInMonth(mo,id);
  confirmDanger('Delete group', `Delete "${g?g.name:'this group'}" and all ${g?g.items.length:0} bill(s) in it, for ${monthLabel(UI.year,UI.month)}?`, ()=>{
    mo.groups = mo.groups.filter(x=>x.id!==id);
    rerenderWorkspace(); scheduleSave(); toast('Group deleted.');
  });
}
function addItem(groupId){
  if(!requireUnlock()) return;
  const mo = getMonth(UI.year, UI.month);
  const g = findGroupInMonth(mo,groupId);
  if(!g) return;
  g.items.push({id:nextId('item'), name:'New bill', due:null, budget:null, vacation:false, weekly:{}, notes:null});
  rerenderWorkspace(); scheduleSave();
}
function renameItem(id, field, val){
  if(!requireUnlock()){ rerenderWorkspace(); return; }
  const mo = getMonth(UI.year, UI.month);
  const r = findItemInMonth(mo,id);
  if(!r) return;
  if(field==='name'){ r.item.name = val.trim() || r.item.name; }
  else if(field==='budget'){ const t=val.trim(); r.item.budget = t===''? null : (isNaN(parseFloat(t)) ? t : parseFloat(t)); }
  else if(field==='due'){ r.item.due = val.trim() || null; }
  else if(field==='notes'){ r.item.notes = val.trim() || null; }
  rerenderWorkspace(); scheduleSave();
}
function onDeleteItem(id){
  if(!requireUnlock()) return;
  const mo = getMonth(UI.year, UI.month);
  const r = findItemInMonth(mo,id);
  confirmDanger('Delete bill', `Delete "${r?r.item.name:'this bill'}" from ${monthLabel(UI.year,UI.month)}?`, ()=>{
    if(r) r.group.items = r.group.items.filter(x=>x.id!==id);
    rerenderWorkspace(); scheduleSave(); toast('Bill deleted.');
  });
}
function toggleItemVacation(id){
  if(!requireUnlock()) return;
  const mo = getMonth(UI.year, UI.month);
  const r = findItemInMonth(mo,id);
  if(r) r.item.vacation = !r.item.vacation;
  rerenderWorkspace(); scheduleSave();
}

/* ===== WEEKS ===== */
function addWeek(y,m){
  if(!requireUnlock()) return;
  const mo = getMonth(y,m);
  let base = mo.weeks.length ? mo.weeks[mo.weeks.length-1].date : todayISO();
  const d = new Date(base+'T00:00:00Z');
  d.setUTCDate(d.getUTCDate()+7);
  mo.weeks.push({id:nextId('wk'), date: d.toISOString().slice(0,10)});
  rerenderWorkspace(); scheduleSave();
}
function onDeleteWeek(y,m,weekId){
  if(!requireUnlock()) return;
  confirmDanger('Remove week column', 'This removes the date column and every amount entered in it, for this month only.', ()=>{
    const mo = getMonth(y,m);
    mo.weeks = mo.weeks.filter(w=>w.id!==weekId);
    mo.accounts.forEach(a=> delete a.balances[weekId]);
    mo.groups.forEach(g=> g.items.forEach(it=> delete it.weekly[weekId]));
    rerenderWorkspace(); scheduleSave(); toast('Week removed.');
  });
}
function changeWeekDate(y,m,weekId,newDate){
  if(!requireUnlock()){ rerenderWorkspace(); return; }
  const mo = getMonth(y,m);
  const w = mo.weeks.find(x=>x.id===weekId);
  if(w && newDate) w.date = newDate;
  rerenderWorkspace(); scheduleSave();
}

/* ===== MONTHS / YEARS ===== */
function copyForwardMonth(year, monthNum){
  const weeks = generateFridays(year,monthNum).map(d=>({id:nextId('wk'), date:d}));
  const prev = mostRecentMonth();
  let groups, accounts;
  if(prev){
    groups = prev.data.groups.map(g=>({id:nextId('grp'), name:g.name, items: g.items.map(it=>({
      id:nextId('item'), name:it.name, due:it.due, budget:it.budget, vacation:it.vacation, weekly:{}, notes:null
    }))}));
    accounts = prev.data.accounts.map(a=>({id:nextId('acc'), name:a.name, primary:a.primary, vacation:a.vacation, balances:{}, note:null}));
  } else {
    groups = GROUP_DEFAULTS.map(n=>({id:nextId('grp'), name:n, items:[]}));
    accounts = [];
  }
  if(!STATE.years[year]) STATE.years[year] = {months:{}};
  STATE.years[year].months[monthNum] = {label: monthLabel(year,monthNum), weeks, accounts, groups};
}
function onAddMonth(year){
  if(!requireUnlock()) return;
  const existing = months(year);
  const missing = MONTH_NUMS.filter(mn=>!existing.includes(mn));
  if(!missing.length){ toast('All 12 months already exist for '+year+'.'); return; }
  const options = missing.map(mn=> `<option value="${mn}">${MONTH_NAMES[parseInt(mn,10)-1]}</option>`).join('');
  openModal({
    title:'Add a month',
    body:`<p>New months start with every Friday pre-filled, and copy the bill groups and accounts forward from the most recent month.</p>
      <div class="field"><label for="addmonthsel">Month</label><select id="addmonthsel">${options}</select></div>`,
    confirmLabel:'Add month',
    onConfirm: ()=>{
      const mn = document.getElementById('addmonthsel').value;
      copyForwardMonth(year, mn);
      UI.year = year; UI.month = mn;
      renderAll(); scheduleSave(true);
      toast('Added '+monthLabel(year,mn)+'.');
      return true;
    }
  });
}
function onDeleteMonth(y,m){
  if(!requireUnlock()) return;
  confirmDanger('Delete month', `Delete ${monthLabel(y,m)} entirely — all bills and balances? A backup snapshot is kept in shared storage, but this cannot be undone from here.`, ()=>{
    rotateBackup(deepClone(STATE));
    delete STATE.years[y].months[m];
    if(UI.year===y && UI.month===m) UI.month=null;
    renderAll(); scheduleSave(true); toast('Month deleted.');
  });
}
function onAddYear(){
  if(!requireUnlock()) return;
  const ys = years().map(Number);
  const def = ys.length ? Math.max(...ys)+1 : new Date().getFullYear();
  openModal({
    title:'Add a year',
    body:`<div class="field"><label for="addyearinput">Year</label><input type="number" id="addyearinput" value="${def}" min="2000" max="2100" step="1"></div>`,
    confirmLabel:'Add year',
    onConfirm: ()=>{
      const val = String(parseInt(document.getElementById('addyearinput').value,10));
      if(!val || val==='NaN' || val.length!==4){ toast('Enter a 4-digit year.'); return false; }
      if(STATE.years[val]){ toast('That year already exists.'); return false; }
      STATE.years[val] = {months:{}};
      UI.year = val; UI.month = null;
      renderAll(); scheduleSave(true);
      return true;
    }
  });
}
function onDeleteYear(y){
  if(!requireUnlock()) return;
  confirmDanger('Delete year', `Delete ${y} and every month in it? A backup snapshot is kept in shared storage, but this cannot be undone from here.`, ()=>{
    rotateBackup(deepClone(STATE));
    delete STATE.years[y];
    if(UI.year===y){ UI.year=null; UI.month=null; }
    renderAll(); scheduleSave(true); toast('Year deleted.');
  });
}

/* ===== EXPORT / IMPORT ===== */
async function exportBackup(){
  const payload = JSON.stringify(STATE, null, 2);
  const filename = 'manning-bills-backup-'+todayISO()+'.json';
  if(downloadsCap){
    try{ await downloadsCap.save({filename, data:payload}); toast('Export ready — check your downloads.'); return; }
    catch(e){ toast('Could not start the download.'); }
    return;
  }
  // No Claude-artifact downloads capability available (e.g. this build is
  // running as a plain self-hosted site, not inside the Artifact viewer's
  // sandbox where a plain <a download> link is inert) — a normal
  // Blob + <a download> works fine in a real browser.
  try{
    const blob = new Blob([payload], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=> URL.revokeObjectURL(url), 1000);
    toast('Export ready — check your downloads.');
  }catch(e){ toast('Downloads are not available in this view.'); }
}
function onImportFile(e){
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if(!file) return;
  if(!requireUnlock()) return;
  const reader = new FileReader();
  reader.onload = () => {
    let json;
    try{ json = JSON.parse(reader.result); }catch(err){ toast('That file is not valid JSON.'); return; }
    if(!json || typeof json!=='object' || !json.years){ toast('That file does not look like a Manning Bills backup.'); return; }
    confirmDanger('Import backup', 'This overwrites the current shared bills tracker for everyone with the contents of this file. Your current data is kept in a backup snapshot. Continue?', ()=>{
      const priorBackups = STATE.backups || [];
      const priorSnapshot = deepClone(STATE);
      const keepAuth = STATE.auth;
      STATE = json;
      STATE.auth = keepAuth;
      STATE.backups = priorBackups;
      rotateBackup(priorSnapshot);
      let max=0; const scan=(v)=>{ if(v&&typeof v==='object'){ if(typeof v.id==='string'){ const mch=/(\d+)$/.exec(v.id); if(mch) max=Math.max(max,parseInt(mch[1],10)); } for(const k in v) scan(v[k]); } };
      scan(STATE.years); scan(STATE.billsReference);
      STATE.nextId = Math.max(max+1, STATE.nextId||1);
      UI.year=null; UI.month=null;
      renderAll(); scheduleSave(true);
      toast('Import complete.');
    });
  };
  reader.readAsText(file);
}

/* ===== BILLS REFERENCE TAB ===== */
function renderReferenceHTML(){
  const rows = STATE.billsReference.map(r=> `<tr>
    <td>${UI.unlocked? `<input class="namefield" value="${escAttr(r.name)}" onblur="renameReference('${r.id}','name',this.value)">` : `<strong>${esc(r.name)}</strong>`}</td>
    <td>${UI.unlocked? `<input class="textfield" style="width:90px;" value="${escAttr(r.due||'')}" onblur="renameReference('${r.id}','due',this.value)">` : esc(r.due||'—')}</td>
    <td style="text-align:left;">${UI.unlocked? `<input class="textfield" style="width:100%;min-width:220px;" value="${escAttr(r.link||'')}" onblur="renameReference('${r.id}','link',this.value)">` :
        (r.link && /^https?:\/\//i.test(r.link) ? `<a class="reflink" target="_blank" rel="noopener" href="${escAttr(r.link)}">${esc(r.link)}</a>` : esc(r.link||'—'))}</td>
    <td style="text-align:left;">${UI.unlocked? `<input class="textfield" style="width:100%;min-width:200px;" value="${escAttr(r.login||'')}" onblur="renameReference('${r.id}','login',this.value)">` : esc(r.login||'—')}</td>
    <td>${UI.unlocked? `<button class="rowdel" style="opacity:.6" onclick="onDeleteReference('${r.id}')">🗑</button>`:''}</td>
  </tr>`).join('');
  return `<div class="card">
    <div class="card-head"><div><h2>Bills Reference</h2><div class="desc">Payment links and logins for reference — passwords are never stored here.</div></div>
      <div class="spacer"></div>${UI.unlocked? `<button class="btn small" onclick="addReference()">+ Biller</button>`:''}
    </div>
    <div class="card-body"><div class="tablewrap"><table class="ledger">
      <thead><tr><th style="text-align:left;">Biller</th><th>Due</th><th style="text-align:left;">Payment link</th><th style="text-align:left;">Login</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="emptynote">No billers listed yet.</td></tr>`}</tbody>
    </table></div></div>
  </div>`;
}
function addReference(){
  if(!requireUnlock()) return;
  STATE.billsReference.push({id:nextId('ref'), name:'New biller', due:null, link:null, login:null});
  document.getElementById('main').innerHTML = renderReferenceHTML();
  scheduleSave();
}
function renameReference(id, field, val){
  if(!requireUnlock()){ document.getElementById('main').innerHTML = renderReferenceHTML(); return; }
  const r = STATE.billsReference.find(x=>x.id===id);
  if(!r) return;
  if(field==='name') r.name = val.trim() || r.name;
  else r[field] = val.trim() || null;
  document.getElementById('main').innerHTML = renderReferenceHTML();
  scheduleSave();
}
function onDeleteReference(id){
  if(!requireUnlock()) return;
  const r = STATE.billsReference.find(x=>x.id===id);
  confirmDanger('Delete biller', `Remove "${r?r.name:'this biller'}" from the reference list?`, ()=>{
    STATE.billsReference = STATE.billsReference.filter(x=>x.id!==id);
    document.getElementById('main').innerHTML = renderReferenceHTML();
    scheduleSave(); toast('Removed.');
  });
}

/* ===== SPENDING TRENDS TAB ===== */
const TREND_CATEGORIES = [
  ['Tithe','#2a78d6'],['Housing','#eb6834'],['Credit Cards','#1baf7a'],['Cars','#eda100']
];
const UTIL_PALETTE = ['#2a78d6','#eb6834','#1baf7a','#eda100','#e87ba4','#008300','#4a3aa7','#e34948','#8a5a2f','#0aa3a3'];
let CHART_INSTANCES = [];

function trailing12(){ return allMonthsChrono().slice(-12); }
function groupTotalByName(rec, name){
  const g = rec.data.groups.find(x=> x.name.trim().toLowerCase()===name.toLowerCase());
  return g ? groupMonthlyTotal(g, rec.data.weeks) : null;
}
function utilityGroup(rec){ return rec.data.groups.find(x=> x.name.trim().toLowerCase()==='utilities'); }
function utilityItemNames(list){
  const set = new Set();
  list.forEach(rec=>{ const g = utilityGroup(rec); if(g) g.items.forEach(it=> set.add(it.name)); });
  return Array.from(set);
}
function utilityItemTotal(rec, name){
  const g = utilityGroup(rec); if(!g) return null;
  const it = g.items.find(x=>x.name===name);
  return it ? itemMonthlyTotal(it, rec.data.weeks) : null;
}

function renderTrendsHTML(){
  const list = trailing12();
  if(!list.length){
    return `<div class="card"><div class="card-body"><p class="emptynote">Add a month of bills to see spending trends.</p></div></div>`;
  }
  return `<div class="card bigchart">
      <div class="card-head"><div><h2>Tithe, Housing, Credit Cards &amp; Cars</h2><div class="desc">Monthly totals, trailing ${list.length} month${list.length>1?'s':''}.</div></div></div>
      <div class="card-body"><canvas id="trend-groups"></canvas></div>
    </div>
    <div class="card bigchart">
      <div class="card-head"><div><h2>Utilities, by biller</h2><div class="desc">Monthly totals, trailing ${list.length} month${list.length>1?'s':''}.</div></div></div>
      <div class="card-body"><canvas id="trend-tithe-utils"></canvas></div>
    </div>`;
}
function afterTrendsRender(){
  CHART_INSTANCES.forEach(c=> c.destroy());
  CHART_INSTANCES = [];
  const list = trailing12();
  if(!list.length) return;
  if(typeof Chart==='undefined'){
    const main = document.getElementById('main');
    if(main) main.innerHTML = `<div class="card"><div class="card-body"><p class="emptynote">Charts could not load (the chart library did not reach this browser). Your data is safe — try reloading, or check Bills for the underlying numbers.</p></div></div>`;
    return;
  }
  const labels = list.map(r=> monthShort(r.month)+' ’'+String(r.year).slice(2));
  const styles = getComputedStyle(document.body);
  const grid = styles.getPropertyValue('--line-soft').trim();
  const ink = styles.getPropertyValue('--ink-soft').trim();
  const baseOpts = (showLegend)=>({
    responsive:true, maintainAspectRatio:false,
    interaction:{mode:'index', intersect:false},
    plugins:{ legend:{display:showLegend, position:'bottom', labels:{color:ink, boxWidth:10, font:{size:11}}},
      tooltip:{callbacks:{ label:(c)=> c.dataset.label+': '+(c.parsed.y==null?'—':('$'+c.parsed.y.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}))) } } },
    scales:{ x:{grid:{color:grid}, ticks:{color:ink, font:{size:10.5}}},
             y:{grid:{color:grid}, ticks:{color:ink, font:{size:10.5}, callback:(v)=>'$'+v.toLocaleString()}} }
  });
  const gEl = document.getElementById('trend-groups');
  if(gEl){
    CHART_INSTANCES.push(new Chart(gEl, {type:'line', data:{labels, datasets: TREND_CATEGORIES.map(([name,color])=>({
      label:name, data:list.map(r=>groupTotalByName(r,name)), borderColor:color, backgroundColor:color, tension:.3, spanGaps:true, pointRadius:3, borderWidth:2.25
    }))}, options: baseOpts(true)}));
  }
  const tEl = document.getElementById('trend-tithe-utils');
  if(tEl){
    const utilNames = utilityItemNames(list);
    const datasets = utilNames.map((name,i)=>({
      label:name, data:list.map(r=>utilityItemTotal(r,name)), borderColor:UTIL_PALETTE[i%UTIL_PALETTE.length], backgroundColor:UTIL_PALETTE[i%UTIL_PALETTE.length], tension:.3, spanGaps:true, pointRadius:2.5, borderWidth:2
    }));
    CHART_INSTANCES.push(new Chart(tEl, {type:'line', data:{labels, datasets}, options: baseOpts(true)}));
  }
}

/* ===== PENDING-EDIT SAFETY NET ===== */
function stashPendingEdit(){
  try{
    const el = document.activeElement;
    if(el && el.classList && el.classList.contains('money') && el.id && UI.unlocked){
      // Commit it as a real edit (not just a visual snapshot) so it's part
      // of whatever the unload-time flush save sends, in case the field
      // never got a chance to blur before the page went away.
      onMoneyBlur(el);
      sessionStorage.setItem(SS_PENDING_KEY, JSON.stringify({id:el.id, value:el.value}));
    }
  }catch(e){}
}
function restorePendingEdit(){
  try{
    const raw = sessionStorage.getItem(SS_PENDING_KEY);
    if(!raw) return;
    sessionStorage.removeItem(SS_PENDING_KEY);
    const data = JSON.parse(raw);
    setTimeout(()=>{
      const el = document.getElementById(data.id);
      if(el){
        el.focus();
        el.value = data.value;
        el.select();
        // Re-commit it here too: it was already saved via the unload-time
        // flush in the common case, but if that flush lost the race with
        // the page actually closing, this guarantees it still gets saved
        // now rather than just sitting visible-but-unsaved in the field.
        if(UI.unlocked) onMoneyBlur(el);
      }
    }, 80);
  }catch(e){}
}
function warnBeforeUnload(e){
  stashPendingEdit();
  flushPendingSave();
  if(UI.dirty){
    e.preventDefault();
    e.returnValue = '';
    return '';
  }
}

/* ===== INIT ===== */
async function init(){
  await initCapabilities();
  await loadInitialState();
  UI.unlocked = isLocallyUnlocked() && !!(STATE.auth && STATE.auth.passwordHash);
  UI.lastSavedAt = STATE.savedAt;
  renderAll();
  window.addEventListener('beforeunload', warnBeforeUnload);
  document.addEventListener('visibilitychange', ()=>{ if(document.hidden){ stashPendingEdit(); flushPendingSave(); } });
  restorePendingEdit();
}
if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded', init); } else { init(); }
