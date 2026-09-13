/* ui-terminal.js — Terminal view. The frame matrix, the BTC strip, the stance block, the live backtest
   badge on every cross, and the render loop that keeps them honest.
   part of VL */

// display shorthand — desk nomenclature, not new logic
const ZONE_SHORT = {oversold:'OS', middle:'Mid', overbought:'OB'};
const zoneTag = v => ZONE_SHORT[zoneOf(v)] || '—';
const zoneTone = v => zoneOf(v)==='oversold' ? 'var(--up)'
                   : zoneOf(v)==='overbought' ? 'var(--down)' : 'var(--mute)';
const barsTag = n => n+'b';            // bars since; 'live' is reserved for unsettled bars
const signed = v => (v>0?'+':'') + v.toFixed(1);

// what the cross means, said once and said tightly
function readCross(dir, level){
  const z = zoneOf(level);
  if(dir==='bull') return z==='oversold' ? 'reversal off oversold'
                        : z==='middle'   ? 'continuation through mid'
                                         : 'late, already extended';
  return z==='overbought' ? 'reversal off overbought'
       : z==='middle'     ? 'continuation through mid'
                          : 'late, already extended';
}

const SIG = {
  'bull':           {text:'Bull cross',      color:'var(--up)'},
  'bear':           {text:'Bear cross',      color:'var(--down)'},
  'potential-bull': {text:'Bull cross',      color:'var(--pend)', ring:true},
  'potential-bear': {text:'Bear cross',      color:'var(--pend)', ring:true},
  'nearing-bull':   {text:'Bull cross nearing', color:'var(--pend)', ring:true},
  'nearing-bear':   {text:'Bear cross nearing', color:'var(--pend)', ring:true},
  'holding-bull':   {text:'Above signal',    color:'var(--mute)'},
  'holding-bear':   {text:'Below signal',    color:'var(--mute)'},
  'flat':           {text:'Converged',       color:'var(--mute)'},
  'none':           {text:'Insufficient history', color:'var(--mute)'}
};

function signalText(key){
  const s = states[active][key];
  if(!s || s.type==='none') return {title:SIG.none.text, sub:'building the series'};

  if(s.pending){
    return {title:SIG[s.type].text, tag:'Unconfirmed', countdown:true,
            sub:'fired at %K '+s.level.toFixed(1)+', '+readCross(s.dir, s.level)};
  }
  if(s.type==='bull'||s.type==='bear'){
    return {title:SIG[s.type].text, tag:s.fresh?'Confirmed':'Stale',
            sub:'fired at %K '+s.level.toFixed(1)+', '+readCross(s.dir, s.level)};
  }
  if(s.nearing){
    const side = s.dir==='bull' ? 'under' : 'over';
    const when = !isFinite(s.eta) ? 'closing slowly'
               : s.eta<=1 ? 'meets next bar at this pace'
               : 'about '+Math.round(s.eta)+' bars at this pace';
    return {title:SIG[s.type].text, tag:'Approaching',
            sub:'%K '+s.gap.toFixed(1)+' '+side+' %D and turning into it, '+when};
  }
  if(s.type==='flat')
    return {title:SIG.flat.text, sub:'%K and %D within '+s.gap.toFixed(1)+' at '+s.level.toFixed(1)};

  const side = s.type==='holding-bull' ? 'over' : 'under';
  return {title:SIG[s.type].text,
          sub:'%K '+s.gap.toFixed(1)+' '+side+' %D, '+(s.closing?'converging':'widening')};
}

function kdCell(key){
  const st = stoch[active] && stoch[active][key];
  if(!st) return '<span class="dv">·</span>';
  const k = st.k[st.k.length-1], d = st.d[st.d.length-1];
  if(k==null||d==null) return '<span class="dv">·</span>';
  return '<span class="kv">'+k.toFixed(1)+'</span>'+
         '<span class="kslash">/</span>'+
         '<span class="dv">'+d.toFixed(1)+'</span>';
}

function deltaCell(key){
  const st = stoch[active] && stoch[active][key];
  if(!st) return '—';
  const k = st.k[st.k.length-1], d = st.d[st.d.length-1];
  if(k==null||d==null) return '—';
  const g = k-d;
  const col = g>0 ? 'var(--up)' : g<0 ? 'var(--down)' : 'var(--mute)';
  return spark(key)+'<span class="dnum num" style="color:'+col+'">'+signed(g)+'</span>';
}

function spark(key){
  const st = stoch[active][key];
  if(!st) return '';
  const g = gapSeries(st.k, st.d, 8).filter(v=>v!==null);
  if(g.length<2) return '';
  const W=56, H=18, mid=H/2, bw=W/g.length;
  const scale = Math.max(4, ...g.map(Math.abs));
  let bars='';
  g.forEach((v,i)=>{
    const h = Math.max(1, Math.abs(v)/scale*(mid-1.5));
    const y = v>=0 ? mid-h : mid;
    const col = v>=0 ? '#3ECF8E' : '#F0616D';
    const op = 0.32 + 0.68*(i/(g.length-1));
    bars += '<rect x="'+(i*bw+0.8).toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+(bw-1.6).toFixed(1)+
            '" height="'+h.toFixed(1)+'" rx="1" fill="'+col+'" opacity="'+op.toFixed(2)+'"/>';
  });
  return '<svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" aria-hidden="true">'+bars+
         '<line x1="0" y1="'+mid+'" x2="'+W+'" y2="'+mid+'" stroke="#1B212B"/></svg>';
}

function buildPanels(){
  const conf = [], pot = [];
  for(const tf of TFS){
    const s = states[active][tf.key];
    if(s && (s.type==='bull'||s.type==='bear')){
      conf.push({tf, dir:s.dir, stale:!s.fresh,
                 what:(s.dir==='bull'?'Bull':'Bear')+' cross',
                 how:'%K '+s.level.toFixed(1)+' '+zoneTag(s.level)+' · '+barsTag(s.barsAgo)+
                     ' · '+readCross(s.dir, s.level),
                 edge: edgeFor(active, tf.key, s.dir, s.level)});
    } else if(s && s.pending){
      pot.push({tf, dir:s.dir, what:(s.dir==='bull'?'Bull':'Bear')+' cross',
                how:'crossed, unsettled · %K '+s.level.toFixed(1)+' '+zoneTag(s.level)+
                    ' · settles in <span id="pc-'+tf.key+'">—</span>',
                edge: edgeFor(active, tf.key, s.dir, s.level)});
    } else if(s && s.nearing){
      pot.push({tf, dir:s.dir, what:(s.dir==='bull'?'Bull':'Bear')+' cross nearing',
                how:'not crossed yet · %K '+s.gap.toFixed(1)+' '+(s.dir==='bull'?'under':'over')+
                    ' %D and turning in'+(isFinite(s.eta)?', about '+Math.round(s.eta)+' bars':'')});
    }
    const dv = divNow[active][tf.key];
    if(dv && (dv.pending || dv.barsAgo <= 12)){
      const n = dv.legs+1;
      const what = (dv.dir==='bull'?'Bull':'Bear')+' divergence';
      const how = n+' legs · '+(dv.dir==='bull' ? 'price lower, %K higher'
                                                : 'price higher, %K lower')+
                  ' · '+(dv.pending ? 'leg unset until it turns' : barsTag(dv.barsAgo));
      (dv.pending ? pot : conf).push({tf, dir:dv.dir, what, how});
    }
  }
  const paint = (id, items, empty) => {
    const ul = $(id);
    ul.innerHTML = items.length ? '' : '<li class="empty" style="display:block">'+empty+'</li>';
    items.forEach(it=>{
      const col = it.stale ? 'var(--mute)' : (it.dir==='bull' ? 'var(--up)' : 'var(--down)');
      const li = document.createElement('li');
      li.innerHTML = '<span class="tfk">'+it.tf.key+'</span>'+
                     '<span><span class="what" style="color:'+col+'">'+it.what+'</span>'+
                     '<span class="how">'+it.how+'</span>'+
                     (it.edge ? '<span class="edge'+(it.edge.thin?' thin':'')+'" title="'+
                       nvEsc(edgeTitle(it.edge))+'">'+edgeLine(it.edge)+'</span>' : '')+
                     '</span>';
      ul.appendChild(li);
    });
  };
  paint('list-conf', conf, 'No settled signal on any frame.');
  paint('list-pot',  pot,  'No live-bar activity.');
}

/*  The signature element: five blocks, width proportional to that timeframe's
    weight, tinted by its stance. Wide blocks are the slow frames, so a screen
    of green on the left means the trend agrees where it counts most.        */
function renderBtcStrip(){
  const row = $('btcrow'), verdict = $('btcverdict');
  verdict.classList.remove('with','against');
  if(active===BTC || !states[BTC]){
    row.hidden = true;
    verdict.textContent = active===BTC ? 'This is the market reference' : 'Width = frame weight';
    return;
  }
  row.hidden = false;
  const box = $('btcstrip');
  box.innerHTML = '';
  TFS.forEach(tf=>{
    const v = btcSideOn(tf.key);
    const col = v===null ? 'var(--mute)' : v>0.15 ? 'var(--up)' : v<-0.15 ? 'var(--down)' : 'var(--mute)';
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.style.flexGrow = String(tf.weight);
    seg.style.flexShrink = '1';
    seg.style.flexBasis = '0%';
    seg.title = 'BTC '+tf.label;
    seg.innerHTML = '<i style="background:'+col+';opacity:'+(v===null?0.08:0.10+Math.min(1,Math.abs(v))*0.28)+'"></i>';
    box.appendChild(seg);
  });

  const al = alignBtc(states[active]);
  if(!al.n){ verdict.textContent = 'BTC reference loading'; return; }
  if(al.pct>=40){
    verdict.textContent = 'Running with BTC on '+al.agree+' of '+al.n+' frames';
    verdict.classList.add('with');
  } else if(al.pct<=-40){
    verdict.textContent = 'Fighting BTC on '+al.clash+' of '+al.n+' frames';
    verdict.classList.add('against');
  } else {
    verdict.textContent = 'Mixed against BTC · '+al.agree+' with, '+al.clash+' against';
  }
}

function renderStance(){
  const box = $('strip');
  const total = TFS.reduce((n,t)=>n+t.weight,0);
  box.innerHTML = '';
  TFS.forEach(tf=>{
    const v = sideOf(states[active] && states[active][tf.key]);
    const col = v>0.15 ? 'var(--up)' : v<-0.15 ? 'var(--down)' : 'var(--mute)';
    const seg = document.createElement('button');
    seg.className = 'seg';
    seg.style.flexGrow = String(tf.weight);
    seg.style.flexShrink = '1';
    seg.style.flexBasis = '0%';
    seg.title = tf.label+' — '+(v>0.15?'bullish':v<-0.15?'bearish':'neutral');
    seg.innerHTML = '<i style="background:'+col+';opacity:'+(0.10+Math.min(1,Math.abs(v))*0.30)+'"></i>'+
                    '<b style="color:'+col+'">'+tf.key+'</b>';
    seg.onclick = ()=>{
      if(!shown.includes(tf.key)){ shown=[...shown, tf.key]; buildPicker(); buildCharts(); }
      const el = document.getElementById('cv-'+tf.key);
      if(el) el.scrollIntoView({behavior:'smooth', block:'center'});
    };
    box.appendChild(seg);
  });
}


/*  ---- live backtest badge on every cross --------------------------------
    The History tab already answers "how has this setup performed" for
    whichever bucket you go looking for. This attaches that same answer
    directly to the signal the moment it's on screen, so reading the edge
    doesn't require leaving the terminal to go check.

    One thing worth being careful about: replayCrosses reorients every return
    so + always means "the call was right" — a bear cross that gets +2% is
    a 2% drop, correctly called. That's the right shape for scoring win rate,
    but it is NOT what "will it go up or down" is asking. So here the sign is
    flipped back for bear setups before anything is displayed, because a
    trader reading "+2.1%" on a bear row must see an actual expected drop,
    not a scoring artefact that happens to look like a gain.                 */
let edgeCache = {};
function histEdge(sym){
  if(!edgeCache[sym]) edgeCache[sym] = historyFor(sym);
  return edgeCache[sym];
}

function edgeFor(sym, frameKey, dir, level){
  if(level==null) return null;
  const per = histEdge(sym);
  if(!per || !per.buckets) return null;   // no analysed data for this coin yet
  const zone = zoneOf(level);
  const b = per.buckets[frameKey+'|'+dir+'|'+zone];
  if(!b || !b.sum) return null;

  const byH = {};
  HORIZONS.forEach(h=>{
    const st = b.sum.byH[h];
    byH[h] = st ? {
      n: st.n, win: st.win,
      move:    +((dir==='bull' ? st.med : -st.med).toFixed(2)),
      avgMove: +((dir==='bull' ? st.avg : -st.avg).toFixed(2))
    } : null;
  });
  const mid = byH[H_MAIN] || byH[HORIZONS[0]];
  if(!mid) return null;
  return {n:b.sum.n, thin:b.sum.n<30, zone, dir, frame:frameKey, byH, primary:mid};
}

function edgeLine(e){
  const parts = HORIZONS.map(h=>{
    const st = e.byH[h];
    if(!st) return spanShort(e.frame,h)+' —';
    const wc = st.win>=55 ? 'var(--up)' : st.win<=45 ? 'var(--down)' : 'var(--mute)';
    const mc = st.move>=0 ? 'var(--up)' : 'var(--down)';
    const sign = st.move>0 ? '+' : '';
    return spanShort(e.frame,h)+' <span style="color:'+wc+'">'+st.win+'%</span>/'+
           '<span style="color:'+mc+'">'+sign+st.move+'%</span>';
  });
  return '<span class="edgelab">Backtest</span> '+parts.join(' · ')+
         (e.thin?' <span class="edgethin">(thin)</span>':'')+' · n='+e.n;
}

function edgeTitle(e){
  const zoneWord = e.zone==='oversold' ? 'deep oversold' : e.zone==='overbought' ? 'deep overbought' : 'the middle';
  const lines = HORIZONS.map(h=>{
    const st = e.byH[h];
    if(!st) return spanLabel(e.frame,h)+' — not enough closed history yet to score this';
    const sign = st.move>0?'+':'';
    const asign = st.avgMove>0?'+':'';
    return spanLabel(e.frame,h)+' ('+barsLabel(h)+'): '+st.win+'% of '+st.n+' past '+e.dir+' crosses from '+zoneWord+
           ' were right · median '+sign+st.move+'% ('+(st.move>=0?'price up':'price down')+
           ') · average '+asign+st.avgMove+'%';
  });
  lines.push(e.thin
    ? 'Fewer than 30 signals behind this bucket — read it as a lean, not proof.'
    : 'Measured across '+e.n+' past '+e.dir+' crosses on '+e.frame+' from '+zoneWord+
      ', on the history currently loaded for this coin.');
  return lines.join('\n');
}

function render(){
  delete edgeCache[active];      // fresh candles this render — score them again
  const rows = $('rows');
  rows.innerHTML = '';
  for(const tf of TFS){
    const s = states[active][tf.key], st = stoch[active][tf.key];
    const info = {...SIG[s ? s.type : 'none']};
    if(s && s.fresh===false) info.color = 'var(--mute)';
    const txt = signalText(tf.key);
    const k = st && st.k[st.k.length-1], d = st && st.d[st.d.length-1];
    const dv = divNow[active][tf.key], total = (divsAll[active][tf.key]||[]).length;
    const e = (s && s.level!=null && (s.type==='bull'||s.type==='bear'||s.pending))
      ? edgeFor(active, tf.key, s.dir, s.level) : null;

    const el = document.createElement('div');
    el.className = 'mrow';
    const tagTone = txt.tag==='Confirmed' ? 'ok' : txt.tag==='Stale' ? 'dim' : '';
    const age = !s ? '·'
      : s.pending ? 'live'
      : (s.type==='bull'||s.type==='bear') ? barsTag(s.barsAgo) : '·';
    const lvl = s && s.level!=null ? s.level : (k!=null?k:null);

    el.innerHTML =
      '<div class="tfk">'+tf.key+'</div>'+

      '<div class="sigcell">'+
        '<div class="sigline"><span class="'+(info.ring?'ring':'dot')+'" style="'+
          (info.ring?'':'background:'+info.color)+'"></span>'+
          '<span class="stitle">'+txt.title+'</span>'+
          (txt.tag ? '<span class="tag '+tagTone+'">'+txt.tag+'</span>' : '')+
          (txt.countdown ? '<span class="cd num" id="cd-'+tf.key+'">—</span>' : '')+
        '</div>'+
        '<div class="sub">'+txt.sub+'</div>'+
        (e ? '<div class="edge'+(e.thin?' thin':'')+'" title="'+nvEsc(edgeTitle(e))+'">'+edgeLine(e)+'</div>' : '')+
      '</div>'+

      '<div class="age num">'+age+'</div>'+
      '<div class="kd num" id="kd-'+tf.key+'">'+kdCell(tf.key)+'</div>'+
      '<div class="delta" id="sp-'+tf.key+'">'+deltaCell(tf.key)+'</div>'+

      '<div class="zone">'+(lvl!=null
        ? '<span class="zpill" style="color:'+zoneTone(lvl)+'">'+zoneTag(lvl)+'</span>'
        : '<span class="none">·</span>')+'</div>'+

      '<div class="trend">'+(()=>{
        const e = st && st.ema;
        if(!e || !e.ok) return '<span class="tpill">n/a</span>';
        return '<span class="tpill '+(e.above?'above':'below')+'" title="'+
               (e.above?'above':'below')+' the 200 by '+Math.abs(e.dist).toFixed(1)+'%">'+
               (e.above?'above':'below')+'</span>';
      })()+'</div>'+
      '<div class="dvg">'+(dv
        ? '<span class="chip" style="color:'+(dv.dir==='bull'?'var(--up)':'var(--down)')+
          ';background:'+(dv.dir==='bull'?'rgba(62,207,142,.10)':'rgba(240,97,109,.10)')+'">'+
          (dv.dir==='bull'?'Bull':'Bear')+'</span>'+
          '<span class="dmeta num">'+(dv.legs+1)+'L '+(dv.pending?'live':barsTag(dv.barsAgo))+'</span>'
        : '<span class="none">·</span>')+'</div>';
    rows.appendChild(el);
  }

  const meta = symbolOf(active);
  paintPrice();
  document.querySelector('.sym').innerHTML =
    nvIcon(active) + nvEsc(nvCoinName(active, meta.name));
  document.querySelector('.quote').textContent = MARKET==='linear' ? '/ USDT perpetual' : '/ USDT spot';

  const score = bias(states[active], WEIGHTS);
  const agreeing = TFS.filter(t=>{ const v = sideOf(states[active][t.key]); return score>=0 ? v>0 : v<0; }).length;
  $('verdict').textContent = Math.abs(score)<=8
    ? 'Composite mixed, no frame majority'
    : 'Composite '+(score>0?'long':'short')+', '+agreeing+' of 5 frames aligned';
  const sc = $('score');
  sc.textContent = (score>0?'+':'') + score;
  sc.style.color = score>8 ? 'var(--up)' : score<-8 ? 'var(--down)' : 'var(--mute)';
  $('src').textContent = marketLabel();
  renderStance();
  renderBtcStrip();
  renderTrackBtn();
  buildPanels();
  tick();
}

// one-second heartbeat: bar countdowns and freshness, no refetch
function tick(){
  for(const tf of TFS){
    const c = data[active] && data[active][tf.key];
    if(!c) continue;
    const left = countdown(barClose(tf, c[c.length-1].t) - Date.now());
    const a = $('cd-'+tf.key), b = $('pc-'+tf.key);
    if(a) a.textContent = left;
    if(b) b.textContent = left;
  }
  if(!lastOk) return;
  const age = Math.round((Date.now()-lastOk)/1000);
  $('livetxt').textContent = age<3 ? 'Live' : 'Live · updated '+age+'s ago';
  $('pulse').classList.toggle('stale', age>45);
}
