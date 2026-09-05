// Editing behaviour reported as irritating during a real bill-paying session:
//   1. the save indicator cycled while the cursor sat in a field
//   2. the scroll wheel silently changed amounts
const fs = require('fs');
const {load, check, section, report} = require('./test_harness');

const render = fs.readFileSync(__dirname + '/app_render.js','utf8');
const events = fs.readFileSync(__dirname + '/app_events.js','utf8');
const skeleton = fs.readFileSync(__dirname + '/skeleton.html','utf8');
const page = fs.readFileSync(__dirname + '/../dist_static/index.html','utf8');

section('Typing marks dirty but does not schedule a save');
{
  const s = load({rows:{}, session:null, member:false});
  s.UI.dirty = false;
  s.markDirty();
  check(s.UI.dirty === true, 'markDirty() marks the ledger unsaved');
  check(s.saveTimer === null, 'markDirty() starts no debounce timer');
}

section('Saves are scheduled on blur, not per keystroke');
{
  check(!/oninput="scheduleSave\(\)"/.test(render),
        'no text field schedules a save on every keystroke');
  check((render.match(/oninput="markDirty\(\)"/g) || []).length === 7,
        'all 7 text fields mark dirty instead');
  check(/onblur="renameAccount|onblur="renameItem|onblur="renameGroup/.test(render),
        'text fields still commit on blur');

  const moneyInput = /function onMoneyInput\(el\)\{[\s\S]*?\n\}/.exec(events)[0];
  check(/markDirty\(\)/.test(moneyInput), 'money cells mark dirty while typing');
  check(!/scheduleSave\(\)/.test(moneyInput), 'money cells do not schedule a save while typing');

  const moneyBlur = /function onMoneyBlur\(el\)\{[\s\S]*?\n\}/.exec(events)[0];
  check(/scheduleSave\(\)/.test(moneyBlur), 'leaving a money cell schedules the save');
}

section('An unsaved edit is still never lost');
{
  // markDirty() sets UI.dirty, which is what both safety nets consult.
  check(/UI\.dirty/.test(events.match(/function warnBeforeUnload[\s\S]*?\n\}/)[0]),
        'beforeunload still warns on unsaved edits');
  check(/flushPendingSave/.test(events), 'visibility change still flushes');
  const flush = /function flushPendingSave\(\)\{[\s\S]*?\n\}/.exec(
    fs.readFileSync(__dirname + '/app_persist_static.js','utf8'))[0];
  check(/if\(!UI\.dirty\) return;/.test(flush) && /doSave\(true\)/.test(flush),
        'flushPendingSave force-saves a dirty ledger even with no timer pending');
}

section('The save indicator cannot shift the toolbar');
{
  check(/\.savestate\{[^}]*min-width:15ch/.test(skeleton.replace(/\s+/g,' ')) ||
        /min-width:15ch/.test(skeleton),
        'the indicator reserves a fixed width');
  check(/white-space:nowrap/.test(skeleton), 'and never wraps');
  check(!/\.savestate\{[^}]*min-width:0/.test(skeleton), 'the old min-width:0 is gone');
}

section('The scroll wheel cannot change an amount');
{
  check(/addEventListener\('wheel'/.test(events), 'a wheel handler is installed');
  const wheel = /document\.addEventListener\('wheel'[\s\S]*?\{passive:true\}\);/.exec(events)[0];
  check(/el\.type === 'number'/.test(wheel), 'it targets number inputs');
  check(/\.blur\(\)/.test(wheel), 'it blurs the field rather than changing it');
  check(/passive:true/.test(wheel), 'it is passive, so the page still scrolls');
  check(!/preventDefault/.test(wheel), 'it does not suppress scrolling over the table');
}

section('Both fixes are actually in the built page');
{
  check(page.includes('markDirty'), 'markDirty ships');
  check(/addEventListener\('wheel'/.test(page), 'the wheel guard ships');
  check(/min-width:15ch/.test(page), 'the indicator width ships');
}

report();

// ---------------------------------------------------------------------------
// Regression: typing must not trigger repeated saves.
//
// Reported from a real session: the indicator "fires quickly over and over"
// while the cursor sits in a cell. Cause was markDirty() bumping editSeq,
// which doSave()'s completion path reads as "more edits arrived during the
// save" and answers with a 400ms follow-up — once per keystroke.
// ---------------------------------------------------------------------------
(async () => {
const {load, check, section, report} = require('./test_harness');
const LEDGER = {main:{version:3, data:{schema:1, savedAt:'2026-09-01T00:00:00.000Z', savedSeq:5,
  years:{'2026':{months:{'09':{label:'September 2026',weeks:[],accounts:[],groups:[]}}}},
  billsReference:[], backups:[], nextId:2}}};
const settle = ms => new Promise(r => setTimeout(r, ms));

section('Typing never triggers a write');
{
  const s = load({rows:LEDGER, session:{user:{email:'m@e.c'}}, member:true});
  await s.boot();
  const updatesBefore = s.__calls.update.length;

  for(let i=0;i<10;i++){ s.markDirty(); await settle(5); }
  await settle(700);                       // well past the 400ms follow-up window

  check(s.__calls.update.length === updatesBefore, 'ten keystrokes produce zero writes');
  check(s.saveTimer === null, 'no save timer is armed by typing');
  check(s.UI.dirty === true, 'but the ledger is correctly marked unsaved');
}

section('A timer armed before typing does not fire mid-entry');
{
  const s = load({rows:LEDGER, session:{user:{email:'m@e.c'}}, member:true});
  await s.boot();
  s.SAVE_DEBOUNCE_MS = 30;
  s.scheduleSave();          // as a blur would
  s.markDirty();             // user starts typing in the next cell
  await settle(120);         // the armed timer elapses

  check(s.__calls.update.length === 0, 'the pending save is held while typing');
  check(s.UI.dirty === true, 'the edit is still marked unsaved');
}

section('Leaving the field saves');
{
  const s = load({rows:LEDGER, session:{user:{email:'m@e.c'}}, member:true});
  await s.boot();
  s.markDirty();                       // typing
  s.STATE.years['2026'].months['09'].label = 'edited';
  s.scheduleSave(true);                // blur -> commit + immediate save
  await settle(60);
  check(s.__calls.update.length === 1, 'blur writes exactly once');
  check(s.UI.dirty === false, 'and the ledger is marked saved');
}

section('An unsaved edit is still forced out when the page goes away');
{
  const s = load({rows:LEDGER, session:{user:{email:'m@e.c'}}, member:true});
  await s.boot();
  s.markDirty();                       // typing, nothing committed
  s.STATE.years['2026'].months['09'].label = 'typed but not blurred';
  s.flushPendingSave();                // beforeunload / tab hidden
  await settle(60);
  check(s.__calls.update.length === 1, 'the flush forces a write despite the typing hold');
  check(s.__rows.main.data.years['2026'].months['09'].label === 'typed but not blurred',
        'the in-progress edit reached the database');
}

report();
})();

// ---------------------------------------------------------------------------
// Regression: a save must never re-trigger itself.
//
// doSave() used to call stashPendingEdit(), which commits the focused money
// cell via onMoneyBlur() -> scheduleSave(). That advanced editSeq past the
// mySeq captured at the top of doSave(), so finish() read it as "edits arrived
// during the save" and armed a 400ms follow-up -- which saved, and stashed,
// and armed again. An endless loop for as long as the cursor stayed in an
// amount cell.
// ---------------------------------------------------------------------------
(async () => {
const {load, check, section, report} = require('./test_harness');
const fs = require('fs');
const LEDGER = {main:{version:3, data:{schema:1, savedAt:'2026-09-01T00:00:00.000Z', savedSeq:5,
  years:{'2026':{months:{'09':{label:'September 2026',weeks:[],accounts:[],groups:[]}}}},
  billsReference:[], backups:[], nextId:2}}};
const settle = ms => new Promise(r => setTimeout(r, ms));
const persist = fs.readFileSync(__dirname + '/app_persist_static.js','utf8');

section('The save path does not commit the focused field');
{
  const body = /async function doSave\(force\)\{[\s\S]*?\n\}/.exec(persist)[0]
    .replace(/\/\*[\s\S]*?\*\//g,'')     // block comments
    .replace(/^\s*\/\/.*$/gm,'');         // line comments (the NOTE names it)
  check(!/stashPendingEdit\s*\(/.test(body),
        'doSave() contains no call to stashPendingEdit()');
  check(/stashPendingEdit/.test(fs.readFileSync(__dirname + '/app_events.js','utf8')),
        'stashPendingEdit still exists for the unload paths');
}

section('One commit produces exactly one write, even with focus in a cell');
{
  const s = load({rows:LEDGER, session:{user:{email:'m@e.c'}}, member:true});
  await s.boot();
  // Reinstate the old hazard: anything in the save path that commits the
  // focused cell would schedule another save. If doSave() ever calls it
  // again, this loops and the write count explodes.
  s.stashPendingEdit = () => { s.scheduleSave(); };
  s.STATE.years['2026'].months['09'].label = 'edited';
  s.scheduleSave(true);
  await settle(1500);
  check(s.__calls.update.length === 1,
        `exactly one write (got ${s.__calls.update.length})`);
  check(s.UI.dirty === false, 'and the ledger settles as saved');
}

section('The indicator settles instead of cycling');
{
  const s = load({rows:LEDGER, session:{user:{email:'m@e.c'}}, member:true});
  await s.boot();
  s.__calls.toasts.length = 0;
  s.markDirty(); s.markDirty(); s.markDirty();
  s.scheduleSave(true);
  await settle(1200);
  check(s.UI.dirty === false, 'dirty clears once the write lands');
  check(s.UI.saving === false, 'and saving is no longer in progress');
  check(s.__calls.update.length === 1, 'with a single write');
}

report();
})();
