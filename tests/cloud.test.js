/* cloud.test.js — the sync's judgement and the config paste.

   cloudDecide is the piece worth pinning down: it is the only code in the app
   that can silently replace a journal someone spent months filling in. The
   network, the clock and Firestore are all deliberately outside it, so every
   case below is a plain call with no mocking.
   part of Odysseus */
const {load} = require('./harness');
const app = load(['cloud.js', 'logan.js']);
const {cloudDecide, cloudParseConfig, CLOUD_KEYS, vlPut, lgIsUserTurn} = app;
const storage = app.localStorage;   // the harness's stub, not anything Node provides

/* ---------- cloudDecide ---------- */

suite('cloudDecide — an empty server');
check('first machine ever: local goes up',
      cloudDecide('{"a":1}', 500, 0, null), 'push');
check('nothing local and nothing remote is not an error, just nothing to do',
      cloudDecide(null, 0, 0, null), 'skip');

suite('cloudDecide — the two sides already agree');
check('identical values need no traffic',
      cloudDecide('{"a":1}', 900, 100, {value:'{"a":1}', at:100}), 'same');
check('agreement wins even when both sides think they changed',
      cloudDecide('{"a":1}', 900, 0, {value:'{"a":1}', at:800}), 'same');

suite('cloudDecide — only one side moved');
check('a local edit since the last sync goes up',
      cloudDecide('{"a":2}', 900, 100, {value:'{"a":1}', at:100}), 'push');
check('a remote edit since the last sync comes down',
      cloudDecide('{"a":1}', 100, 100, {value:'{"a":2}', at:900}), 'pull');

suite('cloudDecide — a machine that has never synced this key');
// the case that matters most: a second laptop signing in for the first time.
// Nothing local is newer than a sync that never happened, so the server wins.
check('a fresh machine adopts the server copy',
      cloudDecide('{"stale":true}', 0, 0, {value:'{"real":true}', at:900}), 'pull');
check('...and an empty fresh machine does too',
      cloudDecide(null, 0, 0, {value:'{"real":true}', at:900}), 'pull');

suite('cloudDecide — both sides moved since the last agreement');
check('the later local edit stands',
      cloudDecide('{"a":2}', 900, 100, {value:'{"a":3}', at:500}), 'push');
check('the later remote edit stands',
      cloudDecide('{"a":2}', 500, 100, {value:'{"a":3}', at:900}), 'pull');
check('an exact tie resolves to the local copy rather than flapping',
      cloudDecide('{"a":2}', 700, 100, {value:'{"a":3}', at:700}), 'push');

/* ---------- what is allowed to leave the machine ---------- */

suite('CLOUD_KEYS — caches and secrets');
{
  const keys = CLOUD_KEYS.map(e=>e.k);
  check('the journal syncs', keys.includes('vl.journal.v1'), true);
  check("Logan's memory syncs", keys.includes('vl.logan.chat.v1'), true);
  check('the coin-name cache never leaves the machine', keys.includes('vl.coins.v2'), false);
  check('the why cache never leaves the machine', keys.includes('vl.why.v1'), false);

  const secrets = CLOUD_KEYS.filter(e=>e.secret).map(e=>e.k).sort();
  check('exactly the two credential-bearing keys are marked secret',
        secrets, ['vl.alerts.v1', 'vl.logan.v1']);
}

/* ---------- the write funnel ---------- */

suite('vlPut — writes through and stamps');
{
  const ok = vlPut('vl.journal.v1', '[1,2,3]');
  check('the value actually reaches storage', storage.getItem('vl.journal.v1'), '[1,2,3]');
  check('it reports success like the try/catch it replaced', ok, true);
  const meta = JSON.parse(storage.getItem('vl.cloud.meta.v1'));
  check('the local edit is stamped so the sync can see it',
        typeof meta.local['vl.journal.v1'], 'number');
}

/* ---------- the Firebase config paste ---------- */

suite('cloudParseConfig — what the console actually gives you');
{
  // the real thing is a JS object literal inside an assignment, not JSON
  const pasted = `const firebaseConfig = {
    apiKey: "AIzaSyExample",
    authDomain: "odysseus-1234.firebaseapp.com",
    projectId: "odysseus-1234",
    storageBucket: "odysseus-1234.appspot.com",
    messagingSenderId: "123456789",
    appId: "1:123:web:abc"
  };`;
  const cfg = cloudParseConfig(pasted);
  check('bare keys are quoted and the object parses', cfg.projectId, 'odysseus-1234');
  check('the apiKey survives', cfg.apiKey, 'AIzaSyExample');
  check('the surrounding assignment and semicolon are ignored', cfg.appId, '1:123:web:abc');
}
check('plain JSON is accepted unchanged',
      cloudParseConfig('{"apiKey":"k","projectId":"p"}').projectId, 'p');
check('single quotes are tolerated',
      cloudParseConfig("{apiKey:'k', projectId:'p'}").apiKey, 'k');
check('a trailing comma is tolerated',
      cloudParseConfig('{"apiKey":"k","projectId":"p",}').projectId, 'p');
throws('an empty paste is rejected rather than saved as {}',
       ()=> cloudParseConfig('   '));
throws('text with no object in it is rejected',
       ()=> cloudParseConfig('go to the console and copy the thing'));

/* ---------- Logan's transcript trimming ---------- */

suite('lgIsUserTurn — an exchange boundary, not just role:user');
check('Anthropic user text opens an exchange',
      lgIsUserTurn({role:'user', content:'hello'}), true);
check('an Anthropic tool_result carrier does not',
      lgIsUserTurn({role:'user', content:[{type:'tool_result', tool_use_id:'x', content:'{}'}]}), false);
check('Gemini user text opens an exchange',
      lgIsUserTurn({role:'user', parts:[{text:'hello'}]}), true);
check('a Gemini functionResponse carrier does not',
      lgIsUserTurn({role:'user', parts:[{functionResponse:{name:'read_coin', response:{}}}]}), false);
check('an assistant turn is never a boundary',
      lgIsUserTurn({role:'assistant', content:'hi'}), false);
check('a model turn is never a boundary',
      lgIsUserTurn({role:'model', parts:[{text:'hi'}]}), false);
