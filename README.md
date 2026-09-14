# ODYSSEUS

A stochastic terminal for crypto perpetuals. Multi-timeframe (5,3,3) stochastic
across 1H / 4H / 1D / 1W / 1M, a backtest that scores every past cross, a board
scanner, a news/catalyst view that explains why a coin moved, and Logan — an
in-app analyst that reads the terminal's own numbers.

Data comes from Bybit (candles, tickers, open interest, announcements),
CoinGecko (coin names and logos) and a handful of public RSS feeds. Logan and
the catalyst call use the Anthropic API and need a key; everything else is free
and needs none.

## Running it

Open `index.html` in a browser and it works — the terminal, scanner, history,
alerts, news and the offline reader all run straight off disk.

Logan and the "Why did this move?" call are the exception. Opened from disk the
page has no origin, and the Anthropic API refuses the request. For those, serve
the folder instead:

    python -m http.server 8000

then open <http://localhost:8000/>. Same app, one working origin.

## Layout

    index.html          markup, and the load order for everything else
    css/                base → layout → terminal → views → logan → charts → news
    js/                 one file per concern, loaded in dependency order
    tests/              node test runner; `node tests/run.js`
    tools/              build_single.py — folds the project back into one file

### js/, in load order

| file | what lives there |
| --- | --- |
| `indicators.js` | stochastic, crosses, swings, divergence, EMA 200. Pure maths, no DOM. |
| `market-data.js` | timeframes and weights, Bybit endpoints, candle fetch/merge, symbol list |
| `storage.js` | localStorage with an in-memory fallback |
| `state.js` | shared state, and `analyse()` — candles in, signals out |
| `backtest.js` | signal history: replay every cross, score 1/3/5/7 bars, bucket the results |
| `btc-reference.js` | keeps BTC loaded so any coin can be read with or against it |
| `verdict.js` | the graded read on a trade, and the offline reader |
| `scanner.js` | sweeps the whole perpetual board for setups turning now |
| `alerts.js` | what is worth announcing, Telegram/browser delivery, alerts UI |
| `news.js` | movers, beta decomposition, headlines, the catalyst call |
| `logan.js` | tool schemas, the bounded tool loop, the chat UI |
| `charts.js` | Lightweight Charts, with a canvas fallback when it fails to load |
| `ui-terminal.js` | frame matrix, BTC strip, stance, the live backtest badge, `render()` |
| `ui-symbols.js` | symbol search and pickers |
| `ui-watchlist.js` | watchlist view |
| `ui-history.js` | the backtest tables |
| `app.js` | the app loop and `load()` |
| `boot.js` | every DOM wiring line and start-up call — **loaded last** |

**The one rule:** definitions go in a feature file, anything that *runs* at
start-up goes in `boot.js`. These are plain scripts sharing one global scope, so
a file may call anything defined in another file, but may not *execute* against
it at load time. Keeping start-up in one place at the end is what makes that
safe — and it is not theoretical: in the old single-file version `nvLoadCoins()`
ran ~400 lines above its own `let nvCoins` declaration, threw inside a promise
where nothing was watching, and silently left every coin name and logo unloaded
until the News view was opened. Splitting it fixed that.

## Tests

    node tests/run.js            # everything
    node tests/run.js backtest   # one suite

The maths and the backtest engine are tested directly, in Node, against
synthetic candles with known answers — including the sign convention, where `+`
always means the call was right, so a *positive* number on a bear setup means
price fell. That trap has bitten this app twice.

`tests/harness.js` loads the browser files into a sandbox with a deliberately
thin DOM stub, so anything that quietly depends on the DOM fails loudly instead
of passing on a lie.

## One-file build

    python tools/build_single.py

Writes `dist/btc-stochastic.html`: every stylesheet and script inlined in load
order, behaving exactly like the split app, with nothing beside it. Use it to
carry the app around; work on the split files.

## Keys

Both keys stay in this browser's `localStorage` and are sent only to the service
they belong to — the Anthropic key to `api.anthropic.com`, the Telegram bot
token to `api.telegram.org`. Neither is in the source, and neither should be
committed. That is also the reason this is a local tool: anything hosted
publicly would need the key to move to a server.
