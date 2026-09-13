/* journal.test.js — position sizing, R-multiples, and the stats rollups,
   including the veto check: does jGradeStats actually read the verdict
   engine's own grades rather than something journal.js invented.
   part of VL */
const {load} = require('./harness');
const app = load(['indicators.js','market-data.js','storage.js','state.js','backtest.js',
                   'btc-reference.js','logan.js','verdict.js','journal.js']);
const {jR, jPct, jSuggestSize, jRiskUnit, jStats, jGradeStats, jAdd, jClose} = app;

suite('position sizing — (account × risk%) ÷ (entry − invalidation)');
check('a $1,000 account risking 1% against a $10 stop buys 1 unit',
      jSuggestSize(100, 90, 1000, 1), 1);
check('a tighter stop (closer invalidation) sizes bigger for the same risk',
      jSuggestSize(100, 95, 1000, 1), 2);
check('works the same shape for a short (invalidation above entry)',
      jSuggestSize(100, 110, 1000, 1), 1);
check('no account means no suggestion, not a divide-by-zero', jSuggestSize(100, 90, 0, 1), null);
check('entry equal to invalidation has no risk unit to size against',
      jSuggestSize(100, 100, 1000, 1), null);

suite('R-multiple — the same risk unit the sizing formula uses');
{
  const long = {direction:'long', entryPrice:100, invalidation:90};
  check('risk unit is the distance to invalidation', jRiskUnit(long), 10);
  check('a move of the full risk unit in your favour is +1R', jR(long, 110), 1);
  check('hitting the invalidation exactly is -1R', jR(long, 90), -1);
  check('halfway to target is +0.5R', jR(long, 105), 0.5);
  check('no price yet reads as unknown, not zero', jR(long, null), null);

  const short = {direction:'short', entryPrice:100, invalidation:110};
  check('a short profits when price falls, same +1R at one risk unit', jR(short, 90), 1);
  check('a short losing is price rising toward invalidation', jR(short, 110), -1);

  check('percent return respects direction the same way as R', jPct(long, 110), 10);
  check('a short position\'s percent return is sign-flipped', jPct(short, 90), 10);
}

suite('jStats — closed trades only, wins vs losses vs everything');
{
  const rows = [
    {status:'closed', direction:'long', entryPrice:100, invalidation:90, exitPrice:110},   // +1R
    {status:'closed', direction:'long', entryPrice:100, invalidation:90, exitPrice:130},   // +3R
    {status:'closed', direction:'long', entryPrice:100, invalidation:90, exitPrice:90},    // -1R
    {status:'open',   direction:'long', entryPrice:100, invalidation:90, exitPrice:null},  // ignored — still open
  ];
  const s = jStats(rows);
  check('only closed trades count toward the sample', s.n, 3);
  check('win rate is 2 of 3', s.winRate, 67);
  check('average winning R', s.avgWinR, 2);
  check('average losing R', s.avgLossR, -1);
  check('total R booked', s.totalR, 3);
  check('expectancy is the mean R across everything closed', s.expectancy, 1);
  check('no closed trades yet returns null rather than NaN', jStats([]), null);
  check('an all-open journal also returns null', jStats([rows[3]]), null);
}

suite('jGradeStats — does the verdict engine\'s own grade actually predict the outcome');
{
  const rows = [
    {status:'closed', direction:'long', entryPrice:100, invalidation:90, exitPrice:130, verdict:{grade:'strong'}},
    {status:'closed', direction:'long', entryPrice:100, invalidation:90, exitPrice:110, verdict:{grade:'strong'}},
    {status:'closed', direction:'long', entryPrice:100, invalidation:90, exitPrice:90,  verdict:{grade:'thin'}},
    {status:'closed', direction:'long', entryPrice:100, invalidation:90, exitPrice:95,  verdict:null},          // no snapshot — excluded
  ];
  const g = jGradeStats(rows);
  const strong = g.find(x=>x.grade==='strong'), thin = g.find(x=>x.grade==='thin');
  check('a trade logged with no verdict snapshot is excluded rather than miscounted',
        g.reduce((n,x)=>n+x.n,0), 3);
  check('strong-graded trades are grouped together', strong.n, 2);
  check('and their average R is computed correctly', strong.avgR, 2);
  check('thin-graded trades are kept separate', thin.n, 1);
  ok('strong outperforming thin in this sample is visible in the breakdown, not buried',
     strong.avgR > thin.avgR);
}

suite('jAdd / jClose — the CRUD path end to end');
{
  const rowsBefore = [];
  const t = jAdd({symbol:'BTC', frame:'1D', direction:'long', entryPrice:100, invalidation:90, size:1});
  check('a new trade starts open', t.status, 'open');
  ok('gets a unique id', typeof t.id === 'string' && t.id.length > 0);
  const closed = jClose(t.id, 120);
  check('closing sets the exit price', closed.exitPrice, 120);
  check('and flips status', closed.status, 'closed');
  check('closing an id that does not exist is a no-op, not a throw', jClose('nope', 100), null);
}
