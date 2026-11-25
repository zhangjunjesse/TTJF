'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('../saas/testing.cjs');
const ROOT = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
// The runtime uses an explicit, single-line COPY list for top-level assets.
// This deliberately checks that format instead of interpreting arbitrary Dockerfiles.
const htmlAssets = [...new Set([...read('index.html').matchAll(/(?:src|href)="([^"/#?:]+)"/g)].map(match => match[1])), 'voice-pcm-worklet.js'];
const rootCopies = read('Dockerfile.saas').split(/\r?\n/).filter(line => /^COPY\s/.test(line)).flatMap(line => {
  const parts = line.trim().split(/\s+/).slice(1).filter(part => !part.startsWith('--'));
  return parts.pop() === './' ? parts : [];
});

test('Docker runtime COPY serves every top-level HTML asset through the SaaS HTTP handler', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ttjf-package-test-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^ttjf-package-test-[A-Za-z0-9]+$/);
    assert.equal(fs.realpathSync(directory), directory);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  for (const file of rootCopies) {
    assert.equal(path.basename(file), file, 'top-level runtime file');
    fs.copyFileSync(path.join(ROOT, file), path.join(directory, file));
  }
  const fixture = await H.fixture(t, { rootDir: directory });
  const home = await H.request(fixture.server, 'GET', '/');
  assert.equal(home.status, 200);
  const missing = [];
  for (const file of htmlAssets) {
    const response = await H.request(fixture.server, 'GET', '/' + file);
    if (response.status !== 200) missing.push({ file, status: response.status });
    else if (file === 'runtime.js') assert.match(response.body, /window\.__TTJF_SAAS__=true;/, 'SaaS serves its own runtime mode');
    else {
      const expected = read(file);
      if (file.endsWith('.css')) {
        assert.ok(response.body.trim() && !response.body.includes('\0'), `${file} must contain nonempty stylesheet text without NUL bytes`);
      }
      assert.deepEqual(response.body, file.endsWith('.webmanifest') ? JSON.parse(expected) : expected, file);
    }
  }
  assert.deepEqual(missing, [], 'HTML dependencies must be present in the container static root');
});

test('the deny-by-default Docker context explicitly includes every top-level HTML asset', () => {
  const rules = read('.dockerignore').split(/\r?\n/).map(line => line.trim());
  assert.ok(rules.includes('**'), 'retain the private-data deny-by-default context');
  const missing = htmlAssets.filter(file => !rules.includes('!' + file));
  assert.deepEqual(missing, [], 'required assets must reach Docker COPY');
});

test('the runtime package includes the server-only assistant tools and editable prompts', async t => {
  const docker = read('Dockerfile.saas'), rules = read('.dockerignore').split(/\r?\n/);
  for (const name of ['assistant-service.cjs', 'assistant-chat.cjs', 'assistant-tools.cjs']) {
    assert.ok(rootCopies.includes(name) && rules.includes('!' + name), name);
  }
  assert.match(docker, /COPY --chown=node:node config\/assistant .\/config\/assistant/);
  for (const rule of ['!config/', '!config/assistant/', '!config/assistant/*.md', '!config/assistant/tools.json']) assert.ok(rules.includes(rule), rule);
  const fixture = await H.fixture(t);
  for (const file of fs.readdirSync(path.join(ROOT, 'config', 'assistant'))) {
    const response = await H.request(fixture.server, 'GET', '/config/assistant/' + file);
    assert.equal(response.status, 404, file);
  }
});
