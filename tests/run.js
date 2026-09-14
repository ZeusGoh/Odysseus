/* run.js — the test runner.  `node tests/run.js`  (add a name to filter)
   part of Odysseus */
const fs = require('fs'), path = require('path');

let pass = 0, fail = 0, current = '';
const failures = [];

global.suite = name => { current = name; console.log('\n' + name); };
global.check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok){ pass++; console.log('  ok   ' + label); }
  else { fail++; failures.push(`${current} › ${label}\n       expected ${JSON.stringify(want)}\n       got      ${JSON.stringify(got)}`);
         console.log('  FAIL ' + label); }
};
global.ok = (label, cond) => global.check(label, !!cond, true);
// floating point: 7 and 7.000000000000001 are the same answer
global.near = (label, got, want, tol) => {
  const ok = typeof got === 'number' && Math.abs(got - want) <= (tol === undefined ? 1e-9 : tol);
  if (ok){ pass++; console.log('  ok   ' + label); }
  else { fail++; failures.push(`${current} \u203a ${label}\n       expected ~${want}\n       got      ${got}`);
         console.log('  FAIL ' + label); }
};

const filter = process.argv[2];
const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js'))
                .filter(f => !filter || f.includes(filter));
for (const f of files) require(path.join(__dirname, f));

console.log('\n' + '-'.repeat(52));
if (failures.length){ console.log('\n' + failures.join('\n\n') + '\n'); }
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
