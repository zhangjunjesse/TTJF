/* A lightweight points home. Dates and balances follow the shared domain model. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./model.js'));
  else root.FamilyHomePoints = factory(root.FamilyModel);
}(typeof window !== 'undefined' ? window : this, function (M) {
  'use strict';

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function shortDate(key) { return Number(key.slice(5, 7)) + '.' + Number(key.slice(8, 10)); }
  function dateLabel(key) { return Number(key.slice(5, 7)) + '月' + Number(key.slice(8, 10)) + '日'; }
  function draw(options, name) { return options.icon ? options.icon(name) : ''; }
  function button(options, action, content, className, id, label) {
    if (options.button) return options.button(action, content, className, id, label);
    return '<button type="button" class="' + esc(className) + '" data-action="' + esc(action) + '"' + (id == null ? '' : ' data-id="' + esc(id) + '"') + (label ? ' aria-label="' + esc(label) + '"' : '') + '>' + content + '</button>';
  }
  function kindLabel(kind) { return { points: '加分', redemption: '礼品兑换', purchase: '道具购买' }[kind]; }

  function ledgerRecords(state) {
    var rows = [], actionIndexes = Object.create(null);
    state.appliedActions.forEach(function (id, index) { actionIndexes[id] = index; });
    [['points', state.points, 'points-'], ['redemption', state.redemptions, 'redeem-'], ['purchase', state.petPurchases || [], 'purchase-']].forEach(function (source, sourceOrder) {
      source[1].forEach(function (record, index) {
        var actionId = record.id.indexOf(source[2]) === 0 ? record.id.slice(source[2].length) : '';
        var actionIndex = actionIndexes[actionId];
        rows.push({ id: record.id, kind: source[0], itemId: record.itemId, name: record.name, reason: record.reason || record.note || '',
          points: record.points, at: record.at, timestamp: new Date(record.at).getTime(), order: index, sourceOrder: sourceOrder,
          actionIndex: actionIndex === undefined ? -1 : actionIndex,
          positive: source[0] === 'points', kindLabel: kindLabel(source[0]) });
      });
    });
    // Only equal recorded times use saved action order. Unmatched legacy rows follow
    // matched rows, then keep category priority and newest append within each ledger.
    // Category priority is a display fallback, not an inferred cross-ledger chronology.
    rows.sort(function (a, b) { return b.timestamp - a.timestamp || b.actionIndex - a.actionIndex || a.sourceOrder - b.sourceOrder || b.order - a.order; });
    return rows;
  }
  function groupBehaviors(records, pointItems) {
    var byKey = Object.create(null), names = Object.create(null), items = Object.create(null), groups = [];
    pointItems.forEach(function (item) { items[item.id] = item; });
    records.forEach(function (record) {
      // Separate templates stay separate even when their saved names match.
      var key = record.itemId ? 'item:' + record.itemId : 'custom:' + record.name;
      var at = new Date(record.at).getTime(), group = byKey[key];
      if (!group) {
        group = { key: key, itemId: record.itemId || '', name: record.name, count: 0, points: 0, latest: -Infinity, reason: '' };
        byKey[key] = group; groups.push(group);
      }
      group.count += 1; group.points += record.points;
      if (at > group.latest) { group.latest = at; group.name = record.name; group.reason = record.reason || ''; }
    });
    groups.sort(function (a, b) { return b.count - a.count || b.points - a.points || b.latest - a.latest || a.key.localeCompare(b.key); });
    groups.forEach(function (group) { names[group.name] = (names[group.name] || 0) + 1; });
    groups.forEach(function (group) {
      var item = items[group.itemId];
      group.source = group.itemId ? '常用行为' : '自定义加分';
      group.description = group.itemId && item ? item.reason : group.reason;
      if (names[group.name] > 1 && group.itemId) {
        group.description = (item ? '默认 +' + item.points + ' 分' : '原常用项') + (group.description ? ' · ' + group.description : '');
      } else if (item && !group.description) group.description = '默认 +' + item.points + ' 分';
    });
    return groups;
  }

  function analyze(options) {
    options = options || {};
    var state = options.state, zone = options.zone, now = options.now === undefined ? new Date() : options.now;
    var today = M.dateKey(options.today === undefined ? now : options.today, zone), totals = M.totals(state), ledger = ledgerRecords(state);
    var days = [], byDay = Object.create(null), records = [], earned = 0, count = 0, activeDays = 0;
    for (var i = -6; i <= 0; i += 1) {
      var key = M.addDays(today, i, zone), parts = M.calendarParts(key, zone);
      var day = { key: key, label: i === 0 ? '今天' : '周' + ['日', '一', '二', '三', '四', '五', '六'][parts.weekday],
        dateLabel: dateLabel(key), shortDate: shortDate(key), points: 0, count: 0, records: [] };
      days.push(day); byDay[key] = day;
    }
    var startAt = new Date(M.calendarTimestamp(days[0].key, '00:00', zone)).getTime();
    var endAt = new Date(M.calendarTimestamp(M.addDays(today, 1, zone), '00:00', zone)).getTime();
    // Daily detail and behavior metadata inherit the same newest-first ledger order.
    ledger.forEach(function (record) {
      if (record.kind !== 'points') return;
      var timestamp = record.timestamp;
      if (timestamp < startAt || timestamp >= endAt) return;
      var day = byDay[M.dateKey(record.at, zone)];
      if (!day) return;
      day.points += record.points; day.count += 1; earned += record.points; count += 1; records.push(record);
      day.records.push({ id: record.id, itemId: record.itemId, name: record.name, reason: record.reason, points: record.points, at: record.at, timestamp: timestamp });
    });
    days.forEach(function (day) {
      if (day.count) activeDays += 1;
    });
    return { today: today, zone: zone, from: days[0].key, to: today, rangeLabel: shortDate(days[0].key) + ' — ' + shortDate(today),
      totals: totals, earned: earned, count: count, activeDays: activeDays, todayEarned: days[6].points, todayCount: days[6].count,
      days: days, behaviors: groupBehaviors(records, state.pointItems), recent: ledger.slice(0, 3).map(function (row) {
        var parts = M.calendarParts(row.at, zone);
        row.day = parts.date;
        row.dayLabel = parts.date === today ? '今天' : parts.date === days[5].key ? '昨天' : dateLabel(parts.date);
        row.clock = parts.time;
        row.timeLabel = row.dayLabel + ' ' + row.clock;
        return row;
      }) };
  }
  function summaryFor(options) { return options.summary || analyze(options); }
  function amountClass(value) { return String(value).length > 7 ? ' points-amount-long' : ''; }

  function wallet(options, summary) {
    var total = summary.totals;
    var balances = '<span class="points-balance-row"><span>历史总积分</span><strong class="points-total" data-testid="earned-points">' + total.earned + '</strong></span>' +
      '<span class="points-balance-row points-available"><span>可兑换积分</span><strong data-testid="available-points">' + total.available + '</strong></span>';
    var label = '历史总积分' + total.earned + '，可兑换积分' + total.available + '，查看积分记录';
    var today = '<div class="points-today"><span class="points-today-label">今日获得</span><strong class="points-today-score' + amountClass(summary.todayEarned) + '"><span class="points-score-sign">+</span>' + summary.todayEarned + '<small>分</small></strong>' +
      '<span class="points-today-count">' + summary.todayCount + ' 次加分</span></div>';
    return '<section class="points-wallet points-paper" aria-label="积分操作"><div class="points-wallet-values">' + today +
      button(options, 'records', balances, 'points-balance-entry', '', label) + '</div><div class="points-main-actions">' +
      button(options, 'add-points', draw(options, 'plus') + '<span>加分</span>', 'btn primary points-add', '', '加分') +
      button(options, 'jump-rewards', draw(options, 'gift') + '<span>兑换礼品</span>', 'btn points-redeem', '', '礼品兑换') + '</div></section>';
  }
  function weekChart(summary) {
    var maximum = Math.max.apply(null, summary.days.map(function (day) { return day.points; }));
    return '<ol class="points-week-chart" aria-label="最近七天每天获得的积分">' + summary.days.map(function (day, i) {
      var height = maximum ? Math.round(day.points / maximum * 100) : 0;
      var dayLabel = day.label.startsWith('周') ? '<span class="points-day-prefix">周</span>' + day.label.slice(1) : day.label;
      var number = '<span class="points-day-number' + (String(day.points).length > 5 ? ' points-day-number-long' : '') + '">' + (day.points || '') + '</span>';
      var track = '<span class="points-day-track" aria-hidden="true">' + number + '<span class="points-day-bar" style="height:' + height + '%"></span></span>';
      return '<li class="' + (i === 6 ? 'is-today' : '') + '" aria-label="' + esc(day.dateLabel + '，获得' + day.points + '分，' + day.count + '次加分') + '">' + track + '<span class="points-day-label" aria-hidden="true">' + dayLabel + '</span></li>';
    }).join('') + '</ol>';
  }
  function overview(options, summary) {
    return '<section class="points-overview points-paper" aria-labelledby="points-week-heading"><div class="points-section-heading"><h2 id="points-week-heading">最近 7 天</h2><span class="points-week-range">' + esc(summary.rangeLabel) + '</span>' + button(options, 'home-week', draw(options, 'chevron'), 'text-button points-section-link', '', '查看最近七天积分小结') + '</div>' +
      '<div class="points-week-totals"><strong class="' + (String(summary.earned).length > 8 ? 'points-small-amount' : '') + '">+' + summary.earned + '<small> 分</small></strong><span>' + summary.count + ' 次加分</span></div>' + weekChart(summary) + '</section>';
  }
  function recentEntry(row) {
    var detail = row.positive ? row.reason : row.kindLabel + (row.reason ? ' · ' + row.reason : '');
    var amountClass = row.positive ? 'is-earned' : 'is-spent';
    if (String(row.points).length > 6) amountClass += ' points-small-amount';
    return '<li class="points-recent-row"><time class="points-record-time" datetime="' + esc(row.at) + '" aria-label="' + esc(row.timeLabel) + '">' + esc(row.clock) + '</time>' +
      '<div class="points-record-copy"><strong>' + esc(row.name) + '</strong>' + (detail ? '<span class="points-record-reason">' + esc(detail) + '</span>' : '') + '</div>' +
      '<b class="points-record-amount ' + amountClass + '">' + (row.positive ? '+' : '−') + row.points + '<small> 分</small></b></li>';
  }
  function recent(options, summary) {
    var days = [];
    summary.recent.forEach(function (row) {
      var day = days[days.length - 1];
      if (!day || day.key !== row.day) {
        day = { key: row.day, label: row.dayLabel, entries: [] };
        days.push(day);
      }
      day.entries.push(recentEntry(row));
    });
    var groups = days.map(function (day) {
      var headingId = 'points-record-day-' + esc(day.key);
      return '<div class="points-record-day' + (day.key === summary.today ? ' is-today' : '') + '"><h3 id="' + headingId + '"><time datetime="' + esc(day.key) + '">' + esc(day.label) + '</time></h3>' +
        '<ul class="points-recent-list" role="list" aria-labelledby="' + headingId + '">' + day.entries.join('') + '</ul></div>';
    });
    return '<section class="points-recent points-paper" aria-labelledby="points-recent-heading"><div class="points-section-heading"><h2 id="points-recent-heading">最近记录</h2>' +
      button(options, 'records', draw(options, 'chevron'), 'text-button points-section-link', '', '查看全部积分记录') + '</div>' +
      (days.length ? '<div class="points-record-days">' + groups.join('') + '</div>' : '<div class="points-records-empty"><p>暂无积分记录</p></div>') + '</section>';
  }
  function behavior(options, item) {
    return button(options, 'choose-point', '<span class="points-shortcut-symbol" aria-hidden="true">' + draw(options, 'star') + '</span><span class="behavior-copy"><b>' + esc(item.name) + '</b></span><strong>+' + item.points + '</strong>',
      'behavior-card points-home-behavior', item.id, item.name + '，加' + item.points + '分');
  }
  function behaviors(options) {
    var items = options.items || [], allCount = options.allCount === undefined ? items.length : options.allCount;
    return '<section class="points-behaviors points-paper" aria-labelledby="points-behaviors-heading"><div class="points-section-heading"><h2 id="points-behaviors-heading">快捷加分</h2>' + button(options, 'all-behaviors', (allCount > 1 ? allCount + ' 项 ' : '') + draw(options, 'chevron'), 'text-button points-section-link', '', '选择全部' + allCount + '个启用行为') + '</div><div class="points-behavior-grid">' + (items.length ? items.map(function (item) { return behavior(options, item); }).join('') : button(options, 'all-behaviors', '<span>' + draw(options, 'leaf') + '</span><b>添加一个值得鼓励的小习惯</b><small>保存常用行为，下次加分更方便</small>', 'points-behaviors-empty')) + '</div></section>';
  }
  function render(options) {
    var summary = summaryFor(options);
    return '<section class="points-home" data-home-mode="points" aria-label="积分首页"><h1 class="points-home-title">成长积分册</h1>' + wallet(options, summary) + behaviors(options) + recent(options, summary) + overview(options, summary) + '</section>';
  }
  function summaryBody(options) {
    var summary = summaryFor(options), expanded = false;
    var dailyRows = summary.days.slice().reverse().map(function (day) {
      var heading = '<span><b>' + esc(day.dateLabel) + '</b><small>' + day.label + '</small></span><span>' + day.count + '<small> 次</small></span><strong>+' + day.points + '<small> 分</small></strong>';
      if (!day.records.length) return '<div class="points-summary-day is-empty"><div class="points-day-summary">' + heading + '</div></div>';
      var open = !expanded; expanded = true;
      var rows = day.records.map(function (record) {
        return '<li><div><strong>' + esc(record.name) + '</strong>' + (record.reason ? '<p>' + esc(record.reason) + '</p>' : '') + '<time datetime="' + esc(record.at) + '">' + M.calendarParts(record.at, summary.zone).time + '</time></div><b class="' + (String(record.points).length > 8 ? 'points-small-amount' : '') + '">+' + record.points + '<small> 分</small></b></li>';
      }).join('');
      return '<details class="points-summary-day" data-date="' + esc(day.key) + '"' + (open ? ' open' : '') + '><summary class="points-day-summary">' + heading + draw(options, 'chevron') + '</summary><ol class="points-detail-records">' + rows + '</ol></details>';
    }).join('');
    var ranked = summary.behaviors.slice(0, 5).map(function (group, index) {
      return '<li><span class="points-summary-rank" aria-hidden="true">' + (index + 1) + '</span><div><strong>' + esc(group.name) + '</strong><small>' + esc(group.source + (group.description ? ' · ' + group.description : '')) + '</small></div><span><b>' + group.count + ' 次</b><small>+' + group.points + ' 分</small></span></li>';
    }).join('');
    return '<div class="points-week-detail" data-testid="home-week-summary"><p class="points-summary-range">' + esc(dateLabel(summary.from) + ' — ' + dateLabel(summary.to)) + '<span>含今天的最近 7 天</span></p><div class="points-summary-stats"><div><strong class="' + (String(summary.earned).length > 8 ? 'points-small-amount' : '') + '">+' + summary.earned + '</strong><span>获得积分</span></div><div><strong>' + summary.count + '</strong><span>加分次数</span></div><div><strong>' + summary.activeDays + '<small> / 7</small></strong><span>有加分的天数</span></div></div><section class="points-summary-section"><h3>每日加分明细</h3><div class="points-summary-days">' + dailyRows + '</div></section><section class="points-summary-section"><h3>常获鼓励的行为</h3>' + (ranked ? '<ol class="points-summary-behaviors">' + ranked + '</ol><p class="points-summary-explainer">按加分次数展示前 5 项；不同常用项分别统计，自定义加分按名称合并。</p>' : '<p class="points-summary-empty">这 7 天暂无加分记录</p>') + '</section><p class="points-summary-footnote">小结只统计加分，兑换礼品和购买道具请查看积分记录。</p>' + button(options, 'records', draw(options, 'list') + '<span>查看全部积分记录</span>', 'btn outline full points-summary-records') + '</div>';
  }

  return { analyze: analyze, render: render, summaryBody: summaryBody };
}));
