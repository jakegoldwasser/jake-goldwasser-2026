// End-to-end check of Code.js on this computer (npm test): a teacher opens
// a casual session, a student joins, writes (a long essay, so it's stored
// in several cells), hands in, and the teacher reads the paper, comments
// and shares the grading. Every request runs Code.js afresh, as Apps
// Script does, against a Sheet kept in memory.
import { makeGas, sessionFor } from './fake-gas.mjs';
import assert from 'node:assert/strict';

const SECRET = 'dev-secret';
const gas = makeGas({ properties: { SESSION_SECRET: SECRET } });
const teacher = sessionFor(SECRET, { sub: 't1', email: 'jake.goldwasser@gmail.com', name: 'Jake' });
const student = sessionFor(SECRET, { sub: 's1', email: 'student@example.com', name: 'Sam Student' });

let n = 0;
function call(token, method, path, body) {
  const t = Date.now();
  const res = gas.post({ m: method, p: path, a: token, o: 'http://localhost:8000', b: body ? JSON.stringify(body) : '' });
  console.log(String(++n).padStart(2), method.padEnd(3), path.padEnd(38), res.status, (Date.now() - t) + 'ms');
  return res;
}
function ok(res) { assert.equal(res.status, 200, JSON.stringify(res.body)); return res.body; }

// Signing in
assert.equal(call('', 'GET', '/luddite/status').status, 401);
assert.equal(call('s1.bogus.token', 'GET', '/luddite/status').status, 401);
const st = ok(call(teacher, 'GET', '/luddite/status'));
assert.equal(st.luddite.role, 'owner');
assert.ok(st.session && st.session.startsWith('s1.'), 'a fresh session token comes back');
assert.equal(ok(call(student, 'GET', '/luddite/status')).luddite.role, 'student');

// A teacher opens a casual session
const made = ok(call(teacher, 'PUT', '/luddite/assignments', { casual: true, prompt: 'Write about a **storm**.' }));
const room = made.room || made.assignment || made;
const code = room.code;
assert.ok(code, 'got an Entry Phrase: ' + JSON.stringify(made).slice(0, 200));
console.log('   Entry Phrase:', room.codeLabel);
assert.ok(ok(call(teacher, 'GET', '/luddite/assignments')).assignments.some((a) => a.code === code));

// The student joins, writes, hands in
ok(call(student, 'PUT', '/luddite/join', { code }));
const essay = Array.from({ length: 2400 }, (_, i) => 'The storm came in over the river, word ' + i + ' — “quoted” é ü 雨 🌧.').join(' ');
assert.ok(essay.length > 130000, 'long enough to need several cells');
ok(call(student, 'PUT', '/luddite/event', { code, type: 'writing', words: 30, text: essay.slice(0, 2000) }));
ok(call(student, 'PUT', '/luddite/event', { code, type: 'writing', words: 30000, text: essay }));
const draft = ok(call(student, 'GET', '/luddite/draft?code=' + code)).draft;
assert.equal(draft.text, essay, 'the backup comes back whole, unicode and all');
ok(call(student, 'PUT', '/luddite/submit', { code, text: essay }));

// The teacher reads the paper, comments, shares the grading
const sess = ok(call(teacher, 'GET', '/luddite/assignment?code=' + encodeURIComponent(code)));
const subs = (sess.room || sess.assignment || sess).submissions || [];
assert.equal(subs.length, 1, 'one paper handed in');
const paperId = subs[0].id;
const paper = ok(call(teacher, 'GET', '/luddite/sub?id=' + paperId));
assert.equal((paper.sub || paper.paper || paper).text, essay, 'the paper is exactly what was handed in');
ok(call(teacher, 'PUT', '/luddite/marks', { id: paperId, marks: [{ type: 'margin', start: 4, end: 9, note: 'Vivid!' }], endComment: 'Lovely work.', grade: 'A' }));
ok(call(teacher, 'PUT', '/luddite/handback', { ids: [paperId], back: true }));
const mine = ok(call(student, 'GET', '/luddite/mypaper?id=' + paperId));
assert.ok(JSON.stringify(mine).includes('Vivid!'), 'the student sees the comment once shared');

// What's in the Sheet
const book = Object.values(gas.books)[0];
for (const tab of book.sheets) {
  const rows = tab.rows.slice(1).filter((r) => r && r[0]);
  console.log('   tab "' + tab.name + '": ' + rows.length + ' items, widest ' + Math.max(...rows.map((r) => Number(String(r[3]).slice(1)))) + ' cells');
}
const bigRow = book.getSheetByName('big').rows.find((r) => r && String(r[0]).startsWith('~luddite:sub:'));
assert.ok(Number(String(bigRow[3]).slice(1)) >= 3, 'the paper spans several cells');
console.log('\nAll checks passed.', gas.stats());
