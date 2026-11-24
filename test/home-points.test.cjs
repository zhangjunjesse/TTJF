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

test('same-minute awards show the latest successful entry on home and in seven-day detail', () => {
  const at = M.calendarTimestamp('2026-11-21', '00:04', zone);
  let state = empty();
  for (let index = 1; index <= 4; index += 1) {
    state = M.apply(state, {
      id: 'same-minute-' + index, type: 'points.add', name: '第' + index + '次鼓励', points: index, at
    }, new Date(new Date(now).getTime() + index * 1000), zone);
  }
  const before = JSON.stringify(state), summary = Home.analyze({ state, now, zone });
  assert.equal(state.points.length, 4);
  assert.deepEqual(summary.recent.map(row => row.name), ['第4次鼓励', '第3次鼓励', '第2次鼓励']);
  assert.deepEqual(summary.days[6].records.map(row => row.name), ['第4次鼓励', '第3次鼓励', '第2次鼓励', '第1次鼓励']);
  const html = Home.render({ state, summary }), detail = Home.summaryBody({ summary });
  assert.ok(!html.includes('第1次鼓励'), 'the three home entries include the latest award');
  for (const content of [html, detail]) {
    assert.ok(content.indexOf('第4次鼓励') < content.indexOf('第3次鼓励'));
    assert.ok(content.indexOf('第3次鼓励') < content.indexOf('第2次鼓励'));
  }
  assert.deepEqual([summary.earned, summary.count], [10, 4]);
  assert.equal(JSON.stringify(state), before);
});

test('equal-time awards, redemptions and purchases follow their saved domain action order', () => {
  const at = '2026-11-20T16:04:00.000Z';
  let state = M.apply(empty(), {
    id: 'prepare-gift', type: 'reward.save', reward: { id: 'test-gift', name: '彩虹铅笔', points: 2 }
  }, at, zone);
  for (let index = 1; index <= 4; index += 1) {
    state = M.apply(state, { id: 'mixed-award-' + index, type: 'points.add', name: '连续鼓励' + index, points: 10, at }, at, zone);
  }
  state = M.apply(state, { id: 'mixed-gift', type: 'reward.redeem', rewardId: 'test-gift' }, at, zone);
  state = M.apply(state, { id: 'mixed-supply', type: 'pet.buy', itemId: 'snack', quantity: 1, expectedPoints: 3 }, at, zone);
  let summary = Home.analyze({ state, now, zone });
  assert.deepEqual(summary.recent.map(row => row.id), ['purchase-mixed-supply', 'redeem-mixed-gift', 'points-mixed-award-4']);
  assert.deepEqual(summary.recent.map(row => row.kind), ['purchase', 'redemption', 'points']);
  assert.deepEqual(summary.recent.map(row => row.positive), [false, false, true]);
  assert.deepEqual([summary.earned, summary.count, summary.totals.available], [40, 4, 35]);

  state = M.apply(state, { id: 'mixed-final', type: 'points.add', name: '最后鼓励', points: 3, at }, at, zone);
  const before = JSON.stringify(state);
  summary = Home.analyze({ state, now, zone });
  assert.deepEqual(summary.recent.map(row => row.id), ['points-mixed-final', 'purchase-mixed-supply', 'redeem-mixed-gift']);
  assert.equal(summary.days[6].records[0].id, 'points-mixed-final');
  assert.equal(JSON.stringify(state), before);
});

test('actual recorded time takes priority over action order even within one displayed minute', () => {
  let state = empty();
  const records = [
    ['later-time', '2026-11-20T16:04:50.000Z'],
    ['earlier-time', '2026-11-20T16:04:10.000Z'],
    ['earlier-tie', '2026-11-20T16:04:10.000Z']
  ];
  for (const [id, at] of records) {
    state = M.apply(state, { id, type: 'points.add', name: id, points: 2, at }, now, zone);
  }
  const summary = Home.analyze({ state, now, zone });
  const expected = ['points-later-time', 'points-earlier-tie', 'points-earlier-time'];
  assert.deepEqual(summary.recent.map(row => row.id), expected);
  assert.deepEqual(summary.days[6].records.map(row => row.id), expected);
  assert.deepEqual(summary.recent.map(row => row.timeLabel), Array(3).fill('今天 00:04'));
});

test('legacy equal-time records use reverse ledger order and stable category priority', () => {
  const state = empty(), at = '2026-11-20T16:04:00.000Z';
  state.points = [point('zz-old-award', at, 10), point('aa-new-award', at, 10)];
  state.redemptions = [redemption('zz-old-gift', at), redemption('aa-new-gift', at)];
  state.petPurchases = ['zz-old-supply', 'aa-new-supply'].map(id => ({
    id, at, itemId: 'snack', name: '小零食', quantity: 1, unitPoints: 2, points: 2
  }));
  const before = JSON.stringify(state), summary = Home.analyze({ state, now, zone });
  assert.deepEqual(summary.recent.map(row => row.id), ['aa-new-award', 'zz-old-award', 'aa-new-gift']);
  assert.deepEqual(summary.days[6].records.map(row => row.id), ['aa-new-award', 'zz-old-award']);
  assert.equal(JSON.stringify(state), before);
  const funding = [point('historical-funding', '2026-11-01T08:00:00.000Z', 20)];
  const spending = Home.analyze({ state: { ...state, points: funding }, now, zone });
  assert.deepEqual(spending.recent.map(row => row.id), ['aa-new-gift', 'zz-old-gift', 'aa-new-supply']);
  const supplies = Home.analyze({ state: { ...state, points: funding, redemptions: [] }, now, zone });
  assert.deepEqual(supplies.recent.map(row => row.id), ['aa-new-supply', 'zz-old-supply', 'historical-funding']);
});

test('partially recorded action history has a consistent order without inventing legacy chronology', () => {
  const state = empty(), at = '2026-11-20T16:04:00.000Z';
  state.points = [point('points-logged-first', at, 10), point('points-unlogged', at, 10)];
  state.redemptions = [redemption('redeem-logged-last', at), redemption('legacy-gift', at)];
  state.appliedActions = ['logged-first', 'logged-last'];
  const before = JSON.stringify(state), summary = Home.analyze({ state, now, zone });
  assert.deepEqual(summary.recent.map(row => row.id), ['redeem-logged-last', 'points-logged-first', 'points-unlogged']);
  assert.deepEqual(summary.days[6].records.map(row => row.id), ['points-logged-first', 'points-unlogged']);
  assert.equal(JSON.stringify(state), before);
  state.points.push(point('legacy-later-time', '2026-11-20T16:04:01.000Z', 1));
  assert.equal(Home.analyze({ state, now, zone }).recent[0].id, 'legacy-later-time');
});

test('behavior summaries use the latest equal-time saved name and reason after a template is deleted', () => {
  const at = '2026-11-20T16:04:00.000Z';
  let state = M.apply(empty(), { id: 'prepare-reading', type: 'pointItem.save', item: { id: 'reading', name: '阅读', points: 5 } }, at, zone);
  state = M.apply(state, { id: 'reading-first', type: 'points.add', itemId: 'reading', name: '最初名称', reason: '最初原因', at }, at, zone);
  state = M.apply(state, { id: 'reading-last', type: 'points.add', itemId: 'reading', name: '最近名称', reason: '最近原因', at }, at, zone);
  state = M.apply(state, { id: 'remove-reading', type: 'pointItem.delete', itemId: 'reading' }, at, zone);
  for (const candidate of [state, { ...state, appliedActions: [] }]) {
    const before = JSON.stringify(candidate), summary = Home.analyze({ state: candidate, now, zone });
    assert.equal(summary.behaviors.length, 1);
    assert.equal(summary.behaviors[0].name, '最近名称');
    assert.equal(summary.behaviors[0].description, '最近原因');
    assert.deepEqual([summary.behaviors[0].count, summary.behaviors[0].points], [2, 10]);
    assert.equal(JSON.stringify(candidate), before);
  }
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
  assert.match(detail, /<details class="points-summary-day" data-date="2026-11-21" open>/);
  assert.match(detail, /<time datetime="2026-11-20T16:01:00.000Z">00:01<\/time>/);
  assert.match(detail, /&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
  assert.match(html, /class="points-record-reason"/);
});

test('recent records group entries by family day and retain a full accessible timestamp after midnight', () => {
  const state = empty();
  state.points = [point('early', '2026-11-20T16:02:00.000Z', 1), point('late', '2026-11-20T16:03:00.000Z', 1)];
  const recentSection = () => Home.render({ state, summary: Home.analyze({ state, now, zone }) }).match(/<section class="points-recent[^]*?<\/section>/)[0];
  let html = recentSection();
  assert.equal((html.match(/>今天</g) || []).length, 1);
  assert.match(html, /aria-label="今天 00:02"/);
  state.points[0].at = '2026-11-20T15:59:00.000Z';
  html = recentSection();
  const groups = [...html.matchAll(/<h3[^>]*><time datetime="([^"]+)">([^<]+)<\/time><\/h3>\s*<ul[^>]*>([\s\S]*?)<\/ul>/g)];
  assert.deepEqual(groups.map(group => [group[1], group[2]]), [['2026-11-21', '今天'], ['2026-11-20', '昨天']]);
  assert.match(groups[0][3], /aria-label="今天 00:03">00:03<\/time>/);
  assert.match(groups[1][3], /aria-label="昨天 23:59">23:59<\/time>/);
  assert.equal((html.match(/>昨天</g) || []).length, 1);
});

test('recent entries keep the recorded reason, redemption type and signed amount next to the correct name', () => {
  const state = empty();
  state.points = [
    { ...point('bag', '2026-11-20T10:58:00Z', 3, '整理书包'), reason: '按明天的课表收好课本' },
    point('meal', '2026-11-20T16:03:00Z', 1, '好好吃饭')
  ];
  state.redemptions = [{ ...redemption('pencil', '2026-11-20T13:17:00Z'), note: '蓝色' }];
  const html = Home.render({ state, summary: Home.analyze({ state, now, zone }) });
  const rows = [...html.matchAll(/<li class="points-recent-row">([\s\S]*?)<\/li>/g)].map(match => match[1]);
  assert.equal(rows.length, 3);
  assert.match(rows[0], /好好吃饭[\s\S]*\+1<small>/);
  assert.doesNotMatch(rows[0], /points-record-reason/);
  assert.match(rows[1], /彩虹铅笔[\s\S]*礼品兑换 · 蓝色[\s\S]*−2<small>/);
  assert.match(rows[2], /18:58[\s\S]*整理书包[\s\S]*按明天的课表收好课本[\s\S]*\+3<small>/);
  assert.equal((html.match(/>昨天<\/time>/g) || []).length, 1);
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
