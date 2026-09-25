#!/usr/bin/env node
/* publish.js — push an analyst report into the app.

     node mcp/publish.js verdicts/latest.json            → the app's cloud key
     node mcp/publish.js verdicts/latest.json --dry-run   → validate and print, send nothing
     node mcp/publish.js verdicts/latest.json --print     → print the merged key, to paste by hand

   This is the ONLY thing in the whole MCP tree that writes anywhere, and it is
   deliberately not an MCP tool. The server stays read-only: nothing a model can
   call from a chat can alter the app's state. Publishing is a separate command
   a person (or a script they wrote) runs on purpose.

   It writes to the same Firestore document the app's own cloud sync uses —
   users/<uid>/state/vl.analyst.v1 — so the report simply appears the next time
   the app syncs. Existing reports are merged, not replaced, using the app's own
   analystMerge, loaded out of js/analyst.js rather than copied.

   Credentials come from the environment or a prompt and are never written down:
     ODYSSEUS_CLOUD_EMAIL, ODYSSEUS_CLOUD_PASSWORD
   part of Odysseus */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const harness = require('../tests/harness.js');

// the app's own merge/validation, and the app's own Firebase project config
const app = harness.load(['cloud.js', 'analyst.js']);

const IDENTITY = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword';
const FIRESTORE = 'https://firestore.googleapis.com/v1';

function usage() {
  return [
    'Usage: node mcp/publish.js <report.json> [options]',
    '',
    '  --dry-run    validate the report and show what would be sent; send nothing',
    '  --print      print the merged key to stdout, for pasting into the app by hand',
    '  --email E    cloud account email     (or $ODYSSEUS_CLOUD_EMAIL)',
    '  --help',
    '',
    'The password comes from $ODYSSEUS_CLOUD_PASSWORD, or you will be asked for it.',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { file: null, dryRun: false, print: false, email: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--print') out.print = true;
    else if (a === '--email') out.email = argv[++i];
    else if (a.startsWith('--email=')) out.email = a.slice(8);
    else if (a === '--help' || a === '-h') out.help = true;
    else if (!a.startsWith('-')) out.file = a;
  }
  return out;
}

/*  Reads a password without echoing it. No dependency, and it degrades to a
    visible prompt rather than failing outright when stdin is not a TTY.     */
function askSecret(prompt) {
  return new Promise(resolve => {
    if (!process.stdin.isTTY) {
      process.stderr.write(prompt + ' (input will be visible)\n');
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      return rl.question('', a => { rl.close(); resolve(a); });
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const onData = () => { readline.moveCursor(process.stderr, 0, 0); };
    process.stderr.write(prompt);
    rl.input.on('data', onData);
    const origWrite = rl._writeToOutput ? rl._writeToOutput.bind(rl) : null;
    rl._writeToOutput = s => { if (/\n/.test(s)) origWrite && origWrite(s); };
    rl.question('', answer => {
      rl.input.removeListener('data', onData);
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
  });
}

async function signIn(cfg, email, password) {
  const res = await fetch(IDENTITY + '?key=' + encodeURIComponent(cfg.apiKey), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = (body.error && body.error.message) || ('HTTP ' + res.status);
    throw new Error('sign-in failed: ' + why +
      (why === 'INVALID_LOGIN_CREDENTIALS' || why === 'INVALID_PASSWORD'
        ? ' — this is the same email and password you use in the app\'s Cloud panel' : ''));
  }
  return { idToken: body.idToken, uid: body.localId };
}

function docUrl(cfg, uid, key) {
  return FIRESTORE + '/projects/' + cfg.projectId + '/databases/(default)/documents/' +
         'users/' + encodeURIComponent(uid) + '/state/' + encodeURIComponent(key);
}

async function readDoc(cfg, auth, key) {
  const res = await fetch(docUrl(cfg, auth.uid, key), {
    headers: { authorization: 'Bearer ' + auth.idToken },
  });
  if (res.status === 404) return null;                       // nothing up there yet
  if (!res.ok) throw new Error('could not read the existing key: HTTP ' + res.status);
  const body = await res.json();
  const f = body.fields || {};
  return {
    value: f.value && typeof f.value.stringValue === 'string' ? f.value.stringValue : null,
    at: f.at && f.at.integerValue != null ? +f.at.integerValue : 0,
  };
}

async function writeDoc(cfg, auth, key, value, at) {
  const res = await fetch(docUrl(cfg, auth.uid, key), {
    method: 'PATCH',
    headers: { authorization: 'Bearer ' + auth.idToken, 'content-type': 'application/json' },
    body: JSON.stringify({
      fields: {
        value: { stringValue: value },
        at: { integerValue: String(at) },
        key: { stringValue: key },
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('write failed: HTTP ' + res.status + ' ' + text.slice(0, 300));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.file) {
    process.stdout.write(usage() + '\n');
    process.exit(args.help ? 0 : 1);
  }

  const file = path.resolve(args.file);
  if (!fs.existsSync(file)) throw new Error('no such file: ' + file);
  const text = fs.readFileSync(file, 'utf8');

  /* ---- validate with the app's own validator, before anything else ---- */
  const parsed = app.analystParseMany(text);
  if (!parsed.ok) throw new Error('that file is not a usable report — ' + parsed.error);
  if (parsed.error) process.stderr.write('warning: ' + parsed.error + '\n');

  for (const r of parsed.reports) {
    process.stderr.write('  ' + r.symbol + '  ' + r.agreement + '/' + r.direction +
      (r.confidence == null ? '' : '  confidence ' + r.confidence) +
      '  — ' + r.headline.slice(0, 80) + (r.headline.length > 80 ? '…' : '') + '\n');
    if (r.agreementDisputed)
      process.stderr.write('  ! this report calls itself "' + r.agreement + '" but its two calls read as "' +
                           r.derivedAgreement + '"\n');
  }

  const KEY = app.ANALYST_KEY;

  if (args.print) {
    // no network at all: merge against nothing and print what the key should hold
    process.stdout.write(JSON.stringify(app.analystMerge([], parsed.reports), null, 2) + '\n');
    return;
  }

  if (args.dryRun) {
    process.stderr.write('\ndry run: ' + parsed.reports.length + ' report(s) validated, nothing sent.\n');
    return;
  }

  /* ---- publish ---- */
  const cfg = app.FB_DEFAULT;
  const email = args.email || process.env.ODYSSEUS_CLOUD_EMAIL;
  if (!email) throw new Error('no account email — pass --email or set ODYSSEUS_CLOUD_EMAIL');
  const password = process.env.ODYSSEUS_CLOUD_PASSWORD || await askSecret('Cloud password for ' + email + ': ');
  if (!password) throw new Error('no password given');

  const auth = await signIn(cfg, email, password);

  const remote = await readDoc(cfg, auth, KEY);
  let existing = [];
  if (remote && remote.value) {
    try { existing = JSON.parse(remote.value) || []; } catch (e) { existing = []; }
    if (!Array.isArray(existing)) existing = [];
  }

  const merged = app.analystMerge(existing, parsed.reports);
  const added = merged.length - existing.length;

  await writeDoc(cfg, auth, KEY, JSON.stringify(merged), Date.now());

  process.stderr.write('\npublished to ' + cfg.projectId + ' — the key now holds ' + merged.length +
    ' report(s), ' + (added > 0 ? added + ' new' : 'none new') + '.\n');
  process.stderr.write('Open the app, sign in on the Cloud panel and hit Sync now; ' +
    'the Analyst view will have it.\n');
}

main().catch(e => {
  process.stderr.write('\nFAILED: ' + (e && e.message || e) + '\n');
  process.exit(1);
});
