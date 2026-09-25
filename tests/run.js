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
// a function that must reject its input — "returned something odd" and "refused"
// are different outcomes, and only one of them is the contract
global.throws = (label, fn) => {
  let threw = false;
  try{ fn(); }catch(e){ threw = true; }
  global.check(label, threw, true);
};
// floating point: 7 and 7.000000000000001 are the same answer
global.near = (label, got, want, tol) => {
  const ok = typeof got === 'number' && Math.abs(got - want) <= (tol === undefined ? 1e-9 : tol);
  if (ok){ pass++; console.log('  ok   ' + label); }
  else { fail++; failures.push(`${current} \u203a ${label}\n       expected ~${want}\n       got      ${got}`);
         console.log('  FAIL ' + label); }
};

/*  Asynchronous suites.

    Everything here used to be synchronous, and a test file that wrapped itself
    in an async IIFE registered exactly zero assertions and reported a clean
    pass — the worst possible failure mode for a test runner. The agent loop is
    async end to end (it awaits the model, awaits each tool, and now awaits a
    human pressing a button), so it cannot be tested any other way.

    `later(fn)` queues a block to run after every file has been loaded, in
    registration order. Assertions inside it count exactly as they do anywhere
    else; the only rule is that a suite() called inside a later() block names
    the output from that point on, which is why they run one at a time rather
    than concurrently.                                                        */
const deferred = [];
global.later = fn => { deferred.push(fn); };

const filter = process.argv[2];
const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js'))
                .filter(f => !filter || f.includes(filter));
for (const f of files) require(path.join(__dirname, f));

(async ()=>{
  for (const fn of deferred){
    try{ await fn(); }
    catch(e){
      fail++;
      failures.push(`${current} › threw out of an async suite\n       ${e && e.stack || e}`);
      console.log('  FAIL (threw) ' + (e && e.message));
    }
  }

  console.log('\n' + '-'.repeat(52));
  if (failures.length){ console.log('\n' + failures.join('\n\n') + '\n'); }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
