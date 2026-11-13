const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const extension = path.join(root, 'extension');
const target = path.join(root, 'dist', 'coursera-study-tools');
const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert(fs.readFileSync(path.join(extension,'recovery.js'),'utf8').includes(`const VERSION = '${manifest.version}'`),'Recovery version must match the packaged manifest');
assert.deepEqual(manifest.permissions.toSorted(), ['activeTab', 'scripting', 'storage', 'nativeMessaging'].toSorted());
const excluded = ['assignments.js','editor-bridge.js'];
const names = fs.readdirSync(extension).filter(name=>!excluded.includes(name)).sort();
assert(manifest.content_scripts.every(script=>script.js.every(name=>!excluded.includes(name))));
assert(!fs.readFileSync(path.join(extension,manifest.background.service_worker),'utf8').includes('courseraEditorBridge'));
for (const name of [manifest.action.default_popup, ...manifest.content_scripts.flatMap(script => script.js)]) {
  assert(names.includes(name), `Missing manifest entry: ${name}`);
}
assert(names.includes(manifest.background.service_worker));
assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*', 'https://*.coursera.org/*', 'https://coursera.org/*']);
for (const name of names.filter(name => name.endsWith('.js'))) {
  const check = spawnSync(process.execPath, ['--check', path.join(extension, name)], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
}
const files = [...names.map(name => ({ name: `extension/${name}`, data: fs.readFileSync(path.join(extension, name)) })),
  ...['README.md', 'LICENSE', 'Start-Bridge.ps1', 'Start-Bridge.cmd', 'Stop-Bridge.cmd', 'bridge/server.cjs', 'bridge/quiz-images.cjs', 'bridge/quiz-batches.cjs', 'bridge/manager.cjs', 'bridge/native-host.cjs', 'bridge/install-native.cjs', 'bridge/start.cjs', 'docs/native-connection.md'].map(name => ({ name, data: fs.readFileSync(path.join(root, name)) }))];
fs.mkdirSync(target, { recursive: true });
// Remove only files produced by the previous flat release, after validating the exact target.
assert.equal(path.dirname(target), path.join(root, 'dist'));
for(const name of excluded){
  const old=path.resolve(target,'extension',name);
  assert.equal(path.dirname(old),path.resolve(target,'extension'));
  if(fs.existsSync(old)&&fs.statSync(old).isFile())fs.unlinkSync(old);
}
for (const name of [...names, 'README.md', 'LICENSE']) {
  const old = path.join(target, name);
  if (fs.existsSync(old) && fs.statSync(old).isFile()) fs.unlinkSync(old);
}
for (const file of files) {
  fs.mkdirSync(path.dirname(path.join(target, file.name)), { recursive: true });
  fs.writeFileSync(path.join(target, file.name), file.data);
}
// Store-mode ZIP: no build dependency or platform-specific archiver.
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
const chunks = [], directory = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(file.name, 'utf8');
  const crc = crc32(file.data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(file.data.length, 18); local.writeUInt32LE(file.data.length, 22); local.writeUInt16LE(name.length, 26);
  chunks.push(local, name, file.data);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
  central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(file.data.length, 20); central.writeUInt32LE(file.data.length, 24);
  central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
  directory.push(central, name);
  offset += local.length + name.length + file.data.length;
}
const central = Buffer.concat(directory);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...chunks, central, end]);
const zipPath = path.join(root, 'dist', 'coursera-study-tools.zip');
fs.writeFileSync(zipPath, zip);
// Verify the actual written artifact, not just the input list.
const written = fs.readFileSync(zipPath);
let position = 0;
for (const file of files) {
  assert.equal(written.readUInt32LE(position), 0x04034b50);
  const size = written.readUInt32LE(position + 18);
  const length = written.readUInt16LE(position + 26);
  assert.equal(written.subarray(position + 30, position + 30 + length).toString(), file.name);
  const data = written.subarray(position + 30 + length, position + 30 + length + size);
  assert.deepEqual(data, file.data);
  assert.equal(crc32(data), written.readUInt32LE(position + 14));
  position += 30 + length + size;
}
assert.equal(written.readUInt32LE(position), 0x02014b50);
assert.equal(written.readUInt16LE(written.length - 12), files.length);
assert.deepEqual(fs.readdirSync(target, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => path.relative(target, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/')).sort(), files.map(file => file.name).sort());
console.log(`PACKAGE_VERIFIED (${files.length} files, ${written.length} bytes)`);
