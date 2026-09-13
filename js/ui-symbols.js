/* ui-symbols.js — Symbol search and pickers. The curated buttons are shortcuts; real search pulls the
   exchange's own universe.
   part of VL */

/* ---------- searchable symbol universe ---------- */
/*  The curated buttons are just shortcuts. Real search pulls the exchange's
    full spot list so anything actually tradeable can be found.               */
let UNIVERSE = null, universeLoading = null;

const universeCache = {};
async function loadUniverse(){
  const mkt = MARKET;
  if(universeCache[mkt]){ UNIVERSE = universeCache[mkt]; return UNIVERSE; }
  if(universeLoading) return universeLoading;
  universeLoading = (async ()=>{
    const found = new Map(SYMBOLS.map(sm=>[sm.sym, sm]));
    try{
      const res = await bybit('/instruments-info?category='+mkt+'&limit=1000');
      (res.list||[]).forEach(x=>{
        if(x.status!=='Trading') return;
        if(x.quoteCoin!=='USDT' && x.quoteCoin!=='USDC') return;
        // in futures, take only the perpetuals — not dated contracts
        if(mkt==='linear' && x.contractType && x.contractType!=='LinearPerpetual') return;
        if(!found.has(x.baseCoin))
          found.set(x.baseCoin, {sym:x.baseCoin, name:x.baseCoin, bybit:x.symbol});
      });
    }catch(e){}
    universeCache[mkt] = [...found.values()].sort((a,b)=>a.sym.localeCompare(b.sym));
    UNIVERSE = universeCache[mkt];
    universeLoading = null;
    return UNIVERSE;
  })();
  return universeLoading;
}

function searchSymbols(q){
  q = q.trim().toUpperCase();
  if(!q) return [];
  const pool = UNIVERSE || SYMBOLS;
  const starts = [], contains = [];
  pool.forEach(sm=>{
    const inName = (sm.name||'').toUpperCase();
    if(sm.sym.startsWith(q) || inName.startsWith(q)) starts.push(sm);
    else if(sm.sym.includes(q) || inName.includes(q)) contains.push(sm);
  });
  return [...starts, ...contains].slice(0, 10);
}

function renderSuggestions(list){
  const box = $('symsugg');
  if(!list.length){ box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = '';
  list.forEach(sm=>{
    const b = document.createElement('button');
    b.className = 'sugg';
    const dn = nvCoinName(sm.sym, sm.name);
    b.innerHTML = nvIcon(sm.sym)+'<b>'+sm.sym+'</b>'+
                  (dn && dn!==sm.sym ? '<span>'+nvEsc(dn)+'</span>' : '');
    b.onmousedown = e=>{ e.preventDefault(); switchSymbol(sm.sym); };
    box.appendChild(b);
  });
}

/* ---------- symbol picker ---------- */
function buildSymbolPicker(){
  const box = $('symlist');
  const meta = symbolOf(active);
  box.innerHTML = '';
  const ordered = [...recents.map(symbolOf), ...SYMBOLS.filter(s=>!recents.includes(s.sym))];
  ordered.forEach(sm=>{
    const b = document.createElement('button');
    b.className = 'symtab';
    b.textContent = sm.sym;
    b.title = sm.name;
    b.setAttribute('aria-pressed', sm.sym===active);
    b.onclick = ()=> switchSymbol(sm.sym);
    box.appendChild(b);
  });
}

async function switchSymbol(code){
  code = code.trim().toUpperCase();
  if(!code || code===active) { $('symsearch').value=''; return; }
  active = code;
  lastSig = ''; lastPx = null; tickerOK = false;
  ['st-hi','st-lo','st-vol'].forEach(id=> $(id).textContent = '—');
  recents = [code, ...recents.filter(c=>c!==code)].slice(0,6);
  $('symsearch').value = '';
  buildSymbolPicker();
  if(!data[active]){
    $('rows').innerHTML = '<div class="loading">Fetching '+code+' data…</div>';
    $('charts').innerHTML = '';
  } else {
    render(); buildCharts();
  }
  await load();
}

async function switchMarket(mkt){
  if(mkt === MARKET) return;
  MARKET = mkt;
  $('m-perp').setAttribute('aria-pressed', mkt==='linear');
  $('m-spot').setAttribute('aria-pressed', mkt==='spot');
  $('src').textContent = marketLabel();
  // candles from the other book are not comparable — drop everything and refetch
  Object.keys(data).forEach(k=> delete data[k]);
  Object.keys(stoch).forEach(k=> delete stoch[k]);
  Object.keys(states).forEach(k=> delete states[k]);
  Object.keys(divsAll).forEach(k=> delete divsAll[k]);
  Object.keys(divNow).forEach(k=> delete divNow[k]);
  UNIVERSE = null; universeLoading = null;
  lastSig = ''; lastPx = null; tickerOK = false;
  ['st-hi','st-lo','st-vol','st-fund','st-oi'].forEach(id=> $(id).textContent = '—');
  disposePanes();
  $('rows').innerHTML = '<div class="loading">Loading '+(mkt==='linear'?'perpetual':'spot')+' candles</div>';
  $('charts').innerHTML = '';
  await load();
  refreshTicker();
  loadUniverse();
}

function renderWSugg(list){
  const box = $('wsugg');
  if(!list.length){ box.hidden = true; box.innerHTML=''; return; }
  box.hidden = false; box.innerHTML = '';
  list.forEach(sm=>{
    const b = document.createElement('button');
    b.className = 'sugg';
    const dn = nvCoinName(sm.sym, sm.name);
    b.innerHTML = nvIcon(sm.sym)+'<b>'+sm.sym+'</b>'+
                  (dn && dn!==sm.sym ? '<span>'+nvEsc(dn)+'</span>' : '');
    b.onmousedown = e=>{ e.preventDefault(); addWatch(sm.sym); };
    box.appendChild(b);
  });
}
