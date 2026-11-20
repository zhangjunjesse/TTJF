'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const M = require('../model.js');
const Home = require('../home-points.js');
const zone = 'Asia/Shanghai';
const now = '2026-11-20T16:05:00.000Z';
const empty = () => M.createEmptyFamily({ childName: '合成核对宝' }, now);
function point(id, at, points, name = '自主阅读', itemId = '') {
  return { id, at, points, name, itemId, reason: '' };
}
function item(id, name, points, reason = '') { return { id, name, points, reason, enabled: true }; }
function redemption(id, at, points = 2) {
  return { id, at, points, rewardId: 'reward-test', name: '彩虹铅笔', category: 'daily', note: '' };
}

test('seven-day summary counts Shanghai civil days across midnight and the start boundary', () => {
  const state = empty();
  state.points = [
    point('outside', '2026-11-14T15:59:59.999Z', 1),
    point('first', '2026-11-14T16:00:00.000Z', 2),
    point('yesterday', '2026-11-20T15:59:59.999Z', 3),
    point('today', '2026-11-20T16:00:00.000Z', 5)
  ];
  const summary = Home.analyze({ state, now, zone });
  assert.equal(summary.today, '2026-11-21');
  assert.equal(summary.from, '2026-11-15');
  assert.equal(summary.earned, 10);
  assert.equal(summary.count, 3);
  assert.equal(summary.activeDays, 3);
  assert.equal(summary.todayEarned, 5);
  assert.equal(summary.todayCount, 1);
  assert.deepEqual(summary.days.map(day => day.points), [2, 0, 0, 0, 0, 3, 5]);
  assert.equal(summary.days[6].records[0].id, 'today');
  assert.equal(summary.totals.earned, 11, 'historical balance includes the older record');
});

test('Shanghai day boundaries ignore the device zone and offline mode follows the device', () => {
  const script = `
    const assert = require('node:assert/strict');
    const M = require('./model.js');
    const Home = require('./home-points.js');
    const now = ${JSON.stringify(now)};
    const state = M.createEmptyFamily({childName:'合成日期宝'}, now);
    state.points = [${JSON.stringify(point('midnight', '2026-11-20T16:00:00.000Z', 7))}];
    const shanghai = Home.analyze({state,now,zone:'Asia/Shanghai'});
    assert.equal(shanghai.today,'2026-11-21');
    assert.equal(shanghai.todayEarned,7);
    assert.deepEqual(shanghai.days.map(day=>day.count),[0,0,0,0,0,0,1]);
    const local = Home.analyze({state,now});
    assert.equal(local.today,M.dateKey(now));
    assert.equal(local.todayEarned,7);
    assert.equal(local.days[6].key,M.dateKey(now));
  `;
  for (const timezone of ['Asia/Shanghai', 'America/Los_Angeles', 'UTC', 'Pacific/Apia']) {
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, TZ: timezone }, encoding: 'utf8', timeout: 15000
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, timezone + ': ' + result.stderr);
  }
});

test('same-name templates stay separate while repeated custom names count together', () => {
  const state = empty();
  state.pointItems = [item('reading-a', '阅读', 5, '读绘本'), item('reading-b', '阅读', 10, '读章节书')];
  state.points = [
    point('one', '2026-11-20T16:01:00.000Z', 5, '阅读', 'reading-a'),
    point('two', '2026-11-20T16:02:00.000Z', 6, '阅读', 'reading-a'),
    point('three', '2026-11-20T16:03:00.000Z', 10, '阅读', 'reading-b'),
    point('four', '2026-11-20T16:03:20.000Z', 3, '阅读'),
    point('five', '2026-11-20T16:04:00.000Z', 2, '阅读')
  ];
  const summary = Home.analyze({ state, now, zone });
  assert.equal(summary.behaviors.length, 3);
  const a = summary.behaviors.find(group => group.itemId === 'reading-a');
  const b = summary.behaviors.find(group => group.itemId === 'reading-b');
  const custom = summary.behaviors.find(group => !group.itemId);
  assert.deepEqual([a.count, a.points], [2, 11]);
  assert.deepEqual([b.count, b.points], [1, 10]);
  assert.deepEqual([custom.count, custom.points], [2, 5]);
  assert.match(a.description, /5.*读绘本/);
  assert.match(b.description, /10.*读章节书/);
  assert.equal(summary.behaviors.reduce((total, group) => total + group.count, 0), summary.count);
});

test('recent entries combine all ledger types and sort by recorded time without changing state', () => {
  const state = empty();
  state.points = [point('new', '2026-11-20T16:03:00.000Z', 10), point('old', '2026-11-19T08:00:00.000Z', 40)];
  state.redemptions = [redemption('gift', '2026-11-20T16:04:00.000Z')];
  state.petPurchases = [{ id: 'supply', at: '2026-11-20T16:02:00.000Z', itemId: 'snack', name: '小零食', quantity: 1, unitPoints: 2, points: 2 }];
  const before = JSON.stringify(state);
  const summary = Home.analyze({ state, now, zone });
  assert.deepEqual(summary.recent.map(row => row.id), ['gift', 'new', 'supply']);
  assert.deepEqual(summary.recent.map(row => row.positive), [false, true, false]);
  assert.deepEqual(summary.recent.map(row => row.kindLabel), ['礼品兑换', '加分', '道具购买']);
  assert.equal(summary.recent[0].timeLabel, '今天 00:04');
  assert.equal(summary.totals.available, 46);
  assert.equal(JSON.stringify(state), before);
});

test('spending today does not count as encouragement or create invented chart data', () => {
  const state = empty();
  state.points = [point('older', '2026-11-01T08:00:00.000Z', 20)];
  state.redemptions = [redemption('today', '2026-11-20T16:02:00.000Z')];
  const summary = Home.analyze({ state, now, zone });
  assert.equal(summary.count, 0);
  assert.equal(summary.todayEarned, 0);
  assert.equal(summary.todayCount, 0);
  assert.deepEqual(summary.days.map(day => [day.points, day.count]), Array.from({ length: 7 }, () => [0, 0]));
  assert.equal(summary.recent[0].kind, 'redemption');
  const html = Home.render({ state, summary });
  assert.equal((html.match(/style="height:0%"/g) || []).length, 7);
  assert.match(html, /今日获得/);
  assert.match(html, /0 次加分/);
});

test('home and detail render saved content as text and preserve action entrances', () => {
  const state = empty(), hostile = '<img src=x onerror=alert(1)>';
  state.pointItems = [item('safe-item', hostile, 5, '<script>alert(2)</script>')];
  state.points = [{ ...point('safe-record', '2026-11-20T16:01:00.000Z', 5, hostile, 'safe-item'), reason: '<script>alert(3)</script>' }];
  const summary = Home.analyze({ state, now, zone });
  const html = Home.render({ state, summary, items: state.pointItems, allCount: 1 });
  const detail = Home.summaryBody({ summary });
  for (const content of [html, detail]) {
    assert.ok(!content.includes('<img src=x'));
    assert.ok(!content.includes('<script>'));
    assert.match(content, /&lt;img src=x onerror=alert\(1\)&gt;/);
  }
  assert.match(html, /data-home-mode="points"/);
  for (const action of ['records', 'add-points', 'jump-rewards', 'choose-point', 'all-behaviors', 'home-week']) {
    assert.match(html, new RegExp('data-action="' + action + '"'));
  }
  assert.match(html, /data-testid="earned-points"/);
  assert.match(html, /data-testid="available-points"/);
  assert.match(detail, /data-testid="home-week-summary"/);
  assert.match(detail, /<details class="points-summary-day" open>/);
  assert.match(detail, /<time datetime="2026-11-20T16:01:00.000Z">00:01<\/time>/);
  assert.match(detail, /&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
  assert.match(html, /class="points-record-reason"/);
});

test('empty families have seven zero days and clear empty states', () => {
  const state = empty(), summary = Home.analyze({ state, now, zone });
  assert.deepEqual(summary.totals, { earned: 0, spent: 0, available: 0 });
  assert.equal(summary.recent.length, 0);
  assert.equal(summary.behaviors.length, 0);
  assert.equal(summary.days.length, 7);
  const html = Home.render({ state, summary });
  assert.match(html, /暂无积分记录/);
  assert.match(html, /添加一个值得鼓励的小习惯/);
  assert.match(Home.summaryBody({ summary }), /这 7 天暂无加分记录/);
});
