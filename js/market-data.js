/* market-data.js — Market data. Timeframes and their weights, the Bybit endpoints, candle fetching
   and merging, the curated symbol list. The only place that talks to the exchange.
   part of VL */

/* ---------- data ---------- */
const TFS = [
  {key:'1M', label:'Monthly', weight:5, ms:0,        binance:'1M', bybit:'M',   okx:'1M'},
  {key:'1W', label:'Weekly',  weight:4, ms:604800e3, binance:'1w', bybit:'W',   okx:'1W'},
  {key:'1D', label:'Daily',   weight:3, ms:86400e3,  binance:'1d', bybit:'D',   okx:'1D'},
  {key:'4H', label:'4-hour',  weight:2, ms:14400e3,  binance:'4h', bybit:'240', okx:'4H'},
  {key:'1H', label:'1-hour',  weight:1, ms:3600e3,   binance:'1h', bybit:'60',  okx:'1H'}
];
const WEIGHTS = Object.fromEntries(TFS.map(t=>[t.key,t.weight]));

/*  One venue: Bybit spot. Every price, every candle, every symbol comes from
    the same book, so nothing can disagree with itself between timeframes.   */
const BYBIT = 'https://api.bybit.com/v5/market';

/*  'linear' is the USDT perpetual book — deeper than spot on most alts, and it
    carries funding and open interest. 'spot' stays available as a toggle.    */
let MARKET = 'linear';
const marketLabel = () => MARKET==='linear' ? 'Bybit perpetual' : 'Bybit spot';

/*  1000 is Bybit's per-request maximum. A 200 EMA seeded 800 bars back is fully
    converged, where one seeded 100 bars back is still drifting toward truth —
    that was why the 200 looked wrong on a 300-bar series.                    */
const BARS = 1000, POLL = 1000, TAIL = 3;

function mergeCandles(existing, incoming){
  if(!existing || !existing.length) return incoming;
  const map = new Map(existing.map(c=>[c.t,c]));
  incoming.forEach(c=>map.set(c.t,c));
  return [...map.values()].sort((a,b)=>a.t-b.t).slice(-BARS);
}

async function bybit(path, tries){
  tries = tries===undefined ? 3 : tries;
  for(let attempt=0; attempt<=tries; attempt++){
    const r = await fetch(BYBIT+path+'&_='+Date.now(), {cache:'no-store', mode:'cors'});
    if(r.status===429 || r.status===403){
      // rate limited: wait a little longer each time rather than dropping the coin
      if(attempt===tries) throw new Error('rate limited by Bybit');
      await new Promise(res=>setTimeout(res, 400*(attempt+1)));
      continue;
    }
    if(!r.ok) throw new Error('Bybit returned '+r.status);
    const j = await r.json();
    if(j.retCode !== 0) throw new Error(j.retMsg || 'Bybit rejected the request');
    return j.result;
  }
}

async function pull(sym, tf, n){
  n = n || BARS;
  let out = [], end = null;
  // page backwards until we have what we asked for or the exchange runs out
  while(out.length < n){
    const want = Math.min(n - out.length, 1000);
    const res = await bybit('/kline?category='+MARKET+'&symbol='+sym.bybit+
                            '&interval='+tf.bybit+'&limit='+want+
                            (end ? '&end='+end : ''));
    const page = (res.list||[])
      .map(r=>({t:+r[0], o:+r[1], h:+r[2], l:+r[3], c:+r[4], v:+r[5]}))
      .reverse();
    if(!page.length) break;
    out = page.concat(out);
    if(page.length < want) break;            // no deeper history exists
    end = page[0].t - 1;
    if(n <= 1000) break;                     // single page was all that was asked for
  }
  if(out.length < 3) throw new Error('not enough candles for '+sym.bybit);
  return out;
}

// 24h book stats for the market bar
async function pullTicker(sym){
  const res = await bybit('/tickers?category='+MARKET+'&symbol='+sym.bybit);
  return (res.list||[])[0] || null;
}

// When does the bar that opened at `open` close?
function barClose(tf, open){
  if(tf.ms) return open + tf.ms;
  const d = new Date(open);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth()+1, 1);
}
function countdown(ms){
  if(ms<=0) return 'any moment';
  const s = Math.floor(ms/1000), m = Math.floor(s/60), h = Math.floor(m/60), dd = Math.floor(h/24);
  if(dd>0) return dd+'d '+(h%24)+'h';
  if(h>0)  return h+'h '+(m%60)+'m';
  if(m>0)  return m+'m '+(s%60)+'s';
  return s+'s';
}

const SYMBOLS = [
  {sym:'BTC', name:'Bitcoin',   bybit:'BTCUSDT'},
  {sym:'ETH', name:'Ethereum',  bybit:'ETHUSDT'},
  {sym:'SOL', name:'Solana',    bybit:'SOLUSDT'},
  {sym:'XRP', name:'XRP',       bybit:'XRPUSDT'},
  {sym:'BNB', name:'BNB',       bybit:'BNBUSDT'},
  {sym:'DOGE',name:'Dogecoin',  bybit:'DOGEUSDT'},
  {sym:'ADA', name:'Cardano',   bybit:'ADAUSDT'},
  {sym:'AVAX',name:'Avalanche', bybit:'AVAXUSDT'},
  {sym:'LINK',name:'Chainlink', bybit:'LINKUSDT'},
  {sym:'SUI', name:'Sui',       bybit:'SUIUSDT'},
  {sym:'TON', name:'Toncoin',   bybit:'TONUSDT'},
  {sym:'LTC', name:'Litecoin',  bybit:'LTCUSDT'},
  {sym:'ZEC', name:'Zcash',     bybit:'ZECUSDT'},
  {sym:'NEAR',name:'NEAR',      bybit:'NEARUSDT'},
  {sym:'ARB', name:'Arbitrum',  bybit:'ARBUSDT'}
];

function symbolOf(code){
  const found = (UNIVERSE||SYMBOLS).find(s=>s.sym===code) || SYMBOLS.find(s=>s.sym===code);
  if(found) return found;
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g,'').replace(/USDT$/,'');
  return {sym:clean, name:clean, bybit:clean+'USDT'};
}
