/* logan.test.js — Logan's provider-agnostic pieces: the Gemini schema
   converter and the tool-activity labels. The actual API calls (Anthropic
   and Gemini both) need a real browser and a real key — not exercised here.
   part of Odysseus */
const {load} = require('./harness');
const app = load(['logan.js']);
const {toGeminiSchema, LG_TOOLS, GEMINI_TOOLS, lgToolLabel} = app;

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
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'logan.js'), 'utf8'), ctx, {filename:'logan.js'});
  // top-level const/let live in the lexical scope, not on the context object
  // (see harness.js's own note on this) — expose the two names this block needs
  vm.runInContext('Object.assign(globalThis, {lgCfg, lgActiveKey});', ctx, {filename:'<expose>'});

  check('the old key lands as anthropicKey', ctx.lgCfg.anthropicKey, 'sk-ant-old');
  check('the old model lands as anthropicModel', ctx.lgCfg.anthropicModel, 'claude-sonnet-5');
  check('a migrated config defaults to the anthropic provider', ctx.lgCfg.provider, 'anthropic');
  check('lgActiveKey reads the migrated field', ctx.lgActiveKey(), 'sk-ant-old');
}
