const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = path.resolve(root, '../ui');
if (!fs.existsSync(path.join(source, 'index.html'))) throw Error('Shared client UI is missing');
const output = path.join(root, 'ui');
fs.mkdirSync(output, { recursive: true });
for (const name of fs.readdirSync(source)) {
  const file = path.join(source, name);
  if (fs.statSync(file).isFile() && /\.(html|css|js|svg|png|ico|woff2)$/.test(name))
    fs.copyFileSync(file, path.join(output, name));
}
console.log('Prepared shared client UI (no server code or user data).');
