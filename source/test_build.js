// What ships. The handoff build inlined the live ledger and all 14 banking
// usernames into dist_static/index.html — the file the deploy guide told you
// to upload publicly. Nothing caught it, because nothing looked. This does.
const fs = require('fs');
const {check, section, report} = require('./test_harness');

const page = fs.readFileSync(__dirname + '/../dist_static/index.html', 'utf8');

section('The published page carries no household data');
{
  // Structural markers: these appear in the real ledger and nowhere else.
  for(const marker of ['"login"', 'passwordHash', '"balances":{"w', '"accounts":[{"id":"acc']){
    check(!page.includes(marker), `no ${marker} in the built page`);
  }
  const seed = /const SEED_DATA = (\{.*?\});/s.exec(page);
  check(!!seed, 'SEED_DATA is present');
  const parsed = JSON.parse(seed[1]);
  check(Object.keys(parsed.years).length === 0, 'SEED_DATA ships no months');
  check(parsed.billsReference.length === 0, 'SEED_DATA ships no billers');
}

section('No third-party code is fetched at runtime');
{
  const external = page.match(/<script[^>]*\ssrc="(https?:)?\/\/[^"]*"/gi) || [];
  check(external.length === 0, 'no external <script> tags: ' + JSON.stringify(external));
  check(page.includes('<script id="supabaselib">'), 'supabase-js is inlined, not linked');
  check(page.includes('<script id="chartlib">'), 'chart.js is inlined, not linked');
}

section('The page is wired to the right place');
{
  const cfg = fs.readFileSync(__dirname + '/../dist_static/supabase-config.js', 'utf8');
  check(/SUPABASE_SCHEMA\s*=\s*'bills'/.test(cfg), 'config targets the bills schema');
  check(!/YOUR_/.test(cfg), 'config has no placeholder values left');
  check(!/service_role|secret|sb_secret/i.test(cfg), 'no secret key in the shipped config');
  check(/sb_publishable_/.test(cfg), 'uses a publishable key, which is safe to ship');
}

section('The lock is a UX guard, not a security control');
{
  // Worth stating explicitly: UI.unlocked must never be what protects data.
  const persist = fs.readFileSync(__dirname + '/app_persist_static.js', 'utf8');
  check(!/sha256|passwordHash|randomSalt/.test(persist), 'no client-side credential checking');
  check(/IS_MEMBER/.test(persist), 'access is gated on server-confirmed membership');
}

report();
