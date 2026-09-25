/* oicvd.js — open interest and cumulative volume delta, perpetual and spot,
   read together.

   CVD is the running sum of taker buy volume minus taker sell volume: the
   net of who has been hitting the market, bar by bar, added up. Binance's
   klines carry the taker-buy share of every bar, on spot and on the
   perpetual alike, so both CVDs come from the same shape of row and are
   comparable by construction. Open interest is Binance's own hourly (or
   finer) history for the same contract.

   The point of having the three side by side: open interest says whether
   positions are being opened or closed, the perp CVD says which side is
   doing the hitting, and the spot CVD says whether real money agrees.
   Price up on rising OI and a rising perp CVD is longs opening; price down
   on rising OI is shorts opening; OI falling is positions closing — short
   covering if price rises, long liquidation if it falls. Spot and perp CVD
   pulling apart says which market is leading, and whether the move is
   leverage or money.

   Pure: raw rows in, series and a read out. The fetching and the drawing
   are in ui-oicvd.js.
   part of Odysseus */

/* ==OICVD_START== */
const OICVD_WINDOWS = [
  { key: '24h', interval: '15m', period: '15m', bars: 96,  ms: 900e3 },
  { key: '3d',  interval: '15m', period: '15m', bars: 288, ms: 900e3 },
  { key: '7d',  interval: '1h',  period: '1h',  bars: 168, ms: 3600e3 },
  { key: '30d', interval: '4h',  period: '4h',  bars: 180, ms: 14400e3 },
];
const OICVD_FLAT_OI = 1;          // % change in OI below this is "flat"
const OICVD_FLAT_PX = 0.5;        // % change in price below this is "flat"

/*  A Binance kline row (spot and USDⓈ-M futures share the layout):
    [openTime, o, h, l, c, volume, closeTime, quoteVol, trades, takerBuyBase, takerBuyQuote, _]
    Delta per bar in base coins = taker buys − taker sells = 2·takerBuy − volume.
    The sum starts at zero at the first bar, so a CVD is always "since the
    window began" — the level means nothing, the slope and the shape do.  */
function cvdFromKlines(rows) {
  const out = [];
  let cum = 0;
  for (const r of rows || []) {
    if (!Array.isArray(r)) continue;
    const t = +r[0], vol = +r[5], buy = +r[9], close = +r[4];
    if (!isFinite(t) || !isFinite(vol) || !isFinite(buy)) continue;
    const delta = 2 * buy - vol;
    cum += delta;
    out.push({ t, delta: +delta.toFixed(4), cum: +cum.toFixed(4), close: isFinite(close) ? close : null, vol });
  }
  return out.sort((a, b) => a.t - b.t);
}

/*  Binance futures/data/openInterestHist rows → {t, oi (coins), oiUsd}.   */
function oiFromHist(rows) {
  return (rows || []).map(r => ({ t: +r.timestamp, oi: +r.sumOpenInterest, oiUsd: +r.sumOpenInterestValue }))
    .filter(p => isFinite(p.t) && isFinite(p.oi)).sort((a, b) => a.t - b.t);
}

function oicvdPct(a, b) { return a > 0 && isFinite(b) ? +((b - a) / a * 100).toFixed(2) : null; }
function oicvdFirstLast(series, key) {
  if (!series || !series.length) return null;
  return { first: series[0][key], last: series[series.length - 1][key] };
}

/*  The read over the window. Four things are measured — price change, OI
    change, the perp CVD's end level and the spot CVD's end level — and
    turned into: what positions did (opened long / opened short / covered /
    liquidated / flat), which market led (spot or perp), and whether the
    hitting matched the price (or was absorbed). Lean is the combination,
    and it stays null when the picture is mixed.                          */
function oicvdRead(d) {
  const perp = d && d.perp ? d.perp : [];
  const spot = d && d.spot ? d.spot : [];
  const oi = d && d.oi ? d.oi : [];
  const px = oicvdFirstLast(perp.length ? perp : spot, 'close');
  const o = oicvdFirstLast(oi, 'oi');
  const priceChg = px ? oicvdPct(px.first, px.last) : null;
  const oiChg = o ? oicvdPct(o.first, o.last) : null;
  const perpCvd = perp.length ? perp[perp.length - 1].cum : null;
  const spotCvd = spot.length ? spot[spot.length - 1].cum : null;

  // positions
  let positions = null, posWhy = null;
  if (oiChg != null && priceChg != null) {
    const oiUp = oiChg >= OICVD_FLAT_OI, oiDn = oiChg <= -OICVD_FLAT_OI;
    const pxUp = priceChg >= OICVD_FLAT_PX, pxDn = priceChg <= -OICVD_FLAT_PX;
    if (oiUp && pxUp) { positions = 'longs opening'; posWhy = 'open interest and price both up — new longs are being put on'; }
    else if (oiUp && pxDn) { positions = 'shorts opening'; posWhy = 'open interest up into a falling price — new shorts are being put on'; }
    else if (oiDn && pxUp) { positions = 'short covering'; posWhy = 'open interest falling as price rises — shorts closing, not longs opening'; }
    else if (oiDn && pxDn) { positions = 'longs closing'; posWhy = 'open interest falling with price — longs are being closed or liquidated'; }
    else if (oiUp) { positions = 'positions building'; posWhy = 'open interest up with price going nowhere — both sides loading, a move is being set up'; }
    else if (oiDn) { positions = 'positions unwinding'; posWhy = 'open interest falling with price flat — leverage leaving without a move'; }
    else { positions = 'flat'; posWhy = 'open interest and price both inside the noise'; }
  }

  // which market led
  let led = null, ledWhy = null;
  if (perpCvd != null && spotCvd != null) {
    const ps = Math.sign(perpCvd), ss = Math.sign(spotCvd);
    if (ps > 0 && ss > 0) { led = 'both buying'; ledWhy = 'spot and perps both net buying'; }
    else if (ps < 0 && ss < 0) { led = 'both selling'; ledWhy = 'spot and perps both net selling'; }
    else if (ss > 0 && ps < 0) { led = 'spot-led'; ledWhy = 'spot is buying while perps sell — money in, leverage fading it'; }
    else if (ss < 0 && ps > 0) { led = 'perp-led'; ledWhy = 'perps are buying while spot sells — leverage carrying the bid, money leaving'; }
    else { led = 'flat'; ledWhy = 'neither market has a net side'; }
  }

  // hitting against price: a CVD leaning one way while price goes the other is absorption
  let flow = null, flowWhy = null;
  const net = perpCvd != null && spotCvd != null ? perpCvd + spotCvd : perpCvd != null ? perpCvd : spotCvd;
  if (net != null && priceChg != null) {
    const pxUp = priceChg >= OICVD_FLAT_PX, pxDn = priceChg <= -OICVD_FLAT_PX;
    if (net > 0 && pxUp) { flow = 'buying, paid'; flowWhy = 'net buying and price followed'; }
    else if (net < 0 && pxDn) { flow = 'selling, paid'; flowWhy = 'net selling and price followed'; }
    else if (net > 0 && pxDn) { flow = 'buying absorbed'; flowWhy = 'net buying into a falling price — the buyers are being sold to and not getting paid'; }
    else if (net < 0 && pxUp) { flow = 'selling absorbed'; flowWhy = 'net selling into a rising price — the sellers are being bought and not getting paid'; }
    else { flow = 'undecided'; flowWhy = 'price has not gone anywhere on this flow yet'; }
  }

  // the lean: money leading and paid is a trend; absorption and leverage-led moves fade
  let lean = null;
  if (positions === 'shorts opening' && led === 'spot-led') lean = 'bull';          // shorts loading into spot buying: squeeze fuel
  else if (positions === 'longs opening' && led === 'perp-led') lean = 'bear';      // longs loading on leverage alone: fragile
  else if (flow === 'buying, paid' && positions !== 'short covering') lean = 'bull';
  else if (flow === 'selling, paid' && positions !== 'longs closing') lean = 'bear';
  else if (flow === 'selling absorbed') lean = 'bull';
  else if (flow === 'buying absorbed') lean = 'bear';

  return { priceChg, oiChg, perpCvd, spotCvd, positions, posWhy, led, ledWhy, flow, flowWhy, lean };
}
/* ==OICVD_END== */
