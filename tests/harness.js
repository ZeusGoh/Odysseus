/* harness.js — loads Odysseus's browser files into a Node sandbox so they can be tested
   directly. This is what splitting the app bought us: the maths used to be
   trapped inside a 5,000-line HTML file and had to be scraped out to be tested.

   Usage:  const {load} = require('./harness');
           const app = load(['indicators.js', 'backtest.js']);
   part of Odysseus */
const fs = require('fs'), path = require('path'), vm = require('vm');

const JS_DIR = path.join(__dirname, '..', 'js');

// Enough of a browser for the pure-logic files. Anything that really needs the
// DOM belongs in a browser test, not here — the stub stays deliberately thin so
// a file that quietly depends on the DOM fails loudly instead of passing on a lie.
/*  `overrides` is merged over the stub before the context is created, so a
    caller that needs a real `fetch` (the MCP engine in mcp/engine.js) or a
    less thin DOM can swap those in without a second copy of the stub
    existing anywhere.                                                      */
function browserStub(overrides){
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
  Object.assign(ctx, overrides || {});
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return ctx;
}

/*  Top-level `const` and `let` live in the global LEXICAL scope, which is not
    the same thing as the global object — exactly as in a browser. Functions and
    `var`s show up on the context by themselves; TFS, HORIZONS, FRAME_UNIT and
    friends do not, so they are copied across explicitly after loading.

    A plain regex can't do this correctly: a line like
    `const data = {}, stoch = {}, states = {}, divsAll = {}, divNow = {};`
    has several declarators separated by commas that are themselves inside
    the initializers of earlier ones, so a single-shot regex only ever
    captures the first name. This scans each top-level const/let/var
    statement char-by-char, tracking bracket depth and string/comment state,
    and splits its declarator list on commas at depth 0 — no dependency
    needed since (checked) nothing in this codebase destructures at the
    top level. */
function topLevelNames(src){
  const names = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    if (i === 0 || src[i-1] === '\n') {
      const km = /^(?:const|let|var)\b/.exec(src.slice(i));
      if (km) {
        let j = i + km[0].length;
        let depth = 0, inStr = null, segStart = j;
        const segs = [];
        while (j < n) {
          const c = src[j];
          if (inStr) {
            if (c === '\\') { j += 2; continue; }
            if (c === inStr) inStr = null;
            j++; continue;
          }
          if (c === '"' || c === "'" || c === '`') { inStr = c; j++; continue; }
          if (c === '/' && src[j+1] === '/') { const nl = src.indexOf('\n', j); j = nl === -1 ? n : nl; continue; }
          if (c === '/' && src[j+1] === '*') { const e = src.indexOf('*/', j+2); j = e === -1 ? n : e+2; continue; }
          if (c === '(' || c === '[' || c === '{') { depth++; j++; continue; }
          if (c === ')' || c === ']' || c === '}') { depth--; j++; continue; }
          if (depth === 0 && c === ',') { segs.push(src.slice(segStart, j)); segStart = j+1; j++; continue; }
          if (depth === 0 && c === ';') { segs.push(src.slice(segStart, j)); j++; break; }
          j++;
        }
        for (const seg of segs) {
          const m = /^\s*([A-Za-z_$][\w$]*)/.exec(seg);
          if (m) names.push(m[1]);
        }
        i = j;
        continue;
      }
    }
    i++;
  }
  return names;
}

/*  Loads app files into an ALREADY-CREATED context. Split out of load() so the
    MCP engine can build its own context — real fetch, a less thin DOM — and
    still go through this exact loader. One implementation of the VM trick, not
    two, which is the same reason the engine does not reimplement the maths.

    A top-level const/let stays in the context's global LEXICAL scope, and later
    scripts run in the SAME context can both read and assign it. That is what
    lets the engine do vm.runInContext("MARKET = 'spot'", ctx) from outside, and
    it is why the expose pass below can see the names at all.               */
function loadInto(ctx, files){
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

function load(files, overrides){
  return loadInto(vm.createContext(browserStub(overrides)), files);
}

module.exports = {load, loadInto, browserStub, topLevelNames, JS_DIR};
