'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Model = require('../model.js');
const now = '2026-11-16T14:00:00.000Z';

test('point photos preserve their order as ids and reject malformed, repeated or excess references', () => {
  const state = Model.createEmptyFamily({ childName: '初初' }, now);
  const ids = ['b925481c-3b8a-4d2e-817c-e4ada7393d37', '45900ed8-8502-4aee-8830-21dacfd10883', '8b4f53c2-bdf3-4a0d-a0d9-b8c404a36360'];
  const action = { id: 'photos', type: 'points.add', name: '阅读', points: 5, photoIds: [...ids] };
  const saved = Model.apply(state, action, now);
  assert.deepEqual(saved.points[0].photoIds, ids);
  assert.equal(Model.totals(saved).earned, 5);
  action.photoIds.reverse();
  assert.deepEqual(saved.points[0].photoIds, ids, 'the caller cannot mutate saved references');
  assert.deepEqual(Model.normalize(saved), saved);
  const plain = Model.apply(state, { id: 'plain', type: 'points.add', name: '阅读', points: 5 }, now);
  assert.equal(Object.hasOwn(plain.points[0], 'photoIds'), false, 'old awards keep their original shape');
  for (const photoIds of [null, ids[0], [null], Array(1), ['data:image/jpeg;base64,AAAA'], [ids[0], ids[0].toUpperCase()], [...ids, ids[0]]]) {
    assert.throws(() => Model.apply(state, { ...action, photoIds }, now), /照片/);
  }
  assert.throws(() => Model.apply(saved, { ...action, id: 'reuse', photoIds: [ids[0]] }, now), /照片不能用于多次/);
});

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
