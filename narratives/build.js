// Builds narratives/index.html from src/index.html, putting veracross-filler.js in as the
// "Fill Veracross" bookmarklet. Run from the repo root:  node narratives/build.js
const fs = require('fs'), path = require('path');
const dir = __dirname;
const js = fs.readFileSync(path.join(dir, 'veracross-filler.js'), 'utf8');
const min = js.replace(/\/\*[\s\S]*?\*\//, '').replace(/\s+\/\/ .*$/gm, '')
  .split('\n').map(l => l.trim()).filter(Boolean).join('\n');
new Function(min); // syntax check
let html = fs.readFileSync(path.join(dir, 'src', 'index.html'), 'utf8');
const marker = /\/\*BOOKMARKLET\*\/[\s\S]*?\/\*END\*\//;
if (!marker.test(html)) throw new Error('bookmarklet marker missing in src/index.html');
html = html.replace(marker, () => JSON.stringify(min));
fs.writeFileSync(path.join(dir, 'index.html'), html);
console.log('Built narratives/index.html');
