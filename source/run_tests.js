#!/usr/bin/env node
// Runs the whole suite. No dependencies, no npm install: `node run_tests.js`.
const {execFileSync} = require('child_process');
const files = ['test_access.js','test_saving.js','test_build.js'];
let failed = 0;
for(const f of files){
  console.log('\n' + '='.repeat(60) + '\n' + f + '\n' + '='.repeat(60));
  try{ execFileSync(process.execPath, [__dirname + '/' + f], {stdio:'inherit'}); }
  catch(e){ failed++; }
}
console.log('\n' + '='.repeat(60));
console.log(failed ? `${failed} test file(s) FAILED` : 'All test files passed.');
process.exit(failed ? 1 : 0);
