/* logan.test.js — Logan's provider-agnostic pieces: the Gemini schema
   converter and the tool-activity labels. The actual API calls (Anthropic
   and Gemini both) need a real browser and a real key — not exercised here.
   part of Odysseus */
const {load} = require('./harness');
const app = load(['cloud.js', 'logan.js']);   // logan persists through cloud.js's vlPut
const {toGeminiSchema, LG_TOOLS, GEMINI_TOOLS, lgToolLabel, lgErrorHint, lgApiError, lgTransient} = app;

suite('toGeminiSchema — type casing');
check('object becomes OBJECT', toGeminiSchema({type:'object', properties:{}}).type, 'OBJECT');
check('string becomes STRING', toGeminiSchema({type:'string'}).type, 'STRING');
check('array becomes ARRAY', toGeminiSchema({type:'array', items:{type:'string'}}).type, 'ARRAY');
check('nested items are converted too', toGeminiSchema({type:'array', items:{type:'integer'}}).items.type, 'INTEGER');
check('an unrecognised type is upper-cased rather than dropped',
      toGeminiSchema({type:'weird'}).type, 'WEIRD');
check('a schema with no type at all passes through with no type key',
      'type' in toGeminiSchema({description:'no type here'}), false);

suite('toGeminiSchema — structure is preserved, not just the type field');
{
  const src = {type:'object', properties:{
    symbol:{type:'string', description:'a ticker'},
    frame:{type:'string', enum:['1M','1W','1D','4H','1H']}
  }, required:['symbol']};
  const out = toGeminiSchema(src);
  check('properties survive with their own types converted',
        out.properties.symbol, {type:'STRING', description:'a ticker'});
  check('enum values pass through unchanged', out.properties.frame.enum, ['1M','1W','1D','4H','1H']);
  check('required list passes through unchanged', out.required, ['symbol']);
}

suite('GEMINI_TOOLS — every tool converts, and nothing slips through in lowercase');
{
  const decls = GEMINI_TOOLS[0].functionDeclarations;
  check('one declaration per Anthropic-shaped tool', decls.length, LG_TOOLS.length);
  check('names line up 1:1, same order', decls.map(d=>d.name), LG_TOOLS.map(t=>t.name));
  ok('every declaration carries its description forward',
     decls.every((d,i)=> d.description === LG_TOOLS[i].description));

  // walk every converted schema looking for a stray lowercase JSON-Schema type —
  // the one mistake that would make every real Gemini call fail at once
  const LOWER = new Set(['object','string','integer','number','boolean','array']);
  function findLowerType(node, bad){
    if(!node || typeof node !== 'object') return;
    if(typeof node.type === 'string' && LOWER.has(node.type)) bad.push(node.type);
    if(node.properties) Object.values(node.properties).forEach(p=>findLowerType(p, bad));
    if(node.items) findLowerType(node.items, bad);
  }
  const bad = [];
  decls.forEach(d=>findLowerType(d.parameters, bad));
  check('no lowercase JSON-Schema type leaked into a Gemini declaration', bad, []);
}

suite('lgToolLabel — the activity line the user watches Logan work through');
check('read_coin names the coin', lgToolLabel('read_coin', {symbol:'sol'}), 'reading SOL');
check('assess_trade includes the frame when given',
      lgToolLabel('assess_trade', {symbol:'btc', frame:'4H'}), 'grading the setup on BTC (4H)');
check('assess_trade without a frame omits the parenthetical',
      lgToolLabel('assess_trade', {symbol:'btc'}), 'grading the setup on BTC');
check('scan_market with no depth given has no coin count',
      lgToolLabel('scan_market', {}), 'sweeping the board');
check('an unknown tool name falls back to itself', lgToolLabel('mystery_tool', {}), 'mystery_tool');

suite('lgCfg — old single-provider saves migrate forward, not sideways');
{
  // this exercises the exact migration branch in logan.js's lgCfg initializer,
  // rather than re-implementing it, by loading the module against a harness
  // whose localStorage was seeded first with the pre-Gemini {key, model} shape
  const {load: loadFresh} = require('./harness');
  const fs = require('fs'), path = require('path'), vm = require('vm');
  // reuse harness's own context builder isn't exported, so seed through a tiny
  // wrapper script that writes localStorage before logan.js's own top-level runs
  const seed = `localStorage.setItem('vl.logan.v1', JSON.stringify({key:'sk-ant-old', model:'claude-sonnet-5'}));`;
  const ctx = vm.createContext((function(){
    const m = {};
    const storage = { getItem:k=>(k in m?m[k]:null), setItem:(k,v)=>{m[k]=String(v);},
                       removeItem:k=>{delete m[k];}, clear:()=>{for(const k in m) delete m[k];} };
    const c = {
      console, Math, Date, JSON, Object, Array, String, Number, Boolean, Promise, Set, Map,
      isNaN, parseFloat, parseInt, setTimeout, clearTimeout, setInterval, clearInterval,
      localStorage: storage, location:{protocol:'http:', href:'http://localhost/'},
      fetch: async()=>{ throw new Error('no fetch in tests'); },
      navigator:{clipboard:{writeText:async()=>{}}},
      document:{ getElementById:()=>null, querySelectorAll:()=>[], addEventListener:()=>{},
                 createElement:()=>({style:{}, classList:{add(){},remove(){}}, appendChild(){}, setAttribute(){}}) },
      addEventListener:()=>{}
    };
    c.window = c; c.globalThis = c;
    return c;
  })());
  vm.runInContext(seed, ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'cloud.js'), 'utf8'), ctx, {filename:'cloud.js'});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'logan.js'), 'utf8'), ctx, {filename:'logan.js'});
  // top-level const/let live in the lexical scope, not on the context object
  // (see harness.js's own note on this) — expose the two names this block needs
  vm.runInContext('Object.assign(globalThis, {lgCfg, lgActiveKey});', ctx, {filename:'<expose>'});

  check('the old key lands as anthropicKey', ctx.lgCfg.anthropicKey, 'sk-ant-old');
  check('the old model lands as anthropicModel', ctx.lgCfg.anthropicModel, 'claude-sonnet-5');
  check('a migrated config defaults to the anthropic provider', ctx.lgCfg.provider, 'anthropic');
  check('lgActiveKey reads the migrated field', ctx.lgActiveKey(), 'sk-ant-old');
}

suite('lgErrorHint — a refusal from the API is not a connection problem');
{
  // the real message Gemini returns when the free tier's window is spent
  const quota = lgApiError({error:{message:
    'You exceeded your current quota, please check your plan and billing details. '+
    '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, '+
    'limit: 20, model: gemini-3.6-flash Please retry in 52.044789132s.'}}, 429);
  const out = lgErrorHint(quota);
  ok('a quota refusal is named as a rate limit, not a failure to connect',
     /rate limited/i.test(out));
  ok('it says nothing is broken, because nothing is',
     /nothing is broken/i.test(out));
  ok('the retry delay is rounded into something readable', out.includes('53 seconds'));
  ok('it does not tell the user to go and serve the folder',
     !/python3 -m http\.server/.test(out));
}
{
  // an API that answered with a real complaint — a bad key, say
  const refused = lgApiError({error:{message:'API key not valid. Please pass a valid API key.'}}, 400);
  const out = lgErrorHint(refused);
  ok('the API\'s own wording is passed through', out.includes('API key not valid'));
  ok('a reached API is never blamed on the page origin',
     !/python3 -m http\.server/.test(out));
  check('an answered error is marked as having reached the API', refused.reached, true);
  check('the status is kept for the caller to branch on', refused.status, 400);
}
{
  // a call that never landed: fetch itself threw, so there is no status
  const dead = new TypeError('Failed to fetch');
  const out = lgErrorHint(dead);
  ok('a genuine connection failure still reports the underlying message',
     out.includes('Failed to fetch'));
  check('nothing marks it as reached', dead.reached, undefined);
}

suite('lgTransient — which failures are worth another knock');
{
  const busy = lgApiError({error:{message:
    'This model is currently experiencing high demand. Spikes in demand are usually temporary. '+
    'Please try again later.'}}, 503);
  ok('a high-demand refusal is transient', lgTransient(busy));
  const out = lgErrorHint(busy);
  ok('it is reported as their servers being busy, not as a failure to connect',
     /servers are busy/i.test(out));
  ok('it does not repeat the raw "could not reach the API" framing',
     !/could not reach/i.test(out));
  ok('it says a retry already happened, so the user is not told to do it twice',
     /tried twice/i.test(out));

  const quota = lgApiError({error:{message:'Quota exceeded, please retry in 52.0s.'}}, 429);
  ok('a quota refusal is NOT retried — the window has to pass', !lgTransient(quota));

  const badKey = lgApiError({error:{message:'API key not valid.'}}, 400);
  ok('a bad key is not transient either', !lgTransient(badKey));
}
