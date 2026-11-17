import { build } from 'esbuild';
import { readFile, stat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const threeManifest = path.resolve(path.dirname(require.resolve('three')), '../package.json');
const threeVersion = JSON.parse(await readFile(threeManifest, 'utf8')).version;
if (threeVersion !== '0.160.1') throw new Error(`Expected Three.js 0.160.1 for WebGL1/2 compatibility, found ${threeVersion}`);
const files = (await readdir(path.join(root, 'assets/farm/models'))).filter(name => name.endsWith('.glb')).map(name => name.slice(0, -4)).sort();
const sources = JSON.parse(await readFile(path.join(root, 'assets/farm/SOURCES.json'), 'utf8'));
let assetBytes = 0;
for (const name of files) {
  const buffer = await readFile(path.join(root, 'assets/farm/models', name + '.glb'));
  const record = sources.files.find(file => file.file === 'models/' + name + '.glb');
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  if (!record || record.sha256 !== sha256 || record.bytes !== buffer.length) throw new Error('Unverified local asset: ' + name);
  if (buffer.readUInt32LE(0) !== 0x46546c67 || buffer.readUInt32LE(4) !== 2) throw new Error('Not glTF2: ' + name);
  const gltf = JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString('utf8'));
  for (const resource of [...(gltf.buffers || []), ...(gltf.images || [])]) {
    if (resource.uri && !resource.uri.startsWith('data:')) throw new Error('External model resource: ' + name + ': ' + resource.uri);
  }
  assetBytes += buffer.length;
}
const licenses = await readFile(path.join(root, 'assets/farm/THIRD-PARTY-LICENSES.txt'), 'utf8');
const upstreamLicense = await readFile(path.join(root, 'assets/farm/HARVEST-HOLLOW-LICENSE.txt'), 'utf8');
const notice = `/*! FamilyFarmScene — offline continuous 3D farm.\n${licenses.replace(/\*\//g, '* /')}\nHarvest Hollow rendering reference and adapted deterministic terrain noise:\n${upstreamLicense.replace(/\*\//g, '* /')}\nFull model credits and CC0 legal code are retained under assets/farm/. Original companion and world layout implemented locally. */`;
await build({
  absWorkingDir: root,
  entryPoints: ['farm/scene.js'], outfile: 'farm-scene.js',
  bundle: true, format: 'iife', globalName: 'FamilyFarmScene', platform: 'browser',
  target: ['safari15', 'es2018'], loader: { '.glb': 'dataurl' },
  minify: true, sourcemap: false, legalComments: 'inline', charset: 'utf8',
  banner: { js: notice }, logLevel: 'info'
});
const result = await readFile(path.join(root, 'farm-scene.js'));
console.log(JSON.stringify({ three: threeVersion, models: files.length, assetBytes, bundleBytes: (await stat(path.join(root, 'farm-scene.js'))).size, gzipBytes: gzipSync(result).length, offline: 'GLB buffers embedded as data URLs; no runtime remote assets', target: 'Safari15 / ES2018; WebGL1 or WebGL2' }, null, 2));
