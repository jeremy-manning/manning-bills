
/* ===== STATE ===== */
const SCHEMA_VERSION = 1;
const GROUP_DEFAULTS = ['Tithe','Housing','Utilities','Credit Cards','Cars'];
var STATE = null;          // canonical shared state (mirrors last published/loaded data)
var VIEW_VERSION_TOKEN = null; // opaque marker of the version this view loaded, for conflict UX
var UI = {
  tab: 'tracker',          // tracker | reference | trends
  year: null,
  month: null,
  unlocked: false,
  saving: false,
  dirty: false,
  lastSavedAt: null,
};
var artifactCap = null;    // resolved claude.use('artifact') namespace, or null
var downloadsCap = null;
var saveTimer = null;

function freshState(){
  return {
    schema: SCHEMA_VERSION,
    savedAt: null,
    savedSeq: 0,
    years: {},
    billsReference: [],
    backups: [],
    nextId: 1,
  };
}

function seedState(){
  const s = freshState();
  s.years = JSON.parse(JSON.stringify(SEED_DATA.years));
  s.billsReference = JSON.parse(JSON.stringify(SEED_DATA.billsReference));
  // compute nextId above any embedded id
  let max = 0;
  const scan = (v)=>{ if(v && typeof v==='object'){ if(typeof v.id==='string'){ const m=/(\d+)$/.exec(v.id); if(m) max=Math.max(max, parseInt(m[1],10)); } for(const k in v) scan(v[k]); } };
  scan(s.years); scan(s.billsReference);
  s.nextId = max+1;
  s.savedAt = new Date().toISOString();
  return s;
}

function nextId(prefix){
  const n = STATE.nextId++;
  return prefix + n;
}

/* ===== UTIL ===== */
function fmtMoney(n){
  if(n===null || n===undefined || n==='' || isNaN(n)) return '';
  return Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
}
function fmtMoneyUSD(n){
  if(n===null || n===undefined || n==='' || isNaN(n)) return '—';
  const num = Number(n);
  return (num<0 ? '-$' : '$') + fmtMoney(Math.abs(num));
}
function moneyInputVal(n){
  if(n===null || n===undefined || n==='' ) return '';
  return Number(n).toFixed(2);
}
function parseMoney(str){
  if(str===null||str===undefined) return null;
  const t = String(str).trim();
  if(t==='') return null;
  const n = parseFloat(t.replace(/,/g,''));
  return isNaN(n) ? null : n;
}
function sum(arr){ return arr.reduce((a,b)=> a + (Number(b)||0), 0); }
function esc(str){
  if(str===null||str===undefined) return '';
  return String(str).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escAttr(str){ return esc(str); }
const MONTH_NUMS = ['01','02','03','04','05','06','07','08','09','10','11','12'];
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function monthLabel(y,m){ return MONTH_NAMES[parseInt(m,10)-1] + ' ' + y; }
function monthShort(m){ return MONTH_NAMES[parseInt(m,10)-1].slice(0,3); }

function fmtDateShort(iso){
  if(!iso) return '—';
  const [y,m,d] = iso.split('-').map(Number);
  return monthShort(String(m).padStart(2,'0')) + ' ' + d;
}
function fmtDateLong(iso){
  if(!iso) return '—';
  const [y,m,d] = iso.split('-').map(Number);
  return MONTH_NAMES[m-1] + ' ' + d + ', ' + y;
}
function todayISO(){
  const d = new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function isCurrentMonth(y,m){
  const d = new Date();
  return String(d.getFullYear())===String(y) && String(d.getMonth()+1).padStart(2,'0')===m;
}
function generateFridays(year, monthNum){
  const y = parseInt(year,10), m = parseInt(monthNum,10);
  const out = [];
  const d = new Date(Date.UTC(y, m-1, 1));
  while(d.getUTCMonth() === m-1){
    if(d.getUTCDay() === 5){
      out.push(d.toISOString().slice(0,10));
    }
    d.setUTCDate(d.getUTCDate()+1);
  }
  return out;
}
function deepClone(o){ return JSON.parse(JSON.stringify(o)); }

/* ===== DATA ACCESSORS ===== */
function years(){ return Object.keys(STATE.years).sort(); }
function getYear(y){ return STATE.years[y]; }
function months(y){ const yy = getYear(y); return yy ? Object.keys(yy.months).sort() : []; }
function getMonth(y,m){ const yy = getYear(y); return yy ? yy.months[m] : null; }

function allMonthsChrono(){
  // returns [{year,month,data}] ascending
  const out = [];
  for(const y of years()){
    for(const m of months(y)){
      out.push({year:y, month:m, data: getMonth(y,m)});
    }
  }
  return out;
}
function mostRecentMonth(){
  const all = allMonthsChrono();
  return all.length ? all[all.length-1] : null;
}
function allWeeksChrono(){
  // flattened list across all months, ascending, each {year,month,weekId,date}
  const out = [];
  for(const rec of allMonthsChrono()){
    for(const w of rec.data.weeks){
      out.push({year:rec.year, month:rec.month, weekId:w.id, date:w.date});
    }
  }
  out.sort((a,b)=> (a.date||'').localeCompare(b.date||'') || (a.year+a.month).localeCompare(b.year+b.month));
  return out;
}
function prevWeekEntry(y,m,weekId){
  const all = allWeeksChrono();
  const idx = all.findIndex(w=> w.year===y && w.month===m && w.weekId===weekId);
  if(idx<=0) return null;
  return all[idx-1];
}
function findAccountBalanceAt(y,m,accountName,weekId){
  const mo = getMonth(y,m);
  if(!mo) return null;
  const acc = mo.accounts.find(a=>a.name===accountName);
  if(!acc) return null;
  const v = acc.balances[weekId];
  return (v===undefined) ? null : v;
}

function getPrimaryAccount(mo){ return mo.accounts.find(a=>a.primary) || null; }
function getVacationAccount(mo){ return mo.accounts.find(a=>a.vacation) || null; }

function mostRecentBalanceInfo(mo, acc){
  for(let i=mo.weeks.length-1;i>=0;i--){
    const w = mo.weeks[i];
    const v = acc.balances[w.id];
    if(v!==null && v!==undefined && v!=='') return {weekId:w.id, date:w.date, value:v};
  }
  return null;
}

function itemMonthlyTotal(item, weeks){
  return sum(weeks.map(w=> item.weekly[w.id]));
}
function groupWeekTotal(group, weekId){
  return sum(group.items.map(it=> it.weekly[weekId]));
}
function groupMonthlyTotal(group, weeks){
  return sum(group.items.map(it=> itemMonthlyTotal(it, weeks)));
}
function grandWeekTotal(mo, weekId){
  return sum(mo.groups.map(g=> groupWeekTotal(g, weekId)));
}
function grandMonthlyTotal(mo){
  return sum(mo.groups.map(g=> groupMonthlyTotal(g, mo.weeks)));
}
function vacationWeekTotal(mo, weekId){
  let t=0;
  mo.groups.forEach(g=> g.items.forEach(it=>{ if(it.vacation){ const v=it.weekly[weekId]; if(v) t+=Number(v); } }));
  return t;
}
function vacationMonthlyTotal(mo){
  return sum(mo.weeks.map(w=> vacationWeekTotal(mo, w.id)));
}

function runningCheck(y, m, weekId){
  const mo = getMonth(y,m);
  const primary = getPrimaryAccount(mo);
  if(!primary) return null;
  const actual = primary.balances[weekId];
  if(actual===null || actual===undefined || actual==='') return null;
  const prevEntry = prevWeekEntry(y,m,weekId);
  if(!prevEntry) return null;
  const prevBal = findAccountBalanceAt(prevEntry.year, prevEntry.month, primary.name, prevEntry.weekId);
  if(prevBal===null || prevBal===undefined || prevBal==='') return null;
  const weekTotal = grandWeekTotal(mo, weekId);
  const expected = Number(prevBal) - weekTotal;
  const variance = Number(actual) - expected;
  let status = 'good';
  if(Math.abs(variance) >= 100) status='critical';
  else if(Math.abs(variance) >= 15) status='warn';
  return {expected, actual:Number(actual), variance, status, prevBal:Number(prevBal), weekTotal};
}
