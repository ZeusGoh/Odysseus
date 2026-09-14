/* news.js — News / catalyst. Why did this coin move? Board sweep and beta decomposition first,
   then headlines, then optionally Claude with web search.
   part of Odysseus */
/* ============================================================
   NEWS — what moved, and why it moved.

   Two layers, deliberately separate.

   The board sweep is free, needs no key, and never guesses: it finds
   the abnormal moves and explains the *mechanics* from Bybit alone —
   whether the coin moved because the whole market moved or because
   something happened to it specifically, when the move actually
   landed, and what the derivatives book did while it happened.

   The "Why" button is the second layer. It hands that evidence to
   Claude with web search switched on and asks for the catalyst. The
   evidence goes in the prompt so the model is checking a specific
   claim against the web rather than free-associating, and it is told
   to report "nothing found" instead of inventing a headline.
   ============================================================ */

const NEWS_KEY = 'vl.news.v1', WHY_KEY = 'vl.why.v1';

const newsCfg = Object.assign({
  win:'24h', side:'both', minMove:5, minLiq:10
}, (()=>{ try{ return JSON.parse(localStorage.getItem(NEWS_KEY)||'{}'); }catch(e){ return {}; } })());

function newsSaveCfg(){
  try{ localStorage.setItem(NEWS_KEY, JSON.stringify(newsCfg)); }catch(e){}
}

/*  Answers are cached per coin per hour per window — clicking the same row
    twice must not cost a second search.                                     */
let whyCache = (()=>{ try{ return JSON.parse(localStorage.getItem(WHY_KEY)||'{}'); }catch(e){ return {}; } })();
function whySave(){
  try{
    const keys = Object.keys(whyCache);
    if(keys.length > 60)
      keys.sort((a,b)=>(whyCache[a].at||0)-(whyCache[b].at||0))
          .slice(0, keys.length-60).forEach(k=>delete whyCache[k]);
    localStorage.setItem(WHY_KEY, JSON.stringify(whyCache));
  }catch(e){}
}

let newsRaw = [], newsRows = [], newsMkt = null;
let newsScanning = false, newsAbort = false, newsRan = false;
let newsAt = 0, newsOpen = null;

const NV_WINDOWS = [['1h','1H'],['4h','4H'],['24h','24H']];
const NV_BACK    = {'1h':1, '4h':4, '24h':24};

function nvMedian(a){
  const s = a.filter(v=>isFinite(v)).slice().sort((x,y)=>x-y);
  if(!s.length) return 0;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m-1]+s[m])/2;
}

/*  Own worker pool rather than the scanner's — that one keys off the shared
    scanAbort flag, and a Stop here must not kill a scan running over there. */
async function nvPool(items, limit, fn, onProgress){
  let next = 0, done = 0;
  const out = new Array(items.length);
  const worker = async () => {
    while(next < items.length && !newsAbort){
      const i = next++;
      try{ out[i] = await fn(items[i]); }catch(e){ out[i] = null; }
      done++;
      if(onProgress) onProgress(done, items.length);
    }
  };
  await Promise.all(Array.from({length:Math.min(limit, items.length)}, worker));
  return out;
}

/*  The whole board in one request. Same shape as the scanner's sweep but it
    keeps funding and open interest, which is half of the explanation.       */
async function newsBoard(){
  const res = await bybit('/tickers?category='+MARKET);
  return (res.list||[])
    .filter(t=>/USDT$/.test(t.symbol))
    .map(t=>({
      sym: t.symbol.replace(/USDT$/,''), bybit: t.symbol,
      price: +t.lastPrice,
      turnover: +t.turnover24h,
      funding: +t.fundingRate,
      oiVal: +t.openInterestValue
    }))
    .filter(t=>isFinite(t.turnover) && t.turnover>0)
    .sort((a,b)=>b.turnover-a.turnover);
}

// close-to-close over `hours` completed bars
function nvPctOver(candles, hours){
  const n = candles.length;
  if(n < hours+1) return null;
  const then = candles[n-1-hours].c, now = candles[n-1].c;
  if(!isFinite(then) || !then) return null;
  return (now-then)/then*100;
}

/*  Which single hour did the damage. This is what makes the news match worth
    anything — "it moved sometime today" matches every headline; "it moved
    between 14:00 and 15:00" matches one.                                    */
function nvSharpest(candles, hours){
  let best = null;
  for(let i=Math.max(1, candles.length-hours); i<candles.length; i++){
    const b = candles[i];
    if(!isFinite(b.o) || !b.o) continue;
    const pct = (b.c-b.o)/b.o*100;
    if(!best || Math.abs(pct) > Math.abs(best.pct)) best = {t:b.t, pct, v:b.v};
  }
  return best;
}

/*  Price and open interest together say who was on the other side. Price up
    on rising OI is fresh money; price up on falling OI is shorts being
    forced out, which is a different trade with a different half-life.       */
function nvFlow(move, oiChg){
  if(oiChg==null || !isFinite(oiChg))
    return {tag:'—', why:'no open interest', cls:'neutral'};
  if(Math.abs(oiChg) < 2)
    return {tag:'Spot-led', why:'OI flat — not a leverage move', cls:'neutral'};
  const up = move > 0;
  if(up && oiChg > 0)  return {tag:'New longs',     why:'price up, OI up — fresh money', cls:'long'};
  if(up && oiChg < 0)  return {tag:'Short squeeze', why:'price up, OI down — shorts covering', cls:'long'};
  if(!up && oiChg > 0) return {tag:'New shorts',    why:'price down, OI up — shorts pressing', cls:'short'};
  return {tag:'Long flush', why:'price down, OI down — longs liquidated', cls:'short'};
}


/*  How much of a coin's move the board already accounts for. Three classes,
    not two — a coin up 11% on a board up 6% is neither "the market did it"
    nor "something happened to this coin". It is the market, amplified, and
    that is a different trade with a different cause (usually leverage and
    thin books, not news).                                                   */
function nvKind(move, med){
  const share = move ? med/move : 0;
  return share >= 0.70 ? 'mkt' : share >= 0.35 ? 'part' : 'spec';
}

async function nvOpenInterest(row){
  if(MARKET !== 'linear') return null;
  const res = await bybit('/open-interest?category=linear&symbol='+row.bybit+
                          '&intervalTime=1h&limit=25');
  const list = (res.list||[])
    .map(x=>({t:+x.timestamp, oi:+x.openInterest}))
    .filter(x=>isFinite(x.oi) && x.oi>0)
    .sort((a,b)=>a.t-b.t);
  if(list.length < 2) return null;
  const back = NV_BACK[newsCfg.win] || 24;
  const then = list[Math.max(0, list.length-1-back)].oi;
  const now  = list[list.length-1].oi;
  if(!then) return null;
  return {chg:(now-then)/then*100, now};
}

/*  Sweep. One ticker request, then an hour-by-hour history for the liquid
    slice of the board so 1h / 4h / 24h are all measured the same way. A 400%
    move on $20k of turnover is noise, so the book depth floor comes first.  */
async function newsScan(){
  if(newsScanning) return;
  newsScanning = true; newsAbort = false; newsRan = true;
  $('nv-run').hidden = true; $('nv-stop').hidden = false;
  $('nv-bar').hidden = false; $('nv-fill').style.width = '0%';
  $('nvrows').innerHTML = '<div class="loading">Reading the board</div>';
  $('nvnote').textContent = '';

  try{
    const board  = await newsBoard();
    const liquid = board.filter(t=>t.turnover >= newsCfg.minLiq*1e6);
    if(!liquid.length) throw new Error('nothing on the board clears a $'+newsCfg.minLiq+'m book');

    // deepest books first — those are the ones you can actually trade
    const cands = liquid.slice(0, 90);
    const H1 = TFS.find(t=>t.key==='1H');

    const measured = await nvPool(cands, 6, async t=>{
      const candles = await pull({bybit:t.bybit}, H1, 26);
      if(!candles || candles.length < 6) return null;
      return Object.assign({}, t, {
        m: { '1h':nvPctOver(candles,1), '4h':nvPctOver(candles,4), '24h':nvPctOver(candles,24) },
        sharp: { '1h':nvSharpest(candles,1), '4h':nvSharpest(candles,4), '24h':nvSharpest(candles,24) },
        hourlyVol: nvMedian(candles.slice(-24).map(c=>c.v))
      });
    }, (d,n)=>{
      $('nv-fill').style.width = Math.round(d/n*100)+'%';
      $('nvrows').innerHTML = '<div class="loading">Measuring '+d+' of '+n+' books</div>';
    });

    newsRaw = measured.filter(Boolean);
    newsAt = Date.now();
    if(!newsRaw.length) throw new Error('no candle history came back');
  }catch(e){
    $('nvrows').innerHTML = '<div class="loading">Scan failed: '+e.message+'</div>';
    newsScanning = false; newsAbort = false;
    $('nv-run').hidden = false; $('nv-stop').hidden = true; $('nv-bar').hidden = true;
    return;
  }

  newsScanning = false;
  $('nv-run').hidden = false; $('nv-stop').hidden = true; $('nv-bar').hidden = true;
  recomputeNews();
}

/*  Filtering and classification are separate from the sweep, so changing the
    window or the threshold is instant and costs no requests.                */
function recomputeNews(){
  if(!newsRaw.length){ renderNews(); return; }
  const win = newsCfg.win;

  const moves = newsRaw.map(r=>r.m[win]).filter(v=>v!=null && isFinite(v));
  const med   = nvMedian(moves);
  const btcR  = newsRaw.find(r=>r.sym==='BTC');
  newsMkt = {med, btc: btcR ? btcR.m[win] : null, n: newsRaw.length, win};

  newsRows = newsRaw.filter(r=>{
    const v = r.m[win];
    if(v==null || !isFinite(v)) return false;
    if(Math.abs(v) < newsCfg.minMove) return false;
    if(newsCfg.side==='up'   && v < 0) return false;
    if(newsCfg.side==='down' && v > 0) return false;
    return true;
  }).map(r=>{
    const v = r.m[win];
    const excess = v - med;
    const share = v ? med/v : 0;
    const kind  = nvKind(v, med);
    const sharp = r.sharp[win];
    return Object.assign({}, r, {
      move:v, excess, share, kind, sharp,
      volX: (sharp && r.hourlyVol) ? sharp.v/r.hourlyVol : null
    });
  }).sort((a,b)=>Math.abs(b.excess)-Math.abs(a.excess)).slice(0,20);

  renderNews();
  fillFlow();
}

/*  Open interest is only worth a request for rows that actually made the cut,
    so it is fetched after the table is already on screen.                   */
async function fillFlow(){
  const need = newsRows.filter(r=>!r.oiTried);
  if(!need.length || MARKET!=='linear') return;
  await nvPool(need, 5, async r=>{
    r.oiTried = true;
    try{ r.oi = await nvOpenInterest(r); }catch(e){ r.oi = null; }
    r.flow = nvFlow(r.move, r.oi ? r.oi.chg : null);
    return true;
  });
  renderNews();
}

function nvEsc(s){
  return String(s==null?'':s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}
function nvPct(v, dp){
  if(v==null || !isFinite(v)) return '—';
  return (v>=0?'+':'') + v.toFixed(dp==null?2:dp) + '%';
}
function nvClock(t){
  const d = new Date(t), p = n => String(n).padStart(2,'0');
  return p(d.getHours())+':'+p(d.getMinutes());
}
function nvAgo(t){
  const mins = Math.round((Date.now()-t)/60000);
  if(mins < 1) return 'just now';
  if(mins < 60) return mins+'m ago';
  return Math.floor(mins/60)+'h ago';
}

function renderNewsMkt(){
  const el = $('nv-mkt');
  if(!newsMkt){ el.hidden = true; return; }
  el.hidden = false;
  const cls = v => (v==null||!isFinite(v)) ? '' : v>0 ? 'up' : v<0 ? 'down' : '';
  const cell = (label, val, c) =>
    '<div><dt>'+label+'</dt><dd class="'+(c||'')+'">'+val+'</dd></div>';
  el.innerHTML =
    cell('Board median', nvPct(newsMkt.med), cls(newsMkt.med)) +
    (newsMkt.btc!=null ? cell('BTC', nvPct(newsMkt.btc), cls(newsMkt.btc)) : '') +
    cell('Books measured', newsMkt.n) +
    cell('Window', newsMkt.win.toUpperCase()) +
    cell('Swept', nvAgo(newsAt));
}

/*  ---- headlines, no key required ------------------------------------------
    Every free crypto news API worth using has moved behind a key, and the
    public CORS proxies that would let a local file read RSS are unreliable.
    What does work from a browser with no key: rss2json for the major desks,
    and Bybit's own announcements endpoint — the same host the rest of the app
    already talks to. Listings and delistings are the single most common cause
    of a 200% move on an alt, so the exchange feed carries real weight here.  */
const NV_FEEDS = [
  ['Cointelegraph','https://cointelegraph.com/rss'],
  ['CoinDesk',     'https://www.coindesk.com/arc/outboundfeeds/rss/'],
  ['The Block',    'https://www.theblock.co/rss.xml'],
  ['Decrypt',      'https://decrypt.co/feed'],
  ['CryptoSlate',  'https://cryptoslate.com/feed/']
];
const RSS2JSON = 'https://api.rss2json.com/v1/api.json?rss_url=';
const BYBIT_ANN = 'https://api.bybit.com/v5/announcements/index?locale=en-US&limit=50';
const BINANCE_ANN = 'https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=';

let newsFeed = null, newsFeedAt = 0, newsFeedLoading = null, newsFeedErr = null;
let newsFeedSrcs = [];   // sources that actually answered this round

async function nvHeadlines(force){
  if(!force && newsFeed && Date.now()-newsFeedAt < 6e5) return newsFeed;   // 10 min
  if(newsFeedLoading) return newsFeedLoading;

  newsFeedLoading = (async ()=>{
    const items = [];
    let okSources = 0;
    const seen = new Set();

    const jobs = NV_FEEDS.map(([name,url]) =>
      fetch(RSS2JSON+encodeURIComponent(url))
        .then(r=>r.json())
        .then(j=>{
          if(j.status!=='ok') return;
          okSources++; seen.add(name);
          (j.items||[]).forEach(it=>{
            // rss2json hands back "2026-09-12 16:09:41", which is UTC
            const t = Date.parse(String(it.pubDate||'').replace(' ','T')+'Z');
            if(!isFinite(t)) return;
            items.push({
              src:name, title:it.title||'', url:it.link||'', t,
              body:String(it.description||'').replace(/<[^>]*>/g,' ')
                     .replace(/\s+/g,' ').slice(0,400)
            });
          });
        }).catch(()=>{})
    );

    [[48,'listings'],[161,'delistings']].forEach(cat=>{
      jobs.push(
        fetch(BINANCE_ANN+cat[0]+'&pageNo=1&pageSize=25')
          .then(r=>r.json())
          .then(j=>{
            const arts = (j.data && j.data.catalogs && j.data.catalogs[0] &&
                          j.data.catalogs[0].articles) || [];
            if(arts.length){ okSources++; seen.add('Binance'); }
            arts.forEach(a=>{
              const t = +a.releaseDate || 0;
              if(!t) return;
              items.push({src:'Binance', title:a.title||'', t, body:'', exch:true,
                url:'https://www.binance.com/en/support/announcement/'+(a.code||'')});
            });
          }).catch(()=>{})
      );
    });

    jobs.push(
      fetch(BYBIT_ANN+'&_='+Date.now())
        .then(r=>r.json())
        .then(j=>{
          const list = (j.result && j.result.list) || [];
          if(list.length){ okSources++; seen.add('Bybit'); }
          list.forEach(a=>{
            const t = +a.publishTime || +a.dateTimestamp || 0;
            if(!t) return;
            items.push({src:'Bybit', title:a.title||'', url:a.url||'', t,
                        body:a.description||'', exch:true});
          });
        }).catch(()=>{})
    );

    await Promise.all(jobs);
    newsFeedErr = okSources ? null : 'no news source responded';
    newsFeedSrcs = [...seen];
    newsFeed = items.sort((a,b)=>b.t-a.t);
    newsFeedAt = Date.now();
    newsFeedLoading = null;
    return newsFeed;
  })();

  return newsFeedLoading;
}

/*  Ticker matching is exactly where a naive scraper starts lying: ID, OP, GAS,
    NEAR and SUN are all ordinary English words. So a short ticker has to show
    up capitalised, or with a $ or a USDT pair suffix. Only tickers of four
    characters or more get a plain word-boundary match.                       */
/*  Desks write "Lisk", not "LSK". CoinGecko's symbol->name list is free, needs
    no key, and is trimmed to the symbols actually on our board before being
    cached, so it costs a few KB rather than the 1.4MB the full list weighs.  */

/*  ---- coin identity: name + logo ------------------------------------------
    One CoinGecko call, cached a week, shared by every table in the app.
    Ranked by market cap because the raw /coins/list order is arbitrary and
    hands back "batcat" for BTC. The small image variant is a couple of KB
    rather than thirty, which matters when a table paints twenty at once.    */
const COINS_KEY = 'vl.coins.v2';
let nvCoins = null, nvCoinsLoading = null;

async function nvLoadCoins(){
  if(nvCoins) return nvCoins;
  if(nvCoinsLoading) return nvCoinsLoading;
  nvCoinsLoading = (async ()=>{
    try{
      const raw = JSON.parse(localStorage.getItem(COINS_KEY)||'null');
      if(raw && raw.map && Date.now()-raw.at < 7*864e5){
        nvCoins = raw.map; nvCoinsLoading = null; return nvCoins;
      }
    }catch(e){}
    const map = {};
    try{
      for(let p=1; p<=4; p++){
        const list = await (await fetch(
          'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd' +
          '&order=market_cap_desc&per_page=250&sparkline=false&page='+p)).json();
        if(!Array.isArray(list) || !list.length) break;
        list.forEach(c=>{
          const sy = String(c.symbol||'').toLowerCase();
          if(!sy || map[sy] || !c.name) return;
          map[sy] = {n:c.name, i:String(c.image||'').replace('/large/','/small/')};
        });
      }
      if(Object.keys(map).length)
        try{ localStorage.setItem(COINS_KEY, JSON.stringify({at:Date.now(), map})); }catch(e){}
    }catch(e){}
    nvCoins = map; nvCoinsLoading = null;
    if(Object.keys(map).length) nvRepaintIcons();
    return map;
  })();
  return nvCoinsLoading;
}

/*  Perp boards bolt a multiplier onto thin tickers — 1000PEPE, SHIB1000 —
    which are the same asset as far as a name and a logo are concerned.      */
function nvCoin(sym){
  if(!nvCoins || !sym) return null;
  const s = String(sym).toLowerCase();
  return nvCoins[s]
      || nvCoins[s.replace(/^1000+/,'')]
      || nvCoins[s.replace(/1000+$/,'')]
      || null;
}

function nvCoinName(sym, fallback){
  const c = nvCoin(sym);
  return (c && c.n) || fallback || '';
}

function nvMonoColor(sym){
  let h = 0;
  const s = String(sym||'?');
  for(let i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i)) % 360;
  return 'hsl('+h+' 44% 64%)';
}

/*  The monogram is painted underneath and the logo covers it. A coin outside
    CoinGecko's top thousand — Bybit's tokenised stocks, mostly — simply keeps
    the monogram, and an image that 404s removes itself to reveal the same
    thing. Nothing in the app can render as a broken-image icon.             */
/*  Logos come from several independent hosts, tried in turn. A single source
    is a single point of failure: CoinGecko's image CDN has the best coverage
    but is not always reachable from every network or from a file:// page,
    whereas jsDelivr is built for hotlinking and answers from anywhere — it
    just carries an older icon set that stops short of the newer listings. So
    the reliable one goes first and the comprehensive one catches what it
    misses. When every source has failed the circle becomes the monogram.    */
function nvIconSrcs(sym){
  const bare = String(sym||'').toLowerCase().replace(/^1000+/,'').replace(/1000+$/,'');
  const m = nvCoin(sym);
  const out = [];
  if(bare)
    out.push('https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/32/color/'+bare+'.png');
  if(m && m.i) out.push(m.i);                       // CoinGecko: best coverage
  if(bare){
    out.push('https://assets.coincap.io/assets/icons/'+bare+'@2x.png');
    /*  Last resort, and deliberately so. Bybit's own asset host is the one
        external domain this app already proves it can reach on every load, so
        if a network blocks the icon CDNs outright this is the most likely
        thing still standing. It costs nothing unless everything above failed. */
    out.push('https://s1.bycsi.com/app/assets/token/'+bare+'.svg');
  }
  return out;
}

// step to the next source; when the list runs out, reveal the monogram
function nvIconFail(img){
  const el = img && img.parentNode;
  if(!el) return;
  const left = (el.getAttribute('data-next')||'').split('|').filter(Boolean);
  if(left.length){
    el.setAttribute('data-next', left.slice(1).join('|'));
    img.src = left[0];
    return;
  }
  el.classList.remove('logo');
  el.style.background = el.getAttribute('data-c') || 'var(--raise)';
  img.remove();
}

/*  Paste vlIcons() into the console if logos ever come back as monograms —
    it says whether the coin map loaded and which source each circle settled
    on, which is the difference between a data problem and a network one.    */
window.vlIcons = function(){
  const spans = [].slice.call(document.querySelectorAll('.cico'));
  const withImg = spans.filter(e=>e.querySelector('img'));
  return {
    coinsMapped: nvCoins ? Object.keys(nvCoins).length : 0,
    sampleBtc: nvCoins ? nvCoins.btc : null,
    circlesOnScreen: spans.length,
    showingLogo: withImg.length,
    showingMonogram: spans.length - withImg.length,
    firstLogoSrc: withImg.length ? withImg[0].querySelector('img').src : null,
    triedAndFailed: spans.filter(e=>!e.querySelector('img') &&
                                    e.getAttribute('data-c')).length
  };
};

/*  Two states, decided at render time rather than layered on top of each other.
    With a logo the circle is dark and carries no monogram, so a transparent PNG
    cannot bleed a stray letter through it. Without one — Bybit's tokenised
    stocks, mostly — the monogram shows immediately instead of a dark hole that
    never fills. A logo that 404s hands the circle back to the monogram.      */
function nvIcon(sym, cls){
  const s = String(sym||'');
  const mono = (s.replace(/^1000+/,'').replace(/1000+$/,'') || s).slice(0,2) || '?';
  const col = nvMonoColor(s);
  const srcs = nvIconSrcs(s);
  if(srcs.length)
    return '<span class="cico logo'+(cls?' '+cls:'')+'" data-m="'+nvEsc(mono)+
           '" data-c="'+col+'" data-next="'+nvEsc(srcs.slice(1).join('|'))+'">'+
           '<img src="'+nvEsc(srcs[0])+'" alt="" onerror="nvIconFail(this)"></span>';
  return '<span class="cico'+(cls?' '+cls:'')+'" style="background:'+col+
         '" data-m="'+nvEsc(mono)+'"></span>';
}

// the map lands after the first paint, so refresh whatever is currently on screen
function nvRepaintIcons(){
  try{
    if(view==='news' && newsRan) renderNews();
    else if(view==='watch') renderWatch();
    else if(view==='scan' && scanRan) renderScan(scanRows.length);
    const el = document.querySelector('.pair .sym');
    if(el && typeof active !== 'undefined')
      el.innerHTML = nvIcon(active) + nvEsc(nvCoinName(active, symbolOf(active).name));
  }catch(e){}
}


/*  Ticker matching is exactly where a naive scraper starts lying. Live proof
    from the feeds: a plain case-insensitive match on FLOCK pulled in "GTA Mod
    Adds Flock Cameras", and a bare match on S hit 26 unrelated headlines. So:
    a $ prefix or a USDT pair suffix is trusted outright; a bare ticker counts
    only in the capitalised form a desk would actually print, and never at one
    or two characters; and the coin's real name is matched separately.        */
function nvMentions(text, sym, name){
  const esc = String(sym).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  if(new RegExp('\\$'+esc+'\\b','i').test(text)) return 2;
  if(new RegExp('\\b'+esc+'USDT?\\b','i').test(text)) return 2;
  if(sym.length >= 3 && new RegExp('\\b'+esc+'\\b').test(text)) return 1;
  if(name && name.length >= 4 && name.toUpperCase() !== sym.toUpperCase()){
    const en = name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    if(new RegExp('\\b'+en+'\\b','i').test(text)) return 1;
  }
  return 0;
}


/*  A headline that broke just BEFORE the sharpest hour is a candidate cause.
    One published after it is reporting, not explanation — it still shows, but
    it ranks below, and the panel labels which side of the move it landed on. */
function nvMatchNews(row, feed){
  if(!feed || !feed.length) return [];
  const anchor = row.sharp ? row.sharp.t : Date.now();
  const from = Date.now() - 36*3600e3;

  return feed.map(n=>{
    if(n.t < from) return null;
    const hay = n.title + ' ' + (n.body||'');
    const hit = nvMentions(hay, row.sym, row.coinName);
    if(!hit) return null;

    const lag = (anchor - n.t)/3600e3;          // hours the news came before the move
    let score = hit*10;
    if(lag >= -1 && lag <= 6)      score += 14; // just before, or during
    else if(lag > 6 && lag <= 24)  score += 5;
    else if(lag < -1)              score += 1;  // after the move
    if(n.exch) score += 8;                      // exchange announcements move alts
    if(nvMentions(n.title, row.sym, row.coinName)) score += 6;
    return Object.assign({}, n, {score, lag});
  }).filter(Boolean).sort((a,b)=>b.score-a.score).slice(0,6);
}

/*  The explanation the app can always give, from its own numbers.            */
function nvStructural(r){
  const bits = [];
  bits.push(
    r.kind==='spec'
      ? r.sym+' moved '+nvPct(r.excess,1)+' beyond the board — this is its own move, not the market.'
      : r.kind==='part'
      ? 'The board moved the same way, but '+r.sym+' moved '+nvPct(r.excess,1)+
        ' harder than it — high beta rather than its own story.'
      : 'The whole board moved about this much; '+r.sym+' came along with it.'
  );
  if(r.sharp)
    bits.push('Most of it landed in the hour from '+nvClock(r.sharp.t)+' ('+nvPct(r.sharp.pct,1)+
      (r.volX ? ' on '+r.volX.toFixed(1)+'x normal hourly volume' : '')+').');
  if(r.flow && r.oi)
    bits.push(r.flow.tag+' — '+r.flow.why+', open interest '+nvPct(r.oi.chg,1)+' across the window.');
  if(isFinite(r.funding) && Math.abs(r.funding*100) > 0.05)
    bits.push('Funding at '+(r.funding*100).toFixed(3)+'% per 8h is crowded: positioning is one-sided and expensive to hold.');
  return bits.join(' ');
}

function nvLagLabel(lag){
  const h = Math.abs(lag);
  const when = h < 1 ? Math.round(h*60)+'m' : h.toFixed(h<10?1:0)+'h';
  if(lag >= -0.5) return when+' before the move';
  return when+' after the move';
}

function nvWhyPanel(r){
  const d = document.createElement('div');
  d.className = 'nvwhy';
  let html = '';

  /* 1. what the app knows for certain, from its own numbers — always shown */
  html += '<p class="nvread">'+nvEsc(nvStructural(r))+'</p>';

  /* 2. headlines that actually name this coin */
  if(r.newsBusy){
    html += '<p class="thinking">Pulling headlines…</p>';
  }else{
    const hits = r.headlines || [];
    if(hits.length){
      html += '<ul class="nvhl">' + hits.map(n=>
        '<li><a href="'+nvEsc(n.url)+'" target="_blank" rel="noopener">'+nvEsc(n.title)+'</a>'+
        '<span class="meta">'+nvEsc(n.src)+' · '+
        (n.lag >= -0.5 ? '<b>'+nvEsc(nvLagLabel(n.lag))+'</b>' : nvEsc(nvLagLabel(n.lag)))+
        ' · '+nvEsc(nvClock(n.t))+'</span></li>'
      ).join('') + '</ul>';
    }else if(newsFeedErr){
      html += '<p class="nvnone">Could not reach the news feeds ('+nvEsc(newsFeedErr)+'). '+
              'The read above comes from the exchange data and still stands.</p>';
    }else{
      const checked = newsFeedSrcs.length ? newsFeedSrcs.join(', ') : 'the news feeds';
      html += '<p class="nvnone">No headline in the last 36 hours names '+nvEsc(r.sym)+
              (r.coinName ? ' or '+nvEsc(r.coinName) : '')+
              ' — checked '+nvEsc(checked)+'. Be careful reading that as “nothing happened”: '+
              'the major desks mostly cover BTC, ETH and regulation, and a mid-cap doing '+
              nvPct(r.move,0)+' is usually below their line. The cause is more often an '+
              'exchange listing elsewhere, an unlock, or a squeeze — which is what the '+
              'web search below is for.</p>';
    }
  }

  /* 3. the optional written explanation, if a key is on file */
  const cached = r.why || whyCache[r.sym+'.'+newsCfg.win+'.'+Math.floor(Date.now()/36e5)];
  if(r.whyBusy){
    html += '<div class="nvmore"><span class="thinking">Logan is searching the web…</span></div>';
  }else if(cached && cached.err){
    html += '<div class="nvmore"><span class="err">'+nvEsc(cached.err)+'</span></div>';
  }else if(cached && cached.text){
    html += '<div class="nvmore" style="display:block"><p>'+nvEsc(cached.text)+'</p>';
    if(cached.srcs && cached.srcs.length)
      html += '<div class="nvsrc">' + cached.srcs.map(s=>
        '<a href="'+nvEsc(s.url)+'" target="_blank" rel="noopener">'+nvEsc(s.title)+'</a>'
      ).join('') + '</div>';
    html += '</div>';
  }

  d.innerHTML = html;

  /*  The button only appears when it can actually do something. No key means a
      quiet line about what it would add, not an error the user cannot act on. */
  if(!r.whyBusy && !(cached && cached.text)){
    const more = document.createElement('div');
    more.className = 'nvmore';
    if(lgCfg.key){
      const b = document.createElement('button');
      b.className = 'nvask';
      b.textContent = 'Ask Logan to dig';
      b.onclick = ()=> askLogan(r.sym);
      more.appendChild(b);
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = 'Searches the web and writes it up. Costs a few cents against your API key.';
      more.appendChild(hint);
    }else{
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = 'Add an Anthropic API key in the Logan tab and this panel will also search the web and write up the catalyst. Everything above works without one.';
      more.appendChild(hint);
    }
    d.appendChild(more);
  }
  return d;
}

/*  The free path: open the row, pull the shared headline feed once, match it
    against this coin. No key, no cost.                                       */
async function openWhy(sym){
  const r = newsRows.find(x=>x.sym===sym);
  if(!r) return;
  newsOpen = sym;

  if(r.headlines){ renderNews(); return; }
  r.newsBusy = true; renderNews();
  try{
    const [feed] = await Promise.all([nvHeadlines(), nvLoadCoins()]);
    r.coinName = nvCoinName(r.sym, null) || null;
    r.headlines = nvMatchNews(r, feed);
  }catch(e){
    newsFeedErr = e.message;
    r.headlines = [];
  }
  r.newsBusy = false;
  renderNews();
}

/*  The paid path, unchanged in spirit: hand the evidence to Claude with web
    search on. Only reachable once a key is on file.                          */
async function askLogan(sym){
  const r = newsRows.find(x=>x.sym===sym);
  if(!r || r.whyBusy || !lgCfg.key) return;

  const bucket = sym+'.'+newsCfg.win+'.'+Math.floor(Date.now()/36e5);
  if(whyCache[bucket]){ r.why = whyCache[bucket]; renderNews(); return; }

  r.whyBusy = true; renderNews();

  const body = {
    model: lgCfg.model || 'claude-sonnet-5',
    max_tokens: 1000,
    system: WHY_SYSTEM,
    messages: [{role:'user', content: whyPrompt(r)}],
    tools: [{type:'web_search_20250305', name:'web_search', max_uses:5}]
  };

  try{
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'x-api-key': lgCfg.key,
        'anthropic-version':'2023-06-01',
        'anthropic-dangerous-direct-browser-access':'true'
      },
      body: JSON.stringify(body)
    });
    const j = await res.json();
    if(!res.ok)
      throw new Error((j && j.error && j.error.message) || ('request failed with '+res.status));

    const parts = j.content || [];
    const text = parts.filter(c=>c.type==='text').map(c=>c.text).join('\n').trim();

    const srcs = [];
    const add = (u,t)=>{ if(u && !srcs.some(s=>s.url===u)) srcs.push({url:u, title:t||u}); };
    parts.forEach(c=>{
      (c.citations||[]).forEach(ct=>add(ct.url, ct.title));
      if(c.type==='web_search_tool_result' && Array.isArray(c.content))
        c.content.forEach(x=>add(x.url, x.title));
    });

    r.why = {text: text || 'No answer came back.', srcs, at: Date.now()};
    whyCache[bucket] = r.why; whySave();
  }catch(e){
    let hint = 'Could not reach the API: '+e.message;
    if(isFileOrigin()) hint += '\n\n'+FILE_HINT;
    r.why = {err:hint};
  }
  r.whyBusy = false;
  renderNews();
}


function renderNews(){
  renderNewsMkt();
  const host = $('nvrows');
  if(!host) return;

  if(!newsRan){
    host.innerHTML = '<div class="loading">Hit Scan movers to sweep the board.</div>';
    return;
  }
  if(newsScanning && !newsRows.length) return;   // progress text is already up

  if(!newsRows.length){
    host.innerHTML = '<div class="loading">Nothing moved more than '+newsCfg.minMove+
      '% over '+newsCfg.win.toUpperCase()+' on a book deeper than $'+newsCfg.minLiq+'m.</div>';
    $('nvnote').textContent = '';
    return;
  }

  host.innerHTML = '';
  newsRows.forEach((r, i)=>{
    const row = document.createElement('div');
    row.className = 'nvrow';

    const rank = document.createElement('span');
    rank.className = 'nvrank'; rank.textContent = i+1;

    const sym = document.createElement('button');
    sym.className = 'nvsym';
    const nm = nvCoinName(r.sym, symbolOf(r.sym).name);
    sym.innerHTML = nvIcon(r.sym) + '<b>'+nvEsc(r.sym)+'</b>' +
                    (nm && nm !== r.sym ? '<em>'+nvEsc(nm)+'</em>' : '');
    sym.title = 'Open '+r.sym+' in the terminal';
    sym.onclick = ()=>{ switchSymbol(r.sym); setView('terminal'); };

    const last = document.createElement('span');
    last.className = 'nvlast'; last.textContent = fmtUsd(r.price);

    const move = document.createElement('span');
    move.className = 'nvmove ' + (r.move>=0?'up':'down');
    move.textContent = nvPct(r.move, 1);

    const exc = document.createElement('span');
    exc.className = 'nvexc';
    exc.textContent = nvPct(r.excess, 1);
    exc.title = 'Move minus the board median — what this coin did on its own';

    const kind = document.createElement('span');
    const kd = document.createElement('span');
    kd.className = 'nvkind ' + r.kind;
    kd.textContent = r.kind==='spec' ? 'Coin-specific'
                   : r.kind==='part' ? 'Amplified'
                   : 'Market-wide';
    kd.title = r.kind==='spec'
      ? 'The board did not do this — something happened to this coin'
      : r.kind==='part'
      ? 'The board moved this way too, but this coin moved far harder — high beta, often leverage rather than news'
      : 'The whole board moved about this much; this coin just came along';
    kind.appendChild(kd);

    const when = document.createElement('span');
    when.className = 'nvwhen';
    when.innerHTML = r.sharp
      ? '<b>'+nvClock(r.sharp.t)+'</b>' + nvPct(r.sharp.pct,1) +
        (r.volX ? ' · '+r.volX.toFixed(1)+'x vol' : '')
      : '—';
    if(r.sharp) when.title = 'Sharpest single hour in the window — '+new Date(r.sharp.t).toString();

    const flow = document.createElement('span');
    flow.className = 'nvflow';
    if(r.flow)
      flow.innerHTML = '<b class="'+r.flow.cls+'">'+nvEsc(r.flow.tag)+'</b>' +
                       '<span>'+nvEsc(r.flow.why)+'</span>';
    else
      flow.innerHTML = '<b class="neutral">…</b><span>reading OI</span>';

    const fund = document.createElement('span');
    const frPct = isFinite(r.funding) ? r.funding*100 : null;
    fund.className = 'nvfund' + (frPct!=null && Math.abs(frPct)>0.05 ? ' hot' : '');
    fund.textContent = frPct!=null ? frPct.toFixed(3)+'%' : '—';
    if(frPct!=null)
      fund.title = 'Funding per 8h — ' + (r.funding*3*365*100).toFixed(0) + '% annualised' +
                   (Math.abs(frPct)>0.05 ? '. Crowded positioning.' : '');

    const ask = document.createElement('button');
    ask.className = 'nvask' + (newsOpen===r.sym ? ' on' : '');
    ask.textContent = newsOpen===r.sym ? 'Hide' : 'Why?';
    ask.disabled = !!r.whyBusy;
    ask.onclick = ()=>{
      if(newsOpen===r.sym){ newsOpen = null; renderNews(); return; }
      openWhy(r.sym);
    };

    [rank,sym,last,move,exc,kind,when,flow,fund,ask].forEach(el=>row.appendChild(el));
    host.appendChild(row);

    if(newsOpen===r.sym) host.appendChild(nvWhyPanel(r));
  });

  $('nvnote').textContent =
    newsRows.length + ' of ' + newsMkt.n + ' liquid books cleared the filter. ' +
    'Ranked by how far each moved beyond the board, not by raw percentage — ' +
    'a coin up 9% on a board up 8% is not news.' +
    (MARKET!=='linear' ? ' Funding and open interest are perp-only; switch to Perp for the positioning read.' : '');
}

/*  ---- the catalyst call -------------------------------------------------
    Everything the board sweep worked out goes into the prompt. The model is
    not asked "why did X move" in a vacuum — it is asked to find the news that
    fits a move of known size, at a known hour, with known positioning behind
    it, and to say so when nothing fits.                                     */
const WHY_SYSTEM =
  'You are a crypto desk analyst. You explain why one specific coin moved, using web search for current news. ' +
  'Rules: cite what you actually find; never fabricate a headline, a date, a number, or a source; ' +
  'if search turns up nothing specific to this coin, open with "No coin-specific catalyst found" and explain the move ' +
  'structurally from the positioning data instead. Be terse and concrete — the reader is a trader looking at the chart ' +
  'right now, not a newsletter subscriber. No preamble, no disclaimers, no advice on whether to trade it.';

function whyPrompt(r){
  const w = newsCfg.win.toUpperCase();
  const when = r.sharp
    ? new Date(r.sharp.t).toISOString().replace('T',' ').slice(0,16)+' UTC'
    : 'unclear';
  const lines = [
    'Coin: ' + r.sym + ' (Bybit ' + r.bybit + ')',
    'Move: ' + nvPct(r.move,1) + ' over the last ' + w,
    'Board median over the same window: ' + nvPct(newsMkt.med,1) +
      (newsMkt.btc!=null ? ', BTC ' + nvPct(newsMkt.btc,1) : ''),
    'Read: ' + (r.kind==='spec'
      ? 'coin-specific — it moved ' + nvPct(r.excess,1) + ' beyond what the board did'
      : r.kind==='part'
      ? 'the board moved the same way, but this coin moved ' + nvPct(r.excess,1) +
        ' harder than it — amplified, not necessarily its own story'
      : 'mostly market-wide — the whole board moved about this much'),
    r.sharp ? 'Sharpest hour: ' + when + ' (' + nvPct(r.sharp.pct,1) + ' in that single hour' +
      (r.volX ? ', ' + r.volX.toFixed(1) + 'x normal hourly volume' : '') + ')' : null,
    r.oi ? 'Open interest over the window: ' + nvPct(r.oi.chg,1) + ' — ' +
      r.flow.tag.toLowerCase() + ' (' + r.flow.why + ')' : null,
    isFinite(r.funding) ? 'Funding: ' + (r.funding*100).toFixed(4) + '% per 8h (' +
      (r.funding*3*365*100).toFixed(0) + '% annualised)' : null,
    '24h turnover: $' + fmtVol(r.turnover),
    "Today's date: " + new Date().toISOString().slice(0,10)
  ].filter(Boolean);

  return 'Find what caused this crypto price move.\n\n' + lines.join('\n') +
    '\n\nSearch for news on ' + r.sym + ' from the last 48 hours — listings, unlocks, hacks, ' +
    'partnerships, token burns, protocol upgrades, regulatory news, large liquidations, exchange announcements.\n\n' +
    'Answer in under 130 words, as two short paragraphs:\n' +
    'First: the catalyst, if there is one — name it and say when it broke relative to the sharpest hour above.\n' +
    'Second: whether the positioning data supports that story or argues against it.';
}



function buildNewsControls(){
  const chip = (host, items, isOn, pick) => {
    const el = $(host); if(!el) return;
    el.innerHTML = '';
    items.forEach(([val,label])=>{
      const b = document.createElement('button');
      b.textContent = label;
      b.setAttribute('aria-pressed', isOn(val));
      b.onclick = ()=>{
        pick(val); newsSaveCfg(); buildNewsControls();
        newsOpen = null;
        recomputeNews();      // rebuilds each row, so OI is re-read for the new window
      };
      el.appendChild(b);
    });
  };
  chip('nv-win',  NV_WINDOWS, v=>newsCfg.win===v,  v=>newsCfg.win=v);
  chip('nv-side', [['both','Both'],['up','Up'],['down','Down']],
       v=>newsCfg.side===v, v=>newsCfg.side=v);
  chip('nv-move', [[3,'3%'],[5,'5%'],[10,'10%'],[20,'20%']],
       v=>newsCfg.minMove===v, v=>newsCfg.minMove=v);
  chip('nv-liq',  [[1,'$1m'],[10,'$10m'],[50,'$50m']],
       v=>newsCfg.minLiq===v, v=>newsCfg.minLiq=v);
}
