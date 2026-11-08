// Luddite on this computer with the Google backend (npm run dev):
//   http://localhost:8000/luddite/  the page (the whole site, served as is)
//   http://localhost:8787           Code.js, answering as Apps Script would
// The page on localhost offers the Google test and points it here
// (GOOGLE_API in luddite/index.html). What's saved goes in dev/data.json.
// Google sign-in may not work on localhost, so sign-in tokens for a test
// teacher and student are printed below: paste one into the page's
// localStorage as luddite.g.auth.v1.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { makeGas, sessionFor } from './fake-gas.mjs';

const SECRET = 'dev-secret';
const root = new URL('../../', import.meta.url).pathname;
const gas = makeGas({ properties: { SESSION_SECRET: SECRET }, dataFile: new URL('./data.json', import.meta.url).pathname });

http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (req.method === 'GET') { res.writeHead(200, cors); res.end('Luddite (Google) is running.'); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let out;
    try {
      const r = gas.post(JSON.parse(body || '{}'));
      out = JSON.stringify({ s: r.status, b: JSON.stringify(r.body) });
      console.log(new Date().toTimeString().slice(0, 8), r.status, JSON.parse(body).p);
    } catch (e) { console.error(e); out = JSON.stringify({ s: 500, b: '{"error":"server_error"}' }); }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(out);
  });
}).listen(8787);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
http.createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(root, p));
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  try { const data = await readFile(file); res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }); res.end(data); }
  catch (e) { res.writeHead(404); res.end('Not found'); }
}).listen(8000);

console.log('Page: http://localhost:8000/luddite/?backend=google   Backend: http://localhost:8787');
console.log('Teacher token:', sessionFor(SECRET, { sub: 'dev-teacher', email: 'jake.goldwasser@gmail.com', name: 'Jake Goldwasser' }));
console.log('Student token:', sessionFor(SECRET, { sub: 'dev-student', email: 'sam.student@example.com', name: 'Sam Student' }));
