// Access control: what the page does before anyone has proved who they are.
// These are the assertions that matter most — the handoff build failed every
// one of them, because the ledger was readable by anyone holding the URL.
const {load, check, section, report} = require('./test_harness');

const LEDGER = {main:{version:7, data:{schema:1, savedAt:'2026-09-01T01:06:38.081Z', savedSeq:175,
  years:{'2026':{months:{'08':{label:'August 2026',weeks:[],accounts:[],groups:[]}}}},
  billsReference:[{id:'ref1',name:'Bank of America',due:'Weekly',link:'https://x'}], backups:[], nextId:2}}};

(async () => {

section('No session');
{
  const s = load({rows:LEDGER, session:null, member:false});
  const ready = await s.boot();
  check(ready === false, 'loadInitialState reports not-ready so init() renders nothing');
  check(s.STATE === null, 'STATE is never populated without a session');
  const fetched = s.__calls.select.filter(c => c.table === 'state');
  check(fetched.length === 0, 'the ledger table is not even queried without a session');
  check(s.document.getElementById('app').innerHTML.includes('Sign in to view the ledger'),
        'the sign-in gate is painted over the page');
}

section('Signed in, not on the allowlist');
{
  const s = load({rows:LEDGER, session:{user:{email:'stranger@example.com'}}, member:false});
  const ready = await s.boot();
  check(ready === false, 'a non-member is not ready');
  check(s.STATE === null, 'a non-member never receives ledger data');
  check(s.IS_MEMBER === false, 'membership is false when the allowlist read returns nothing');
  const html = s.document.getElementById('app').innerHTML;
  check(html.includes('Not authorised yet'), 'the not-authorised gate is shown');
  check(html.includes('Check again'), 'the primary action is Check again, not Sign out');
  check(html.indexOf('Check again') < html.indexOf('Sign out'),
        'Check again precedes Sign out, so the obvious click keeps the session');
}

section('Signed in and allowlisted');
{
  const s = load({rows:LEDGER, session:{user:{email:'member@example.com'}}, member:true});
  const ready = await s.boot();
  check(ready === true, 'a member is ready to render');
  check(s.STATE && s.STATE.savedSeq === 175, 'the shared ledger is adopted as STATE');
  check(s.stateVersion === 7, 'the row version is captured for the stale-write guard');
  check(s.signedInEmail() === 'member@example.com', 'the signed-in address is reported');
  check(s.__calls.channel.length === 1, 'a realtime subscription is opened');
}

section('Membership is decided server-side');
{
  const s = load({rows:LEDGER, session:{user:{email:'a@b.c'}}, member:true});
  await s.initCapabilities();
  await s.refreshSession();
  const probe = s.__calls.select.find(c => c.table === 'allowed_emails');
  check(!!probe, 'membership is checked by querying the RLS-gated allowlist');
  check(s.IS_MEMBER === true, 'a returned row is what proves membership');
  // Nothing in the module decides access from local state:
  const src = require('fs').readFileSync(__dirname + '/app_persist_static.js','utf8');
  check(!/passwordHash|sha256Hex/.test(src), 'no password hashing remains in the client');
}

section('Client configuration');
{
  const s = load({rows:LEDGER, session:null, member:false});
  await s.initCapabilities();
  check(s.__clientOpts.db.schema === 'bills', 'the client is pinned to the bills schema');
  check(s.__clientOpts.auth.detectSessionInUrl === true, 'magic-link redirects are completed');
  check(s.__clientOpts.auth.persistSession === true, 'sessions persist so links are rarely needed');
}

section('Sign out clears the local mirror');
{
  const s = load({rows:LEDGER, session:{user:{email:'m@e.c'}}, member:true});
  await s.boot();
  check(s.localStorage.getItem('manning-bills-mirror-v1') !== null, 'a local mirror is written when signed in');
  await s.signOut();
  check(s.localStorage.getItem('manning-bills-mirror-v1') === null,
        'signing out removes the mirrored ledger from the browser');
}

report();
})();
