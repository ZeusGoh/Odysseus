/* ui-tvchart.js — the real TradingView chart on the Terminal.

   TradingView's free embed: their chart, their data (the same Bybit book the
   app reads), their toolbar — zoom, draw, add studies. It follows the coin and
   market the symbol bar has picked, and an interval of its own that is
   remembered. The embed is a sealed box: nothing the app computes can be drawn
   inside it, which is why the app's own frame charts, with the crosses and
   divergence lines, stay directly beneath. Anything set inside the widget
   (an indicator's inputs, a drawing) lives until the page is left.
   part of Odysseus */

const TV_KEY = 'vl.tv.v1';
const TV_EMBED = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
const TV_INTERVALS = [
  { key: '60',  label: '1H' },
  { key: '240', label: '4H' },
  { key: 'D',   label: '1D' },
  { key: 'W',   label: '1W' },
  { key: 'M',   label: '1M' },
];

const tvState = {
  interval: (() => { try { return localStorage.getItem(TV_KEY) || 'D'; } catch (e) { return 'D'; } })(),
  built: null,             // symbol|interval the box currently shows
};

/*  Bybit's names on TradingView: the perpetual is BTCUSDT.P, spot is BTCUSDT.  */
function tvSymbol() {
  const s = symbolOf(active).sym;
  return 'BYBIT:' + s + 'USDT' + (MARKET === 'linear' ? '.P' : '');
}

function tvChartShow(force) {
  const box = $('tv-box'), sec = $('tvchart');
  if (!box || !sec) return;
  if (typeof view !== 'undefined' && view !== 'terminal') return;
  if (sec.classList.contains('folded')) return;
  const key = tvSymbol() + '|' + tvState.interval;
  if (!force && tvState.built === key) return;
  tvState.built = key;

  const sym = $('tv-sym');
  if (sym) sym.textContent = symbolOf(active).sym + '/USDT ' + (MARKET === 'linear' ? 'perpetual' : 'spot') + ' · Bybit';
  tvPaintWin();

  box.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'tradingview-widget-container';
  wrap.style.height = '100%';
  const inner = document.createElement('div');
  inner.className = 'tradingview-widget-container__widget';
  inner.style.height = '100%';
  wrap.appendChild(inner);
  const s = document.createElement('script');
  s.type = 'text/javascript';
  s.src = TV_EMBED;
  s.async = true;
  s.text = JSON.stringify({
    autosize: true,
    symbol: tvSymbol(),
    interval: tvState.interval,
    timezone: 'Etc/UTC',
    theme: 'dark',
    style: '1',
    locale: 'en',
    backgroundColor: '#0E121A',
    gridColor: 'rgba(255,255,255,0.04)',
    hide_top_toolbar: false,
    hide_legend: false,
    hide_volume: false,
    allow_symbol_change: false,
    save_image: false,
    calendar: false,
    withdateranges: false,
    studies: ['STD;Stochastic'],
    support_host: 'https://www.tradingview.com',
  });
  wrap.appendChild(s);
  box.appendChild(wrap);
}

function tvChartDispose() {
  const box = $('tv-box');
  if (box) box.innerHTML = '';
  tvState.built = null;
}

function tvSetInterval(key) {
  if (!TV_INTERVALS.some(i => i.key === key)) return;
  tvState.interval = key;
  try { localStorage.setItem(TV_KEY, key); } catch (e) {}
  tvChartShow();
}

function tvPaintWin() {
  const win = $('tv-win');
  if (!win) return;
  if (!win.children.length) {
    win.innerHTML = TV_INTERVALS.map(i => '<button data-tv-int="' + i.key + '">' + i.label + '</button>').join('');
    win.addEventListener('click', e => {
      const b = e.target.closest('[data-tv-int]');
      if (b) tvSetInterval(b.getAttribute('data-tv-int'));
    });
  }
  win.querySelectorAll('[data-tv-int]').forEach(b => b.classList.toggle('on', b.getAttribute('data-tv-int') === tvState.interval));
}
