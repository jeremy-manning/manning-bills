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
  check(/if\(!UI\.dirty\) return;/.test(flush) && /doSave\(\)/.test(flush),
        'flushPendingSave saves a dirty ledger even with no timer pending');
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
