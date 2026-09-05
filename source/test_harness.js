// Minimal environment for exercising app_persist_static.js under plain node.
//
// The original suite drove the whole page through jsdom. That needed an npm
// install, so in practice the tests were never run. Everything worth asserting
// about persistence and access control is reachable by loading that one module
// with stubs for the handful of globals it borrows from app_core/app_render,
// so this harness has NO dependencies and runs on any node.

const fs = require('fs');
const vm = require('vm');
const path = require('path');

function makeElement(id){
  const el = {
    id, innerHTML:'', textContent:'', className:'', value:'', disabled:false,
    children:[], onclick:null, onsubmit:null, style:{},
    appendChild(c){ this.children.push(c); return c; },
    remove(){}, addEventListener(){}, removeEventListener(){},
    classList:{add(){},remove(){},contains(){return false;}},
    querySelector(){ return makeElement('q'); },
    querySelectorAll(){ return []; },
    focus(){}
  };
  return el;
}

function makeStorage(){
  const m = new Map();
  return {
    getItem:k=>(m.has(k)?m.get(k):null),
    setItem:(k,v)=>m.set(k,String(v)),
    removeItem:k=>m.delete(k),
    clear:()=>m.clear(),
    _map:m
  };
}

/**
 * Load app_persist_static.js into a fresh sandbox.
 * opts.rows       — initial contents of the fake bills.state table
 * opts.session    — auth session to report, or null
 * opts.member     — whether the RLS-gated allowlist read returns a row
 */
function load(opts = {}){
  const src = fs.readFileSync(path.join(__dirname,'app_persist_static.js'),'utf8');

  const calls = {
    select:[], update:[], insert:[], channel:[], signInWithOtp:[], signOut:0,
    renderAll:0, toasts:[], reload:0
  };
  const rows = JSON.parse(JSON.stringify(opts.rows || {}));
  const elements = {};
  const getEl = id => (elements[id] || (elements[id] = makeElement(id)));

  function queryBuilder(table){
    const state = {table, filters:{}};
    const api = {
      select(){ return api; },
      eq(col,val){ state.filters[col]=val; return api; },
      limit(){ calls.select.push({...state, kind:'limit'});
               return Promise.resolve(
                 table==='allowed_emails'
                   ? {data: opts.member ? [{email:'x@example.com'}] : [], error:null}
                   : {data:[], error:null}); },
      maybeSingle(){
        calls.select.push({...state, kind:'maybeSingle'});
        const r = rows[state.filters.id];
        return Promise.resolve({data: r ? {data:r.data, version:r.version} : null, error:null});
      },
      then(res){ // bare `await sb.from(x).select(y).eq(...)`
        calls.select.push({...state, kind:'bare'});
        const r = rows[state.filters.id];
        return Promise.resolve({data: r?[{data:r.data,version:r.version}]:[], error:null}).then(res);
      }
    };
    return api;
  }

  const sbStub = {
    from(table){
      return {
        select(cols){ const b = queryBuilder(table); b._cols = cols; return b; },
        update(payload){
          const st = {table, payload, filters:{}};
          const api = {
            eq(c,v){ st.filters[c]=v; return api; },
            select(){ calls.update.push(st);
              const row = rows[st.filters.id];
              if(!row || (st.filters.version !== undefined && row.version !== st.filters.version)){
                return Promise.resolve({data:[], error:null});      // stale write rejected
              }
              row.version += 1; row.data = payload.data;
              return Promise.resolve({data:[{version:row.version}], error:null});
            }
          };
          return api;
        },
        insert(payload){
          const st = {table, payload};
          return { select(){ calls.insert.push(st);
            rows[payload.id] = {data:payload.data, version:1};
            return Promise.resolve({data:[{version:1}], error:null}); } };
        }
      };
    },
    channel(name){ calls.channel.push(name);
      const ch = { on(evt,cfg,cb){ ch._cb=cb; ch._cfg=cfg; return ch; },
                   subscribe(){ sandbox.__realtime = ch; return ch; } };
      return ch; },
    auth: {
      getSession: async ()=>({data:{session: opts.session || null}}),
      signInWithOtp: async (a)=>{ calls.signInWithOtp.push(a); return {error:null}; },
      signOut: async ()=>{ calls.signOut++; return {error:null}; }
    }
  };

  const sandbox = {
    console,
    // config
    SUPABASE_URL:'https://example.supabase.co',
    SUPABASE_ANON_KEY:'sb_publishable_test',
    SUPABASE_SCHEMA:'bills', SUPABASE_TABLE:'state', SUPABASE_ROW_ID:'main',
    supabase:{ createClient:(url,key,o)=>{ sandbox.__clientOpts=o; return sbStub; } },
    // globals borrowed from the other modules
    STATE:null, UI:{dirty:false,saving:false,unlocked:false,lastSavedAt:null},
    VIEW_VERSION_TOKEN:'', saveTimer:null,
    esc:s=>String(s==null?'':s),
    renderAll:()=>{ calls.renderAll++; },
    seedState:()=>({schema:1,savedAt:new Date().toISOString(),savedSeq:0,years:{},billsReference:[],backups:[],nextId:1}),
    stashPendingEdit:()=>{},
    // browser
    localStorage: makeStorage(), sessionStorage: makeStorage(),
    document:{ getElementById:getEl, createElement:()=>makeElement('new'),
               querySelector:()=>makeElement('q'), body:makeElement('body') },
    window:{ location:{origin:'https://example.test', pathname:'/app/', href:'', reload:()=>{calls.reload++;} } },
    requestAnimationFrame:cb=>cb(), setTimeout, clearTimeout,
    __calls:calls, __rows:rows, __elements:elements
  };
  sandbox.window.localStorage = sandbox.localStorage;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, {filename:'app_persist_static.js'});
  // Mirror init()'s boot order: the client must exist before anything loads.
  sandbox.boot = async () => { await sandbox.initCapabilities(); return sandbox.loadInitialState(); };
  // Spy on toast(). Top-level declarations land on the sandbox global, so
  // reassigning it here is seen by the module's own internal calls too.
  sandbox.toast = msg => { calls.toasts.push(String(msg)); };
  return sandbox;
}

let pass=0, fail=0;
function check(cond, msg){
  if(cond){ pass++; console.log('  ok   ' + msg); }
  else { fail++; console.error('  FAIL ' + msg); }
}
function section(t){ console.log('\n' + t); }
function report(){
  console.log(`\n${pass} passed, ${fail} failed`);
  if(fail) process.exitCode = 1;
}
module.exports = {load, check, section, report};
