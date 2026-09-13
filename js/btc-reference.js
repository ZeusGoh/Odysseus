/* btc-reference.js — BTC reference. Keeps BTC loaded regardless of what is on screen, so any coin can be
   read with or against the market leader.
   part of VL */

/* ---------- BTC reference ----------
   The whole strategy rests on alts only being worth taking when the market
   itself agrees, so BTC is kept loaded at all times regardless of what symbol
   is on screen, and every surface can ask "does this agree with BTC?".      */
const BTC = 'BTC';
let btcAt = 0, btcLoading = null;

async function ensureBtc(force){
  if(active===BTC && states[BTC]) { btcAt = Date.now(); return; }
  if(!force && states[BTC] && Date.now()-btcAt < 60000) return;
  if(btcLoading) return btcLoading;
  btcLoading = (async ()=>{
    try{
      const meta = symbolOf(BTC);
      // same depth the terminal uses, so BTC's stance can never depend on which
      // surface happened to load it first
      const res = await Promise.all(TFS.map(tf=>pull(meta, tf, BARS)));
      data[BTC] = data[BTC] || {};
      TFS.forEach((tf,i)=>{ data[BTC][tf.key] = mergeCandles(data[BTC][tf.key], res[i]); });
      analyse(BTC);
      btcAt = Date.now();
    }catch(e){ /* leave the previous reference in place */ }
    finally{ btcLoading = null; }
  })();
  return btcLoading;
}

const btcSideOn = key => (states[BTC] && states[BTC][key]) ? sideOf(states[BTC][key]) : null;

/*  Compare a symbol's per-frame stance against BTC's on the same frames.
    Returns a weighted -100..100, plus how many frames actually agree.       */
function alignBtc(symStates, frameKeys){
  const keys = frameKeys || TFS.map(t=>t.key);
  let sum=0, tot=0, agree=0, clash=0, n=0;
  keys.forEach(key=>{
    const tf = TFS.find(t=>t.key===key);
    const a = symStates && symStates[key] ? sideOf(symStates[key]) : null;
    const b = btcSideOn(key);
    if(a===null || b===null) return;
    tot += tf.weight; n++;
    const aDir = a>0.15 ? 1 : a<-0.15 ? -1 : 0;
    const bDir = b>0.15 ? 1 : b<-0.15 ? -1 : 0;
    if(aDir && bDir && aDir===bDir){ sum += tf.weight; agree++; }
    else if(aDir && bDir && aDir!==bDir){ sum -= tf.weight; clash++; }
  });
  return {pct: tot ? Math.round(sum/tot*100) : 0, agree, clash, n};
}

// does a proposed direction run with BTC on that frame, or into it?
function btcVerdict(dir, key){
  const b = btcSideOn(key);
  if(b===null) return {tone:'flat', text:'—'};
  const bDir = b>0.15 ? 'bull' : b<-0.15 ? 'bear' : 'flat';
  if(bDir==='flat') return {tone:'flat', text:'~'};
  if(bDir===dir)    return {tone:'up',   text:'with'};
  return {tone:'down', text:'against'};
}
