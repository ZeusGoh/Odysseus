/* symbols.test.js — the searchable universe: one contract per coin, and it
   is the USDT one when there is one. Bybit lists HYPEPERP (USDC) before
   HYPEUSDT, and "first seen wins" was reading the thinner book, where the
   long/short ratio does not exist at all.
   part of Odysseus */
const {load} = require('./harness');

const instruments = [
  {symbol:'HYPEPERP', baseCoin:'HYPE', quoteCoin:'USDC', contractType:'LinearPerpetual', status:'Trading'},
  {symbol:'HYPEUSDT', baseCoin:'HYPE', quoteCoin:'USDT', contractType:'LinearPerpetual', status:'Trading'},
  {symbol:'HYPEUSDT-02OCT26', baseCoin:'HYPE', quoteCoin:'USDT', contractType:'LinearFutures', status:'Trading'},
  {symbol:'ONLYPERP', baseCoin:'ONLY', quoteCoin:'USDC', contractType:'LinearPerpetual', status:'Trading'},
  {symbol:'LATEUSDT', baseCoin:'LATE', quoteCoin:'USDT', contractType:'LinearPerpetual', status:'Trading'},
  {symbol:'LATEPERP', baseCoin:'LATE', quoteCoin:'USDC', contractType:'LinearPerpetual', status:'Trading'},
  {symbol:'DEADUSDT', baseCoin:'DEAD', quoteCoin:'USDT', contractType:'LinearPerpetual', status:'Closed'},
];
const app = load(['indicators.js','market-data.js','cloud.js','storage.js','state.js','ui-symbols.js'],
  { fetch: async () => ({ ok:true, status:200, json: async () => ({ retCode:0, result:{ list: instruments } }) }) });

later(async () => {
  suite('loadUniverse — the USDT perpetual wins when a coin has both');
  const uni = await app.loadUniverse();
  const by = Object.fromEntries(uni.map(u => [u.sym, u.bybit]));
  check('HYPE resolves to the USDT contract, not the USDC one listed first', by.HYPE, 'HYPEUSDT');
  check('the dated future never takes the slot', /-/.test(by.HYPE), false);
  check('a coin with only a USDC contract keeps it', by.ONLY, 'ONLYPERP');
  check('USDT first, USDC after: still USDT', by.LATE, 'LATEUSDT');
  check('a closed instrument is not in the universe', 'DEAD' in by, false);
  check('the curated coins are still there, on their USDT books', by.BTC, 'BTCUSDT');
  check('symbolOf reads the universe', app.symbolOf('HYPE').bybit, 'HYPEUSDT');
});
