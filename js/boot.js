/* boot.js — Boot. Every DOM wiring line and every start-up call, in their original order.
   Loaded last, so everything it touches is already defined.
   part of VL */

$('trackbtn').onclick = ()=>{
  if(watch.includes(active)) removeWatch(active);
  else addWatch(active);
};
$('waddbtn').onclick = ()=>{
  const hits = searchSymbols($('wsearch').value);
  addWatch(hits.length ? hits[0].sym : $('wsearch').value);
};
$('nav-scan').onclick  = ()=> setView('scan');
$('sc-run').onclick    = runScan;
$('sc-stop').onclick   = ()=>{ scanAbort = true; };
$('nav-alerts').onclick = ()=> setView('alerts');
$('a-on').onchange = e=> armAlerts(e.target.checked);
$('a-save').onclick = ()=>{
  alertCfg.token = $('a-token').value.trim();
  alertCfg.chat  = $('a-chat').value.trim();
  const ok = saveAlertCfg();
  $('a-note').textContent = ok
    ? 'Saved in this browser. The token is sent only to api.telegram.org.'
    : 'This preview cannot save, so these last only for the session.';
};
$('a-test').onclick = async ()=>{
  $('a-test').textContent = 'Sending…';
  const res = await sendTelegram('VL test alert — if you can read this, Telegram is wired up correctly.');
  notifyBrowser('VL test alert', 'Browser notifications are working.');
  alertLog.unshift({t:Date.now(), title:'VL test alert', body:'manual test',
                    tg: res.ok ? 'sent' : (res.why||'off')});
  renderAlertLog();
  $('a-test').textContent = res.ok ? 'Sent' : 'Failed';
  if(!res.ok) $('a-note').textContent = 'Telegram refused it: '+(res.why||'unknown')+
    '. Check the token, and make sure you have sent your bot a message first.';
  setTimeout(()=>{ $('a-test').textContent = 'Send test'; }, 2000);
};
$('nav-hist').onclick  = ()=> setView('hist');
$('h-run').onclick     = buildHistory;

/* ---------- journal ---------- */
$('nav-journal').onclick = ()=> setView('journal');
$('j-new').onclick = ()=> jOpenForm();
$('j-cancel').onclick = ()=>{ $('j-form').hidden = true; };
$('j-save').onclick = jSaveForm;
$('j-refresh').onclick = ()=> jRefreshPrices(($('j-sym').value||'').trim().toUpperCase() || undefined);
document.querySelectorAll('#j-dir button').forEach(b=>{
  b.onclick = ()=> jSetDir(b.dataset.dir);
});
$('j-sym').addEventListener('input', jUpdateVerdictPreview);
$('j-frame').addEventListener('change', jUpdateVerdictPreview);
$('j-entrytime').addEventListener('change', jUpdateVerdictPreview);
$('j-entry').addEventListener('input', jFillSuggestedSize);
$('j-inval').addEventListener('input', jFillSuggestedSize);
$('j-account').addEventListener('change', ()=>{ jCfg.account = parseFloat($('j-account').value)||jCfg.account; jSaveCfg(); });
$('j-riskpct').addEventListener('change', ()=>{ jCfg.riskPct = parseFloat($('j-riskpct').value)||jCfg.riskPct; jSaveCfg(); });
// one delegated listener per table rather than re-binding on every render
$('j-open-rows').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  const id = b.dataset.id;
  if(b.classList.contains('jclose'))       jStartClose(id);
  else if(b.classList.contains('jconfirm'))     jConfirmClose(id);
  else if(b.classList.contains('jcancelclose')) jCancelClose();
  else if(b.classList.contains('jdel')){ jDelete(id); renderJournal(); }
});
$('j-closed-rows').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  const id = b.dataset.id;
  if(b.classList.contains('jreopen')){ jReopen(id); renderJournal(); }
  else if(b.classList.contains('jdel')){ jDelete(id); renderJournal(); }
});
$('j-account').value = jCfg.account;
$('j-riskpct').value = jCfg.riskPct;
renderJournal();
$('nav-logan').onclick = ()=> setView('logan');
$('lg-offbtn').onclick = ()=>{ const b=$('lg-settings'); b.hidden=false; $('lg-key').focus(); };
$('lg-send').onclick = ()=>{ const t=$('lg-text'); lgSend(t.value); t.value=''; t.style.height='auto'; };
$('lg-text').addEventListener('keydown', e=>{
  if(e.key==='Enter' && !e.shiftKey){
    e.preventDefault();
    const t=$('lg-text'); lgSend(t.value); t.value=''; t.style.height='auto';
  }
});
$('lg-text').addEventListener('input', e=>{
  e.target.style.height='auto';
  e.target.style.height = Math.min(130, e.target.scrollHeight)+'px';
});
$('lg-clear').onclick = ()=>{ lgChat = []; lgApi = []; lgRender(); };
$('lg-setup').onclick = ()=>{ const b=$('lg-settings'); b.hidden = !b.hidden; };
$('lg-save').onclick = ()=>{
  lgCfg.key = $('lg-key').value.trim();
  lgCfg.model = $('lg-model').value.trim();
  const ok = lgSaveCfg();
  $('lg-keynote').textContent = ok
    ? 'Saved in this browser. Sent only to api.anthropic.com.'
    : 'This preview cannot save settings, so the key lasts only for this session.';
  $('lg-settings').hidden = true;
  lgSetMode();
};
$('lg-brief').onclick = async ()=>{
  const text = briefing();
  try{
    await navigator.clipboard.writeText(text);
    $('lg-brief').textContent = 'Copied';
  }catch(e){
    // clipboard blocked (common on file://) — put it in the log to copy by hand
    lgPush('assistant', 'Clipboard is blocked here, so here is the briefing to copy:\n\n'+text);
    $('lg-brief').textContent = 'In chat';
  }
  setTimeout(()=>{ $('lg-brief').textContent = 'Copy briefing'; }, 1800);
};
$('nav-terminal').onclick = ()=> setView('terminal');
$('nav-watch').onclick    = ()=> setView('watch');

const wInput = $('wsearch');
wInput.addEventListener('focus', ()=> loadUniverse());
wInput.addEventListener('input', async ()=>{
  renderWSugg(searchSymbols(wInput.value));
  await loadUniverse();
  if(document.activeElement===wInput) renderWSugg(searchSymbols(wInput.value));
});
wInput.addEventListener('keydown', e=>{
  if(e.key==='Enter'){
    const hits = searchSymbols(e.target.value);
    addWatch(hits.length ? hits[0].sym : e.target.value);
  }
  if(e.key==='Escape') $('wsugg').hidden = true;
});
wInput.addEventListener('blur', ()=> setTimeout(()=>{ $('wsugg').hidden = true; }, 120));

$('refresh').onclick = load;
$('m-perp').onclick = ()=> switchMarket('linear');
$('m-spot').onclick = ()=> switchMarket('spot');
$('why').onchange = redrawWhy;
$('pickall').onclick = ()=>{ shown = shown.length===5 ? ['1D'] : TFS.map(t=>t.key); buildPicker(); buildCharts(); };
const symInput = $('symsearch');
symInput.addEventListener('focus', async ()=>{
  await loadUniverse();
  if(symInput.value.trim()) renderSuggestions(searchSymbols(symInput.value));
});
symInput.addEventListener('input', async ()=>{
  renderSuggestions(searchSymbols(symInput.value));
  await loadUniverse();
  if(document.activeElement===symInput) renderSuggestions(searchSymbols(symInput.value));
});
symInput.addEventListener('keydown', e=>{
  if(e.key==='Enter'){
    const hits = searchSymbols(e.target.value);
    switchSymbol(hits.length ? hits[0].sym : e.target.value);
    $('symsugg').hidden = true;
  }
  if(e.key==='Escape') $('symsugg').hidden = true;
});
symInput.addEventListener('blur', ()=> setTimeout(()=>{ $('symsugg').hidden = true; }, 120));

let rz; addEventListener('resize', ()=>{
  if(LWC()) return;                      // autoSize handles it
  clearTimeout(rz); rz = setTimeout(buildCharts,150);
});
nvLoadCoins();
watch = store.read();
updateWatchCount();
renderTrackBtn();
lgInit();
buildScanControls();
buildHistHeads();
buildAlertControls();
restartAlertTimer();
if(alertCfg.on) alertTick();
buildScanControls();
buildPicker();
buildSymbolPicker();
setInterval(()=>{ if(view==='watch') scanWatch(); }, 15000);
load();
refreshTicker();
ensureBtc(true);
setInterval(()=>ensureBtc(), 30000);
setInterval(load, POLL);
setInterval(refreshTicker, 5000);
setInterval(tick, 1000);

$('nv-run').onclick  = newsScan;
$('nv-stop').onclick = ()=>{ newsAbort = true; };
$('nav-news').onclick = ()=> setView('news');
