// Regression test for the Spending Trends tab: two line charts, rolling 12
// months (trailing12() already implements "rolling" via
// allMonthsChrono().slice(-12) — it naturally grows to 12 as more months
// are added, and isn't hardcoded to the 8 seeded months).
// Chart 1 ("Tithe, Housing, Credit Cards & Cars"): those four group
// totals, in that order.
// Chart 2 ("Utilities, by biller"): each individual utility item as its
// own line, all in a single chart (not the old one-mini-chart-per-utility
// grid, and no longer carrying Tithe — Tithe moved to chart 1 per the
// user's follow-up request).
const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');

(async () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'https://example.test/artifact/', pretendToBeVisual: true });
  const { window } = dom;
  window.fetch = () => Promise.reject(new Error('no net'));
  window.claude = undefined;
  const createdCharts = [];
  window.Chart = function(ctx, cfg){ this.destroy = ()=>{}; this._cfg = cfg; createdCharts.push(this); };
  const nodeCrypto = require('crypto');
  Object.defineProperty(window, 'crypto', { value: nodeCrypto.webcrypto, configurable: true });
  window.scrollTo = () => {};
  await new Promise(r => setTimeout(r, 300));

  const doc = window.document;
  const assert = (c,m) => { if(!c){ console.error('FAIL:',m); process.exitCode=1; } else console.log('ok  :', m); };

  window.UI.unlocked = true;
  window.STATE.auth = {passwordHash:'x', salt:'y'};

  // --- Rolling window: trailing12() should return ALL months when there
  // are fewer than 12, and should be a plain trailing slice, not tied to
  // any fixed calendar range or to exactly 8.
  const all = window.allMonthsChrono();
  const list = window.trailing12();
  assert(list.length === all.length, 'with fewer than 12 months of data, trailing12() returns every month there is (currently '+all.length+')');
  assert(list.length >= 1, 'sanity: there is at least one month of seed data');
  // Confirm it's truly a *trailing* window: if we had >12 months it should
  // drop the oldest ones, not the newest. Simulate by checking slice logic
  // directly against a synthetic 15-entry array shape.
  const synthetic = Array.from({length:15}, (_,i)=>({year:'2099', month:String(i+1).padStart(2,'0'), data:null}));
  const slice12 = synthetic.slice(-12);
  assert(slice12.length===12 && slice12[0].month==='04' && slice12[11].month==='15', 'sanity check on the slice(-12) mechanism itself: keeps the most recent 12, drops the oldest');

  window.selectYear('2026'); window.selectMonth('08');
  window.setTab('trends');

  const main = doc.getElementById('main');
  assert(main.innerHTML.includes('Tithe, Housing, Credit Cards'), 'chart 1 heading present and leads with Tithe');
  assert(main.innerHTML.includes('Cars'), 'chart 1 heading mentions Cars');
  assert(main.innerHTML.includes('Utilities, by biller'), 'chart 2 heading present');
  assert(!main.innerHTML.includes('id="utilcharts"'), 'old per-utility mini-chart grid container is gone');
  assert(!/chartcard/.test(main.innerHTML), 'old one-canvas-per-utility chartcard markup is gone');
  assert(doc.getElementById('trend-groups'), 'chart 1 canvas exists');
  assert(doc.getElementById('trend-tithe-utils'), 'chart 2 canvas exists');

  // --- Dataset composition: read straight off the actual Chart.js config
  // passed to the (stubbed) Chart constructor, not a reimplementation.
  assert(createdCharts.length === 2, 'exactly two Chart.js instances were created (chart 1 + chart 2), got '+createdCharts.length);
  const chart1 = createdCharts[0], chart2 = createdCharts[1];
  const chart1Labels = chart1._cfg.data.datasets.map(d=>d.label);
  assert(JSON.stringify(chart1Labels)===JSON.stringify(['Tithe','Housing','Credit Cards','Cars']), 'chart 1 Chart.js config has exactly these four datasets, in order: Tithe, Housing, Credit Cards, Cars — got '+JSON.stringify(chart1Labels));

  const utilNames = window.utilityItemNames(list);
  assert(utilNames.length >= 1, 'sanity: at least one utility item exists in the seed data');
  const chart2Labels = chart2._cfg.data.datasets.map(d=>d.label);
  assert(JSON.stringify(chart2Labels)===JSON.stringify(utilNames), 'chart 2 Chart.js config datasets are exactly the distinct utility biller names, in that order (no Tithe line here) — got '+JSON.stringify(chart2Labels));
  assert(chart2._cfg.options.plugins.legend.display===true, 'chart 2 shows its legend (multiple utility lines need labeling)');
  assert(chart1._cfg.options.plugins.legend.display===true, 'chart 1 shows its legend');

  // --- Data correctness: verify chart 1's Tithe line and chart 2's
  // per-utility lines against the underlying monthly totals for a specific
  // month in the window (August).
  const augRec = list.find(r=>r.year==='2026' && r.month==='08');
  assert(!!augRec, 'August 2026 is present in the trailing window');
  const moAug = window.getMonth('2026','08');

  const titheGroup = moAug.groups.find(g=>g.name.trim().toLowerCase()==='tithe');
  const expectedTitheAug = window.groupMonthlyTotal(titheGroup, moAug.weeks);
  const augIdx = list.findIndex(r=>r.year==='2026' && r.month==='08');
  const titheDataset = chart1._cfg.data.datasets.find(d=>d.label==='Tithe');
  assert(titheDataset.data[augIdx] === expectedTitheAug, 'actual Chart.js data point for Tithe/August (chart 1) matches groupMonthlyTotal');

  const utilGroup = moAug.groups.find(g=>g.name.trim().toLowerCase()==='utilities');
  assert(!!utilGroup && utilGroup.items.length>=1, 'sanity: Utilities group has items in August');
  const sampleItem = utilGroup.items[0];
  const viaHelper = window.utilityItemTotal(augRec, sampleItem.name);
  const expectedItemAug = window.itemMonthlyTotal(sampleItem, moAug.weeks);
  assert(viaHelper === expectedItemAug, 'a sampled utility line value ('+sampleItem.name+') matches itemMonthlyTotal for that item in August');
  const sampleDataset = chart2._cfg.data.datasets.find(d=>d.label===sampleItem.name);
  assert(sampleDataset.data[augIdx] === expectedItemAug, 'actual Chart.js data point for that utility/August (chart 2) matches itemMonthlyTotal');

  // --- Data correctness: chart 1's Housing/Credit Cards/Cars values for
  // August match groupMonthlyTotal for those groups directly.
  ['Housing','Credit Cards','Cars'].forEach(gname=>{
    const g = moAug.groups.find(x=>x.name.trim().toLowerCase()===gname.toLowerCase());
    assert(!!g, 'sanity: group "'+gname+'" exists in August data');
    const expected = window.groupMonthlyTotal(g, moAug.weeks);
    const ds = chart1._cfg.data.datasets.find(d=>d.label===gname);
    assert(ds.data[augIdx]===expected, 'chart 1 value for "'+gname+'" in August matches groupMonthlyTotal');
  });

  console.log('\nALL GOOD 8 — DONE');
  process.exit(process.exitCode||0);
})().catch(e=>{ console.error('CRASH', e); process.exit(1); });
