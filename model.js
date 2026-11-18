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

  var FARM_DURATION_MS = 8 * 60 * 60 * 1000;
  var FARM_CROPS = [
    { id: 'carrot', name: '萝卜', threshold: 0, durationMs: FARM_DURATION_MS, yield: 3 },
    { id: 'strawberry', name: '草莓', threshold: 30, durationMs: FARM_DURATION_MS, yield: 3 },
    { id: 'sunflower', name: '向日葵', threshold: 250, durationMs: FARM_DURATION_MS, yield: 3 }
  ];
  var FARM_PLOT_THRESHOLDS = [0, 0, 30, 100, 250, 500];
  var FARM_SLOTS = ['fence', 'path', 'entry', 'center', 'edge'];
  var FARM_CATALOG = [
    { id: 'fence', name: '基础木围栏', threshold: 0, cost: {}, slot: 'fence' },
    { id: 'path', name: '门前小路', threshold: 0, cost: {}, slot: 'path' },
    { id: 'flowerpot', name: '小花盆', threshold: 0, cost: { carrot: 3 }, slot: 'entry' },
    { id: 'picnic', name: '野餐垫', threshold: 30, cost: { carrot: 6, strawberry: 3 }, slot: 'center' },
    { id: 'rabbitstatue', name: '兔形摆件', threshold: 100, cost: { carrot: 6, strawberry: 6 }, slot: 'center' },
    { id: 'mailbox', name: '彩色邮箱', threshold: 100, cost: { carrot: 9, strawberry: 9 }, slot: 'entry' },
    { id: 'trellis', name: '花架', threshold: 250, cost: { carrot: 6, sunflower: 9 }, slot: 'edge' },
    { id: 'windmill', name: '星光风车', threshold: 500, cost: { carrot: 12, strawberry: 6, sunflower: 12 }, slot: 'edge' },
    { id: 'house2', name: '二级小屋', threshold: 100, cost: { carrot: 12, strawberry: 12 }, slot: 'house', level: 2 },
    { id: 'house3', name: '三级小屋', threshold: 500, cost: { carrot: 24, strawberry: 24, sunflower: 24 }, slot: 'house', level: 3 }
  ];
  var FARM_ANIMALS = [
    { id: 'chicken', name: '小鸡', threshold: 0 },
    { id: 'rabbit', name: '兔子', threshold: 100 }
  ];
  var FARM_UNLOCKS = [
    { threshold: 30, name: '草莓、第三块田和野餐垫', plotLimit: 3 },
    { threshold: 100, name: '兔子、第四块田和二级小屋建设资格', plotLimit: 4 },
    { threshold: 250, name: '向日葵、第五块田和花架', plotLimit: 5 },
    { threshold: 500, name: '第六块田、星光风车和三级小屋建设资格', plotLimit: 6 }
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
  function calendarZone(zone) {
    if (zone !== undefined && zone !== 'Asia/Shanghai') { fail('家庭时区无效'); }
    return zone === 'Asia/Shanghai';
  }
  function calendarKey(value) {
    var match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    var date = new Date(0);
    if (!match || +match[1] < 1) { fail('日期必须为有效的 YYYY-MM-DD'); }
    date.setUTCHours(12, 0, 0, 0);
    date.setUTCFullYear(+match[1], +match[2] - 1, +match[3]);
    if (date.getUTCFullYear() !== +match[1] || date.getUTCMonth() !== +match[2] - 1 || date.getUTCDate() !== +match[3]) { fail('日期不存在'); }
    return date;
  }
  function calendarTimestamp(key, clockValue, zone) {
    var fixed = calendarZone(zone);
    calendarKey(key);
    if (!time(clockValue)) { fail('请填写时间'); }
    return asDate(key + 'T' + clockValue + ':00' + (fixed ? '+08:00' : '')).toISOString();
  }
  function calendarParts(value, zone) {
    var fixed = calendarZone(zone);
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) { value = calendarTimestamp(value, '00:00', zone); }
    var date = asDate(value);
    if (fixed) { date = new Date(date.getTime() + 8 * 60 * 60 * 1000); }
    var prefix = fixed ? 'getUTC' : 'get';
    var year = date[prefix + 'FullYear']();
    if (year < 1 || year > 9999) { fail('日期年份超出范围'); }
    var parts = { year: year, month: date[prefix + 'Month']() + 1, day: date[prefix + 'Date'](),
      weekday: date[prefix + 'Day'](), hour: date[prefix + 'Hours'](), minute: date[prefix + 'Minutes'](),
      second: date[prefix + 'Seconds'](), millisecond: date[prefix + 'Milliseconds']() };
    parts.date = ('0000' + year).slice(-4) + '-' + pad(parts.month) + '-' + pad(parts.day);
    parts.time = pad(parts.hour) + ':' + pad(parts.minute);
    return parts;
  }
  function dateKey(value, zone) {
    var fixed = calendarZone(zone);
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      if (fixed) { calendarKey(value); } else { parseKey(value); }
      return value;
    }
    return calendarParts(value, zone).date;
  }
  function addDays(value, days, zone) {
    var fixed = calendarZone(zone);
    var date = fixed ? calendarKey(value) : parseKey(value);
    integer(days, '天数', -MAX_INTEGER);
    if (fixed) { date.setUTCDate(date.getUTCDate() + days); return dateKey(date, zone); }
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
  function farmInitialized(state) { return !!(state.farm && state.farm.initialized); }
  function farmBatchId(value) {
    // Prefix plus plot suffix must still fit when the public action ID is 200 characters.
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,209}$/.test(value)) { fail('农场批次标识无效'); }
    return value;
  }
  function cropAmounts(source) {
    return { carrot: source && source.carrot || 0, strawberry: source && source.strawberry || 0,
      sunflower: source && source.sunflower || 0 };
  }
  function validateCropAmounts(value) {
    object(value, '作物库存');
    if (Object.keys(value).length !== FARM_CROPS.length) { fail('作物库存种类无效'); }
    FARM_CROPS.forEach(function (crop) { integer(value[crop.id], '作物库存', 0); });
  }
  function emptyPlot(plotId) {
    return { id: plotId, cropId: null, batchId: null, plantedAt: null, readyAt: null, welcomeGift: false };
  }
  function newFarm(actionId, at) {
    var batchId = farmBatchId('welcome-' + actionId);
    var plots = FARM_PLOT_THRESHOLDS.map(function (_, index) { return emptyPlot('p' + (index + 1)); });
    plots[0] = { id: 'p1', cropId: 'carrot', batchId: batchId, plantedAt: null, readyAt: at, welcomeGift: true };
    return { version: 1, initialized: true, startedAt: at,
      welcomeGift: { batchId: batchId, grantedAt: at, harvestedAt: null },
      plots: plots, inventory: cropAmounts(), owned: ['fence', 'path'],
      placements: { fence: 'fence', path: 'path', entry: null, center: null, edge: null },
      houseLevel: 1, animalCare: [], lastHarvest: null };
  }
  function validFarm(farm) {
    if (farm === undefined || farm === null) { return; }
    object(farm, '农场');
    if (farm.version !== 1 || farm.initialized !== true) { fail('农场版本或开启记录无效'); }
    storedTimestamp(farm.startedAt);
    object(farm.welcomeGift, '欢迎礼记录');
    farmBatchId(farm.welcomeGift.batchId);
    if (storedTimestamp(farm.welcomeGift.grantedAt) !== farm.startedAt) { fail('欢迎礼发放时间无效'); }
    if (farm.welcomeGift.harvestedAt !== null) { storedTimestamp(farm.welcomeGift.harvestedAt); }
    if (!Array.isArray(farm.plots) || farm.plots.length !== 6) { fail('农场田地记录无效'); }
    var batches = Object.create(null);
    var gifts = 0;
    validateRows(farm.plots, '田地', function (plot) {
      var crop;
      if (plot.id !== 'p' + (farm.plots.indexOf(plot) + 1)) { fail('田地位置无效'); }
      bool(plot.welcomeGift, '欢迎礼田地');
      if (plot.cropId === null) {
        if (plot.batchId !== null || plot.plantedAt !== null || plot.readyAt !== null || plot.welcomeGift) { fail('空田种植记录无效'); }
        return;
      }
      crop = find(FARM_CROPS, plot.cropId);
      if (!crop) { fail('田地作物不存在'); }
      farmBatchId(plot.batchId);
      if (batches[plot.batchId]) { fail('种植批次重复'); }
      batches[plot.batchId] = true;
      storedTimestamp(plot.readyAt);
      if (plot.welcomeGift) {
        gifts += 1;
        if (plot.id !== 'p1' || plot.cropId !== 'carrot' || plot.plantedAt !== null ||
            plot.batchId !== farm.welcomeGift.batchId || plot.readyAt !== farm.startedAt || farm.welcomeGift.harvestedAt !== null) {
          fail('欢迎礼田地记录无效');
        }
      } else {
        if (plot.batchId === farm.welcomeGift.batchId ||
            asDate(storedTimestamp(plot.plantedAt)).getTime() + crop.durationMs !== asDate(plot.readyAt).getTime()) {
          fail('作物成熟时间或种植批次无效');
        }
      }
    });
    if (gifts !== (farm.welcomeGift.harvestedAt === null ? 1 : 0)) { fail('欢迎礼领取记录无效'); }
    validateCropAmounts(farm.inventory);
    if (!Array.isArray(farm.owned)) { fail('已拥有物品格式无效'); }
    var owned = Object.create(null);
    farm.owned.forEach(function (itemId) {
      if (!find(FARM_CATALOG, itemId) || owned[itemId]) { fail('已拥有物品无效或重复'); }
      owned[itemId] = true;
    });
    if (!owned.fence || !owned.path) { fail('缺少基础农场物品'); }
    integer(farm.houseLevel, '房屋级别', 1, 3);
    if (!!owned.house2 !== (farm.houseLevel >= 2) || !!owned.house3 !== (farm.houseLevel === 3)) { fail('房屋升级记录无效'); }
    object(farm.placements, '小院布置');
    if (Object.keys(farm.placements).length !== FARM_SLOTS.length) { fail('布置位置无效'); }
    FARM_SLOTS.forEach(function (slot) {
      var itemId = farm.placements[slot];
      var item = find(FARM_CATALOG, itemId);
      if (itemId !== null && (!item || item.slot !== slot || !owned[itemId])) { fail('布置物品不存在、未拥有或位置不符'); }
    });
    var cared = Object.create(null);
    validateRows(farm.animalCare, '动物照料记录', function (row) {
      if (!find(FARM_ANIMALS, row.animalId)) { fail('农场动物不存在'); }
      member(row.care, ['feed', 'pet'], '动物照料种类');
      parseKey(row.day);
      storedTimestamp(row.at);
      var key = row.animalId + ':' + row.day;
      if (cared[key]) { fail('动物每日照料记录重复'); }
      cared[key] = true;
    });
    if (farm.lastHarvest !== null) {
      var harvest = object(farm.lastHarvest, '收获结果');
      id(harvest.id, '收获操作标识');
      storedTimestamp(harvest.at);
      validateCropAmounts(harvest.crops);
      if (!Array.isArray(harvest.plotIds) || !Array.isArray(harvest.batchIds) || harvest.plotIds.length < 1 ||
          harvest.plotIds.length > 6 || harvest.plotIds.length !== harvest.batchIds.length) { fail('收获批次记录无效'); }
      var plots = Object.create(null);
      var harvested = Object.create(null);
      harvest.plotIds.forEach(function (plotId, index) {
        if (!/^p[1-6]$/.test(plotId) || plots[plotId]) { fail('收获田地无效或重复'); }
        plots[plotId] = true;
        farmBatchId(harvest.batchIds[index]);
        if (harvested[harvest.batchIds[index]] || batches[harvest.batchIds[index]]) { fail('收获批次重复或仍在田中'); }
        harvested[harvest.batchIds[index]] = true;
      });
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
      text(row.reason, '加分原因', false);
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
      if (row.farmMode !== undefined) {
        bool(row.farmMode, '农场照料标记');
        if (row.farmMode && !farmInitialized(state)) { fail('农场照料缺少开启记录'); }
      }
    });
    validFarm(state.farm);
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
    var exploration = 0;
    (state.petPurchases || []).forEach(function (row) { inventory[row.itemId] += row.quantity; });
    (state.petCare || []).forEach(function (row) {
      if (row.source === 'inventory') { inventory[row.itemId] -= 1; }
      // Farm interactions consume explicitly selected old supplies, but never
      // rewrite the archived exploration count or its three-kinds daily bonus.
      if (row.farmMode) { return; }
      exploration += 1;
      var day = days[row.day];
      if (!day) { day = { freeUsed: 0, kinds: Object.create(null) }; days[row.day] = day; }
      if (row.source === 'free') {
        day.freeUsed += 1;
        if (day.freeUsed > 3) { fail('每日免费照料记录超过3次'); }
      }
      day.kinds[row.care] = true;
    });
    Object.keys(inventory).forEach(function (key) { integer(inventory[key], '道具库存', 0); });
    Object.keys(days).forEach(function (key) {
      if (CARE_KINDS.every(function (care) { return !!days[key].kinds[care]; })) { exploration += 1; }
    });
    return { inventory: inventory, days: days, exploration: integer(exploration, '探索进度', 0) };
  }
  function petStatus(state, suppliedNow, zone) {
    totals(state);
    var familyDay = dateKey(suppliedNow, zone);
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
    return { familyDay: familyDay, farmMode: farmInitialized(state), freeUnlimited: farmInitialized(state), purchasesEnabled: !farmInitialized(state),
      catalog: PET_CATALOG.map(function (item) { return { id: item.id, name: item.name, care: item.care, points: item.points }; }),
      inventory: resources.inventory, freeLimit: 3, freeUsed: today.freeUsed, freeRemaining: 3 - today.freeUsed,
      caredToday: caredToday, dailyBonusEarned: caredToday.length === 3, exploration: resources.exploration,
      scenes: scenes, unlockedScenes: scenes.filter(function (scene) { return scene.unlocked; }).map(function (scene) { return scene.id; }),
      nextUnlock: nextUnlock, sceneId: state.petScene === undefined ? 'home' : state.petScene };
  }
  function farmStatus(state, suppliedNow, suppliedDay) {
    var xp = totals(state).earned;
    var current = asDate(suppliedNow);
    var nowMs = current.getTime();
    var familyDay = suppliedDay === undefined ? dateKey(current) : dateKey(parseKey(suppliedDay));
    var initialized = farmInitialized(state);
    var farm = initialized ? state.farm : null;
    var inventory = cropAmounts(farm && farm.inventory);
    var owned = farm ? farm.owned.slice() : [];
    var houseLevel = farm ? farm.houseLevel : 0;
    var readyCount = 0;
    var emptyCount = 0;
    var nextReadyAt = null;
    var plotLimit = 0;
    var nextUnlock = null;
    var crops = FARM_CROPS.map(function (crop) {
      return { id: crop.id, name: crop.name, threshold: crop.threshold, unlocked: xp >= crop.threshold,
        durationMs: crop.durationMs, yield: crop.yield };
    });
    var plots = FARM_PLOT_THRESHOLDS.map(function (threshold, index) {
      var plot = farm ? farm.plots[index] : emptyPlot('p' + (index + 1));
      var unlocked = initialized && xp >= threshold;
      var remainingMs = plot.readyAt === null ? 0 : Math.max(0, asDate(plot.readyAt).getTime() - nowMs);
      var status = !unlocked ? 'locked' : (!plot.cropId ? 'empty' : (remainingMs === 0 ? 'ready' : 'growing'));
      if (xp >= threshold) { plotLimit += 1; }
      if (status === 'ready') { readyCount += 1; }
      if (status === 'empty') { emptyCount += 1; }
      if (status === 'growing' && (nextReadyAt === null || asDate(plot.readyAt).getTime() < asDate(nextReadyAt).getTime())) {
        nextReadyAt = plot.readyAt;
      }
      return { id: plot.id, index: index, threshold: threshold, unlocked: unlocked, cropId: plot.cropId,
        status: status, plantedAt: plot.plantedAt, readyAt: plot.readyAt, remainingMs: remainingMs,
        batchId: plot.batchId, welcomeGift: plot.welcomeGift };
    });
    var catalog = FARM_CATALOG.map(function (item) {
      var cost = cropAmounts(item.cost);
      var missing = cropAmounts();
      var shortage = [];
      FARM_CROPS.forEach(function (crop) {
        missing[crop.id] = Math.max(0, cost[crop.id] - inventory[crop.id]);
        if (missing[crop.id]) { shortage.push(crop.name + '×' + missing[crop.id]); }
      });
      var isOwned = owned.indexOf(item.id) >= 0;
      var unlocked = xp >= item.threshold;
      var reason = !initialized ? '请先开启小院' : (isOwned ? '已经拥有' : (!unlocked ? '累计成长达到' + item.threshold + '后开放' :
        (item.level && houseLevel !== item.level - 1 ? '请先建成' + (item.level - 1) + '级小屋' :
          (shortage.length ? '还缺' + shortage.join('、') : ''))));
      return { id: item.id, name: item.name, threshold: item.threshold, cost: cost, slot: item.slot,
        owned: isOwned, unlocked: unlocked, canBuy: reason === '', missing: missing, reason: reason };
    });
    var placements = {};
    FARM_SLOTS.forEach(function (slot) { placements[slot] = farm ? farm.placements[slot] : null; });
    var animals = FARM_ANIMALS.map(function (animal) {
      var records = farm ? farm.animalCare.filter(function (row) { return row.animalId === animal.id; }) : [];
      var caredToday = records.some(function (row) { return row.day === familyDay; });
      return { id: animal.id, name: animal.name, threshold: animal.threshold, unlocked: initialized && xp >= animal.threshold,
        caredToday: caredToday, careCount: records.length, cardUnlocked: records.length >= 3, actionUnlocked: records.length >= 7,
        cardAt: 3, actionAt: 7 };
    });
    FARM_UNLOCKS.forEach(function (unlock) {
      if (!nextUnlock && xp < unlock.threshold) {
        nextUnlock = { threshold: unlock.threshold, remaining: unlock.threshold - xp, name: unlock.name, plotLimit: unlock.plotLimit };
      }
    });
    return { initialized: initialized, familyDay: familyDay, crops: crops, plots: plots, inventory: inventory,
      catalog: catalog, owned: owned, placements: placements, houseLevel: houseLevel, animals: animals,
      readyCount: readyCount, emptyCount: emptyCount, nextReadyAt: nextReadyAt, nextUnlock: nextUnlock, plotLimit: plotLimit,
      welcomeGift: farm ? JSON.parse(JSON.stringify(farm.welcomeGift)) : null,
      lastHarvest: farm && farm.lastHarvest ? JSON.parse(JSON.stringify(farm.lastHarvest)) : null };
  }
  function selectedFarmPlots(status, plotIds, desiredStatus) {
    var selected = status.plots;
    if (plotIds !== undefined) {
      if (!Array.isArray(plotIds) || plotIds.length < 1 || plotIds.length > 6) { fail('请选择1至6块田地'); }
      var seen = Object.create(null);
      selected = plotIds.map(function (plotId) {
        var plot = find(status.plots, plotId);
        if (!plot || seen[plotId]) { fail('田地不存在或重复'); }
        seen[plotId] = true;
        if (!plot.unlocked) { fail('田地尚未解锁'); }
        return plot;
      });
    }
    return selected.filter(function (plot) { return plot.status === desiredStatus; });
  }
  function applyFarm(state, action, current, zone) {
    var at = timestamp(current);
    if (action.type === 'farm.start') {
      actionFields(action, []);
      if (farmInitialized(state)) { fail('小院已经开启，无需重复开启'); }
      state.farm = newFarm(action.id, at);
      return;
    }
    var fields = {
      'farm.plant': ['cropId', 'plotIds'], 'farm.harvest': ['plotIds'], 'farm.exchange': ['itemId'],
      'farm.place': ['slot', 'itemId'], 'farm.animalCare': ['animalId', 'care']
    };
    if (!own.call(fields, action.type)) { fail('不支持的农场操作'); }
    actionFields(action, fields[action.type]);
    if (!farmInitialized(state)) { fail('请先开启小院'); }
    var status = farmStatus(state, current, dateKey(current, zone));
    var farm = state.farm;
    var selected;
    var item;
    if (action.type === 'farm.plant') {
      var crop = find(status.crops, id(action.cropId, '作物标识'));
      if (!crop) { fail('作物不存在'); }
      if (!crop.unlocked) { fail('作物尚未解锁'); }
      selected = selectedFarmPlots(status, action.plotIds, 'empty');
      if (!selected.length) { fail('暂时没有可播种的空田'); }
      selected.forEach(function (plot) {
        farm.plots[plot.index] = { id: plot.id, cropId: crop.id, batchId: farmBatchId('plant-' + action.id + '-' + plot.id),
          plantedAt: at, readyAt: timestamp(current.getTime() + crop.durationMs), welcomeGift: false };
      });
    } else if (action.type === 'farm.harvest') {
      selected = selectedFarmPlots(status, action.plotIds, 'ready');
      if (!selected.length) { fail('暂时没有成熟的作物'); }
      var harvest = { id: action.id, at: at, crops: cropAmounts(), plotIds: [], batchIds: [] };
      selected.forEach(function (plot) {
        var crop = find(FARM_CROPS, plot.cropId);
        harvest.crops[crop.id] += crop.yield;
        harvest.plotIds.push(plot.id);
        harvest.batchIds.push(plot.batchId);
        if (plot.welcomeGift) { farm.welcomeGift.harvestedAt = at; }
        farm.plots[plot.index] = emptyPlot(plot.id);
      });
      FARM_CROPS.forEach(function (crop) {
        farm.inventory[crop.id] = integer(farm.inventory[crop.id] + harvest.crops[crop.id], '作物库存', 0);
      });
      farm.lastHarvest = harvest;
    } else if (action.type === 'farm.exchange') {
      item = find(status.catalog, id(action.itemId, '物品标识'));
      if (!item) { fail('兑换物品不存在'); }
      if (!item.canBuy) { fail(item.reason); }
      FARM_CROPS.forEach(function (crop) { farm.inventory[crop.id] -= item.cost[crop.id]; });
      farm.owned.push(item.id);
      if (item.slot === 'house') { farm.houseLevel = find(FARM_CATALOG, item.id).level; }
    } else if (action.type === 'farm.place') {
      var slot = member(action.slot, FARM_SLOTS, '布置位置');
      if (action.itemId !== null) {
        item = find(FARM_CATALOG, id(action.itemId, '物品标识'));
        if (!item || item.slot !== slot) { fail('物品与布置位置不符'); }
        if (farm.owned.indexOf(item.id) < 0) { fail('尚未拥有这个物品'); }
      }
      farm.placements[slot] = action.itemId;
    } else if (action.type === 'farm.animalCare') {
      var animal = find(status.animals, id(action.animalId, '动物标识'));
      if (!animal) { fail('农场动物不存在'); }
      if (!animal.unlocked) { fail('动物尚未解锁'); }
      var care = member(action.care, ['feed', 'pet'], '动物照料种类');
      if (!animal.caredToday) {
        farm.animalCare.push({ id: action.id, animalId: animal.id,
          care: care, day: status.familyDay, at: at });
      }
    }
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
  function availability(state, rewardId, now, zone) {
    var balance = totals(state);
    var reward = find(state.rewards, rewardId);
    var parts = calendarParts(now, zone);
    var last = calendarKey(parts.date);
    if (!reward) { return { allowed: false, reason: '奖励不存在' }; }
    if (!reward.enabled) { return { allowed: false, reason: '奖励已停用' }; }
    if (reward.category === 'weekend' && parts.weekday !== 0 && parts.weekday !== 6) {
      return { allowed: false, reason: '周末美食仅周六、周日可兑换' };
    }
    last.setUTCMonth(last.getUTCMonth() + 1, 0);
    if (reward.category === 'outing' && parts.day < last.getUTCDate() - state.settings.monthEndDays + 1) {
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
    if (next.farm === undefined) { next.farm = null; }
    next.tasks.forEach(function (task) {
      if (task.ackAt === undefined) { task.ackAt = ''; }
      if (task.snoozeUntil === undefined) { task.snoozeUntil = ''; }
    });
    next.pointItems.forEach(function (item) { if (item.reason === undefined) { item.reason = ''; } });
    return next;
  }
  function apply(state, action, now, zone) {
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
    today = dateKey(current, zone);
    at = timestamp(current);
    next = normalize(state);

    if (typeof action.type === 'string' && action.type.indexOf('farm.') === 0) {
      applyFarm(next, action, current, zone);
    } else if (action.type === 'profile.update') {
      next.childName = text(field(action, next, 'childName'), '孩子名字', true, 40);
      next.childAvatar = avatar(field(action, next, 'childAvatar'));
    } else if (action.type === 'pet.configure') {
      next.pet = { kind: member(action.kind, ['plant', 'capybara'], '伙伴种类'),
        name: text(action.name, '伙伴昵称', true, 40) };
    } else if (action.type === 'pet.buy') {
      actionFields(action, ['itemId', 'quantity', 'expectedPoints']);
      if (farmInitialized(next)) { fail('小院已开启，已停止购买旧照料道具'); }
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
      if (source === 'free' && !permission.freeUnlimited && permission.freeRemaining < 1) { fail('今日免费照料已用完，请重新查看资源'); }
      if (source === 'inventory' && permission.inventory[previous.id] < 1) { fail('对应道具库存不足，请先补给'); }
      record = { id: id('care-' + action.id, '照料记录标识'), care: key, source: source,
        itemId: source === 'inventory' ? previous.id : '', day: today, at: at };
      if (farmInitialized(next)) { record.farmMode = true; }
      next.petCare.push(record);
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
        if (record.type === 'task' && record.date > addDays(today, 2, zone)) { fail('近期待办只能安排今天、明天或后天'); }
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
        if (dateKey(record, zone) !== today || record.getTime() > current.getTime()) { fail('加分时间只能为今天且不能晚于当前时间'); }
        at = timestamp(record);
      }
      if (action.saveAsTemplate !== undefined) { bool(action.saveAsTemplate, '同时存为常用'); }
      if (action.saveAsTemplate && key) { fail('已有常用项不能同时另存模板，请先选择自定义加分'); }
      record = {
        id: id('points-' + action.id, '加分记录标识'),
        itemId: previous ? previous.id : '',
        name: text(own.call(action, 'name') ? action.name : (previous ? previous.name : ''), '加分名称', true, 120),
        points: integer(own.call(action, 'points') ? action.points : (previous ? previous.points : undefined), '加分分值', 1),
        reason: text(action.reason, '加分原因', false),
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
      permission = availability(next, key, current, zone);
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
      permission = availability(next, key, current, zone);
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
  function createEmptyFamily(details, now) {
    object(details, '家庭资料');
    Object.keys(details).forEach(function (key) { if (key !== 'childName') { fail('家庭资料字段无效'); } });
    asDate(now);
    return {
      version: 1,
      childName: text(details.childName, '孩子名字', true, 40),
      childAvatar: '',
      pet: { kind: 'plant', name: '芽芽' },
      tasks: [],
      pointItems: [],
      rewards: [],
      points: [],
      redemptions: [],
      requests: [],
      petPurchases: [],
      petCare: [],
      petScene: 'home',
      farm: null,
      settings: { monthEndDays: 3, preferredReward: '' },
      appliedActions: []
    };
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
      farm: null,
      settings: { monthEndDays: 3, preferredReward: 'reward-trip' },
      appliedActions: []
    };
  }

  return { createSeed: createSeed, createEmptyFamily: createEmptyFamily, dateKey: dateKey, addDays: addDays, calendarParts: calendarParts, calendarTimestamp: calendarTimestamp, totals: totals,
    availability: availability, apply: apply, normalize: normalize, growth: growth, frequentPointItems: frequentPointItems, petStatus: petStatus, growthStages: growthStages, farmStatus: farmStatus };
}));
