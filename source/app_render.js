
/* ===== TOP-LEVEL RENDER ===== */
function renderAll(){
  ensureSelection();
  renderTopnav();
  renderLockbar();
  renderMain();
  renderFooter();
}
function ensureSelection(){
  const ys = years();
  if(!ys.length){ UI.year=null; UI.month=null; return; }
  if(!UI.year || !ys.includes(UI.year)) UI.year = ys[ys.length-1];
  const ms = months(UI.year);
  if(!ms.length){ UI.month=null; }
  else if(!UI.month || !ms.includes(UI.month)) UI.month = ms[ms.length-1];
}
function setTab(t){ UI.tab=t; renderAll(); }

function renderTopnav(){
  const el = document.getElementById('topnav');
  const tabs = [['tracker','Tracker'],['reference','Bills Reference'],['trends','Spending Trends']];
  el.innerHTML = tabs.map(([k,label])=> `<button class="${UI.tab===k?'active':''}" onclick="setTab('${k}')">${label}</button>`).join('');
}

function renderLockbar(){
  const el = document.getElementById('lockbar');
  const savedTxt = UI.lastSavedAt ? ('Saved ' + new Date(UI.lastSavedAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})) : '';
  el.innerHTML = `
    <span id="saveindicator" class="savestate"></span>
    <button class="iconbtn" onclick="exportBackup()">⬇ Export</button>
    <button class="iconbtn" onclick="document.getElementById('importfile').click()">⬆ Import</button>
    <input type="file" id="importfile" accept="application/json" style="display:none" onchange="onImportFile(event)">
    ${UI.unlocked
      ? `<button class="pill unlocked" onclick="lockEditing()">🔓 Editing — tap to lock</button><button class="iconbtn" onclick="changePassword()">🔑 Change password</button>`
      : `<button class="pill locked" onclick="requestEdit()">🔒 Locked — tap to edit</button>`}
  `;
  renderSaveIndicator();
}

function renderFooter(){
  document.getElementById('appfoot').textContent = 'Manning household bills — shared ledger. Changes save automatically and sync to whoever else has this page open.';
}

function renderMain(){
  const main = document.getElementById('main');
  if(UI.tab==='reference'){ main.innerHTML = renderReferenceHTML(); return; }
  if(UI.tab==='trends'){ main.innerHTML = renderTrendsHTML(); afterTrendsRender(); return; }
  main.innerHTML = renderTrackerHTML();
}

/* ===== TRACKER TAB ===== */
function renderTrackerHTML(){
  const ys = years();
  let html = '';
  html += `<div class="tabrow years">` + ys.map(y=>
      `<button class="tab year ${y===UI.year?'active':''}" onclick="selectYear('${y}')">${y}
        ${ys.length>0 ? `<span class="del" title="Delete year" onclick="event.stopPropagation(); onDeleteYear('${y}')">✕</span>`:''}
      </button>`
    ).join('') + `<button class="tab ghost year" onclick="onAddYear()">+ Add year</button>` + `</div>`;

  if(!ys.length){
    html += `<div class="card"><div class="card-body"><p class="emptynote">No years yet. Add a year, then add a month to get started.</p></div></div>`;
    return html;
  }

  const ms = months(UI.year);
  html += `<div class="monthscroll"><div class="tabrow months">` + ms.map(m=>
      `<button class="tab ${m===UI.month?'active':''}" onclick="selectMonth('${m}')">${monthShort(m)}
        <span class="del" title="Delete month" onclick="event.stopPropagation(); onDeleteMonth('${UI.year}','${m}')">✕</span>
      </button>`
    ).join('') + `<button class="tab ghost" onclick="onAddMonth('${UI.year}')">+ Add month</button>` + `</div></div>`;

  if(!ms.length || !UI.month){
    html += `<div class="card"><div class="card-body"><p class="emptynote">No months in ${UI.year} yet. Click "+ Add month" to create one.</p></div></div>`;
    return html;
  }

  html += `<div id="workspace">` + renderWorkspaceHTML(UI.year, UI.month) + `</div>`;
  return html;
}
function selectYear(y){ UI.year=y; UI.month=null; renderAll(); }
function selectMonth(m){ UI.month=m; renderAll(); }

function renderWorkspaceHTML(y,m){
  return renderStatStripHTML(y,m) + renderAccountsCardHTML(y,m) + renderBillsCardHTML(y,m);
}
function rerenderWorkspace(){
  const el = document.getElementById('workspace');
  if(el) el.innerHTML = renderWorkspaceHTML(UI.year, UI.month);
}

/* ---------- Accounts card ---------- */
function renderAccountsCardHTML(y,m){
  const mo = getMonth(y,m);
  const weeks = mo.weeks;
  const curWeekId = currentWeekId(y,m);
  let head = `<tr><th>Account</th>${weeks.map(w=>`<th class="weekcol ${w.id===curWeekId?'current':''}">${fmtDateShort(w.date)}</th>`).join('')}<th>Notes</th></tr>`;
  let rows = mo.accounts.map(a=>{
    return `<tr>
      <td class="rowname">
        <button class="starbtn ${a.primary?'on':''}" title="Primary account" onclick="toggleAccountPrimary('${a.id}')">${a.primary?'★':'☆'}</button>
        <button class="flagbtn ${a.vacation?'on':''}" title="Vacation account" onclick="toggleAccountVacation('${a.id}')">✈</button>
        ${UI.unlocked
          ? `<input class="namefield" value="${escAttr(a.name)}" oninput="scheduleSave()" onblur="renameAccount('${a.id}', 'name', this.value)">`
          : `<span>${esc(a.name)}</span>`}
        ${UI.unlocked ? `<button class="rowdel" title="Delete account" onclick="onDeleteAccount('${a.id}')">🗑</button>`:''}
      </td>
      ${weeks.map(w=> `<td class="weekcol ${w.id===curWeekId?'current':''}">` + moneyCellHTML('acct', a.id, w.id, a.balances[w.id]) + `</td>`).join('')}
      <td>${UI.unlocked
          ? `<input class="textfield" style="width:160px;" value="${escAttr(a.note||'')}" oninput="scheduleSave()" onblur="renameAccount('${a.id}', 'note', this.value)">`
          : `<span style="color:var(--ink-soft);">${esc(a.note||'')}</span>`}</td>
    </tr>`;
  }).join('');
  return `<div class="card">
    <div class="card-head">
      <div><h2>Account Balances</h2><div class="desc">★ marks the primary account used for the stat strip above. ✈ marks the account that funds vacation spending.</div></div>
      <div class="spacer"></div>
      ${UI.unlocked ? `<button class="btn small" onclick="addAccount('${y}','${m}')">+ Account</button>`:''}
    </div>
    <div class="card-body"><div class="tablewrap"><table class="ledger" data-nav="acct-${y}-${m}">
      <thead>${head}</thead>
      <tbody>${rows || `<tr><td colspan="99" class="emptynote">No accounts yet.</td></tr>`}</tbody>
    </table></div></div>
  </div>`;
}

/* ---------- Bills card ---------- */
function renderBillsCardHTML(y,m){
  const mo = getMonth(y,m);
  const weeks = mo.weeks;
  const curWeekId = currentWeekId(y,m);
  let head = `<tr><th>Bill</th><th>Due</th><th>Budget</th>${weeks.map(w=>
      `<th class="weekcol ${w.id===curWeekId?'current':''}">${fmtDateShort(w.date)}
        ${UI.unlocked? `<div><input type="date" class="datecell" value="${w.date}" onchange="changeWeekDate('${y}','${m}','${w.id}', this.value)"></div>`:''}
      </th>`).join('')}<th>Monthly total</th><th>Notes</th></tr>`;

  let body = '';
  mo.groups.forEach(g=>{
    body += `<tr class="grouphead"><td class="rowname">
        ${UI.unlocked ? `<input class="namefield" value="${escAttr(g.name)}" oninput="scheduleSave()" onblur="renameGroup('${g.id}', this.value)">` : esc(g.name)}
        ${UI.unlocked ? `<button class="rowdel" title="Delete group" onclick="onDeleteGroup('${g.id}')">🗑</button>`:''}
      </td><td></td><td></td>${weeks.map(()=>'<td></td>').join('')}<td></td><td></td></tr>`;
    g.items.forEach(it=>{
      body += `<tr>
        <td class="rowname">
          <button class="flagbtn ${it.vacation?'on':''}" title="Flag as vacation spending" onclick="toggleItemVacation('${it.id}')">✈</button>
          ${UI.unlocked ? `<input class="namefield" value="${escAttr(it.name)}" oninput="scheduleSave()" onblur="renameItem('${it.id}','name', this.value)">` : `<span>${esc(it.name)}</span>`}
          ${UI.unlocked ? `<button class="rowdel" title="Delete bill" onclick="onDeleteItem('${it.id}')">🗑</button>`:''}
        </td>
        <td>${UI.unlocked ? `<input class="textfield" style="width:92px;" value="${escAttr(it.due||'')}" oninput="scheduleSave()" onblur="renameItem('${it.id}','due', this.value)">` : esc(it.due||'—')}</td>
        <td>${UI.unlocked ? `<input class="textfield" value="${escAttr(it.budget===null||it.budget===undefined?'':it.budget)}" oninput="scheduleSave()" onblur="renameItem('${it.id}','budget', this.value)">` : esc(it.budget||'—')}</td>
        ${weeks.map(w=> `<td class="weekcol ${w.id===curWeekId?'current':''}">` + moneyCellHTML('item', it.id, w.id, it.weekly[w.id]) + `</td>`).join('')}
        <td id="itot-${it.id}" class="num">${fmtMoney(itemMonthlyTotal(it,weeks))}</td>
        <td>${UI.unlocked ? `<input class="textfield" style="width:120px;" value="${escAttr(it.notes||'')}" oninput="scheduleSave()" onblur="renameItem('${it.id}','notes', this.value)">` : `<span style="color:var(--ink-soft);">${esc(it.notes||'')}</span>`}</td>
      </tr>`;
    });
    body += `<tr class="subtotal"><td>${esc(g.name)} total</td><td></td><td></td>
      ${weeks.map(w=> `<td id="gtot-${g.id}-${w.id}" class="num weekcol ${w.id===curWeekId?'current':''}">${fmtMoney(groupWeekTotal(g,w.id))}</td>`).join('')}
      <td id="gtot-${g.id}-month" class="num">${fmtMoney(groupMonthlyTotal(g,weeks))}</td><td></td></tr>`;
    if(UI.unlocked){
      body += `<tr><td colspan="99" style="text-align:left; border-bottom:1px solid var(--line);"><button class="linkbtn" onclick="addItem('${g.id}')">+ Add bill to ${esc(g.name)}</button></td></tr>`;
    }
  });
  body += `<tr class="grandtotal"><td>Grand total</td><td></td><td></td>
    ${weeks.map(w=> `<td id="grand-${w.id}" class="num weekcol ${w.id===curWeekId?'current':''}">${fmtMoney(grandWeekTotal(mo,w.id))}</td>`).join('')}
    <td id="grand-month" class="num">${fmtMoney(grandMonthlyTotal(mo))}</td><td></td></tr>`;

  return `<div class="card">
    <div class="card-head">
      <div><h2>Bills</h2><div class="desc">Fridays are pre-filled as the date each bill was due — edit a date if you actually paid it on a different day.</div></div>
      <div class="spacer"></div>
      ${UI.unlocked ? `<button class="btn small" onclick="addGroup('${y}','${m}')">+ Group</button>
        <button class="btn small" onclick="addWeek('${y}','${m}')">+ Week</button>
        ${weeks.length>1?`<button class="btn small" onclick="onDeleteWeek('${y}','${m}','${weeks[weeks.length-1].id}')">− Week</button>`:''}`:''}
    </div>
    <div class="card-body"><div class="tablewrap"><table class="ledger" data-nav="bills-${y}-${m}">
      <thead>${head}</thead><tbody>${body}</tbody>
    </table></div></div>
  </div>`;
}

function moneyCellHTML(kind, ownerId, weekId, val){
  const idAttr = `m-${kind}-${ownerId}-${weekId}`;
  return `<input type="number" step="0.01" inputmode="decimal" class="money" id="${idAttr}"
    data-kind="${kind}" data-owner="${ownerId}" data-week="${weekId}"
    value="${moneyInputVal(val)}"
    ${UI.unlocked?'':'disabled'}
    oninput="onMoneyInput(this)" onblur="onMoneyBlur(this)" onkeydown="onMoneyKeydown(event,this)">`;
}

/* ---------- Stat strip (top of month workspace) ---------- */
function fmtDateAsOf(iso){
  if(!iso) return '—';
  const d = new Date(iso+'T00:00:00');
  const wd = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
  return wd + ' ' + (d.getMonth()+1) + '/' + d.getDate();
}
// Pulls together the numbers shown in the stat strip so both the initial
// render and the live patch (patchTotals) compute them identically.
function computeStatStripData(mo){
  const primary = getPrimaryAccount(mo);
  const vacAcc = getVacationAccount(mo);
  const totalBills = grandMonthlyTotal(mo);
  const vacSpent = vacationMonthlyTotal(mo);
  const primaryInfo = primary ? mostRecentBalanceInfo(mo, primary) : null;
  const firstWeek = mo.weeks[0] || null;
  const vacStartRaw = (vacAcc && firstWeek) ? vacAcc.balances[firstWeek.id] : null;
  const vacStart = (vacStartRaw===null || vacStartRaw===undefined || vacStartRaw==='') ? null : Number(vacStartRaw);
  const afcuStart = primaryInfo ? Number(primaryInfo.value) : null;

  // "Bills not marked with the airplane" for THIS WEEK only — the starting
  // balance is a snapshot for one specific week (the week of the most
  // recently entered balance), so what's left to spend against it is that
  // same week's non-vacation bills, not the whole month's.
  const nonVacWeekBills = primaryInfo ? (grandWeekTotal(mo, primaryInfo.weekId) - vacationWeekTotal(mo, primaryInfo.weekId)) : null;
  const afcuCurrent = (afcuStart===null || nonVacWeekBills===null) ? null : (afcuStart - nonVacWeekBills);

  // Vacation current balance: the vacation account isn't a strict draw-down
  // (money is also added to it each paycheck), so rather than projecting
  // off the fixed month-starting amount, use the LAST balance actually
  // entered for that account and subtract only the vacation spending that
  // happened in that same week.
  const vacRecentInfo = vacAcc ? mostRecentBalanceInfo(mo, vacAcc) : null;
  const vacCurrent = vacRecentInfo ? (Number(vacRecentInfo.value) - vacationWeekTotal(mo, vacRecentInfo.weekId)) : null;

  return {primary, vacAcc, totalBills, vacSpent, nonVacWeekBills, primaryInfo, firstWeek, vacStart, vacRecentInfo, afcuStart, afcuCurrent, vacCurrent};
}

function renderStatStripHTML(y,m){
  const mo = getMonth(y,m);
  const d = computeStatStripData(mo);
  const {primary, vacAcc, totalBills, vacSpent, nonVacWeekBills, primaryInfo, firstWeek, vacStart, vacRecentInfo, afcuCurrent, vacCurrent} = d;

  const tile = (label, valueId, valueText, asofHtml, extraClass, negative)=> `<div class="stattile">
      <div class="stattile-label">${esc(label)}</div>
      <div class="stattile-value${extraClass?(' '+extraClass):''}${negative?' negative':''}" id="${valueId}-wrap"><span id="${valueId}">${valueText}</span></div>
      ${asofHtml || ''}
    </div>`;

  return `<div class="statstrip-rows">
    <div class="statstrip statstrip-solo">
      ${tile('Total bills this month', 'stat-totalbills', fmtMoneyUSD(totalBills))}
    </div>
    <div class="statstrip">
      ${tile(primary ? primary.name+' starting balance' : 'AFCU starting balance', 'stat-afcu-start',
          primaryInfo? fmtMoneyUSD(primaryInfo.value) : '—',
          `<div class="stattile-asof" id="stat-afcu-start-asof">${primaryInfo? 'As of '+fmtDateAsOf(primaryInfo.date) : (primary? 'No balance entered' : 'No primary account set')}</div>`)}
      ${tile('Bills this week (non-vacation)', 'stat-nonvac-bills', nonVacWeekBills===null? '—' : fmtMoneyUSD(nonVacWeekBills))}
      ${tile(primary ? primary.name+' current balance' : 'AFCU current balance', 'stat-afcu-current',
          afcuCurrent===null? '—' : fmtMoneyUSD(afcuCurrent), '', '', afcuCurrent!==null && afcuCurrent<0)}
    </div>
    <div class="statstrip">
      ${tile('Vacation starting amount', 'stat-vac-start',
          vacStart===null? '—' : fmtMoneyUSD(vacStart),
          `<div class="stattile-asof" id="stat-vac-start-asof">${vacStart!==null? (firstWeek? 'As of '+fmtDateAsOf(firstWeek.date) : '') : (vacAcc? 'No balance entered' : 'No vacation account set')}</div>`,
          'vacation')}
      ${tile('Vacation spent this month', 'stat-vacation-spent', fmtMoneyUSD(vacSpent), '', 'vacation')}
      ${tile('Vacation current balance', 'stat-vac-current',
          vacCurrent===null? '—' : fmtMoneyUSD(vacCurrent),
          `<div class="stattile-asof" id="stat-vac-current-asof">${vacRecentInfo? 'As of '+fmtDateAsOf(vacRecentInfo.date) : (vacAcc? 'No balance entered' : 'No vacation account set')}</div>`,
          'vacation', vacCurrent!==null && vacCurrent<0)}
    </div>
  </div>`;
}

/* ---------- current week + patch/live totals ---------- */
function currentWeekId(y,m){
  if(!isCurrentMonth(y,m)) return null;
  const mo = getMonth(y,m);
  const today = todayISO();
  let best=null;
  mo.weeks.forEach(w=>{ if(w.date<=today) best=w.id; });
  return best;
}

function patchTotals(y,m){
  const mo = getMonth(y,m);
  if(!mo) return;
  const weeks = mo.weeks;
  mo.groups.forEach(g=>{
    g.items.forEach(it=>{
      const el = document.getElementById('itot-'+it.id);
      if(el) el.textContent = fmtMoney(itemMonthlyTotal(it,weeks));
    });
    weeks.forEach(w=>{
      const el = document.getElementById('gtot-'+g.id+'-'+w.id);
      if(el) el.textContent = fmtMoney(groupWeekTotal(g,w.id));
    });
    const gm = document.getElementById('gtot-'+g.id+'-month');
    if(gm) gm.textContent = fmtMoney(groupMonthlyTotal(g,weeks));
  });
  weeks.forEach(w=>{
    const el = document.getElementById('grand-'+w.id);
    if(el) el.textContent = fmtMoney(grandWeekTotal(mo,w.id));
  });
  const gmEl = document.getElementById('grand-month');
  if(gmEl) gmEl.textContent = fmtMoney(grandMonthlyTotal(mo));


  const d = computeStatStripData(mo);
  const {primary, vacAcc, totalBills, vacSpent, nonVacWeekBills, primaryInfo, firstWeek, vacStart, vacRecentInfo, afcuCurrent, vacCurrent} = d;

  const stb = document.getElementById('stat-totalbills'); if(stb) stb.textContent = fmtMoneyUSD(totalBills);
  const sas = document.getElementById('stat-afcu-start'); if(sas) sas.textContent = primaryInfo? fmtMoneyUSD(primaryInfo.value) : '—';
  const saa = document.getElementById('stat-afcu-start-asof'); if(saa) saa.textContent = primaryInfo? 'As of '+fmtDateAsOf(primaryInfo.date) : (primary? 'No balance entered' : 'No primary account set');
  const snv = document.getElementById('stat-nonvac-bills'); if(snv) snv.textContent = nonVacWeekBills===null? '—' : fmtMoneyUSD(nonVacWeekBills);
  const sac = document.getElementById('stat-afcu-current'); if(sac) sac.textContent = afcuCurrent===null? '—' : fmtMoneyUSD(afcuCurrent);
  const sacWrap = document.getElementById('stat-afcu-current-wrap'); if(sacWrap) sacWrap.classList.toggle('negative', afcuCurrent!==null && afcuCurrent<0);
  const svst = document.getElementById('stat-vac-start'); if(svst) svst.textContent = vacStart===null? '—' : fmtMoneyUSD(vacStart);
  const svsta = document.getElementById('stat-vac-start-asof'); if(svsta) svsta.textContent = vacStart!==null? (firstWeek? 'As of '+fmtDateAsOf(firstWeek.date) : '') : (vacAcc? 'No balance entered' : 'No vacation account set');
  const svs = document.getElementById('stat-vacation-spent'); if(svs) svs.textContent = fmtMoneyUSD(vacSpent);
  const svc = document.getElementById('stat-vac-current'); if(svc) svc.textContent = vacCurrent===null? '—' : fmtMoneyUSD(vacCurrent);
  const svcWrap = document.getElementById('stat-vac-current-wrap'); if(svcWrap) svcWrap.classList.toggle('negative', vacCurrent!==null && vacCurrent<0);
  const svca = document.getElementById('stat-vac-current-asof'); if(svca) svca.textContent = vacRecentInfo? 'As of '+fmtDateAsOf(vacRecentInfo.date) : (vacAcc? 'No balance entered' : 'No vacation account set');
}
