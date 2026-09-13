/* harness.js — loads VL's browser files into a Node sandbox so they can be tested
   directly. This is what splitting the app bought us: the maths used to be
   trapped inside a 5,000-line HTML file and had to be scraped out to be tested.

   Usage:  const {load} = require('./harness');
           const app = load(['indicators.js', 'backtest.js']);
   part of VL */
const fs = require('fs'), path = require('path'), vm = require('vm');

const JS_DIR = path.join(__dirname, '..', 'js');

// Enough of a browser for the pure-logic files. Anything that really needs the
// DOM belongs in a browser test, not here — the stub stays deliberately thin so
// a file that quietly depends on the DOM fails loudly instead of passing on a lie.
function browserStub(){
  const storage = (()=>{ const m = {}; return {
    getItem: k => (k in m ? m[k] : null),
    setItem: (k,v) => { m[k] = String(v); },
    removeItem: k => { delete m[k]; },
    clear: () => { for(const k in m) delete m[k]; },
  };})();
  const ctx = {
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, Promise, Set, Map,
    isNaN, parseFloat, parseInt, setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: storage,
    location: {protocol: 'http:', href: 'http://localhost/'},
    fetch: async () => { throw new Error('fetch is not available in the test harness'); },
    navigator: {clipboard: {writeText: async()=>{}}},
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
      createElement: () => ({style:{}, classList:{add(){},remove(){}}, appendChild(){}, setAttribute(){}}),
      addEventListener: () => {},
    },
    addEventListener: () => {},
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return ctx;
}

/*  Top-level `const` and `let` live in the global LEXICAL scope, which is not
    the same thing as the global object — exactly as in a browser. Functions and
    `var`s show up on the context by themselves; TFS, HORIZONS, FRAME_UNIT and
    friends do not, so they are copied across explicitly after loading.       */
const DECL = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\s*(?==|;)/gm;
function topLevelNames(src){
  const names = [];
  let m;
  while ((m = DECL.exec(src))) for (const n of m[1].split(',')) names.push(n.trim());
  return names;
}

function load(files){
  const ctx = vm.createContext(browserStub());
  const names = new Set();
  for (const f of files){
    const src = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
    vm.runInContext(src, ctx, {filename: f});
    topLevelNames(src).forEach(n => names.add(n));
  }
  if (names.size)
    vm.runInContext(`Object.assign(globalThis, {${[...names].join(', ')}});`, ctx, {filename:'<expose>'});
  return ctx;
}

module.exports = {load, JS_DIR};
