'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Model = require('../model.js');
const now = '2026-11-16T14:00:00.000Z';

test('SaaS new family contains only its supplied child and no fictitious activity', () => {
  const state = Model.createEmptyFamily({ childName: '  初初  ' }, now);
  assert.equal(state.childName, '初初');
  for (const name of ['tasks', 'pointItems', 'rewards', 'points', 'redemptions', 'requests', 'petPurchases', 'petCare', 'appliedActions']) assert.deepEqual(state[name], [], name);
  const totals = Model.totals(state);
  assert.equal(totals.earned, 0);
  assert.equal(totals.spent, 0);
  assert.equal(totals.available, 0);
  assert.equal(Model.growth(state).xp, 0);
  assert.equal(state.farm, null);
  assert.equal(Model.farmStatus(state, now).initialized, false);
  assert.deepEqual(Model.normalize(state), state);
  assert.equal(Model.totals(Model.createSeed(now)).earned, 128, 'explicit offline demo is still independent');
});

test('new family inputs cannot inject prior points or skip required identity', () => {
  for (const childName of ['', '   ', null, 3, 'x'.repeat(41)]) assert.throws(() => Model.createEmptyFamily({ childName }, now));
  assert.throws(() => Model.createEmptyFamily({ childName: '初初', points: [{ points: 500 }] }, now));
  assert.throws(() => Model.createEmptyFamily(null, now));
});

test('independent new families start with their own once-only welcome farm', () => {
  const first = Model.createEmptyFamily({ childName: '初初' }, now);
  const second = Model.createEmptyFamily({ childName: '初初' }, now);
  const started = Model.apply(first, { id: 'same-start-id', type: 'farm.start' }, now);
  const startedSecond = Model.apply(second, { id: 'same-start-id', type: 'farm.start' }, now);
  assert.equal(first.farm, null);
  assert.equal(second.farm, null);
  assert.equal(Model.farmStatus(started, now).readyCount, 1);
  assert.equal(Model.farmStatus(started, now).plotLimit, 2);
  assert.equal(Model.totals(started).earned, 0);
  started.farm.inventory.carrot = 99;
  assert.equal(startedSecond.farm.inventory.carrot, 0);
  assert.throws(() => Model.apply(startedSecond, { id: 'another-start', type: 'farm.start' }, now), /已经开启/);
});
