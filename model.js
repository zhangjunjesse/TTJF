/* Family dashboard domain model. ES5 syntax; no browser or server dependencies. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FamilyModel = factory();
  }
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var MAX_INTEGER = 9007199254740991;
  var own = Object.prototype.hasOwnProperty;
  var GROWTH_THRESHOLDS = [0, 30, 100, 250, 500];
  var STAGE_NAMES = {
    plant: ['晶卵初醒', '晶叶幼龙', '踏星小龙', '星翼飞龙', '星辉守护龙'],
    capybara: ['初见团团', '好奇学员', '星岛探员', '银河领航员', '星光守护者']
  };
  var CARE_KINDS = ['feed', 'wash', 'train'];
  var PET_CATALOG = [
    { id: 'snack', name: '能量果', care: 'feed', points: 3 },
    { id: 'dew', name: '星露瓶', care: 'wash', points: 3 },
    { id: 'ball', name: '训练球', care: 'train', points: 3 }
  ];
  var PET_SCENES = [
    { id: 'home', name: '起航基地', threshold: 0 },
    { id: 'forest', name: '微光森林', threshold: 4 },
    { id: 'cave', name: '晶石洞穴', threshold: 10 },
    { id: 'cloud', name: '云海浮岛', threshold: 18 },
    { id: 'camp', name: '流星营地', threshold: 28 },
    { id: 'harbor', name: '星环港湾', threshold: 40 },
    { id: 'aurora', name: '极光山巅', threshold: 56 }
  ];

  function fail(message) { throw new Error(message); }
  function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { fail(label + '格式无效'); }
    return value;
  }
  function text(value, label, required, max) {
    if (value === undefined || value === null) { value = ''; }
    if (typeof value !== 'string') { fail(label + '必须是文字'); }
    value = value.replace(/^\s+|\s+$/g, '');
    if (required && !value) { fail('请填写' + label); }
    if (value.length > (max || 2000)) { fail(label + '太长'); }
    return value;
  }
  function avatar(value) {
    if (value === '') { return ''; }
    if (typeof value !== 'string' || value.length > 160000) { fail('头像必须是160000字符以内的图片'); }
    var match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match || match[0].length !== value.length || match[2].length % 4 !== 0) { fail('头像仅支持有效的JPEG、PNG或WebP图片'); }
    var encoded = match[2];
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var padding = encoded.slice(-2) === '==' ? 2 : (encoded.slice(-1) === '=' ? 1 : 0);
    var length = encoded.length / 4 * 3 - padding;
    if ((padding === 2 && alphabet.indexOf(encoded.charAt(encoded.length - 3)) % 16 !== 0) ||
        (padding === 1 && alphabet.indexOf(encoded.charAt(encoded.length - 2)) % 4 !== 0)) { fail('头像编码无效'); }
    // Inspect format markers without requiring Buffer, atob, a canvas or a full
    // image decoder. The browser re-encodes the cropped photo before saving it.
    function byteAt(index) {
      var part = index % 3;
      var start = Math.floor(index / 3) * 4 + part;
      var left = alphabet.indexOf(encoded.charAt(start));
      var right = alphabet.indexOf(encoded.charAt(start + 1));
      return part === 0 ? left * 4 + Math.floor(right / 16) :
        (part === 1 ? (left % 16) * 16 + Math.floor(right / 4) : (left % 4) * 64 + right);
    }
    function matches(bytes, offset) {
      var i;
      for (i = 0; i < bytes.length; i += 1) { if (byteAt(offset + i) !== bytes[i]) { return false; } }
      return true;
    }
    function uint32(offset, little) {
      return little ? byteAt(offset) + byteAt(offset + 1) * 256 + byteAt(offset + 2) * 65536 + byteAt(offset + 3) * 16777216 :
        byteAt(offset) * 16777216 + byteAt(offset + 1) * 65536 + byteAt(offset + 2) * 256 + byteAt(offset + 3);
    }
    if (match[1] === 'png') {
      if (length < 45 || !matches([137, 80, 78, 71, 13, 10, 26, 10], 0) || uint32(8) !== 13 ||
          !matches([73, 72, 68, 82], 12) || uint32(16) < 1 || uint32(20) < 1 ||
          !matches([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130], length - 12)) { fail('PNG头像文件标识无效'); }
    } else if (match[1] === 'jpeg') {
      if (length < 16 || !matches([255, 216, 255], 0) || !matches([255, 217], length - 2)) { fail('JPEG头像文件标识无效'); }
    } else if (length < 20 || !matches([82, 73, 70, 70], 0) || uint32(4, true) + 8 !== length ||
        !matches([87, 69, 66, 80], 8) ||
        !(matches([86, 80, 56, 32], 12) || matches([86, 80, 56, 76], 12) || matches([86, 80, 56, 88], 12))) {
      fail('WebP头像文件标识无效');
    }
    return value;
  }
  function id(value, label) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value)) {
      fail((label || '标识') + '无效');
    }
    return value;
  }
  function optionalId(value, label) {
    return value === undefined || value === null || value === '' ? '' : id(value, label);
  }
  function integer(value, label, minimum, maximum) {
    if (typeof value !== 'number' || !isFinite(value) || Math.floor(value) !== value ||
        value < minimum || value > (maximum === undefined ? MAX_INTEGER : maximum)) {
      fail(label + (minimum === 1 ? '必须为正整数' : '必须为有效整数'));
    }
    return value;
  }
  function bool(value, label) {
    if (typeof value !== 'boolean') { fail(label + '必须为是或否'); }
    return value;
  }
  function member(value, values, label) {
    if (values.indexOf(value) < 0) { fail(label + '无效'); }
    return value;
  }
  function asDate(value) {
    var result;
    if (value === undefined) { result = new Date(); }
    else if (Object.prototype.toString.call(value) === '[object Date]') { result = new Date(value.getTime()); }
    else if (typeof value === 'number' || (typeof value === 'string' && value)) { result = new Date(value); }
    else { fail('日期时间无效'); }
    if (!isFinite(result.getTime())) { fail('日期时间无效'); }
    return result;
  }
  function pad(value) { return value < 10 ? '0' + value : String(value); }
  function parseKey(value) {
    var match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    var result;
    if (!match || +match[1] < 1) { fail('日期必须为有效的 YYYY-MM-DD'); }
    result = new Date(0);
    result.setHours(12, 0, 0, 0);
    result.setFullYear(+match[1], +match[2] - 1, +match[3]);
    if (result.getFullYear() !== +match[1] || result.getMonth() !== +match[2] - 1 || result.getDate() !== +match[3]) {
      fail('日期不存在');
    }
    return result;
  }
  function dateKey(value) {
    var date;
    var year;
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) { parseKey(value); return value; }
    date = asDate(value);
    year = date.getFullYear();
    if (year < 1 || year > 9999) { fail('日期年份超出范围'); }
    return ('0000' + year).slice(-4) + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }
  function addDays(value, days) {
    var date = parseKey(value);
    integer(days, '天数', -MAX_INTEGER);
    date.setDate(date.getDate() + days);
    return dateKey(date);
  }
  function timestamp(value) { return asDate(value).toISOString(); }
  function storedTimestamp(value) {
    if (typeof value !== 'string' || !value) { fail('记录时间无效'); }
    return timestamp(value);
  }
  function find(items, key) {
    var i;
    for (i = 0; i < items.length; i += 1) { if (items[i].id === key) { return items[i]; } }
    return null;
  }
  function field(input, previous, key, fallback) {
    if (own.call(input, key)) { return input[key]; }
    return previous ? previous[key] : fallback;
  }
  function time(value) {
    value = text(value, '时间', false, 5);
    if (value && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) { fail('时间必须为 HH:mm'); }
    return value;
  }
  function validateRows(rows, label, validate) {
    var seen = Object.create(null);
    var i;
    if (!Array.isArray(rows)) { fail(label + '格式无效'); }
    for (i = 0; i < rows.length; i += 1) {
      object(rows[i], label);
      id(rows[i].id, label + '标识');
      if (seen[rows[i].id]) { fail(label + '标识重复'); }
      seen[rows[i].id] = true;
      validate(rows[i]);
    }
  }
  function validState(state) {
    var seen;
    var i;
    object(state, '数据');
    if (state.version !== 1) { fail('不支持的数据版本'); }
    text(state.childName, '孩子名字', true, 40);
    if (state.childAvatar !== undefined) { avatar(state.childAvatar); }
    if (state.pet !== undefined) {
      object(state.pet, '伙伴配置');
      member(state.pet.kind, ['plant', 'capybara'], '伙伴种类');
      text(state.pet.name, '伙伴昵称', true, 40);
    }
    validateRows(state.tasks, '事项', function (row) {
      member(row.type, ['task', 'event'], '事项类型');
      text(row.title, '事项标题', true, 120);
      parseKey(row.date);
      time(row.time);
      text(row.note, '事项备注', false);
      bool(row.done, '完成状态');
      bool(row.deleted, '删除状态');
      storedTimestamp(row.createdAt);
      integer(row.remindDays, '提醒天数', 0);
      if (row.ackAt !== undefined && row.ackAt !== '') { storedTimestamp(row.ackAt); }
      if (row.snoozeUntil !== undefined && row.snoozeUntil !== '') { storedTimestamp(row.snoozeUntil); }
    });
    validateRows(state.pointItems, '加分项', function (row) {
      text(row.name, '加分项名称', true, 120);
      integer(row.points, '加分项分值', 1);
      text(row.reason, '预设原因', false);
      bool(row.enabled, '启用状态');
    });
    validateRows(state.rewards, '奖励', function (row) {
      text(row.name, '奖励名称', true, 120);
      integer(row.points, '兑换分值', 1);
      member(row.category, ['daily', 'weekend', 'outing'], '奖励类别');
      member(row.icon, ['pencil', 'burger', 'mountain'], '奖励图标');
      bool(row.enabled, '启用状态');
    });
    validateRows(state.points, '加分记录', function (row) {
      text(row.name, '加分名称', true, 120);
      integer(row.points, '加分分值', 1);
      text(row.reason, '加分原因', true);
      optionalId(row.itemId, '加分项标识');
      storedTimestamp(row.at);
    });
    validateRows(state.redemptions, '兑换记录', function (row) {
      id(row.rewardId, '奖励标识');
      text(row.name, '奖励名称', true, 120);
      integer(row.points, '兑换分值', 1);
      member(row.category, ['daily', 'weekend', 'outing'], '奖励类别');
      text(row.note, '兑换备注', false);
      storedTimestamp(row.at);
    });
    validateRows(state.petPurchases === undefined ? [] : state.petPurchases, '道具购买记录', function (row) {
      var item = find(PET_CATALOG, row.itemId);
      if (!item) { fail('购买道具不存在'); }
      text(row.name, '道具名称', true, 120);
      integer(row.quantity, '购买数量', 1, 10);
      integer(row.unitPoints, '历史道具单价', 1);
      integer(row.points, '购买分值', 1);
      var total = integer(row.quantity * row.unitPoints, '购买总价', 1);
      if (row.points !== total) { fail('购买分值记录无效'); }
      storedTimestamp(row.at);
    });
    validateRows(state.petCare === undefined ? [] : state.petCare, '照料记录', function (row) {
      var care = CARE_KINDS.indexOf(row.care);
      if (care < 0) { fail('照料种类无效'); }
      member(row.source, ['free', 'inventory'], '照料来源');
      if (row.itemId !== (row.source === 'inventory' ? PET_CATALOG[care].id : '')) { fail('照料道具记录无效'); }
      parseKey(row.day);
      storedTimestamp(row.at);
    });
    var resources = petResources(state);
    var scene = find(PET_SCENES, state.petScene === undefined ? 'home' : state.petScene);
    if (!scene || scene.threshold > resources.exploration) { fail('当前场景不存在或尚未解锁'); }
    var pending = 0;
    validateRows(state.requests === undefined ? [] : state.requests, '兑换申请', function (row) {
      id(row.rewardId, '奖励标识');
      if (!find(state.rewards, row.rewardId)) { fail('申请对应奖励不存在'); }
      text(row.name, '奖励名称', true, 120);
      integer(row.points, '申请分值', 1);
      member(row.category, ['daily', 'weekend', 'outing'], '奖励类别');
      member(row.status, ['pending', 'cancelled', 'approved'], '申请状态');
      storedTimestamp(row.createdAt);
      storedTimestamp(row.updatedAt);
      optionalId(row.redemptionId, '兑换记录标识');
      if (row.status === 'pending') { pending += 1; }
      if (row.status === 'approved') {
        var redemption = find(state.redemptions, row.redemptionId);
        if (!redemption || redemption.rewardId !== row.rewardId) { fail('申请缺少对应兑换记录'); }
      } else if (row.redemptionId) { fail('未批准的申请不能有兑换记录'); }
    });
    if (pending > 1) { fail('只能有一个待确认兑换申请'); }
    object(state.settings, '设置');
    integer(state.settings.monthEndDays, '月末天数', 1, 31);
    if (optionalId(state.settings.preferredReward, '心愿奖励')) {
      if (!find(state.rewards, state.settings.preferredReward)) { fail('心愿奖励不存在'); }
    }
    if (!Array.isArray(state.appliedActions)) { fail('动作记录格式无效'); }
    seen = Object.create(null);
    for (i = 0; i < state.appliedActions.length; i += 1) {
      id(state.appliedActions[i], '动作标识');
      if (seen[state.appliedActions[i]]) { fail('动作标识重复'); }
      seen[state.appliedActions[i]] = true;
    }
  }
  function totals(state) {
    var earned = 0;
    var spent = 0;
    var i;
    validState(state);
    for (i = 0; i < state.points.length; i += 1) {
      earned += state.points[i].points;
      integer(earned, '累计积分', 0);
    }
    for (i = 0; i < state.redemptions.length; i += 1) {
      spent += state.redemptions[i].points;
      integer(spent, '已兑换积分', 0);
    }
    for (i = 0; i < (state.petPurchases || []).length; i += 1) {
      spent += state.petPurchases[i].points;
      integer(spent, '已消费积分', 0);
    }
    if (spent > earned) { fail('剩余积分不能为负数'); }
    return { earned: earned, spent: spent, available: earned - spent };
  }
  function petResources(state) {
    var inventory = { snack: 0, dew: 0, ball: 0 };
    var days = Object.create(null);
    var exploration = (state.petCare || []).length;
    (state.petPurchases || []).forEach(function (row) { inventory[row.itemId] += row.quantity; });
    (state.petCare || []).forEach(function (row) {
      var day = days[row.day];
      if (!day) { day = { freeUsed: 0, kinds: Object.create(null) }; days[row.day] = day; }
      if (row.source === 'free') {
        day.freeUsed += 1;
        if (day.freeUsed > 3) { fail('每日免费照料记录超过3次'); }
      } else { inventory[row.itemId] -= 1; }
      day.kinds[row.care] = true;
    });
    Object.keys(inventory).forEach(function (key) { integer(inventory[key], '道具库存', 0); });
    Object.keys(days).forEach(function (key) {
      if (CARE_KINDS.every(function (care) { return !!days[key].kinds[care]; })) { exploration += 1; }
    });
    return { inventory: inventory, days: days, exploration: integer(exploration, '探索进度', 0) };
  }
  function petStatus(state, suppliedNow) {
    totals(state);
    var familyDay = dateKey(suppliedNow);
    var resources = petResources(state);
    var today = resources.days[familyDay] || { freeUsed: 0, kinds: Object.create(null) };
    var caredToday = CARE_KINDS.filter(function (care) { return !!today.kinds[care]; });
    var nextUnlock = null;
    var scenes = PET_SCENES.map(function (scene) {
      var unlocked = resources.exploration >= scene.threshold;
      if (!unlocked && !nextUnlock) {
        nextUnlock = { id: scene.id, name: scene.name, threshold: scene.threshold, remaining: scene.threshold - resources.exploration };
      }
      return { id: scene.id, name: scene.name, threshold: scene.threshold, unlocked: unlocked };
    });
    return { familyDay: familyDay,
      catalog: PET_CATALOG.map(function (item) { return { id: item.id, name: item.name, care: item.care, points: item.points }; }),
      inventory: resources.inventory, freeLimit: 3, freeUsed: today.freeUsed, freeRemaining: 3 - today.freeUsed,
      caredToday: caredToday, dailyBonusEarned: caredToday.length === 3, exploration: resources.exploration,
      scenes: scenes, unlockedScenes: scenes.filter(function (scene) { return scene.unlocked; }).map(function (scene) { return scene.id; }),
      nextUnlock: nextUnlock, sceneId: state.petScene === undefined ? 'home' : state.petScene };
  }
  function actionFields(action, allowed) {
    Object.keys(action).forEach(function (key) {
      if (key !== 'id' && key !== 'type' && allowed.indexOf(key) < 0) { fail('操作不接受客户端字段：' + key); }
    });
  }
  function frequentPointItems(state, suppliedNow) {
    totals(state);
    var now = asDate(suppliedNow).getTime();
    var earliest = now - 30 * 24 * 60 * 60 * 1000;
    var byId = Object.create(null);
    var ranked = [];
    state.pointItems.forEach(function (item, index) {
      if (!item.enabled) { return; }
      var row = { item: item, index: index, count: 0, latest: -Infinity };
      byId[item.id] = row;
      ranked.push(row);
    });
    state.points.forEach(function (record) {
      if (typeof record.itemId !== 'string' || !record.itemId || !own.call(byId, record.itemId)) { return; }
      var at = asDate(record.at).getTime();
      if (at < earliest || at > now) { return; }
      var row = byId[record.itemId];
      row.count += 1;
      if (at > row.latest) { row.latest = at; }
    });
    ranked.sort(function (left, right) {
      if (left.count !== right.count) { return right.count - left.count; }
      if (left.latest !== right.latest) { return left.latest < right.latest ? 1 : -1; }
      return left.index - right.index;
    });
    return ranked.map(function (row) { return row.item; });
  }
  function growthStages(kind) {
    kind = member(kind === undefined ? 'plant' : kind, ['plant', 'capybara'], '伙伴种类');
    return STAGE_NAMES[kind].map(function (name, index) { return { stage: index + 1, at: GROWTH_THRESHOLDS[index], name: name }; });
  }
  function growth(state) {
    var xp = totals(state).earned;
    var kind = state.pet === undefined ? 'plant' : state.pet.kind;
    var stage = 1;
    var stars = 0;
    var previousAt;
    var nextAt;
    while (stage < GROWTH_THRESHOLDS.length && xp >= GROWTH_THRESHOLDS[stage]) { stage += 1; }
    previousAt = GROWTH_THRESHOLDS[stage - 1];
    if (stage < 5) { nextAt = GROWTH_THRESHOLDS[stage]; }
    else {
      stars = Math.floor((xp - 500) / 250);
      previousAt = 500 + stars * 250;
      nextAt = previousAt > MAX_INTEGER - 250 ? MAX_INTEGER : previousAt + 250;
    }
    return { xp: xp, stage: stage, level: stage + stars, stageName: STAGE_NAMES[kind][stage - 1],
      previousAt: previousAt, nextAt: nextAt, remaining: nextAt - xp,
      progress: (xp - previousAt) / (nextAt - previousAt), stars: stars };
  }
  function availability(state, rewardId, now) {
    var balance = totals(state);
    var reward = find(state.rewards, rewardId);
    var date = asDate(now);
    var last = parseKey(dateKey(date));
    if (!reward) { return { allowed: false, reason: '奖励不存在' }; }
    if (!reward.enabled) { return { allowed: false, reason: '奖励已停用' }; }
    if (reward.category === 'weekend' && date.getDay() !== 0 && date.getDay() !== 6) {
      return { allowed: false, reason: '周末美食仅周六、周日可兑换' };
    }
    last.setMonth(last.getMonth() + 1, 0);
    if (reward.category === 'outing' && date.getDate() < last.getDate() - state.settings.monthEndDays + 1) {
      return { allowed: false, reason: '月度出游在每月最后' + state.settings.monthEndDays + '天可兑换' };
    }
    if (balance.available < reward.points) {
      return { allowed: false, reason: '还差 ' + (reward.points - balance.available) + ' 分' };
    }
    return { allowed: true, reason: '' };
  }
  function normalize(state) {
    totals(state);
    var next = JSON.parse(JSON.stringify(state));
    if (next.childAvatar === undefined) { next.childAvatar = ''; }
    if (next.pet === undefined) { next.pet = { kind: 'plant', name: '芽芽' }; }
    if (next.requests === undefined) { next.requests = []; }
    if (next.petPurchases === undefined) { next.petPurchases = []; }
    if (next.petCare === undefined) { next.petCare = []; }
    if (next.petScene === undefined) { next.petScene = 'home'; }
    next.tasks.forEach(function (task) {
      if (task.ackAt === undefined) { task.ackAt = ''; }
      if (task.snoozeUntil === undefined) { task.snoozeUntil = ''; }
    });
    next.pointItems.forEach(function (item) { if (item.reason === undefined) { item.reason = ''; } });
    return next;
  }
  function apply(state, action, now) {
    var current;
    var today;
    var next;
    var input;
    var previous;
    var record;
    var key;
    var at;
    var permission;
    var request;
    object(action, '操作');
    id(action.id, '操作标识');
    totals(state);
    if (state.appliedActions.indexOf(action.id) >= 0) { return state; }
    current = asDate(now);
    today = dateKey(current);
    at = timestamp(current);
    next = normalize(state);

    if (action.type === 'profile.update') {
      next.childName = text(field(action, next, 'childName'), '孩子名字', true, 40);
      next.childAvatar = avatar(field(action, next, 'childAvatar'));
    } else if (action.type === 'pet.configure') {
      next.pet = { kind: member(action.kind, ['plant', 'capybara'], '伙伴种类'),
        name: text(action.name, '伙伴昵称', true, 40) };
    } else if (action.type === 'pet.buy') {
      actionFields(action, ['itemId', 'quantity', 'expectedPoints']);
      previous = find(PET_CATALOG, id(action.itemId, '道具标识'));
      if (!previous) { fail('道具不存在'); }
      var quantity = integer(action.quantity, '购买数量', 1, 10);
      var cost = previous.points * quantity;
      if (integer(action.expectedPoints, '确认分值', 1) !== cost) { fail('道具总价已变化，请重新确认'); }
      if (totals(next).available < cost) { fail('剩余积分不足，无法购买道具'); }
      next.petPurchases.push({ id: id('purchase-' + action.id, '购买记录标识'), itemId: previous.id,
        name: previous.name, quantity: quantity, unitPoints: previous.points, points: cost, at: at });
    } else if (action.type === 'pet.care') {
      actionFields(action, ['care', 'source']);
      key = member(action.care, CARE_KINDS, '照料种类');
      var source = member(action.source, ['free', 'inventory'], '照料来源');
      previous = PET_CATALOG[CARE_KINDS.indexOf(key)];
      permission = petStatus(next, today);
      if (source === 'free' && permission.freeRemaining < 1) { fail('今日免费照料已用完，请重新查看资源'); }
      if (source === 'inventory' && permission.inventory[previous.id] < 1) { fail('对应道具库存不足，请先补给'); }
      next.petCare.push({ id: id('care-' + action.id, '照料记录标识'), care: key, source: source,
        itemId: source === 'inventory' ? previous.id : '', day: today, at: at });
      var exploration = petResources(next).exploration;
      PET_SCENES.forEach(function (scene) {
        if (scene.threshold > permission.exploration && scene.threshold <= exploration) { next.petScene = scene.id; }
      });
    } else if (action.type === 'pet.scene') {
      actionFields(action, ['sceneId']);
      previous = find(PET_SCENES, id(action.sceneId, '场景标识'));
      if (!previous || previous.threshold > petStatus(next, today).exploration) { fail('场景不存在或尚未解锁'); }
      next.petScene = previous.id;
    } else if (action.type === 'task.save') {
      input = object(action.task, '事项');
      key = optionalId(input.id, '事项标识') || id('task-' + action.id, '事项标识');
      previous = find(next.tasks, key);
      if (previous && previous.deleted) { fail('请先恢复已删除事项'); }
      record = {
        id: key,
        type: member(field(input, previous, 'type', 'task'), ['task', 'event'], '事项类型'),
        title: text(field(input, previous, 'title', ''), '事项标题', true, 120),
        date: field(input, previous, 'date', ''),
        time: time(field(input, previous, 'time', '')),
        note: text(field(input, previous, 'note', ''), '事项备注', false),
        done: previous ? previous.done : false,
        deleted: false,
        createdAt: previous ? previous.createdAt : at,
        remindDays: integer(field(input, previous, 'remindDays', 0), '提醒天数', 0),
        ackAt: previous ? previous.ackAt : '',
        snoozeUntil: previous ? previous.snoozeUntil : ''
      };
      parseKey(record.date);
      if (!(previous && previous.date < today && record.date === previous.date && record.type === previous.type)) {
        if (record.date < today) { fail('不能新建或移动到过去日期'); }
        if (record.type === 'task' && record.date > addDays(today, 2)) { fail('近期待办只能安排今天、明天或后天'); }
      }
      if (record.type === 'task') { record.remindDays = 0; }
      if (previous && (record.type !== previous.type || record.date !== previous.date ||
          record.time !== previous.time || record.remindDays !== previous.remindDays)) {
        record.ackAt = ''; record.snoozeUntil = '';
      }
      if (previous) { next.tasks[next.tasks.indexOf(previous)] = record; }
      else { next.tasks.push(record); }
    } else if (action.type === 'task.toggle' || action.type === 'task.delete' || action.type === 'task.restore') {
      previous = find(next.tasks, id(action.taskId, '事项标识'));
      if (!previous) { fail('事项不存在'); }
      if (action.type === 'task.toggle') {
        if (previous.deleted) { fail('请先恢复已删除事项'); }
        previous.done = !previous.done;
      } else { previous.deleted = action.type === 'task.delete'; }
      previous.ackAt = ''; previous.snoozeUntil = '';
    } else if (action.type === 'task.ack' || action.type === 'task.snooze') {
      previous = find(next.tasks, id(action.taskId, '事项标识'));
      if (!previous || previous.deleted) { fail('事项不存在或已删除'); }
      if (previous.done) { fail('已完成事项无需提醒'); }
      if (action.type === 'task.ack') { previous.ackAt = at; previous.snoozeUntil = ''; }
      else {
        if (action.minutes !== 10) { fail('稍后提醒只支持10分钟'); }
        previous.ackAt = '';
        previous.snoozeUntil = timestamp(current.getTime() + 10 * 60000);
      }
    } else if (action.type === 'points.add') {
      key = optionalId(action.itemId, '加分项标识');
      previous = key ? find(next.pointItems, key) : null;
      if (key && !previous) { fail('加分项不存在'); }
      if (previous && !previous.enabled) { fail('加分项已停用'); }
      if (action.at !== undefined) {
        record = asDate(action.at);
        if (dateKey(record) !== today || record.getTime() > current.getTime()) { fail('加分时间只能为今天且不能晚于当前时间'); }
        at = timestamp(record);
      }
      if (action.saveAsTemplate !== undefined) { bool(action.saveAsTemplate, '同时存为常用'); }
      if (action.saveAsTemplate && key) { fail('已有常用项不能同时另存模板，请先选择自定义加分'); }
      record = {
        id: id('points-' + action.id, '加分记录标识'),
        itemId: previous ? previous.id : '',
        name: text(own.call(action, 'name') ? action.name : (previous ? previous.name : ''), '加分名称', true, 120),
        points: integer(own.call(action, 'points') ? action.points : (previous ? previous.points : undefined), '加分分值', 1),
        reason: text(action.reason, '加分原因', true),
        at: at
      };
      if (action.saveAsTemplate) {
        record.itemId = id('item-' + action.id, '加分项标识');
        if (find(next.pointItems, record.itemId)) { fail('新常用项标识已存在，请重新确认'); }
        next.pointItems.push({ id: record.itemId, name: record.name, points: record.points, reason: record.reason, enabled: true });
      }
      next.points.push(record);
    } else if (action.type === 'redemption.request') {
      key = id(action.rewardId, '奖励标识');
      permission = availability(next, key, current);
      if (!permission.allowed) { fail(permission.reason); }
      previous = find(next.rewards, key);
      request = null;
      next.requests.forEach(function (item) {
        if (item.status === 'pending' && item.rewardId === key) { request = item; }
        else if (item.status === 'pending') { item.status = 'cancelled'; item.updatedAt = at; }
      });
      if (!request) {
        next.requests.push({ id: id('request-' + action.id, '申请标识'), rewardId: key,
          name: previous.name, points: previous.points, category: previous.category,
          status: 'pending', createdAt: at, updatedAt: at, redemptionId: '' });
      }
    } else if (action.type === 'redemption.cancel') {
      request = find(next.requests, id(action.requestId, '申请标识'));
      if (!request) { fail('兑换申请不存在'); }
      if (request.status === 'approved') { fail('已经确认的兑换不能取消'); }
      request.status = 'cancelled'; request.updatedAt = at;
    } else if (action.type === 'reward.redeem' || action.type === 'redemption.approve') {
      request = null;
      if (action.type === 'redemption.approve') {
        request = find(next.requests, id(action.requestId, '申请标识'));
        if (!request || request.status !== 'pending') { fail('兑换申请不存在或已经处理'); }
        key = request.rewardId;
      } else { key = id(action.rewardId, '奖励标识'); }
      previous = find(next.rewards, key);
      if (!previous) { fail('奖励不存在'); }
      if (request || own.call(action, 'expectedPoints')) {
        integer(action.expectedPoints, '确认分值', 1);
        if (action.expectedPoints !== previous.points) { fail('礼品价格已变化，请按最新分值重新确认'); }
      }
      permission = availability(next, key, current);
      if (!permission.allowed) { fail(permission.reason); }
      record = {
        id: id('redeem-' + action.id, '兑换记录标识'), rewardId: previous.id,
        name: previous.name, points: previous.points, category: previous.category,
        note: text(action.note, '兑换备注', false), at: at
      };
      next.redemptions.push(record);
      if (request) { request.status = 'approved'; request.updatedAt = at; request.redemptionId = record.id; }
    } else if (action.type === 'pointItem.save') {
      input = object(action.item, '加分项');
      key = optionalId(input.id, '加分项标识') || id('item-' + action.id, '加分项标识');
      previous = find(next.pointItems, key);
      record = {
        id: key,
        name: text(field(input, previous, 'name', ''), '加分项名称', true, 120),
        points: integer(field(input, previous, 'points'), '加分项分值', 1),
        reason: text(field(input, previous, 'reason', ''), '预设原因', false),
        enabled: bool(field(input, previous, 'enabled', true), '启用状态')
      };
      if (previous) { next.pointItems[next.pointItems.indexOf(previous)] = record; }
      else { next.pointItems.push(record); }
    } else if (action.type === 'reward.save') {
      input = object(action.reward, '奖励');
      key = optionalId(input.id, '奖励标识') || id('reward-' + action.id, '奖励标识');
      previous = find(next.rewards, key);
      record = {
        id: key,
        name: text(field(input, previous, 'name', ''), '奖励名称', true, 120),
        points: integer(field(input, previous, 'points'), '兑换分值', 1),
        category: member(field(input, previous, 'category', 'daily'), ['daily', 'weekend', 'outing'], '奖励类别'),
        enabled: bool(field(input, previous, 'enabled', true), '启用状态'),
        icon: field(input, previous, 'icon', '')
      };
      if (!record.icon) { record.icon = { daily: 'pencil', weekend: 'burger', outing: 'mountain' }[record.category]; }
      member(record.icon, ['pencil', 'burger', 'mountain'], '奖励图标');
      if (previous) { next.rewards[next.rewards.indexOf(previous)] = record; }
      else { next.rewards.push(record); }
    } else if (action.type === 'settings.update') {
      input = object(action.settings, '设置');
      next.settings.monthEndDays = integer(field(input, state.settings, 'monthEndDays'), '月末天数', 1, 31);
      next.settings.preferredReward = text(field(input, state.settings, 'preferredReward'), '心愿奖励', false, 200);
      if (next.settings.preferredReward && !find(next.rewards, next.settings.preferredReward)) { fail('心愿奖励不存在'); }
      if (own.call(action, 'childName')) { next.childName = text(action.childName, '孩子名字', true, 40); }
    } else { fail('不支持的操作类型'); }

    next.appliedActions.push(action.id);
    totals(next);
    return next;
  }
  function createSeed(now) {
    var current = asDate(now);
    var today = dateKey(current);
    var at = timestamp(current);
    function ago(days) {
      var date = parseKey(addDays(today, -days));
      date.setHours(current.getHours(), current.getMinutes(), current.getSeconds(), current.getMilliseconds());
      return timestamp(date);
    }
    function task(key, title, offset, clock, note, done, type) {
      return { id: key, type: type || 'task', title: title, date: addDays(today, offset), time: clock,
        note: note, done: !!done, deleted: false, createdAt: at, remindDays: type === 'event' ? 7 : 0,
        ackAt: '', snoozeUntil: '' };
    }
    return {
      version: 1,
      childName: '小禾',
      childAvatar: '',
      pet: { kind: 'plant', name: '芽芽' },
      tasks: [
        task('task-reading', '读一会儿喜欢的书', 0, '11:00', '翻开书，先读一页就好', false),
        task('task-bag', '一起收拾小书包', 0, '17:00', '把明天要用的东西准备好', false),
        task('task-breakfast', '好好吃早餐', 0, '08:00', '给新的一天充满能量', true),
        task('task-homework', '专心完成小练习', 1, '16:30', '一次专心做一件小事', false),
        task('task-walk', '和家人出去走走', 1, '18:00', '发现一件有趣的小事', false),
        task('task-plant', '给小植物浇水', 2, '09:00', '看看它有没有长出新叶子', false),
        task('event-birthday', '妈妈生日', 7, '', '一起准备一张亲手做的贺卡', false, 'event')
      ],
      pointItems: [
        { id: 'point-reading', name: '自主阅读', points: 5, reason: '今天主动读了一会儿自己选的书', enabled: true },
        { id: 'point-focus', name: '专心完成作业', points: 8, reason: '把今天的作业认真完成了', enabled: true },
        { id: 'point-tidy', name: '主动整理', points: 5, reason: '不用提醒，自己收好了书包', enabled: true },
        { id: 'point-kindness', name: '关心家人', points: 3, reason: '主动帮家人做了一件力所能及的事', enabled: true }
      ],
      rewards: [
        { id: 'reward-pencil', name: '彩虹铅笔', points: 12, category: 'daily', enabled: true, icon: 'pencil' },
        { id: 'reward-eraser', name: '小熊橡皮', points: 8, category: 'daily', enabled: true, icon: 'pencil' },
        { id: 'reward-burger', name: '一起吃汉堡', points: 60, category: 'weekend', enabled: true, icon: 'burger' },
        { id: 'reward-trip', name: '长隆奇妙之旅', points: 180, category: 'outing', enabled: true, icon: 'mountain' }
      ],
      points: [
        { id: 'seed-p1', itemId: 'point-reading', name: '自主阅读', points: 20, reason: '坚持阅读，发现了许多新故事', at: ago(12) },
        { id: 'seed-p2', itemId: 'point-focus', name: '专心完成作业', points: 20, reason: '认真完成练习，遇到问题主动思考', at: ago(9) },
        { id: 'seed-p3', itemId: 'point-kindness', name: '关心家人', points: 18, reason: '主动帮家人做力所能及的小事', at: ago(6) },
        { id: 'seed-p4', itemId: 'point-tidy', name: '主动整理', points: 25, reason: '把自己的房间和书桌整理得很整齐', at: ago(4) },
        { id: 'seed-p5', itemId: 'point-focus', name: '专心完成作业', points: 30, reason: '这周有耐心地完成了学习计划', at: ago(1) },
        { id: 'seed-p6', itemId: 'point-reading', name: '自主阅读', points: 15, reason: '主动分享了书里最喜欢的故事', at: at }
      ],
      redemptions: [
        { id: 'seed-r1', rewardId: 'reward-pencil', name: '彩虹铅笔', points: 12, category: 'daily', note: '选了喜欢的颜色', at: ago(8) },
        { id: 'seed-r2', rewardId: 'reward-eraser', name: '小熊橡皮', points: 8, category: 'daily', note: '小小奖励，大大开心', at: ago(6) },
        { id: 'seed-r3', rewardId: 'reward-pencil', name: '彩虹铅笔', points: 12, category: 'daily', note: '用来画新的故事', at: ago(3) },
        { id: 'seed-r4', rewardId: 'reward-eraser', name: '小熊橡皮', points: 8, category: 'daily', note: '认真保管新文具', at: ago(1) }
      ],
      requests: [],
      petPurchases: [],
      petCare: [],
      petScene: 'home',
      settings: { monthEndDays: 3, preferredReward: 'reward-trip' },
      appliedActions: []
    };
  }

  return { createSeed: createSeed, dateKey: dateKey, addDays: addDays, totals: totals,
    availability: availability, apply: apply, normalize: normalize, growth: growth, frequentPointItems: frequentPointItems, petStatus: petStatus, growthStages: growthStages };
}));
