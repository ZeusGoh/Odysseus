/* boot.js — Boot. Every DOM wiring line and every start-up call, in their original order.
   Loaded last, so everything it touches is already defined.
   part of Odysseus */

/* ---------- nav menu ---------- */
$('navbtn').onclick = e=>{ e.stopPropagation(); navOpen(); };
// click anywhere else, or Escape, closes it — the panel overlays the page, so leaving
// it open while you work on what is underneath is never what you meant
document.addEventListener('click', e=>{
  if(!$('navpanel').hidden && !(e.target.closest && e.target.closest('.navwrap'))) navOpen(false);
});
addEventListener('keydown', e=>{ if(e.key==='Escape') navOpen(false); });

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
$('nav-crowd').onclick = ()=> setView('crowd');
$('cr-run').onclick    = runCrowd;
$('cr-stop').onclick   = ()=>{ crowdAbort = true; };
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
  const res = await sendTelegram('ODYSSEUS test alert — if you can read this, Telegram is wired up correctly.');
  notifyBrowser('ODYSSEUS test alert', 'Browser notifications are working.');
  alertLog.unshift({t:Date.now(), title:'ODYSSEUS test alert', body:'manual test',
                    tg: res.ok ? 'sent' : (res.why||'off')});
  renderAlertLog();
  $('a-test').textContent = res.ok ? 'Sent' : 'Failed';
  if(!res.ok) $('a-note').textContent = 'Telegram refused it: '+(res.why||'unknown')+
    '. Check the token, and make sure you have sent your bot a message first.';
  setTimeout(()=>{ $('a-test').textContent = 'Send test'; }, 2000);
};
$('nav-hist').onclick  = ()=> setView('hist');
$('h-run').onclick     = buildHistory;
$('nav-sessions').onclick = ()=> setView('sessions');

/* ---------- journal ---------- */
$('nav-journal').onclick = ()=> setView('journal');
$('nav-analyst').onclick = ()=> setView('analyst');
$('nav-anhist').onclick  = ()=> setView('anhist');
$('j-new').onclick = ()=> jOpenForm();
$('j-cancel').onclick = ()=>{ $('j-form').hidden = true; };
$('j-save').onclick = jSaveForm;
$('j-refresh').onclick = ()=> jRefreshPrices(($('j-sym').value||'').trim().toUpperCase() || undefined);
$('j-import').onclick = ()=> $('j-import-file').click();
$('j-import-file').addEventListener('change', async e=>{
  const file = e.target.files[0];
  if(!file) return;
  try{
    const parsed = JSON.parse(await file.text());
    const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.trades) ? parsed.trades : null);
    if(!list) throw new Error('that file doesn\'t look like a trades export');
    const r = jImportTrades(list);
    $('jnote').textContent = r.added
      ? 'Imported '+r.added+' trade'+(r.added===1?'':'s')+' from Bybit'+
        (r.skipped ? ' ('+r.skipped+' already in the journal).' : '.')
      : 'Nothing new — '+(r.skipped ? r.skipped+' trade'+(r.skipped===1?'':'s')+' already logged.' : 'the file had no usable trades.');
    renderJournal();
  }catch(err){
    $('jnote').textContent = 'Could not read that file: '+err.message;
  }
  e.target.value = '';
});
document.querySelectorAll('#j-dir button').forEach(b=>{
  b.onclick = ()=> jSetDir(b.dataset.dir);
});
$('j-sym').addEventListener('input', jUpdateVerdictPreview);
$('j-sym').addEventListener('input', jSyncSource);
$('j-frame').addEventListener('change', jUpdateVerdictPreview);
$('j-entrytime').addEventListener('change', jUpdateVerdictPreview);
$('j-entry').addEventListener('input', jFillSuggestedSize);
$('j-inval').addEventListener('input', jFillSuggestedSize);
// the size box is the trade — typing in it states what that quantity is
// worth and risks, live. A risk amount only ever suggests INTO an empty size
// box (jFillSuggestedSize's own rule), same as entry/invalidation doing so.
$('j-size').addEventListener('input', jRenderSizeWork);
$('j-riskusd').addEventListener('input', jFillSuggestedSize);
$('j-riskusd').addEventListener('change', ()=>{
  const v = parseFloat($('j-riskusd').value);
  if(v > 0){ jCfg.riskUsd = v; jSaveCfg(); }
});
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
  if(b.classList.contains('jmore')){
    const det = $('jd-'+id);
    if(det){
      det.hidden = !det.hidden;
      b.setAttribute('aria-expanded', String(!det.hidden));
      b.textContent = det.hidden ? 'Details' : 'Hide';
    }
    return;   // a re-render here would collapse the panel that was just opened
  }
  if(b.classList.contains('jreopen')){ jReopen(id); renderJournal(); }
  else if(b.classList.contains('jdel')){ jDelete(id); renderJournal(); }
});
$('j-riskusd').value = jCfg.riskUsd || '';
jRenderSizeWork();
renderJournal();
buildBybitControls();
foldInit();                       // every panel gets its chevron, folded ones stay folded
/* ---------- structure views ---------- */
$('nav-anomhist').onclick = ()=> setView('anomhist');

$('nav-btc').onclick      = ()=> setView('btc');
buildBtcControls();
$('nav-terminal').onclick = ()=> setView('terminal');
$('nav-watch').onclick    = ()=> setView('watch');

/* ---------- cloud ---------- */
$('nav-cloud').onclick = ()=> setView('cloud');
$('cl-saveconfig').onclick = ()=>{
  const note = $('cl-confignote');
  try{
    cloudCfg.fb = cloudParseConfig($('cl-config').value);
    cloudSaveCfg();
    note.textContent = 'Saved. Sign in below — the first sign-in on a machine pulls everything down.';
    cloudRender();
  }catch(e){
    note.textContent = 'Could not read that: '+e.message+
      '. Paste the whole firebaseConfig block, braces included.';
  }
};
async function clAuth(makeAccount){
  const note = $('cl-last');
  const email = $('cl-email').value.trim(), pass = $('cl-pass').value;
  if(!cloudConfigured()){ note.textContent = 'Connect a Firebase project first.'; return; }
  if(!email || !pass){ note.textContent = 'Email and password are both needed.'; return; }
  note.textContent = makeAccount ? 'Creating account…' : 'Signing in…';
  try{
    await cloudSignIn(email, pass, makeAccount);
    $('cl-pass').value = '';
    cloudRender();
    note.textContent = 'Signed in. Syncing…';
    await cloudSyncAndRefresh();
    cloudRender();
  }catch(e){
    note.textContent = (makeAccount ? 'Could not create that account: ' : 'Could not sign in: ')+e.message;
    cloudRender();
  }
}
$('cl-signin').onclick = ()=> clAuth(false);
$('cl-signup').onclick = ()=> clAuth(true);
$('cl-signout').onclick = async ()=>{
  await cloudSignOut();
  cloudRender();
  $('cl-last').textContent = 'Signed out. This machine keeps its own copy of everything.';
};
$('cl-sync').onclick = ()=>{
  if(!cloudOn()){ $('cl-last').textContent = 'Sign in first.'; return; }
  cloudSyncAndRefresh();
};
$('cl-secrets').onchange = e=>{
  cloudCfg.syncSecrets = e.target.checked;
  cloudSaveCfg();
  cloudRender();
};

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
idleInit();
cloudInit();
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
lsrShow();
oicvdShow();
crowdTermShow();
// the positioning chart is heavy (deep history, a chart library) — it loads when its panel is opened
$('crowdchart').addEventListener('fold', e => { if(e.detail.folded) cxDispose(); else if(ctState.data) crowdTermChartShow(); });
refreshTicker();
ensureBtc(true);
setInterval(()=>ensureBtc(), 30000);
setInterval(load, POLL);
setInterval(refreshTicker, 5000);
setInterval(tick, 1000);

$('nv-run').onclick  = newsScan;
$('nv-stop').onclick = ()=>{ newsAbort = true; };
$('nav-news').onclick = ()=> setView('news');
