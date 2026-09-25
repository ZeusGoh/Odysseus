/* postmortem.test.js — the news analyst explaining its own settled misses.

   The model call itself cannot run here; what can be pinned is everything
   around it: which misses get asked about (settled wrong at the call's own
   mark, not yet explained, not too old, capped), what the analyst is told
   (its own call and reason, the window, what price did — and nothing about
   the other side), and how its answer is read back.
   part of Odysseus */

const path = require('path');
const MCP = path.join(__dirname, '..', 'mcp');
const { postmortemCandidates, postmortemPrompt, postmortemParse, postmortemPass,
        POSTMORTEM_MAX_PER_PASS, POSTMORTEM_MAX_AGE_H } = require(path.join(MCP, 'postmortem.js'));
const { writeTrack, readTrack, HOUR } = require(path.join(MCP, 'score.js'));

const NOW = Date.parse('2026-09-20T00:00:00.000Z');
let n = 0;
const rec = (call, grade, over) => Object.assign({
  id: 'p' + (++n), symbol: 'SOL', call, conviction: 60, mark: 24, horizon: 'next 24h', setup: 'spec, no catalyst',
  claim: 'the move looked coin-specific', generatedAt: new Date(NOW - (30 + n) * HOUR).toISOString(),
  checks: grade ? { '24': { pct: grade === 'wrong' ? -3 : 3, grade, btcPct: 1, maxUp: 0.2, maxDown: -3.4 } } : {},
}, over || {});

suite('postmortemCandidates — settled misses, at their own mark, not yet explained');
{
  const wrong = rec('bull', 'wrong'), right = rec('bull', 'right'), open = rec('bull', null);
  const done = rec('bear', 'wrong', { postmortem: { text: 'already', at: 'x' } });
  const neutral = rec('neutral', null);
  const weekly = rec('bull', null, { mark: 168, checks: { '24': { pct: -3, grade: 'wrong' } } });   // wrong at 24h, but a weekly call
  const old = rec('bull', 'wrong', { generatedAt: new Date(NOW - (POSTMORTEM_MAX_AGE_H + 5) * HOUR).toISOString() });
  const c = postmortemCandidates([wrong, right, open, done, neutral, weekly, old], NOW);
  check('only the settled miss without an answer', c.map(r => r.id), [wrong.id]);
  const many = []; for (let i = 0; i < 5; i++) many.push(rec('bull', 'wrong'));
  check('capped per pass', postmortemCandidates(many, NOW).length, POSTMORTEM_MAX_PER_PASS);
  check('newest first', postmortemCandidates(many, NOW)[0].id, many[0].id);
  check('a different cap', postmortemCandidates(many, NOW, 4).length, 4);
}

suite('postmortemPrompt — its own call, the window, what price did, nothing else');
{
  const r = rec('bull', 'wrong');
  const p = postmortemPrompt(r);
  ok('names the call and the coin', /called \*\*bull\*\* on \*\*SOL\*\*/.test(p));
  ok('quotes what it said at the time', /"the move looked coin-specific"/.test(p));
  ok('says what price did, and what BTC did', /moved -3%/.test(p) && /BTC moved \+1%/.test(p));
  ok('and the shape of the miss', /never went your way/.test(p));
  ok('asks for a fenced answer', /"postmortem"/.test(p));
  ok('nothing about the other analyst or the desk', !/stoch|desk|reconcil/i.test(p));
}

suite('postmortemParse — the sentences out of whatever came back');
check('the fenced block when it is there', postmortemParse('some prose\n\n```json\n{ "postmortem": "An unlock landed." }\n```\n'), 'An unlock landed.');
check('the last paragraph when it is not', postmortemParse('First thoughts.\n\nThe move was the whole market, BTC did the same.'), 'The move was the whole market, BTC did the same.');
check('nothing usable is null', postmortemParse(''), null);
check('a broken fence falls back rather than throwing', postmortemParse('```json\n{ nope\n```\n\nfallback line'), 'fallback line');

later(async () => {
  suite('postmortemPass — dry run asks nothing and writes nothing');
  const fs = require('fs'), os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odysseus-pm-'));
  writeTrack('news', [rec('bull', 'wrong')], dir);
  const lines = [];
  const done = await postmortemPass({ dir, dryRun: true, now: NOW, log: l => lines.push(l) });
  check('nothing written', done, []);
  ok('but it says what it would have asked', lines.some(l => /would ask \(dry run\)/.test(l)));
  check('and the record is untouched', readTrack('news', dir)[0].postmortem, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});
