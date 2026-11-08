// Builds Code.js -- Luddite's backend for Google Apps Script -- from
// luddite-backend/index.mjs, which stays the one copy of the backend:
// run `npm run build` here after any change to it, then paste Code.js
// into the Apps Script project (README.md).
//
// esbuild bundles index.mjs with the shims in shims/ standing in for
// DynamoDB and Node, and compiles async/await down to generators (target
// es2016) so the whole thing can run on SyncPromise (gas/sync-promise.js).
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const here = (p) => new URL(p, import.meta.url).pathname;

const out = await build({
  entryPoints: [here('gas/entry.mjs')],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: '__luddite',
  target: 'es2016',
  platform: 'neutral',
  alias: {
    '@aws-sdk/client-dynamodb': here('shims/aws-dynamodb.mjs'),
    'node:crypto': here('shims/node-crypto.mjs')
  },
  inject: [here('shims/globals.mjs')],
  logLevel: 'warning'
});

const bundle = out.outputFiles[0].text;
const code = [
  '// Code.js: Luddite\'s backend for Google Apps Script. Made by',
  '// luddite-google/build.mjs from luddite-backend/index.mjs; don\'t edit it',
  '// here, edit those and run `npm run build`. Built ' + new Date().toISOString().slice(0, 10) + '.',
  '',
  readFileSync(here('gas/host.js'), 'utf8'),
  readFileSync(here('gas/sync-promise.js'), 'utf8'),
  '// The backend itself, made once per request the first time it\'s needed.',
  'var luddite__ = null;',
  'function luddite_() {',
  '  if (luddite__) return luddite__;',
  '  // Shadows the real Promise for everything in the bundle (see sync-promise.js).',
  '  var Promise = SyncPromise;',
  bundle,
  '  luddite__ = { run: function (event) { return SyncPromise.settle(__luddite.handler(event)); } };',
  '  return luddite__;',
  '}',
  ''
].join('\n');

writeFileSync(here('Code.js'), code);
console.log('Code.js: ' + Math.round(code.length / 1024) + ' KB');
