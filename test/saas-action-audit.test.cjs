'use strict';
// Independent audit of the real HTTP -> authorization -> PostgreSQL consumer.
// Uses only the existing disposable-schema fixture and synthetic accounts.
// Run: node --env-file=.env.saas.test --test --test-reporter=spec test/saas-action-audit.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'artifacts', 'v14-action-audit.json');
const COMMAND = 'node --env-file=.env.saas.test --test --test-reporter=spec test/saas-action-audit.test.cjs';
const EXPECTED_TYPES = [
  'farm.animalCare', 'farm.exchange', 'farm.harvest', 'farm.place', 'farm.plant', 'farm.start',
  'parent.configure', 'parent.setup', 'pet.buy', 'pet.care', 'pet.configure', 'pet.scene',
  'pointItem.save', 'points.add', 'profile.update', 'redemption.approve', 'redemption.cancel',
  'redemption.request', 'reward.redeem', 'reward.save', 'settings.update', 'task.ack',
  'task.delete', 'task.restore', 'task.save', 'task.snooze', 'task.toggle'
];
function sourceHashes() {
  const files = ['saas-server.cjs', 'model.js', 'assistant-service.cjs', 'assistant.js',
    'package.json', 'package-lock.json', 'test/saas-action-audit.test.cjs'];
  // Include new backend modules/migrations automatically, without reading .env
  // or any business data, exports, mailboxes, or historical evidence.
  function collect(relative) {
    for (const entry of fs.readdirSync(path.join(ROOT, relative), { withFileTypes: true })) {
      const name = relative + '/' + entry.name;
      if (entry.isDirectory()) collect(name);
      else if (/\.(?:cjs|sql)$/.test(entry.name)) files.push(name);
    }
  }
  collect('saas');
  return Object.fromEntries(files.sort().map(file => [file,
    crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex')]));
}
const initialSourceHashes = sourceHashes();
const H = require('../saas/testing.cjs');
const M = require('../model.js');

test('independent SaaS audit: all 27 action types and 98 variants persist, authorize and replay correctly', async t => {
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    replayCommand: COMMAND,
    invocation: { executable: process.execPath, execArgv: process.execArgv, argv: process.argv },
    nodeVersion: process.version,
    scope: 'Real local HTTP and PostgreSQL; disposable schema; synthetic users only.',
    provenance: 'Persisted from the independent 27-type / 98-variant inline audit, then rerun as this test.',
    result: 'running',
    sourceHashes: initialSourceHashes,
    variants: [],
    boundaries: [
      'This verifies backend consumers, not every visible browser entry point.',
      'Uses the fixture clock; 104 hours of crop growth are simulated, not a physical waiting period.',
      'No requests to existing ports 4178 or 4180; no real family JSON or developer mailbox is read.',
      'No external email delivery, cloud AI request, production deployment, billing, or device claim.',
      'New account/family lifecycle APIs are outside this 27-type business-action matrix.'
    ]
  };
  try {
    const f = await H.fixture(t);
    report.databaseSchema = f.schema;
    report.httpAddress = { host: '127.0.0.1', port: f.server.address().port };
    report.clockStart = new Date(f.clock.value).toISOString();
    const owner = await H.family(f, await H.register(f, 'audit-full-owner@example.test'));
    const outsider = await H.family(f, await H.register(f, 'audit-full-other@example.test'));
    let revision = 1, counter = 0, state;
    const seen = new Set(), protectedSeen = new Set();

    async function commit(label, input, protectedAction = false, check = () => {}) {
      // Keep authentication/session time real within the fixture, while giving
      // each scenario its own rate window. Rate-limit behavior has separate tests.
      f.clock.value += 61000;
      const action = { id: 'audit-' + (++counter), ...input };
      const beforeRevision = revision;
      const entry = { index: counter, label, type: action.type, actionId: action.id,
        needsGrant: protectedAction, revisionBefore: beforeRevision, checks: [], result: 'running' };
      report.variants.push(entry);
      const forged = await H.request(f.server, 'POST', '/api/action', { revision, action },
        { ...outsider, familyId: owner.familyId });
      assert.equal(forged.status, 403, label + ': outsider status');
      assert.equal(forged.body.code, 'FAMILY_FORBIDDEN', label + ': outsider code');
      for (const field of ['state', 'parent', 'revision']) assert.equal(forged.body[field], undefined, label + ': no ' + field);
      entry.checks.push('cross-family request denied without private projection');
      if (protectedAction) {
        const denied = await H.request(f.server, 'POST', '/api/action', { revision, action }, owner);
        assert.equal(denied.body.code, 'PARENT_REQUIRED', label + ': missing grant');
        assert.equal(denied.status, 403);
        protectedSeen.add(action.type);
        entry.checks.push('sensitive action denied without one-use grant');
      }
      const grant = protectedAction ? await H.grant(f, owner, action, revision) : undefined;
      const response = await H.request(f.server, 'POST', '/api/action', { revision, action, grant }, owner);
      assert.equal(response.status, 200, label + ': ' + response.body.error);
      assert.equal(response.body.revision, beforeRevision + 1, label + ': one revision');
      assert.equal(response.body.familyId, owner.familyId);
      assert.equal(response.body.userId, owner.userId);
      revision = response.body.revision;
      state = response.body.state;
      assert.equal(state.appliedActions.filter(id => id === action.id).length, 1);
      check(state, action, response.body);
      entry.checks.push('authorized command accepted with bound identity and one revision');
      const replay = await H.request(f.server, 'POST', '/api/action', { revision: 1, action }, owner);
      assert.equal(replay.status, 200, label + ': replay');
      assert.deepEqual(replay.body.state, state, label + ': replay state');
      assert.equal(replay.body.revision, revision, label + ': replay revision');
      entry.checks.push('same-content replay at stale revision has no second effect');
      const altered = await H.request(f.server, 'POST', '/api/action',
        { revision, action: { ...action, auditTamper: true } }, owner);
      assert.equal(altered.status, 400);
      assert.equal(altered.body.code, 'ACTION_ID_REUSED', label + ': changed receipt payload');
      entry.checks.push('same action ID with altered content rejected');
      const row = (await f.pool.query('SELECT state,revision FROM saas_families WHERE id=$1', [owner.familyId])).rows[0];
      assert.deepEqual(row.state, state, label + ': persisted state');
      assert.equal(Number(row.revision), revision, label + ': persisted revision');
      entry.checks.push('PostgreSQL state and revision exactly match accepted response');
      if (protectedAction) {
        assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM saas_parent_grants WHERE family_id=$1',
          [owner.familyId])).rows[0].n, 0, label + ': grant consumed');
        entry.checks.push('one-use grant consumed after commit');
      }
      seen.add(action.type);
      entry.revisionAfter = revision;
      entry.result = 'passed';
      return { action, state };
    }

    await commit('Owner initially configures PIN', { type: 'parent.setup', method: 'pin', pin: H.PIN, confirmPin: H.PIN },
      false, (_s, _a, body) => assert.equal(body.parent.method, 'pin'));
    const item = (await commit('Create point template',
      { type: 'pointItem.save', item: { name: '审查阅读', points: 5, reason: '原预设', enabled: true } }, true)).state.pointItems[0];
    await commit('Disable point template', { type: 'pointItem.save', item: { id: item.id, enabled: false } },
      true, s => assert.equal(s.pointItems[0].enabled, false));
    await commit('Rename, change points and reenable template',
      { type: 'pointItem.save', item: { id: item.id, name: '改名阅读', points: 6, enabled: true } },
      true, s => assert.equal(s.pointItems[0].points, 6));
    await commit('Award points and save template',
      { type: 'points.add', name: '实际行为', points: 600, reason: '实际说明', saveAsTemplate: true }, true,
      s => { assert.equal(M.totals(s).earned, 600); assert.equal(s.pointItems.length, 2); });
    await commit('Configure companion', { type: 'pet.configure', kind: 'capybara', name: '审查伙伴' },
      false, s => assert.equal(s.pet.name, '审查伙伴'));
    await commit('Buy old supplies before starting farm', { type: 'pet.buy', itemId: 'snack', quantity: 2, expectedPoints: 6 },
      true, s => assert.equal(M.totals(s).spent, 6));
    await commit('Consume old supply', { type: 'pet.care', care: 'feed', source: 'inventory' },
      false, s => assert.equal(M.petStatus(s, M.dateKey(new Date(f.clock.value))).inventory.snack, 1));
    await commit('Free wash', { type: 'pet.care', care: 'wash', source: 'free' });
    await commit('Free training', { type: 'pet.care', care: 'train', source: 'free' });
    await commit('Select unlocked old scene', { type: 'pet.scene', sceneId: 'home' }, false, s => assert.equal(s.petScene, 'home'));
    const task = (await commit('Create near-term reminder', { type: 'task.save', task: { title: '今天事项',
      date: M.dateKey(new Date(f.clock.value)), time: '23:40', type: 'task', note: '备注', remindDays: 0 } }, true)).state.tasks[0];
    await commit('Acknowledge reminder', { type: 'task.ack', taskId: task.id }, false, s => assert.ok(s.tasks[0].ackAt));
    await commit('Snooze reminder exactly ten minutes', { type: 'task.snooze', taskId: task.id, minutes: 10 },
      false, s => assert.equal(Date.parse(s.tasks[0].snoozeUntil) - f.clock.value, 600000));
    await commit('Complete task', { type: 'task.toggle', taskId: task.id }, false, s => assert.equal(s.tasks[0].done, true));
    await commit('Undo task completion', { type: 'task.toggle', taskId: task.id }, false, s => assert.equal(s.tasks[0].done, false));
    await commit('Soft delete task', { type: 'task.delete', taskId: task.id }, true, s => assert.equal(s.tasks[0].deleted, true));
    await commit('Restore task', { type: 'task.restore', taskId: task.id }, true, s => assert.equal(s.tasks[0].deleted, false));
    await commit('Edit task title and note', { type: 'task.save', task: { id: task.id, title: '已编辑', note: '编辑备注' } },
      true, s => assert.equal(s.tasks[0].title, '已编辑'));
    await commit('Create future event', { type: 'task.save', task: { title: '远期事件',
      date: M.addDays(M.dateKey(new Date(f.clock.value)), 4), time: '12:00', type: 'event', remindDays: 2 } },
      true, s => assert.equal(s.tasks[1].type, 'event'));
    const reward = (await commit('Create daily reward', { type: 'reward.save',
      reward: { name: '审查礼品', points: 5, category: 'daily', enabled: true } }, true)).state.rewards[0];
    await commit('Rename and disable reward', { type: 'reward.save', reward: { id: reward.id, name: '改名礼品', enabled: false } },
      true, s => assert.equal(s.rewards[0].enabled, false));
    await commit('Reenable reward', { type: 'reward.save', reward: { id: reward.id, enabled: true } }, true);
    const firstRequest = (await commit('Request reward', { type: 'redemption.request', rewardId: reward.id },
      false, s => assert.equal(s.requests[0].status, 'pending'))).state.requests[0];
    await commit('Cancel request', { type: 'redemption.cancel', requestId: firstRequest.id },
      false, s => assert.equal(s.requests[0].status, 'cancelled'));
    const secondRequest = (await commit('Request reward again', { type: 'redemption.request', rewardId: reward.id })).state.requests[1];
    await commit('Approve reward request', { type: 'redemption.approve', requestId: secondRequest.id, expectedPoints: 5, note: '批准' },
      true, s => { assert.equal(s.requests[1].status, 'approved'); assert.equal(s.redemptions.length, 1); });
    await commit('Direct parent-approved redemption', { type: 'reward.redeem', rewardId: reward.id, expectedPoints: 5, note: '直接确认' },
      true, s => assert.equal(s.redemptions.length, 2));
    await commit('Update month-end and preferred reward',
      { type: 'settings.update', settings: { monthEndDays: 4, preferredReward: reward.id } },
      true, s => assert.equal(s.settings.preferredReward, reward.id));
    await commit('Update child name and synthetic image', { type: 'profile.update', childName: '头像审查',
      childAvatar: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY3sAAAAASUVORK5CYII=' },
      true, s => { assert.equal(s.childName, '头像审查'); assert.match(s.childAvatar, /^data:image\/png/); });
    await commit('Change PIN verification to arithmetic', { type: 'parent.configure', method: 'math' },
      true, (_s, _a, body) => assert.equal(body.parent.method, 'math'));
    await commit('Change arithmetic verification back to PIN', { type: 'parent.configure', method: 'pin', pin: H.PIN, confirmPin: H.PIN },
      true, (_s, _a, body) => assert.equal(body.parent.method, 'pin'));
    await commit('Start farm and receive one welcome batch', { type: 'farm.start' },
      false, s => assert.equal(s.farm.welcomeGift.harvestedAt, null));
    await commit('Harvest welcome batch', { type: 'farm.harvest', plotIds: ['p1'] }, false, s => assert.equal(s.farm.inventory.carrot, 3));
    await commit('Exchange crops for flowerpot', { type: 'farm.exchange', itemId: 'flowerpot' },
      false, s => assert.equal(s.farm.inventory.carrot, 0));
    await commit('Place flowerpot', { type: 'farm.place', slot: 'entry', itemId: 'flowerpot' },
      false, s => assert.equal(s.farm.placements.entry, 'flowerpot'));
    await commit('Remove placed flowerpot', { type: 'farm.place', slot: 'entry', itemId: null },
      false, s => assert.equal(s.farm.placements.entry, null));
    await commit('Feed chicken', { type: 'farm.animalCare', animalId: 'chicken', care: 'feed' });
    await commit('Pet unlocked rabbit', { type: 'farm.animalCare', animalId: 'rabbit', care: 'pet' },
      false, s => assert.equal(s.farm.animalCare.length, 2));
    for (let cycle = 1; cycle <= 13; cycle++) {
      for (const [cropId, plotIds] of [['carrot', ['p1', 'p2']], ['strawberry', ['p3', 'p4']], ['sunflower', ['p5', 'p6']]]) {
        await commit('Cycle ' + cycle + ': plant ' + cropId, { type: 'farm.plant', cropId, plotIds });
      }
      f.clock.value += 8 * 3600000;
      await commit('Cycle ' + cycle + ': harvest six mature plots',
        { type: 'farm.harvest', plotIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'] });
    }
    for (const itemId of ['picnic', 'rabbitstatue', 'mailbox', 'trellis', 'windmill', 'house2', 'house3']) {
      await commit('Exchange crops for ' + itemId, { type: 'farm.exchange', itemId });
    }
    assert.equal(state.farm.houseLevel, 3);
    assert.deepEqual(M.totals(state), { earned: 600, spent: 16, available: 584 });
    assert.deepEqual([...seen].sort(), EXPECTED_TYPES);
    assert.equal(counter, 98);
    assert.equal(protectedSeen.size, 12);
    const receiptCount = (await f.pool.query('SELECT count(*)::int AS n FROM saas_action_receipts WHERE family_id=$1',
      [owner.familyId])).rows[0].n;
    assert.equal(receiptCount, counter);
    const otherState = (await H.request(f.server, 'GET', '/api/state', undefined, outsider)).body;
    assert.equal(otherState.revision, 1);
    assert.deepEqual(M.totals(otherState.state), { earned: 0, spent: 0, available: 0 });
    assert.equal(otherState.state.appliedActions.length, 0);
    report.summary = { uniqueActionTypes: seen.size, committedVariants: counter,
      protectedTypes: protectedSeen.size, protectedVariants: report.variants.filter(row => row.needsGrant).length,
      checks: report.variants.reduce((sum, row) => sum + row.checks.length, 0),
      receiptCount, finalRevision: revision, otherFamilyUnchanged: true,
      allThreeCrops: true, allPaidFarmCatalogItems: true, houseLevel: state.farm.houseLevel,
      elapsedCropHoursSimulated: 104, ledger: M.totals(state) };
    report.types = [...seen].sort();
    report.clockEnd = new Date(f.clock.value).toISOString();
    report.result = 'passed';
  } catch (error) {
    report.result = 'failed';
    report.failure = { name: error.name, message: error.message };
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    report.finalSourceHashes = sourceHashes();
    report.sourceStable = JSON.stringify(report.sourceHashes) === JSON.stringify(report.finalSourceHashes);
    // This is the only evidence file owned by this test. No v13 artifact is read
    // or overwritten. A later rerun intentionally replaces this current result.
    fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ result: report.result, output: 'artifacts/v14-action-audit.json',
      sourceStable: report.sourceStable, ...report.summary }));
  }
});
