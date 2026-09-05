// Saving: the version guard, the stale-tab path, and the realtime handler.
const {load, check, section, report} = require('./test_harness');

const mkLedger = (version, seq) => ({main:{version, data:{
  schema:1, savedAt:'2026-09-01T01:06:38.081Z', savedSeq:seq,
  years:{'2026':{months:{'08':{label:'August 2026',weeks:[],accounts:[],groups:[]}}}},
  billsReference:[], backups:[], nextId:2}}});

const settle = () => new Promise(r => setTimeout(r, 20));

(async () => {

section('A normal save');
{
  const s = load({rows:mkLedger(7,175), session:{user:{email:'m@e.c'}}, member:true});
  await s.boot();
  s.STATE.years['2026'].months['08'].label = 'August 2026 (edited)';
  await s.doSave(); await settle();

  const up = s.__calls.update[0];
  check(!!up, 'an update was issued');
  check(up.filters.id === 'main', 'scoped to the ledger row');
  check(up.filters.version === 7, 'conditional on the version this tab loaded');
  check(s.stateVersion === 8, 'the tab tracks the new version after a successful write');
  check(s.__rows.main.data.savedSeq === 176, 'savedSeq advanced in the stored row');
  check(s.UI.dirty === false, 'the edit is marked saved');
}

section('A stale tab is refused, not allowed to overwrite');
{
  const s = load({rows:mkLedger(7,175), session:{user:{email:'m@e.c'}}, member:true});
  await s.boot();

  // Someone else writes while this tab sits open.
  s.__rows.main.version = 9;
  s.__rows.main.data = {...s.__rows.main.data, savedSeq: 200, marker:'newer'};

  s.STATE.years['2026'].months['08'].label = 'stale edit';
  await s.doSave(); await settle();

  check(s.__rows.main.data.marker === 'newer', "the other person's write survives — no clobber");
  check(s.__rows.main.data.savedSeq === 200, 'the stored savedSeq is still theirs, not ours');
  check(s.STATE.savedSeq === 200, 'the stale tab reloaded the current ledger');
  check(s.stateVersion === 9, 'the tab picked up the current version');
  check(s.UI.dirty === false, 'the rejected edit is not left falsely pending');
  const said = s.__calls.toasts.join(' | ');
  check(/out of date/i.test(said), 'the user is told the page was out of date');
  check(/not saved|redo/i.test(said), 'and told their change was not saved');
}

section('First write when the row does not exist');
{
  const s = load({rows:{}, session:{user:{email:'m@e.c'}}, member:true});
  await s.boot(); await settle();
  check(s.__calls.insert.length === 1, 'an insert is used when there is no row yet');
  check(s.__calls.update.length === 0, 'no conditional update is attempted against a missing row');
  check(s.__rows.main && s.__rows.main.version === 1, 'the row is created at version 1');
}

section('Realtime: adopting the other person\'s save');
{
  const s = load({rows:mkLedger(7,175), session:{user:{email:'m@e.c'}}, member:true});
  await s.boot();
  const ch = s.__realtime;
  check(ch._cfg.schema === 'bills', 'subscribed on the bills schema');
  check(ch._cfg.table === 'state', 'subscribed to the ledger table');
  check(ch._cfg.filter === 'id=eq.main', 'filtered to the one row');

  // newer save from elsewhere
  ch._cb({new:{version:9, data:{...s.STATE, savedSeq:180, marker:'theirs'}}});
  check(s.STATE.savedSeq === 180, 'a newer save is adopted');
  check(s.stateVersion === 9, 'the version tracks the pushed row');

  // our own echo must be ignored
  const before = s.__calls.renderAll;
  ch._cb({new:{version:10, data:{...s.STATE, savedSeq:s.lastWrittenSeq}}});
  check(s.__calls.renderAll === before, 'our own echoed write does not re-render');

  // an older push must be ignored
  ch._cb({new:{version:11, data:{...s.STATE, savedSeq:2, marker:'older'}}});
  check(s.STATE.savedSeq === 180, 'an older push is ignored');
}

section('Realtime never clobbers an in-progress edit');
{
  const s = load({rows:mkLedger(7,175), session:{user:{email:'m@e.c'}}, member:true});
  await s.boot();
  s.UI.dirty = true;                       // user is mid-edit
  s.__realtime._cb({new:{version:9, data:{...s.STATE, savedSeq:999, marker:'theirs'}}});
  check(s.STATE.savedSeq === 175, 'an unsaved local edit is not overwritten by a push');
}

report();
})();
