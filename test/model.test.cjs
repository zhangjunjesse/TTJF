'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Model = require('../model.js');
const NOW = new Date(2026, 10, 14, 12, 30, 0);
// Real 1x1 raster files encoded in memory with Pillow; no network fixtures.
const PNG_AVATAR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMImBYAAAJwATedyl3YAAAAAElFTkSuQmCC';
const WEBP_AVATAR = 'data:image/webp;base64,UklGRjQAAABXRUJQVlA4ICgAAACwAQCdASoBAAEAAUAmJZgCdLoABDAAAP7aJv43m81rW/+A6MOVqWwA';
const JPEG_AVATAR = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCCiiivLPFP/9k=';
const seed = () => Model.createSeed(NOW);
function action(state, type, values, now = NOW) {
  return Model.apply(state, Object.assign({ id: 'action-' + (state.appliedActions.length + 1), type }, values), now);
}
function freeze(value) {
  Object.keys(value).forEach(key => {
    if (value[key] && typeof value[key] === 'object') { freeze(value[key]); }
  });
  return Object.freeze(value);
}
function rich() { return action(seed(), 'points.add', { name: '长期坚持', points: 1000, reason: '真实记录优秀表现' }); }

test('seed is deterministic, fixed IDs and real ledgers total 128 / 40 / 88', () => {
  const state = seed();
  assert.deepEqual(state, seed());
  assert.deepEqual(Model.totals(state), { earned: 128, spent: 40, available: 88 });
  assert.equal(state.points.reduce((sum, row) => sum + row.points, 0), 128);
  assert.equal(state.redemptions.reduce((sum, row) => sum + row.points, 0), 40);
  assert.equal(state.tasks.filter(row => row.date === '2026-11-14').length, 3);
  assert.equal(state.tasks.filter(row => row.date === '2026-11-15').length, 2);
  assert.equal(state.tasks.filter(row => row.date === '2026-11-16').length, 1);
  const first = state.tasks.find(row => !row.done);
  assert.equal(first.id, 'task-reading');
  assert.equal(first.title, '读一会儿喜欢的书');
  assert.equal(first.note, '翻开书，先读一页就好');
  assert.equal(first.time, '11:00');
  assert.equal(state.tasks.find(row => row.id === 'task-bag').time, '17:00');
  assert.equal(state.tasks.find(row => row.type === 'event').date, '2026-11-21');
  assert.equal(state.settings.preferredReward, 'reward-trip');
  assert.deepEqual(state.pointItems.map(row => row.reason), [
    '今天主动读了一会儿自己选的书', '把今天的作业认真完成了',
    '不用提醒，自己收好了书包', '主动帮家人做了一件力所能及的事'
  ]);
});

test('UMD publishes the same model APIs to a browser window', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../model.js'), 'utf8'), context);
  assert.deepEqual(Object.keys(context.window.FamilyModel).sort(), Object.keys(Model).sort());
  assert.equal(context.window.FamilyModel.totals(context.window.FamilyModel.createSeed(NOW)).available, 88);
  const browser = context.window.FamilyModel;
  const profiled = browser.apply(browser.createSeed(NOW), { id: 'browser-photo', type: 'profile.update', childName: '小禾', childAvatar: PNG_AVATAR }, NOW);
  assert.equal(profiled.childAvatar, PNG_AVATAR);
  assert.equal(browser.growth(profiled).stage, 3);
  assert.equal(browser.petStatus(profiled, '2026-11-14').freeRemaining, 3);
  const stages = browser.growthStages('plant');
  assert.equal(stages.length, 5);
  assert.equal(stages[2].name, browser.growth(profiled).stageName);
  stages[2].name = 'changed';
  assert.equal(browser.growthStages('plant')[2].name, '踏星小龙');
  assert.throws(() => browser.growthStages('cat'), /伙伴种类/);
  assert.equal(browser.frequentPointItems(profiled, NOW).length, profiled.pointItems.filter(row => row.enabled).length);
});

test('date arithmetic handles leap days, month/year rollover and rejects impossible dates', () => {
  assert.equal(Model.dateKey(NOW), '2026-11-14');
  assert.equal(Model.dateKey('2026-11-14'), '2026-11-14');
  assert.equal(Model.addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(Model.addDays('2024-02-29', 1), '2024-03-01');
  assert.equal(Model.addDays('2026-12-31', 2), '2027-01-02');
  assert.equal(Model.addDays('2027-01-01', -1), '2026-12-31');
  assert.equal(Model.addDays('0099-12-31', 1), '0100-01-01');
  ['2026-02-29', '2026-13-01', '2026-00-01', '2026-11-31', '0000-01-01', 'garbage'].forEach(value => {
    assert.throws(() => Model.dateKey(value), Error);
  });
  assert.throws(() => Model.addDays('2026-11-14', 0.5), Error);
  assert.throws(() => Model.createSeed(new Date(NaN)), Error);
});

test('apply is pure and duplicate action IDs return the original object without effects', () => {
  const state = freeze(seed());
  const command = { id: 'unique-1', type: 'points.add', itemId: 'point-reading', reason: '主动阅读' };
  const next = Model.apply(state, command, NOW);
  assert.notEqual(next, state);
  assert.deepEqual(Model.totals(state), { earned: 128, spent: 40, available: 88 });
  assert.equal(Model.totals(next).earned, 133);
  assert.equal(next.points[next.points.length - 1].name, '自主阅读');
  assert.equal(Model.apply(next, command, NOW), next);
  assert.equal(Model.apply(next, { id: 'unique-1', type: 'not-real' }, NOW), next);
  assert.deepEqual(command, { id: 'unique-1', type: 'points.add', itemId: 'point-reading', reason: '主动阅读' });
});

test('task saves honor the three-day window and important events allow any non-past date', () => {
  let state = action(seed(), 'task.save', { task: { title: '新事项', date: '2026-11-16', time: '23:59' } });
  assert.equal(state.tasks[state.tasks.length - 1].id, 'task-action-1');
  assert.equal(state.tasks[state.tasks.length - 1].type, 'task');
  assert.throws(() => action(state, 'task.save', { task: { title: '太远', date: '2026-11-17' } }), /今天/);
  assert.throws(() => action(state, 'task.save', { task: { title: '已过去', date: '2026-11-13' } }), /过去/);
  state = action(state, 'task.save', { task: { type: 'event', title: '来年计划', date: '2027-06-01', remindDays: 7 } });
  assert.equal(state.tasks[state.tasks.length - 1].remindDays, 7);
  state = action(state, 'task.save', { task: { type: 'event', title: '今日事件', date: '2026-11-14' } });
  assert.equal(state.tasks[state.tasks.length - 1].date, '2026-11-14');
});

test('task window follows natural dates across a year boundary', () => {
  const now = new Date(2026, 11, 31, 23, 59, 0);
  const state = action(Model.createSeed(now), 'task.save', { task: { title: '新年', date: '2027-01-02' } }, now);
  assert.equal(state.tasks[state.tasks.length - 1].date, '2027-01-02');
  assert.throws(() => action(state, 'task.save', { task: { title: '太远', date: '2027-01-03' } }, now), /今天/);
});

test('past tasks may keep their original date during edits, without moving to a new past date', () => {
  const state = seed();
  const later = new Date(2026, 10, 20, 12);
  const updated = action(state, 'task.save', { task: { id: 'task-reading', title: '补充标题' } }, later);
  assert.equal(updated.tasks[0].date, '2026-11-14');
  assert.equal(updated.tasks[0].createdAt, state.tasks[0].createdAt);
  assert.throws(() => action(updated, 'task.save', { task: { id: 'task-reading', date: '2026-11-15' } }, later), /过去/);
  assert.throws(() => action(updated, 'task.save', { task: { id: 'task-reading', type: 'event' } }, later), /过去/);
});

test('toggle, soft delete and restore retain history and never award points', () => {
  let state = action(seed(), 'task.toggle', { taskId: 'task-reading' });
  assert.equal(state.tasks[0].done, true);
  state = action(state, 'task.delete', { taskId: 'task-reading' });
  assert.equal(state.tasks.length, 7);
  assert.equal(state.tasks[0].deleted, true);
  assert.throws(() => action(state, 'task.toggle', { taskId: 'task-reading' }), /恢复/);
  assert.throws(() => action(state, 'task.save', { task: { id: 'task-reading', title: '新名称' } }), /恢复/);
  state = action(state, 'task.restore', { taskId: 'task-reading' });
  assert.equal(state.tasks[0].deleted, false);
  assert.equal(state.tasks[0].done, true);
  state = action(state, 'task.toggle', { taskId: 'task-reading' });
  assert.equal(state.tasks[0].done, false);
  assert.deepEqual(Model.totals(state), { earned: 128, spent: 40, available: 88 });
});

test('invalid task fields, unknown IDs and attempts to rewrite history are rejected or ignored', () => {
  ['24:00', '12:60', '9:00'].forEach(clock => {
    assert.throws(() => action(seed(), 'task.save', { task: { title: '测试', date: '2026-11-14', time: clock } }), Error);
  });
  [undefined, ' ', 123].forEach(title => {
    assert.throws(() => action(seed(), 'task.save', { task: { title, date: '2026-11-14' } }), Error);
  });
  assert.throws(() => action(seed(), 'task.toggle', { taskId: 'missing' }), /不存在/);
  assert.throws(() => action(seed(), 'task.save', { task: { title: '测试', date: '2026-11-14', remindDays: -1 } }), Error);
  const next = action(seed(), 'task.save', { task: { id: 'task-reading', done: true, createdAt: 'bad', deleted: true } });
  assert.equal(next.tasks[0].done, false);
  assert.equal(next.tasks[0].deleted, false);
  assert.equal(next.tasks[0].createdAt, seed().tasks[0].createdAt);
});

test('points require positive integers and a name while optional reasons normalize to empty text', () => {
  [-1, 0, 0.5, NaN, Infinity, '5', null, 9007199254740992].forEach(points => {
    assert.throws(() => action(seed(), 'points.add', { name: '好行为', points, reason: '原因' }), /正整数/);
  });
  [{}, { reason: undefined }, { reason: null }, { reason: '' }, { reason: ' \t\n ' }].forEach(optional => {
    const before = freeze(seed());
    const state = action(before, 'points.add', Object.assign({ name: '好行为', points: 5 }, optional));
    assert.equal(state.points[state.points.length - 1].reason, '');
    assert.deepEqual(Model.totals(state), { earned: 133, spent: 40, available: 93 });
    assert.deepEqual(Model.normalize(JSON.parse(JSON.stringify(state))), state);
    assert.deepEqual(state.points.slice(0, -1), before.points);
  });
  [0, true, {}, [], '字'.repeat(2001)].forEach(reason => {
    assert.throws(() => action(seed(), 'points.add', { name: '好行为', points: 5, reason }), /原因/);
    const stored = seed();
    stored.points[0].reason = reason;
    assert.throws(() => Model.normalize(stored), /原因/);
  });
  assert.throws(() => action(seed(), 'points.add', { points: 5, reason: '有原因但没名称' }), /名称/);
  const state = action(seed(), 'points.add', { name: '  自己系鞋带  ', points: 3, reason: '  耐心尝试  ' });
  const saved = state.points[state.points.length - 1];
  assert.equal(saved.name, '自己系鞋带');
  assert.equal(saved.reason, '耐心尝试');
  assert.equal(saved.itemId, '');
});

test('points only allow backdating within the current natural day', () => {
  const at = new Date(2026, 10, 14, 8).toISOString();
  const state = action(seed(), 'points.add', { itemId: 'point-reading', reason: '今早阅读', at });
  assert.equal(state.points[state.points.length - 1].at, at);
  [new Date(2026, 10, 13, 23).toISOString(), new Date(2026, 10, 14, 13).toISOString(), 'broken'].forEach(value => {
    assert.throws(() => action(seed(), 'points.add', { itemId: 'point-reading', reason: '阅读', at: value }), Error);
  });
});

test('point-item changes leave historical names and points intact; disabled items cannot be used', () => {
  const initial = action(seed(), 'points.add', { itemId: 'point-reading', points: 7, reason: '分享故事' });
  const before = JSON.stringify(initial.points);
  let state = action(initial, 'pointItem.save', { item: { id: 'point-reading', name: '阅读新名称', points: 9 } });
  assert.equal(JSON.stringify(state.points), before);
  state = action(state, 'points.add', { itemId: 'point-reading', reason: '新的表现' });
  assert.equal(state.points[state.points.length - 1].points, 9);
  assert.equal(state.points[state.points.length - 1].name, '阅读新名称');
  state = action(state, 'pointItem.save', { item: { id: 'point-reading', enabled: false } });
  assert.throws(() => action(state, 'points.add', { itemId: 'point-reading', reason: '阅读' }), /停用/);
  assert.throws(() => action(state, 'points.add', { itemId: 'missing', reason: '阅读' }), /不存在/);
  assert.throws(() => action(state, 'pointItem.save', { item: { name: '新项目', points: 0 } }), Error);
  assert.throws(() => action(state, 'points.remove', { pointId: 'seed-p1' }), /不支持/);
});

test('point template deletion removes only the catalog entry and preserves historical points and growth', () => {
  const original = freeze(seed());
  const command = { id: 'delete-used-template', type: 'pointItem.delete', itemId: 'point-reading' };
  const next = Model.apply(original, command, NOW);
  assert.deepEqual(next.pointItems, original.pointItems.filter(item => item.id !== command.itemId));
  assert.deepEqual(next.points, original.points);
  assert.deepEqual(next.redemptions, original.redemptions);
  assert.deepEqual(Model.totals(next), Model.totals(original));
  assert.deepEqual(Model.growth(next), Model.growth(original));
  assert.equal(Model.frequentPointItems(next, NOW).some(item => item.id === command.itemId), false);
  assert.deepEqual(Model.normalize(next), next, 'historical item IDs remain valid after deletion');
  assert.equal(Model.apply(next, command, NOW), next, 'exact retries do not delete a second entry');
  assert.throws(() => action(next, 'points.add', { itemId: command.itemId, name: '自主阅读', points: 5 }), /加分项不存在/);
  assert.throws(() => action(next, 'pointItem.delete', { itemId: command.itemId }), /加分项不存在/);
  assert.equal(original.pointItems.length, 4);
});

test('point template deletion accepts disabled and last entries but requires one existing target', () => {
  let state = action(seed(), 'pointItem.save', { item: { id: 'point-reading', enabled: false } });
  const before = JSON.stringify(state);
  for (const itemId of [undefined, null, '', false, 0, {}, '../point-reading', 'missing-template']) {
    assert.throws(() => action(state, 'pointItem.delete', { itemId }), /标识|不存在/);
    assert.equal(JSON.stringify(state), before);
  }
  assert.throws(() => action(state, 'pointItem.delete', { itemId: 'point-reading', points: 100 }), /不接受客户端字段/);
  assert.equal(JSON.stringify(state), before);
  for (const item of state.pointItems.slice()) { state = action(state, 'pointItem.delete', { itemId: item.id }); }
  assert.deepEqual(state.pointItems, []);
  assert.deepEqual(Model.frequentPointItems(state, NOW), []);
  assert.deepEqual(Model.totals(state), Model.totals(seed()));
});

test('availability combines weekend and month-end categories while daily is always open', () => {
  const state = rich();
  const check = (day, reward) => Model.availability(state, reward, new Date(2026, 10, day, 12)).allowed;
  assert.equal(check(16, 'reward-pencil'), true); // Monday
  assert.equal(check(16, 'reward-burger'), false);
  assert.equal(check(16, 'reward-trip'), false);
  assert.equal(check(14, 'reward-burger'), true); // Saturday, not month end
  assert.equal(check(14, 'reward-trip'), false);
  assert.equal(check(27, 'reward-trip'), false);
  assert.equal(check(28, 'reward-trip'), true); // last three days, Saturday
  assert.equal(check(28, 'reward-burger'), true);
  assert.equal(check(30, 'reward-trip'), true); // month-end Monday
  assert.equal(check(30, 'reward-burger'), false);
  assert.equal(Model.availability(state, 'missing', NOW).allowed, false);
});

test('month-end length handles February and leap years', () => {
  const state = rich();
  assert.equal(Model.availability(state, 'reward-trip', new Date(2024, 1, 26, 12)).allowed, false);
  assert.equal(Model.availability(state, 'reward-trip', new Date(2024, 1, 27, 12)).allowed, true);
  assert.equal(Model.availability(state, 'reward-trip', new Date(2025, 1, 25, 12)).allowed, false);
  assert.equal(Model.availability(state, 'reward-trip', new Date(2025, 1, 26, 12)).allowed, true);
});

test('redemption snapshots cost and name, never decreases earned, and rejects insufficient balance', () => {
  const original = seed();
  let state = action(original, 'reward.redeem', { rewardId: 'reward-pencil', note: '选好颜色啦' });
  assert.deepEqual(Model.totals(state), { earned: 128, spent: 52, available: 76 });
  assert.deepEqual(state.points, original.points);
  const before = JSON.stringify(state.redemptions);
  state = action(state, 'reward.save', { reward: { id: 'reward-pencil', name: '新铅笔', points: 3 } });
  assert.equal(JSON.stringify(state.redemptions), before);
  state = action(state, 'reward.redeem', { rewardId: 'reward-pencil' });
  assert.equal(state.redemptions[state.redemptions.length - 1].name, '新铅笔');
  assert.equal(state.redemptions[state.redemptions.length - 1].points, 3);
  state = action(state, 'reward.save', { reward: { id: 'reward-pencil', enabled: false } });
  assert.throws(() => action(state, 'reward.redeem', { rewardId: 'reward-pencil' }), /停用/);
  assert.throws(() => action(seed(), 'reward.redeem', { rewardId: 'reward-trip' }, new Date(2026, 10, 30, 12)), /还差/);
});

test('exact balance may be spent down to zero; retries and repeated redemptions cannot overdraft', () => {
  let state = seed();
  for (let i = 0; i < 11; i += 1) { state = action(state, 'reward.redeem', { rewardId: 'reward-eraser' }); }
  assert.deepEqual(Model.totals(state), { earned: 128, spent: 128, available: 0 });
  const command = { id: state.appliedActions[state.appliedActions.length - 1], type: 'reward.redeem', rewardId: 'reward-eraser' };
  assert.equal(Model.apply(state, command, NOW), state);
  assert.throws(() => action(state, 'reward.redeem', { rewardId: 'reward-eraser' }), /还差/);
});

test('settings and catalog changes validate values, preserve history and support new entries', () => {
  let state = action(seed(), 'pointItem.save', { item: { name: '新行为', points: 6 } });
  assert.equal(state.pointItems[state.pointItems.length - 1].enabled, true);
  state = action(state, 'reward.save', { reward: { name: '郊游', points: 100, category: 'outing' } });
  const reward = state.rewards[state.rewards.length - 1];
  assert.equal(reward.icon, 'mountain');
  state = action(state, 'settings.update', { settings: { monthEndDays: 1, preferredReward: reward.id }, childName: '小禾禾' });
  assert.equal(state.childName, '小禾禾');
  assert.equal(state.settings.monthEndDays, 1);
  assert.deepEqual(Model.totals(state), Model.totals(seed()));
  [0, -1, 32, 1.5].forEach(monthEndDays => {
    assert.throws(() => action(state, 'settings.update', { settings: { monthEndDays } }), Error);
  });
  assert.throws(() => action(state, 'settings.update', { settings: { preferredReward: 'missing' } }), /不存在/);
  assert.throws(() => action(state, 'reward.save', { reward: { name: '错误', points: 2, category: 'other' } }), Error);
  assert.throws(() => action(state, 'reward.save', { reward: { name: '错误', points: 2, icon: 'other' } }), Error);
  assert.throws(() => action(state, 'pointItem.save', { item: { name: '错误', points: 2, enabled: 'false' } }), Error);
});

test('missing historical timestamps and non-string optional IDs are rejected', () => {
  const state = seed();
  delete state.points[0].at;
  assert.throws(() => Model.totals(state), /记录时间/);
  assert.throws(() => action(seed(), 'points.add', { itemId: 0, name: '阅读', points: 5, reason: '原因' }), /标识/);
  assert.throws(() => action(seed(), 'task.save', { task: { id: false, title: '测试', date: '2026-11-14' } }), /标识/);
  assert.throws(() => action(seed(), 'pointItem.save', { item: { id: 0, name: '测试', points: 1 } }), /标识/);
  assert.throws(() => action(seed(), 'reward.save', { reward: { id: 0, name: '测试', points: 1 } }), /标识/);
});

test('malformed state, arithmetic overflow and malformed actions fail before mutating input', () => {
  assert.throws(() => Model.apply(seed(), {}, NOW), Error);
  assert.throws(() => Model.apply(seed(), { id: 'bad id', type: 'task.toggle' }, NOW), Error);
  assert.throws(() => Model.apply(seed(), { id: 'ok', type: 'unknown' }, NOW), Error);
  const state = seed();
  state.redemptions[0].points = 10000;
  assert.throws(() => Model.totals(state), /负数/);
  assert.throws(() => action(seed(), 'points.add', { name: '溢出', points: Number.MAX_SAFE_INTEGER, reason: '原因' }), Error);
  assert.deepEqual(Model.totals(seed()), { earned: 128, spent: 40, available: 88 });
});

test('legacy v1 state normalizes new request and reminder fields without changing ledgers or input', () => {
  const legacy = seed();
  delete legacy.childAvatar;
  delete legacy.pet;
  delete legacy.requests;
  legacy.tasks.forEach(row => { delete row.ackAt; delete row.snoozeUntil; });
  legacy.pointItems.forEach(row => { delete row.reason; });
  const original = JSON.stringify(legacy);
  const normalized = Model.normalize(freeze(legacy));
  assert.deepEqual(normalized.requests, []);
  assert.equal(normalized.childAvatar, '');
  assert.deepEqual(normalized.pet, { kind: 'plant', name: '芽芽' });
  assert.deepEqual(Model.growth(legacy), Model.growth(normalized));
  assert.ok(normalized.tasks.every(row => row.ackAt === '' && row.snoozeUntil === ''));
  assert.ok(normalized.pointItems.every(row => row.reason === ''));
  assert.equal(JSON.stringify(legacy), original);
  assert.deepEqual(Model.totals(normalized), { earned: 128, spent: 40, available: 88 });
  const acknowledged = action(legacy, 'task.ack', { taskId: 'task-reading' });
  assert.equal(acknowledged.tasks[0].ackAt, NOW.toISOString());
  assert.deepEqual(acknowledged.requests, []);
});

test('redemption requests keep exactly one pending request and never debit the ledger', () => {
  const initial = seed();
  let state = action(initial, 'redemption.request', { rewardId: 'reward-pencil' });
  const first = state.requests[0];
  assert.deepEqual(first, { id: 'request-action-1', rewardId: 'reward-pencil', name: '彩虹铅笔',
    points: 12, category: 'daily', status: 'pending', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), redemptionId: '' });
  state = action(state, 'redemption.request', { rewardId: 'reward-pencil' });
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].id, first.id);
  state = action(state, 'redemption.request', { rewardId: 'reward-eraser' });
  assert.equal(state.requests.length, 2);
  assert.equal(state.requests[0].status, 'cancelled');
  assert.equal(state.requests.filter(row => row.status === 'pending').length, 1);
  assert.equal(state.requests[1].rewardId, 'reward-eraser');
  assert.deepEqual(state.redemptions, initial.redemptions);
  assert.deepEqual(Model.totals(state), Model.totals(initial));
});

test('cancelled and already approved requests cannot be approved again', () => {
  let state = action(seed(), 'redemption.request', { rewardId: 'reward-pencil' });
  const requestId = state.requests[0].id;
  state = action(state, 'redemption.cancel', { requestId });
  assert.equal(state.requests[0].status, 'cancelled');
  assert.deepEqual(Model.totals(state), Model.totals(seed()));
  assert.throws(() => action(state, 'redemption.approve', { requestId, expectedPoints: 12 }), /已经处理/);
  state = action(state, 'redemption.request', { rewardId: 'reward-pencil' });
  const nextId = state.requests[1].id;
  const approve = { id: 'approve-once', type: 'redemption.approve', requestId: nextId, expectedPoints: 12, note: '周六一起选' };
  state = Model.apply(state, approve, NOW);
  assert.equal(state.requests[1].status, 'approved');
  assert.equal(state.requests[1].redemptionId, 'redeem-approve-once');
  assert.equal(state.redemptions[state.redemptions.length - 1].note, '周六一起选');
  assert.deepEqual(Model.totals(state), { earned: 128, spent: 52, available: 76 });
  assert.equal(Model.apply(state, approve, NOW), state);
  assert.throws(() => action(state, 'redemption.approve', { requestId: nextId, expectedPoints: 12 }), /已经处理/);
  assert.throws(() => action(state, 'redemption.cancel', { requestId: nextId }), /不能取消/);
  assert.throws(() => action(state, 'redemption.cancel', { requestId: 'missing' }), /不存在/);
});

test('approval requires explicit current price and preserves the original request snapshot', () => {
  let state = action(seed(), 'redemption.request', { rewardId: 'reward-pencil' });
  const requestId = state.requests[0].id;
  assert.throws(() => action(state, 'redemption.approve', { requestId }), /确认分值/);
  state = action(state, 'reward.save', { reward: { id: 'reward-pencil', name: '新铅笔', points: 19 } });
  const before = JSON.stringify(state);
  assert.throws(() => action(state, 'redemption.approve', { requestId, expectedPoints: 12 }), /价格已变化/);
  assert.equal(JSON.stringify(state), before);
  state = action(state, 'redemption.approve', { requestId, expectedPoints: 19 });
  assert.equal(state.requests[0].points, 12);
  assert.equal(state.requests[0].name, '彩虹铅笔');
  assert.equal(state.redemptions[state.redemptions.length - 1].points, 19);
  assert.equal(state.redemptions[state.redemptions.length - 1].name, '新铅笔');
  assert.equal(Model.totals(state).earned, 128);
  assert.throws(() => action(state, 'reward.redeem', { rewardId: 'reward-pencil', expectedPoints: 12 }), /价格已变化/);
});

test('approval rechecks enabled status, category dates and the live balance', () => {
  let state = action(seed(), 'redemption.request', { rewardId: 'reward-burger' });
  const requestId = state.requests[0].id;
  assert.throws(() => action(state, 'redemption.approve', { requestId, expectedPoints: 60 }, new Date(2026, 10, 16, 12)), /周末/);
  const disabled = action(state, 'reward.save', { reward: { id: 'reward-burger', enabled: false } });
  assert.throws(() => action(disabled, 'redemption.approve', { requestId, expectedPoints: 60 }), /停用/);
  for (let i = 0; i < 3; i++) { state = action(state, 'reward.redeem', { rewardId: 'reward-pencil' }); }
  const before = JSON.stringify(state);
  assert.throws(() => action(state, 'redemption.approve', { requestId, expectedPoints: 60 }), /还差/);
  assert.equal(JSON.stringify(state), before);
  assert.throws(() => action(seed(), 'redemption.request', { rewardId: 'reward-burger' }, new Date(2026, 10, 16, 12)), /周末/);
  assert.throws(() => action(seed(), 'redemption.request', { rewardId: 'missing' }), /不存在/);
});

test('month-end approvals have no added monthly quota and keep cumulative earnings unchanged', () => {
  let state = rich();
  const monthEnd = new Date(2026, 10, 30, 12);
  const earned = Model.totals(state).earned;
  for (let i = 0; i < 2; i++) {
    state = action(state, 'redemption.request', { rewardId: 'reward-trip' }, monthEnd);
    const requestId = state.requests.find(row => row.status === 'pending').id;
    state = action(state, 'redemption.approve', { requestId, expectedPoints: 180 }, monthEnd);
  }
  assert.equal(state.requests.filter(row => row.status === 'approved').length, 2);
  assert.equal(Model.totals(state).earned, earned);
  assert.equal(Model.totals(state).spent, 400);
});

test('acknowledge and ten-minute snooze preserve the task and never change points', () => {
  let state = action(seed(), 'task.ack', { taskId: 'task-reading' });
  assert.equal(state.tasks[0].ackAt, NOW.toISOString());
  assert.equal(state.tasks[0].done, false);
  assert.equal(state.tasks[0].snoozeUntil, '');
  state = action(state, 'task.snooze', { taskId: 'task-reading', minutes: 10 });
  assert.equal(state.tasks[0].ackAt, '');
  assert.equal(state.tasks[0].snoozeUntil, new Date(NOW.getTime() + 600000).toISOString());
  assert.equal(state.tasks[0].done, false);
  state = action(state, 'task.ack', { taskId: 'task-reading' }, new Date(NOW.getTime() + 660000));
  assert.equal(state.tasks[0].snoozeUntil, '');
  assert.equal(state.tasks[0].ackAt, new Date(NOW.getTime() + 660000).toISOString());
  assert.deepEqual(Model.totals(state), Model.totals(seed()));
  assert.equal(state.tasks.length, seed().tasks.length);
});

test('rescheduling resets reminder fields while title and note edits preserve acknowledgement', () => {
  let state = action(seed(), 'task.ack', { taskId: 'task-reading' });
  state = action(state, 'task.save', { task: { id: 'task-reading', title: '换本书', note: '读第一页' } });
  assert.equal(state.tasks[0].ackAt, NOW.toISOString());
  state = action(state, 'task.save', { task: { id: 'task-reading', time: '13:00' } });
  assert.equal(state.tasks[0].ackAt, '');
  state = action(state, 'task.snooze', { taskId: 'task-reading', minutes: 10 });
  state = action(state, 'task.save', { task: { id: 'task-reading', date: '2026-11-15' } });
  assert.equal(state.tasks[0].snoozeUntil, '');
  state = action(state, 'task.ack', { taskId: 'task-reading' });
  state = action(state, 'task.toggle', { taskId: 'task-reading' });
  assert.equal(state.tasks[0].ackAt, '');
  assert.equal(state.tasks[0].done, true);
  state = action(state, 'task.toggle', { taskId: 'task-reading' });
  assert.equal(state.tasks[0].done, false);
  assert.equal(state.tasks[0].ackAt, '');
});

test('reminder actions reject non-ten-minute delays and completed or deleted tasks', () => {
  for (const minutes of [undefined, 0, 5, 11, '10', -10]) {
    assert.throws(() => action(seed(), 'task.snooze', { taskId: 'task-reading', minutes }), /10分钟/);
  }
  for (const type of ['task.ack', 'task.snooze']) {
    assert.throws(() => action(seed(), type, { taskId: 'task-breakfast', minutes: 10 }), /已完成/);
    const deleted = action(seed(), 'task.delete', { taskId: 'task-reading' });
    assert.throws(() => action(deleted, type, { taskId: 'task-reading', minutes: 10 }), /不存在或已删除/);
  }
});

test('stored reason presets do not invent an explicit reason for a new credit', () => {
  let state = action(seed(), 'pointItem.save', { item: { id: 'point-tidy', reason: '  没有提醒，自己收好了书包  ' } });
  assert.equal(state.pointItems.find(row => row.id === 'point-tidy').reason, '没有提醒，自己收好了书包');
  state = action(state, 'points.add', { itemId: 'point-tidy' });
  assert.equal(state.points[state.points.length - 1].reason, '');
  assert.equal(state.pointItems.find(row => row.id === 'point-tidy').reason, '没有提醒，自己收好了书包');
  state = action(state, 'points.add', { itemId: 'point-tidy', reason: '今天自己收好了书包' });
  assert.equal(state.points[state.points.length - 1].reason, '今天自己收好了书包');
});

test('invalid request states and invalid reminder timestamps fail closed', () => {
  const state = action(seed(), 'redemption.request', { rewardId: 'reward-pencil' });
  state.requests.push(Object.assign({}, state.requests[0], { id: 'another-request' }));
  assert.throws(() => Model.totals(state), /只能有一个/);
  state.requests.pop();
  state.requests[0].status = 'approved';
  assert.throws(() => Model.totals(state), /对应兑换记录/);
  const bad = seed();
  bad.tasks[0].ackAt = 'bad-time';
  assert.throws(() => Model.totals(bad), /日期时间/);
});

function atGrowth(xp, kind = 'plant') {
  const state = seed();
  state.points = xp === 0 ? [] : [{ id: 'growth-entry', itemId: '', name: '成长记录', points: xp, reason: '真实累计记录', at: NOW.toISOString() }];
  state.redemptions = [];
  state.pet = { kind, name: kind === 'plant' ? '芽芽' : '团团' };
  return state;
}

test('growth derives all five thresholds and later stars from cumulative earned points', () => {
  const rows = [
    [0, 1, 1, 0, 30, 30, 0, 0], [29, 1, 1, 0, 30, 1, 29 / 30, 0],
    [30, 2, 2, 30, 100, 70, 0, 0], [99, 2, 2, 30, 100, 1, 69 / 70, 0],
    [100, 3, 3, 100, 250, 150, 0, 0], [128, 3, 3, 100, 250, 122, 28 / 150, 0],
    [249, 3, 3, 100, 250, 1, 149 / 150, 0], [250, 4, 4, 250, 500, 250, 0, 0],
    [499, 4, 4, 250, 500, 1, 249 / 250, 0], [500, 5, 5, 500, 750, 250, 0, 0],
    [749, 5, 5, 500, 750, 1, 249 / 250, 0], [750, 5, 6, 750, 1000, 250, 0, 1],
    [1000, 5, 7, 1000, 1250, 250, 0, 2]
  ];
  const names = { plant: ['晶卵初醒', '晶叶幼龙', '踏星小龙', '星翼飞龙', '星辉守护龙'],
    capybara: ['初见团团', '好奇学员', '星岛探员', '银河领航员', '星光守护者'] };
  for (const kind of ['plant', 'capybara']) {
    for (const [xp, stage, level, previousAt, nextAt, remaining, progress, stars] of rows) {
      assert.deepEqual(Model.growth(freeze(atGrowth(xp, kind))), {
        xp, stage, level, stageName: names[kind][stage - 1], previousAt, nextAt, remaining, progress, stars
      }, kind + ' at ' + xp);
    }
  }
});

test('growth stays finite and within safe integers at the ledger maximum', () => {
  const maximum = Number.MAX_SAFE_INTEGER;
  const state = atGrowth(maximum);
  const result = Model.growth(state);
  const stars = Number((BigInt(maximum) - 500n) / 250n);
  assert.equal(result.stars, stars);
  assert.equal(result.level, stars + 5);
  assert.equal(result.previousAt, Number(500n + BigInt(stars) * 250n));
  assert.equal(result.nextAt, maximum);
  assert.equal(result.remaining, 0);
  assert.equal(result.progress, 1);
  for (const field of ['xp', 'stage', 'level', 'previousAt', 'nextAt', 'remaining', 'stars']) {
    assert.ok(Number.isSafeInteger(result[field]), field);
  }
  const almost = Model.growth(atGrowth(maximum - 1));
  assert.equal(almost.remaining, 1);
  assert.ok(almost.progress < 1 && almost.progress >= 0);
  state.points[0].points = maximum + 1;
  assert.throws(() => Model.growth(state), /整数/);
});

test('redemption, completion, appearance and claimed interaction values cannot change growth', () => {
  const initial = seed();
  const before = Model.growth(initial);
  let state = action(initial, 'reward.redeem', { rewardId: 'reward-pencil' });
  assert.deepEqual(Model.growth(state), before);
  state = action(state, 'task.toggle', { taskId: 'task-reading' });
  state = action(state, 'pet.configure', { kind: 'capybara', name: '团团', xp: 99999, level: 100, points: 999,
    childName: '被篡改', childAvatar: PNG_AVATAR, redemptions: [] });
  const changed = Model.growth(state);
  assert.equal(changed.xp, 128);
  assert.equal(changed.stage, 3);
  assert.equal(changed.stageName, '星岛探员');
  assert.equal(changed.remaining, before.remaining);
  assert.deepEqual(state.pet, { kind: 'capybara', name: '团团' });
  assert.equal(state.childName, initial.childName);
  assert.equal(state.childAvatar, '');
  assert.equal(Model.totals(state).available, 76);
  assert.throws(() => action(state, 'pet.feed', { points: 10 }), /不支持/);
  assert.throws(() => action(state, 'growth.add', { points: 10 }), /不支持/);
  state = action(state, 'points.add', { name: '实际进步', points: 122, reason: '完成一次具体进步' });
  assert.equal(Model.growth(state).stage, 4);
  assert.equal(Model.growth(state).xp, 250);
  state = action(state, 'pet.configure', { kind: 'plant', name: '新芽芽' });
  assert.equal(Model.growth(state).stage, 4);
});

test('profile updates change only child fields, preserve avatar on rename and allow removal', () => {
  const initial = freeze(seed());
  let state = action(initial, 'profile.update', { childName: '  小满  ', childAvatar: PNG_AVATAR,
    pet: { kind: 'capybara', name: 'ignored' }, points: [], xp: 999 });
  assert.equal(state.childName, '小满');
  assert.equal(state.childAvatar, PNG_AVATAR);
  assert.equal(initial.childName, '小禾');
  assert.equal(initial.childAvatar, '');
  for (const field of ['pet', 'points', 'redemptions', 'requests', 'tasks', 'settings', 'pointItems', 'rewards']) {
    assert.deepEqual(state[field], initial[field], field);
  }
  state = action(state, 'profile.update', { childName: '小雨' });
  assert.equal(state.childAvatar, PNG_AVATAR);
  state = action(state, 'profile.update', { childAvatar: '' });
  assert.equal(state.childName, '小雨');
  assert.equal(state.childAvatar, '');
  assert.equal(Model.growth(state).xp, 128);
  for (const childName of ['', ' ', 'a'.repeat(41), 123]) {
    assert.throws(() => action(state, 'profile.update', { childName }), /孩子名字/);
  }
});

test('profile validation accepts JPEG PNG and WebP raster data URLs and preserves them through normalize', () => {
  for (const childAvatar of [PNG_AVATAR, JPEG_AVATAR, WEBP_AVATAR]) {
    const state = action(seed(), 'profile.update', { childName: '小禾', childAvatar });
    assert.equal(state.childAvatar, childAvatar);
    assert.equal(Model.normalize(state).childAvatar, childAvatar);
  }
});

test('profile validation rejects active formats, remote URLs, mismatched markers, bad base64 and oversize data', () => {
  const invalid = [
    null, 42, {}, ' ', 'https://example.test/photo.png',
    'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64'),
    'data:text/html;base64,' + Buffer.from('<p>not a photo</p>').toString('base64'),
    PNG_AVATAR.replace('image/png', 'image/jpeg'), JPEG_AVATAR.replace('image/jpeg', 'image/png'),
    PNG_AVATAR.replace(';base64,', ';charset=utf-8;base64,'), PNG_AVATAR + '\n', PNG_AVATAR + '\r\n',
    PNG_AVATAR.slice(0, -4), 'data:image/png;base64,AA=A', 'data:image/png;base64,abc',
    'data:image/png;base64,' + 'A'.repeat(160000)
  ];
  const webp = Buffer.from(WEBP_AVATAR.split(',')[1], 'base64');
  webp[4] = 0;
  invalid.push('data:image/webp;base64,' + webp.toString('base64'));
  for (const childAvatar of invalid) {
    assert.throws(() => action(seed(), 'profile.update', { childName: '小禾', childAvatar }), /头像|PNG|JPEG|WebP/);
  }
});

test('pet configuration validates kind and nickname while normalization preserves saved choices', () => {
  const state = action(seed(), 'pet.configure', { kind: 'capybara', name: '  暖暖  ' });
  assert.deepEqual(state.pet, { kind: 'capybara', name: '暖暖' });
  assert.deepEqual(Model.normalize(state).pet, state.pet);
  for (const values of [{ kind: 'cat', name: '猫咪' }, { kind: 'plant', name: '' },
    { kind: 'plant', name: 'a'.repeat(41) }, { kind: 'plant', name: 7 }]) {
    assert.throws(() => action(state, 'pet.configure', values), /伙伴/);
  }
  const bad = seed();
  bad.pet = { kind: 'cat', name: '猫咪' };
  assert.throws(() => Model.normalize(bad), /伙伴/);
  delete bad.pet;
  bad.childAvatar = 'data:image/svg+xml;base64,AA==';
  assert.throws(() => Model.normalize(bad), /头像/);
});

function withUsage(records = []) {
  const state = seed();
  state.redemptions = [];
  state.points = records.map((record, index) => Object.assign({
    id: 'usage-' + index, itemId: '', name: '历史行为名称', points: 1,
    reason: '真实完成并确认', at: NOW.toISOString()
  }, record));
  return state;
}
const frequentIds = (state, now = NOW) => Model.frequentPointItems(state, now).map(item => item.id);
const usageAt = milliseconds => new Date(milliseconds).toISOString();

test('frequent items rank by committed entry count rather than point value or recency first', () => {
  const now = NOW.getTime();
  const state = withUsage([
    { itemId: 'point-reading', points: 1000 },
    { itemId: 'point-focus', at: usageAt(now - 10), points: 1 },
    { itemId: 'point-focus', at: usageAt(now - 20), points: 1 },
    { itemId: 'point-tidy', at: usageAt(now - 30), points: 5 }
  ]);
  state.pointItems[0].points = 9999;
  assert.deepEqual(frequentIds(state), ['point-focus', 'point-reading', 'point-tidy', 'point-kindness']);
  assert.equal(Model.totals(state).earned, 1007);
});

test('equal counts use the latest timestamp across the ledger, then original configuration order', () => {
  const now = NOW.getTime();
  const state = withUsage([
    { itemId: 'point-tidy', at: usageAt(now - 5) },
    { itemId: 'point-reading', at: usageAt(now - 10) },
    { itemId: 'point-focus', at: usageAt(now - 5) },
    { itemId: 'point-reading', at: usageAt(now - 30) },
    { itemId: 'point-focus', at: usageAt(now - 25) },
    { itemId: 'point-tidy', at: usageAt(now - 40) }
  ]);
  assert.deepEqual(frequentIds(state), ['point-focus', 'point-tidy', 'point-reading', 'point-kindness']);
  state.points.reverse();
  assert.deepEqual(frequentIds(state), ['point-focus', 'point-tidy', 'point-reading', 'point-kindness']);
});

test('no history preserves configuration order for zero, one and many enabled items', () => {
  for (const size of [0, 1, 4, 24]) {
    const state = withUsage();
    state.pointItems = Array.from({ length: size }, (_, index) => ({ id: 'item-' + index,
      name: '行为' + index, points: size - index + 1, reason: '', enabled: index !== 3 && index !== 20 }));
    const original = JSON.stringify(state);
    const expected = state.pointItems.filter(item => item.enabled);
    freeze(state);
    for (let count = 0; count < 5; count++) {
      const result = Model.frequentPointItems(state, NOW);
      assert.notEqual(result, state.pointItems);
      assert.deepEqual(result.map(item => item.id), expected.map(item => item.id));
      result.forEach((item, index) => assert.equal(item, expected[index]));
    }
    assert.equal(JSON.stringify(state), original);
  }
  const disabled = withUsage();
  disabled.pointItems.forEach(item => { item.enabled = false; });
  assert.deepEqual(frequentIds(disabled), []);
});

test('frequency belongs to itemId and excludes custom names, missing IDs and removed templates', () => {
  const state = withUsage([
    { itemId: 'point-tidy', name: '过去的名称' },
    { itemId: '', name: '关心家人', points: 100 },
    { itemId: undefined, name: '关心家人' },
    { itemId: null, name: '关心家人' },
    { itemId: 'removed-template', name: '自主阅读', points: 500 },
    { itemId: 'removed-template', name: '自主阅读', points: 500 }
  ]);
  assert.deepEqual(frequentIds(state), ['point-tidy', 'point-reading', 'point-focus', 'point-kindness']);
});

test('renaming keeps the same historical usage and disabling excludes it without changing history', () => {
  const state = withUsage([
    { itemId: 'point-kindness', name: '关心家人' },
    { itemId: 'point-kindness', name: '关心家人' },
    { itemId: 'point-reading', name: '自主阅读' }
  ]);
  const ledger = JSON.stringify(state.points);
  const renamed = action(state, 'pointItem.save', { item: { id: 'point-kindness', name: '家人的好帮手', points: 100 } });
  assert.equal(Model.frequentPointItems(renamed, NOW)[0].name, '家人的好帮手');
  assert.deepEqual(frequentIds(renamed), ['point-kindness', 'point-reading', 'point-focus', 'point-tidy']);
  const disabled = action(renamed, 'pointItem.save', { item: { id: 'point-kindness', enabled: false } });
  assert.deepEqual(frequentIds(disabled), ['point-reading', 'point-focus', 'point-tidy']);
  const restored = action(disabled, 'pointItem.save', { item: { id: 'point-kindness', enabled: true } });
  assert.equal(frequentIds(restored)[0], 'point-kindness');
  assert.equal(JSON.stringify(restored.points), ledger);
});

test('the rolling 30-day window includes both exact endpoints and excludes one millisecond outside', () => {
  const now = NOW.getTime();
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  const state = withUsage([
    { itemId: 'point-reading', at: usageAt(cutoff - 1) },
    { itemId: 'point-reading', at: usageAt(cutoff - 1) },
    { itemId: 'point-focus', at: usageAt(now + 1) },
    { itemId: 'point-focus', at: usageAt(now + 1) },
    { itemId: 'point-tidy', at: usageAt(cutoff) },
    { itemId: 'point-kindness', at: usageAt(now) }
  ]);
  assert.deepEqual(frequentIds(state), ['point-kindness', 'point-tidy', 'point-reading', 'point-focus']);
  assert.deepEqual(frequentIds(state, now), frequentIds(state, NOW.toISOString()));
  const offsets = withUsage([
    { itemId: 'point-kindness', at: '2026-02-18T11:00:00-05:00' },
    { itemId: 'point-tidy', at: '2026-02-18T10:59:59.999-05:00' },
    { itemId: 'point-focus', at: '2026-03-20T12:00:00-04:00' },
    { itemId: 'point-reading', at: '2026-03-20T12:00:00.001-04:00' }
  ]);
  assert.deepEqual(frequentIds(offsets, '2026-03-20T12:00:00-04:00'),
    ['point-focus', 'point-kindness', 'point-reading', 'point-tidy']);
});

test('discarded previews and invalid drafts do not count, and an idempotent successful credit counts once', () => {
  const state = withUsage();
  const original = JSON.stringify(state);
  const originalOrder = ['point-reading', 'point-focus', 'point-tidy', 'point-kindness'];
  const draft = { id: 'preview-only', type: 'points.add', itemId: 'point-kindness', reason: '主动帮助家人' };
  const preview = Model.apply(state, draft, NOW);
  assert.equal(preview.points.length, 1);
  // The candidate is discarded; the confirmed state remains the source of usage.
  assert.deepEqual(frequentIds(state), originalOrder);
  assert.throws(() => Model.apply(state, Object.assign({}, draft, { id: 'invalid-preview', points: 0, reason: '' }), NOW), /正整数/);
  assert.deepEqual(frequentIds(state), originalOrder);
  assert.equal(JSON.stringify(state), original);
  const acceptedAction = Object.assign({}, draft, { id: 'accepted-once' });
  const accepted = Model.apply(state, acceptedAction, NOW);
  const retried = Model.apply(accepted, acceptedAction, NOW);
  assert.equal(retried, accepted);
  assert.equal(retried.points.length, 1);
  assert.deepEqual(frequentIds(retried), ['point-kindness', 'point-reading', 'point-focus', 'point-tidy']);
});

test('ranking is read-only and recomputes the supplied window without mutable counters or cache', () => {
  const state = withUsage([{ itemId: 'point-kindness' }]);
  const original = JSON.stringify(state);
  freeze(state);
  const supplied = new Date(NOW.getTime());
  const first = Model.frequentPointItems(state, supplied);
  assert.equal(first[0], state.pointItems[3]);
  assert.equal(supplied.getTime(), NOW.getTime());
  first.reverse();
  const later = new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000);
  assert.deepEqual(frequentIds(state, later), ['point-reading', 'point-focus', 'point-tidy', 'point-kindness']);
  assert.deepEqual(frequentIds(state), ['point-kindness', 'point-reading', 'point-focus', 'point-tidy']);
  assert.equal(JSON.stringify(state), original);
  assert.throws(() => Model.frequentPointItems(state, new Date(NaN)), /日期时间/);
});

const careAction = (state, care, source = 'free', now = NOW) => action(state, 'pet.care', { care, source }, now);
const buyAction = (state, itemId, quantity = 1) => action(state, 'pet.buy', { itemId, quantity, expectedPoints: quantity * 3 });

test('legacy pet fields normalize without fictitious care or growth and expose an isolated catalog', () => {
  const legacy = seed();
  delete legacy.petPurchases; delete legacy.petCare; delete legacy.petScene;
  const snapshot = JSON.stringify(legacy);
  const normalized = Model.normalize(freeze(legacy));
  assert.deepEqual(normalized.petPurchases, []);
  assert.deepEqual(normalized.petCare, []);
  assert.equal(normalized.petScene, 'home');
  assert.equal(JSON.stringify(legacy), snapshot);
  assert.deepEqual(Model.totals(normalized), { earned: 128, spent: 40, available: 88 });
  const status = Model.petStatus(legacy, '2026-11-14');
  assert.deepEqual(status.catalog, [
    { id: 'snack', name: '能量果', care: 'feed', points: 3 },
    { id: 'dew', name: '星露瓶', care: 'wash', points: 3 },
    { id: 'ball', name: '训练球', care: 'train', points: 3 }
  ]);
  assert.deepEqual(status.inventory, { snack: 0, dew: 0, ball: 0 });
  assert.equal(status.familyDay, '2026-11-14');
  assert.equal(status.freeRemaining, 3);
  assert.equal(status.exploration, 0);
  assert.deepEqual(status.unlockedScenes, ['home']);
  assert.deepEqual(status.nextUnlock, { id: 'forest', name: '微光森林', threshold: 4, remaining: 4 });
  status.catalog[0].points = 0; status.inventory.snack = 999; status.scenes[1].unlocked = true;
  assert.equal(Model.petStatus(normalized, NOW).catalog[0].points, 3);
  assert.equal(Model.petStatus(normalized, NOW).inventory.snack, 0);
});

test('three distinct free cares unlock the first scene once and restore quota only on a new family day', () => {
  let state = seed();
  const growth = Model.growth(state);
  for (const care of ['train', 'feed', 'wash']) { state = careAction(state, care); }
  const status = Model.petStatus(state, NOW);
  assert.equal(status.freeUsed, 3);
  assert.equal(status.freeRemaining, 0);
  assert.deepEqual(status.caredToday, ['feed', 'wash', 'train']);
  assert.equal(status.dailyBonusEarned, true);
  assert.equal(status.exploration, 4);
  assert.deepEqual(status.unlockedScenes, ['home', 'forest']);
  assert.equal(status.sceneId, 'forest');
  state = action(state, 'pet.scene', { sceneId: 'home' });
  assert.throws(() => careAction(state, 'feed'), /免费照料已用完/);
  const switched = action(state, 'pet.configure', { kind: 'capybara', name: '探员' });
  assert.equal(Model.petStatus(Model.normalize(switched), NOW).freeRemaining, 0);
  assert.deepEqual(Model.totals(switched), { earned: 128, spent: 40, available: 88 });
  assert.equal(Model.growth(switched).xp, growth.xp);
  const tomorrow = new Date(2026, 10, 15, 0, 0, 0);
  const afterMidnight = Model.petStatus(state, tomorrow);
  assert.equal(afterMidnight.freeRemaining, 3);
  assert.deepEqual(afterMidnight.caredToday, []);
  assert.equal(afterMidnight.dailyBonusEarned, false);
  assert.equal(afterMidnight.exploration, 4);
  state = careAction(state, 'feed', 'free', tomorrow);
  assert.equal(state.petCare[3].day, '2026-11-15');
  assert.equal(Model.petStatus(state, '2026-11-15').freeRemaining, 2);
  assert.equal(Model.petStatus(state, '2026-11-15').sceneId, 'home');
  // A server date key stays authoritative regardless of a viewer's own instant/time zone.
  assert.equal(Model.petStatus(state, '2026-11-14').freeRemaining, 0);
  assert.equal(Model.petStatus(state, '2026-11-16').freeRemaining, 3);
  assert.throws(() => Model.petStatus(state, '2026-13-01'), /日期/);
});

test('purchases spend the fixed total price, share the gift balance and never buy growth or exploration', () => {
  const initial = atGrowth(6);
  const state = buyAction(freeze(initial), 'snack', 2);
  assert.deepEqual(Model.totals(state), { earned: 6, spent: 6, available: 0 });
  assert.deepEqual(Model.growth(state), Model.growth(initial));
  assert.equal(Model.petStatus(state, NOW).exploration, 0);
  assert.equal(Model.petStatus(state, NOW).inventory.snack, 2);
  assert.deepEqual(state.petPurchases[0], { id: 'purchase-action-1', itemId: 'snack', name: '能量果', quantity: 2, unitPoints: 3, points: 6, at: NOW.toISOString() });
  assert.equal(Model.availability(state, 'reward-pencil', NOW).allowed, false);
  assert.throws(() => buyAction(state, 'dew'), /积分不足/);
  const larger = buyAction(seed(), 'ball', 10);
  assert.deepEqual(Model.totals(larger), { earned: 128, spent: 70, available: 58 });
  for (const quantity of [0, 11, -1, 1.5, '2', NaN, Infinity]) {
    assert.throws(() => action(seed(), 'pet.buy', { itemId: 'snack', quantity, expectedPoints: 3 }), /数量/);
  }
  for (const expectedPoints of [0, 2, 6, '3']) {
    assert.throws(() => action(seed(), 'pet.buy', { itemId: 'snack', quantity: 1, expectedPoints }), /分值|总价/);
  }
  assert.throws(() => buyAction(seed(), 'unknown'), /道具/);
});

test('historical purchase prices remain readable while new buys require the current fixed price', () => {
  const old = seed();
  old.petPurchases.push({ id: 'old-sale', itemId: 'snack', name: '旧名称果子', quantity: 2, unitPoints: 2, points: 4, at: NOW.toISOString() });
  const normalized = Model.normalize(freeze(old));
  assert.deepEqual(normalized.petPurchases, old.petPurchases);
  assert.deepEqual(Model.totals(normalized), { earned: 128, spent: 44, available: 84 });
  assert.equal(Model.petStatus(normalized, NOW).inventory.snack, 2);
  assert.throws(() => action(normalized, 'pet.buy', { itemId: 'snack', quantity: 2, expectedPoints: 4 }), /总价/);
  const next = buyAction(normalized, 'snack', 2);
  assert.equal(next.petPurchases[1].unitPoints, 3);
  assert.equal(next.petPurchases[1].points, 6);
  const overflow = seed();
  overflow.petPurchases.push({ id: 'overflow-price', itemId: 'snack', name: '错误', quantity: 2, unitPoints: Number.MAX_SAFE_INTEGER, points: Number.MAX_SAFE_INTEGER, at: NOW.toISOString() });
  assert.throws(() => Model.normalize(overflow), /购买总价/);
});

test('pending gifts reserve no balance and both kinds of spending recheck the same remaining points', () => {
  let requested = action(seed(), 'redemption.request', { rewardId: 'reward-burger' });
  assert.equal(Model.totals(requested).available, 88);
  requested = buyAction(requested, 'snack', 10);
  const original = JSON.stringify(requested);
  assert.throws(() => action(freeze(requested), 'redemption.approve', { requestId: requested.requests[0].id, expectedPoints: 60 }), /还差 2 分/);
  assert.equal(JSON.stringify(requested), original);
  assert.equal(requested.requests[0].status, 'pending');
  assert.deepEqual(Model.totals(requested), { earned: 128, spent: 70, available: 58 });
  let gifted = action(seed(), 'reward.redeem', { rewardId: 'reward-burger', expectedPoints: 60 });
  assert.equal(Model.totals(gifted).available, 28);
  assert.throws(() => buyAction(gifted, 'snack', 10), /积分不足/);
  gifted = buyAction(gifted, 'snack', 9);
  assert.deepEqual(Model.totals(gifted), { earned: 128, spent: 127, available: 1 });
  assert.equal(Model.growth(gifted).xp, 128);
});

test('care consumes only its explicit source and repeated kinds cannot repeat a daily bonus', () => {
  let state = buyAction(seed(), 'snack', 2);
  state = careAction(state, 'feed', 'inventory');
  assert.equal(Model.petStatus(state, NOW).freeRemaining, 3);
  assert.equal(Model.petStatus(state, NOW).inventory.snack, 1);
  for (let i = 0; i < 3; i++) { state = careAction(state, 'feed'); }
  assert.equal(Model.petStatus(state, NOW).exploration, 4);
  assert.equal(Model.petStatus(state, NOW).dailyBonusEarned, false);
  assert.throws(() => careAction(state, 'feed'), /免费/);
  state = buyAction(buyAction(state, 'dew', 1), 'ball', 2);
  state = careAction(state, 'train', 'inventory');
  state = careAction(state, 'wash', 'inventory');
  assert.equal(Model.petStatus(state, NOW).exploration, 7);
  assert.equal(Model.petStatus(state, NOW).dailyBonusEarned, true);
  state = careAction(state, 'train', 'inventory');
  assert.equal(Model.petStatus(state, NOW).exploration, 8);
  assert.deepEqual(Model.petStatus(state, NOW).inventory, { snack: 1, dew: 0, ball: 0 });
  assert.equal(Model.totals(state).spent, 55);
  assert.equal(Model.growth(state).xp, 128);
  const empty = seed();
  assert.throws(() => careAction(empty, 'wash', 'inventory'), /库存/);
  assert.equal(Model.petStatus(empty, NOW).freeRemaining, 3);
});

test('exploration deterministically unlocks all six scenes and keeps them across dates and pet changes', () => {
  let state = seed();
  let exploration = 0;
  const thresholds = [0, 4, 10, 18, 28, 40, 56];
  const ids = ['home', 'forest', 'cave', 'cloud', 'camp', 'harbor', 'aurora'];
  assert.throws(() => action(state, 'pet.scene', { sceneId: 'forest' }), /解锁/);
  for (let day = 0; day < 14; day++) {
    const now = new Date(2026, 10, 14 + day, 12);
    for (const [index, care] of ['feed', 'wash', 'train'].entries()) {
      state = careAction(state, care, 'free', now);
      exploration += index === 2 ? 2 : 1;
      const status = Model.petStatus(state, now);
      assert.equal(status.exploration, exploration);
      assert.deepEqual(status.unlockedScenes, ids.filter((id, i) => thresholds[i] <= exploration));
      assert.equal(status.sceneId, status.unlockedScenes[status.unlockedScenes.length - 1]);
    }
  }
  assert.equal(exploration, 56);
  assert.equal(Model.petStatus(state, NOW).nextUnlock, null);
  state = action(state, 'pet.scene', { sceneId: 'aurora' });
  state = action(state, 'pet.configure', { kind: 'capybara', name: '新的伙伴' });
  assert.equal(Model.petStatus(Model.normalize(state), '2027-01-01').sceneId, 'aurora');
  assert.equal(Model.petStatus(state, NOW).exploration, 56);
  state = action(state, 'pet.scene', { sceneId: 'home' });
  assert.deepEqual(Model.petStatus(state, NOW).unlockedScenes, ids);
  assert.equal(Model.growth(state).xp, 128);
});

test('resource actions reject client dates, counters, unknown sources and extra purchase fields', () => {
  const state = freeze(seed());
  for (const key of ['at', 'day', 'date', 'now', 'freeRemaining', 'inventory', 'exploration', 'points']) {
    assert.throws(() => action(state, 'pet.care', { care: 'feed', source: 'free', [key]: '2020-01-01' }), /客户端字段/);
  }
  for (const source of [undefined, '', 'auto', 'paid', null]) {
    assert.throws(() => action(state, 'pet.care', { care: 'feed', source }), /来源/);
  }
  assert.throws(() => careAction(state, 'pet'), /种类/);
  assert.throws(() => action(state, 'pet.buy', { itemId: 'snack', quantity: 1, expectedPoints: 3, unitPoints: 0 }), /客户端字段/);
  assert.throws(() => action(state, 'pet.scene', { sceneId: 'home', exploration: 56 }), /客户端字段/);
  assert.equal(state.petCare.length, 0);
});

test('malformed persisted care, inventory, spending and locked scenes fail without normalization repairs', () => {
  let state = seed();
  for (let i = 0; i < 3; i++) { state = careAction(state, 'feed'); }
  const excess = JSON.parse(JSON.stringify(state));
  excess.petCare.push(Object.assign({}, excess.petCare[0], { id: 'extra-care' }));
  assert.throws(() => Model.normalize(excess), /超过3次/);
  const missing = seed();
  missing.petCare.push({ id: 'missing-stock', care: 'feed', source: 'inventory', itemId: 'snack', day: '2026-11-14', at: NOW.toISOString() });
  assert.throws(() => Model.totals(missing), /库存/);
  const badPrice = buyAction(seed(), 'snack');
  badPrice.petPurchases[0].points = 1;
  assert.throws(() => Model.normalize(badPrice), /购买分值/);
  const locked = seed(); locked.petScene = 'aurora';
  assert.throws(() => Model.normalize(locked), /解锁/);
  const wrongItem = careAction(seed(), 'feed'); wrongItem.petCare[0].itemId = 'snack';
  assert.throws(() => Model.normalize(wrongItem), /照料道具/);
});

test('one custom credit atomically creates a deterministic template without overwriting an equal name', () => {
  const state = freeze(withUsage());
  const originalTemplate = JSON.stringify(state.pointItems[0]);
  const command = { id: 'save-custom', type: 'points.add', name: '自主阅读', points: 6, reason: '独立读完一章', saveAsTemplate: true };
  const next = Model.apply(state, command, NOW);
  assert.equal(next.pointItems.length, state.pointItems.length + 1);
  assert.equal(next.points.length, 1);
  assert.deepEqual(next.pointItems[4], { id: 'item-save-custom', name: '自主阅读', points: 6, reason: '独立读完一章', enabled: true });
  assert.equal(next.points[0].itemId, 'item-save-custom');
  assert.equal(JSON.stringify(next.pointItems[0]), originalTemplate);
  assert.equal(frequentIds(next)[0], 'item-save-custom');
  assert.equal(Model.apply(next, command, NOW), next);
  const second = action(next, 'points.add', { itemId: 'item-save-custom', points: 9, reason: '又完成一章' });
  assert.equal(second.pointItems[4].points, 6);
  assert.equal(second.pointItems[4].reason, '独立读完一章');
  assert.equal(second.points[1].points, 9);
});

test('custom credits may atomically save a reusable template with no reason', () => {
  const state = freeze(withUsage());
  for (const optional of [{}, { reason: null }, { reason: ' \t\n ' }]) {
    const command = Object.assign({ id: 'optional-template', type: 'points.add', name: '整理文具', points: 6, saveAsTemplate: true }, optional);
    const next = Model.apply(state, command, NOW);
    assert.equal(next.points.length, 1);
    assert.equal(next.points[0].reason, '');
    assert.equal(next.points[0].itemId, 'item-optional-template');
    assert.deepEqual(next.pointItems[next.pointItems.length - 1], {
      id: 'item-optional-template', name: '整理文具', points: 6, reason: '', enabled: true
    });
    const reloaded = Model.normalize(JSON.parse(JSON.stringify(next)));
    assert.deepEqual(reloaded, next);
    assert.equal(Model.apply(reloaded, command, NOW), reloaded);
    const reused = action(reloaded, 'points.add', { itemId: 'item-optional-template' });
    assert.equal(reused.points[1].reason, '');
    assert.deepEqual(Model.totals(reused), { earned: 12, spent: 0, available: 12 });
  }
  assert.equal(state.points.length, 0);
  assert.equal(state.pointItems.length, 4);
});

test('invalid or colliding atomic-template credits leave neither a template nor a ledger entry', () => {
  const initial = freeze(seed());
  const original = JSON.stringify(initial);
  const command = { id: 'bad-template', type: 'points.add', name: '测试', points: 5, reason: '测试原因', saveAsTemplate: true };
  for (const patch of [{ itemId: 'point-reading' }, { reason: {} }, { points: 0 }, { saveAsTemplate: 'true' }]) {
    assert.throws(() => Model.apply(initial, Object.assign({}, command, patch), NOW));
    assert.equal(JSON.stringify(initial), original);
  }
  const colliding = seed();
  colliding.pointItems.push({ id: 'item-bad-template', name: '不可覆盖', points: 4, reason: '', enabled: true });
  const old = JSON.stringify(colliding);
  assert.throws(() => Model.apply(colliding, command, NOW), /标识已存在/);
  assert.equal(JSON.stringify(colliding), old);
  const maximum = freeze(atGrowth(Number.MAX_SAFE_INTEGER));
  assert.throws(() => Model.apply(maximum, command, NOW), /整数/);
  assert.equal(maximum.pointItems.length, 4);
  assert.equal(maximum.points.length, 1);
  const ordinary = Model.apply(initial, Object.assign({}, command, { saveAsTemplate: false }), NOW);
  assert.equal(ordinary.pointItems.length, initial.pointItems.length);
  assert.equal(ordinary.points[ordinary.points.length - 1].itemId, '');
});




