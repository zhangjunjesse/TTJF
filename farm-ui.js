/* Farm interface. ES5; domain decisions stay in FamilyModel and the server. */
(function (root) {
  'use strict';
  var host, controller = null, surface = null, sceneState = 'loading', sceneError = '', tickKey = '', activeMode = '', visible = false, focusKey = '', pendingFocus = null, lighting = 'day', sceneEpoch = 0;
  var CROP_NAMES = { carrot: '萝卜', strawberry: '草莓', sunflower: '向日葵' };
  var SLOT_NAMES = { fence: '围栏', path: '小路', entry: '门口', center: '院子中央', edge: '院子边缘', house: '小屋' };
  function e(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function find(rows, id) { for (var i = 0; rows && i < rows.length; i++) if (rows[i].id === id) return rows[i]; return null; }
  function context() { return host.context(); }
  function scopeReady() { if (!host) return false; var c = context(); return c.ready !== false && !!c.state && (root.__TTJF_SAAS__ !== true || !!(root.FamilySaas && root.FamilySaas.ready())); }
  function status() { if (!scopeReady()) return null; var c = context(); return root.FamilyModel.farmStatus(c.state, c.now, c.familyDay); }
  function ready() { if (!scopeReady()) return false; var c = context(); return c.local || c.connected; }
  function blocked() { var c = context(); return !ready() || c.pending || !!(c.retry && c.retry.uncertain); }
  function b(action, text, classes, id, disabled, label) { return '<button type="button" class="' + (classes || 'btn outline') + '" data-action="' + action + '"' + (id != null ? ' data-id="' + e(id) + '"' : '') + (disabled ? ' disabled' : '') + (label ? ' aria-label="' + e(label) + '"' : '') + '>' + text + '</button>'; }
  function art(id) {
    var body;
    if (id === 'carrot') body = '<path d="M36 26 21 66c-2 5 3 7 7 4l30-30Z" fill="#ed974b"/><path d="m39 25-8-15m12 12 1-16m3 20 15-12" stroke="#6a9650" stroke-width="8" stroke-linecap="round"/><path d="m33 42 9 5m-16 8 7 4" stroke="#c97837" stroke-width="3"/>';
    else if (id === 'strawberry') body = '<path d="M17 34c2-18 43-18 46 0 2 14-15 35-23 36S14 48 17 34" fill="#d96868"/><path d="m25 26 9-10 7 9 13-9-2 14-12-4-12 6Z" fill="#639052"/><path d="m30 38 1 3m17-4-1 3m-10 10 1 3m-8-3 1 3m16-2-1 3m-6 7 0 2" stroke="#ffe9b3" stroke-width="3" stroke-linecap="round"/>';
    else if (id === 'sunflower') body = '<path d="M41 43v29M40 60Q18 43 22 64q9 9 18 1M41 54q15-22 20-8-3 14-20 13" fill="#71984e" stroke="#71984e" stroke-width="4"/><path d="m40 10 8 9 12-1 0 12 9 8-10 8-1 12-12-3-10 8-6-11-12-3 4-12-5-10 12-4Z" fill="#edbc56"/><circle cx="40" cy="36" r="13" fill="#997145"/><circle cx="37" cy="32" r="3" fill="#b68d51"/>';
    else if (id === 'chicken') body = '<ellipse cx="39" cy="48" rx="22" ry="20" fill="#fff8dc"/><path d="m21 37-12-13 3 24M48 20q-7-13-2-16 6-1 7 9 8-8 11-2 1 5-8 10" fill="#cc6b56"/><circle cx="51" cy="29" r="14" fill="#fff8dc"/><circle cx="56" cy="27" r="2.5" fill="#394b3e"/><path d="m64 30 10 4-11 4M31 65v9m18-9v9" fill="#d89b40" stroke="#d89b40" stroke-width="4"/><path d="M24 46q8 12 18 1" fill="none" stroke="#e4d9b5" stroke-width="3"/>';
    else if (id === 'rabbit' || id === 'rabbitstatue') body = '<ellipse cx="33" cy="22" rx="7" ry="19" transform="rotate(-12 33 22)" fill="#e4d1b9"/><ellipse cx="49" cy="20" rx="7" ry="19" transform="rotate(10 49 20)" fill="#e4d1b9"/><ellipse cx="40" cy="55" rx="22" ry="20" fill="#e8d8c3"/><circle cx="42" cy="40" r="19" fill="#f0e1ce"/><path d="M33 10v16m15-17v17" stroke="#dba7a0" stroke-width="4" stroke-linecap="round"/><circle cx="35" cy="39" r="2.5" fill="#495344"/><circle cx="49" cy="39" r="2.5" fill="#495344"/><path d="m39 47 3 3 3-3" fill="none" stroke="#a4766b" stroke-width="2"/>';
    else if (id === 'flowerpot') body = '<path d="M24 43h33l-5 30H29Z" fill="#c77f61"/><path d="M20 40h40v9H20Z" fill="#df9b7c"/><path d="M40 42V19m0 17L28 27m12 6 13-9" stroke="#759356" stroke-width="4"/><path d="M22 19q17 0 15 14-14 3-15-14m35-3q-18 2-15 15 15 2 15-15" fill="#83a764"/><circle cx="40" cy="13" r="11" fill="#ecbc70"/><circle cx="40" cy="13" r="4" fill="#ad8251"/>';
    else if (id === 'picnic') body = '<path d="m13 30 46-8 12 39-48 10Z" fill="#b77663"/><path d="m22 28 12 41m3-44 12 40m4-44 12 41M17 43l46-10M21 58l47-11" stroke="#f9e2bd" stroke-width="5"/><ellipse cx="43" cy="43" rx="11" ry="7" fill="#fff7df"/><circle cx="44" cy="41" r="5" fill="#d99751"/>';
    else if (id === 'mailbox') body = '<path d="M38 46h8v29h-8Z" fill="#9c7651"/><path d="M16 23q0-12 15-12h27q11 0 11 12v27H16Z" fill="#7da6a5"/><path d="M16 23q0-12 12-12t12 12v27H16Z" fill="#a6c5b6"/><path d="M51 32V9h14v8H51" fill="#cc8065" stroke="#cc8065" stroke-width="3"/>';
    else if (id === 'windmill') body = '<path d="m30 46-6 29h31l-7-29Z" fill="#e1c697"/><path d="m40 35-6-23 13-5-1 26 23-6 5 13-26-1 6 23-13 5 1-26-23 6-5-13Z" fill="#91aaa5"/><circle cx="40" cy="35" r="7" fill="#f4da8d"/>';
    else if (id === 'trellis') body = '<path d="M18 74V32q0-24 22-24t22 24v42M24 73V33q0-19 16-19t16 19v40" fill="none" stroke="#b19268" stroke-width="5"/><path d="m15 61 10-8-9-11 9-9m28 19 13-8-12-9 9-8" fill="none" stroke="#729350" stroke-width="5"/><circle cx="22" cy="24" r="6" fill="#da9e97"/><circle cx="57" cy="42" r="6" fill="#e0ba6c"/><circle cx="40" cy="11" r="6" fill="#da9e97"/>';
    else if (id === 'fence') body = '<path d="M10 39h60v8H10Zm0 18h60v8H10Z" fill="#ba9b6d"/><path d="m15 30 5-9 5 9v46H15Zm20 0 5-9 5 9v46H35Zm20 0 5-9 5 9v46H55Z" fill="#d1b184"/>';
    else if (id === 'path') body = '<path d="m32 11 17 1 4 14-23 3Zm-9 23 29-2 8 16-40 3Zm-8 24 47-4 12 21H6Z" fill="#d3c7a9" stroke="#b5a68b" stroke-width="2"/>';
    else body = '<path d="M15 36h51v38H15Z" fill="#ebd6ae"/><path d="m7 38 33-28 34 28Z" fill="' + (id === 'house3' ? '#7598a0' : '#b97860') + '"/><path d="M34 49h15v25H34Z" fill="#8d7053"/><path d="M20 45h10v12H20Zm34 0h9v12h-9Z" fill="#96b9ad"/><path d="M17 75h49" stroke="#bcaa86" stroke-width="4"/>';
    return '<svg viewBox="0 0 80 80" aria-hidden="true" focusable="false" class="farm-art">' + body + '</svg>';
  }
  function basket(s) { return '<div class="farm-basket" aria-label="作物背包">' + s.crops.map(function (crop) { return '<div class="farm-crop-count">' + art(crop.id) + '<span>' + e(crop.name) + '<strong>' + s.inventory[crop.id] + '</strong></span></div>'; }).join('') + '</div>'; }
  function costs(cost, inventory) { return Object.keys(CROP_NAMES).filter(function (id) { return cost && cost[id]; }).map(function (id) { return '<span class="farm-cost' + (inventory && inventory[id] < cost[id] ? ' insufficient' : '') + '">' + art(id) + e(CROP_NAMES[id]) + ' × ' + cost[id] + (inventory ? '<small>已有 ' + inventory[id] + '</small>' : '') + '</span>'; }).join('') || '<span class="farm-cost">初始赠送</span>'; }
  function timeLabel(time) { var diff = Math.max(0, new Date(time).getTime() - context().now.getTime()), mins = Math.ceil(diff / 60000); return mins < 1 ? '可以收获' : mins < 60 ? '约' + mins + '分钟后成熟' : '约' + Math.ceil(mins / 60) + '小时后成熟'; }
  function timeExact(time) { var d = root.FamilyModel.calendarParts(time, root.__TTJF_SAAS__ === true ? 'Asia/Shanghai' : undefined); return d.month + '月' + d.day + '日 ' + d.time; }
  function shortStatus(s) { if (!ready()) return '连接中断 · 暂不能收获'; if (!s.initialized) return '尚未开启'; if (s.readyCount) return s.readyCount + '块田可以收获'; if (s.emptyCount) return '空田' + s.emptyCount + '块'; return s.nextReadyAt ? timeLabel(s.nextReadyAt) : '小院里的悠闲时光'; }
  function retryNotice() { var c = context(); return c.retry && c.retry.uncertain && /^farm\./.test(c.retry.action.type) ? '<div class="farm-retry" role="status"><span>上次操作结果待确认</span>' + b('farm-retry', '重试本次', 'btn outline', '', c.pending || !ready()) + '</div>' : ''; }
  function surfaceMarkup(mode, preview) { return '<div class="farm-scene-slot" data-farm-scene="' + mode + '"' + (preview ? ' data-preview-item="' + preview + '"' : '') + '><div class="farm-scene-fallback" role="status"><span>小院加载中</span></div></div>'; }
  function toolArt(kind) {
    var shapes = { harvest: '<path d="M18 65 39 29" stroke="#855a2d" stroke-width="9" stroke-linecap="round"/><path d="M36 31C48 8 76 17 65 41c-1-13-15-18-23-7Z" fill="#cbd5bc" stroke="#536b55" stroke-width="3"/><path d="m17 62 7 4" stroke="#c99a54" stroke-width="3"/>', seeds: '<path d="M26 24h28l-4 10c22 29 13 39-10 39S8 61 30 34Z" fill="#d7ac62" stroke="#956b36" stroke-width="3"/><path d="M26 34h28" stroke="#784b27" stroke-width="5" stroke-linecap="round"/><path d="M40 61V43m0 10c-12-1-14-11-14-11 10-3 14 7 14 7m0 1c13-2 13-12 13-12-10 0-13 8-13 8" fill="#73934b" stroke="#527643" stroke-width="2"/>', care: '<path d="M40 65 15 42C-4 20 23 5 40 25 57 5 84 20 65 42Z" fill="#dd8e72" stroke="#a35948" stroke-width="3"/><path d="M23 26q7-7 13 1" fill="none" stroke="#f7c5a6" stroke-width="5" stroke-linecap="round"/>', build: '<path d="m15 35 25-22 25 22v35H15Z" fill="#d2a05a" stroke="#80552e" stroke-width="3"/><path d="m9 37 31-27 31 27" fill="none" stroke="#a9673d" stroke-width="9" stroke-linecap="round"/><path d="M32 70V46h17v24" fill="#754d30"/><path d="M20 40h11v12H20Z" fill="#a5c9cd"/><circle cx="44" cy="58" r="2" fill="#f2cc7e"/>' };
    return '<svg class="farm-tool-art" viewBox="0 0 80 80" aria-hidden="true" focusable="false">' + (shapes[kind] || shapes.build) + '</svg>';
  }
  function cameraTools() {
    var reset = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 4v6h-6M20 10a8 8 0 1 0-1 7"/></svg>';
    var lightIcon = lighting === 'night' ? host.icon('sun') : '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 15a9 9 0 0 1-11-11 9 9 0 1 0 11 11Z"/><path d="M18 3v4m-2-2h4"/></svg>';
    return '<div class="farm-camera-tools" aria-label="农场视角">' + b('farm-zoom-in', '<span aria-hidden="true">+</span>', 'farm-camera-button', '', false, '放大农场') + b('farm-zoom-out', '<span aria-hidden="true">−</span>', 'farm-camera-button', '', false, '缩小农场') + b('farm-camera-reset', reset, 'farm-camera-button', '', false, '回到农场全景') + b('farm-lighting', lightIcon, 'farm-camera-button', '', false, lighting === 'night' ? '切换为日间景色' : '切换为夜晚景色') + '</div>';
  }
  function toolbar(s, full) {
    var locked = blocked();
    if (!s.initialized) return '<div class="farm-welcome-actions">' + b('farm-start', '开启我的小院', 'btn primary', '', locked) + '<small>成熟萝卜田×1 · 免费</small></div>';
    return '<div class="farm-toolbar" aria-label="农场日常操作">' + b('farm-harvest', toolArt('harvest') + '<span>收获' + (s.readyCount ? '<b>' + s.readyCount + '</b>' : '') + '</span>', 'farm-tool ' + (s.readyCount ? 'farm-tool-primary' : ''), '', locked || !s.readyCount, '收获所有成熟作物') + b('farm-seeds', toolArt('seeds') + '<span>播种</span>', 'farm-tool', '', locked || !s.emptyCount, '选择作物并播种') + b('farm-care', toolArt('care') + '<span>照料</span>', 'farm-tool', '', false, '照料伙伴和动物') + b(full ? 'farm-tab' : 'farm-open', full ? toolArt('build') + '<span>建设</span>' : host.icon('screen') + '<span>展开</span>', 'farm-tool', full ? 'build' : '', false, full ? '打开背包与建设' : '展开整个农场') + '</div>';
  }
  function home() {
    var c = context(), s = status(), pet = c.pet, g = c.growth, next = s.nextUnlock;
    tickKey = timingKey(s);
    return '<section class="companion-card farm-home-card" aria-label="伙伴的小农场"><div class="companion-heading">' + b('pet-growth', '<span id="home-feedback" class="pet-name" role="status" aria-live="polite" data-feedback="' + !!c.feedback + '">' + e(c.feedback || pet.name) + '</span><span class="pet-level">Lv.' + g.level + ' · ' + g.xp + ' 成长值</span>', 'pet-growth-entry', '', false, '查看' + pet.name + '的成长，' + g.stageName) + b('farm-tab', '<b>背包·建设</b>' + (next ? '<small>' + e('再成长' + next.remaining + '点') + '</small>' : ''), 'text-button farm-build-entry', 'build') + '</div><div class="growth-track" role="progressbar" aria-label="本阶段成长进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(g.progress * 100) + '"><div style="width:' + Math.round(g.progress * 100) + '%"></div></div><div class="farm-home-stage">' + surfaceMarkup('home') + '<div class="farm-scene-caption"><span class="farm-weather">' + host.icon('sun') + '小院时光</span><span class="farm-ready-status">' + e(shortStatus(s)) + '</span></div>' + retryNotice() + '<p id="pet-dialogue" class="pet-announcement" aria-live="polite"></p></div>' + toolbar(s, false) + '</section>';
  }
  function tabs(active) { return '<nav class="farm-tabs" aria-label="小院工具">' + [['fields', '田地'], ['animals', '动物'], ['build', '布置'], ['collection', '收藏']].map(function (t) { return b('farm-tab', t[1], 'farm-tab' + (active === t[0] ? ' active' : ''), t[0]).replace('<button ', '<button aria-pressed="' + (active === t[0]) + '" '); }).join('') + '</nav>'; }
  function plotLabel(plot) { return plot.status === 'locked' ? '未开放' : plot.status === 'empty' ? '空田' : plot.status === 'ready' ? (plot.welcomeGift ? '欢迎礼物' : '成熟啦') : timeLabel(plot.readyAt); }
  function plotTiles(s) { return '<div class="farm-plots" aria-label="六块田地">' + s.plots.map(function (p) { return b('farm-plot', '<small>' + (p.index + 1) + '号田</small>' + (p.cropId ? art(p.cropId) : '<span class="farm-empty-plot">' + host.icon(p.unlocked ? 'plus' : 'lock') + '</span>') + '<b>' + e(p.cropId ? CROP_NAMES[p.cropId] : p.unlocked ? '去播种' : '待开放') + '</b><span>' + e(plotLabel(p)) + '</span>', 'farm-plot ' + p.status, p.id, false); }).join('') + '</div>'; }
  function worldStage(s, preview) {
    return '<div class="farm-workspace"><div class="farm-yard-stage' + (preview ? ' farm-preview-stage' : '') + '">' + surfaceMarkup('expanded', preview) + '<div class="farm-world-status"><span class="farm-weather">' + (lighting === 'night' ? '☾ 星夜小院' : host.icon('sun') + '晴日小院') + '</span><strong>' + e(shortStatus(s)) + '</strong></div>' + (preview ? '<span class="farm-preview-label">布置预览</span>' : '') + cameraTools() + '</div></div>';
  }
  function yard(s) { return worldStage(s) + tabs('fields') + '<div class="farm-yard-tray">' + plotTiles(s) + '</div>' + toolbar(s, true); }
  function seedBody(s, d) {
    var empty = s.plots.filter(function (p) { return p.status === 'empty' && (!d.plotId || p.id === d.plotId); }), selected = find(s.crops, d.cropId || 'carrot');
    if (!selected || !selected.unlocked) selected = s.crops.filter(function (crop) { return crop.unlocked; })[0];
    d.cropId = selected ? selected.id : 'carrot';
    return '<div class="farm-intro"><h3>' + (d.plotId ? (find(s.plots, d.plotId).index + 1) + '号田' : empty.length + '块空田') + ' · 选择种子</h3><p>免费 · 8小时成熟</p></div><div class="farm-seeds">' + s.crops.map(function (crop) { return b('farm-crop', art(crop.id) + '<strong>' + e(crop.name) + '</strong><small>' + (crop.unlocked ? '8小时 · 每田3份' : crop.threshold + '成长值开放') + '</small>', 'farm-seed' + (d.cropId === crop.id ? ' selected' : ''), crop.id, !crop.unlocked).replace('<button ', '<button aria-pressed="' + (d.cropId === crop.id) + '" '); }).join('') + '</div><p class="farm-note">' + (empty.length ? '待播种 · ' + empty.length + '块' + e(CROP_NAMES[d.cropId]) + '田' : '空田 0') + '</p><div class="farm-bottom-action">' + b('farm-plant', '种下' + (empty.length || '') + '块田', 'btn primary', '', blocked() || !empty.length || !selected) + '</div>';
  }
  function plotBody(s, d) {
    var p = find(s.plots, d.plotId); if (!p) return '<p class="farm-note">田地状态已更新</p>';
    var threshold = [0, 0, 30, 100, 250, 500][p.index];
    return '<div class="farm-detail-art">' + (p.cropId ? art(p.cropId) : host.icon(p.unlocked ? 'leaf' : 'lock')) + '</div><div class="farm-intro"><h3>' + (p.index + 1) + '号田 · ' + e(p.cropId ? CROP_NAMES[p.cropId] : '小田地') + '</h3><p>' + e(p.status === 'locked' ? threshold + '成长值开放' : p.status === 'empty' ? '待播种' : p.welcomeGift ? '欢迎礼物 · 萝卜 × 3' : p.status === 'ready' ? '已成熟 · 待收获' : '成熟时间 · ' + timeExact(p.readyAt)) + '</p></div><div class="farm-bottom-action">' + (p.status === 'ready' ? b('farm-harvest', '收获' + e(CROP_NAMES[p.cropId]) + ' × 3', 'btn primary', p.id, blocked()) : p.status === 'empty' ? b('farm-seeds', '选择种子', 'btn primary', p.id, blocked()) : p.status === 'growing' ? b('farm-water', host.icon('water') + '浇浇水', 'btn outline', p.id) : '') + '</div>';
  }
  function careBody(s) {
    var c = context();
    return tabs('animals') + '<div class="farm-companion-care"><div><h3>陪' + e(c.pet.name) + '玩一会儿</h3><p>免费互动</p></div><div class="farm-care-buttons">' + [['feed', 'snack', '喂一口'], ['wash', 'water', '洗洗澡'], ['train', 'ball', '玩一玩']].map(function (x) { return b('farm-pet-play', host.icon(x[1]) + x[2], 'btn outline', x[0]); }).join('') + '</div></div><div class="farm-animals">' + s.animals.map(function (a) { return b('farm-animal', art(a.id) + '<span><strong>' + e(a.name) + '</strong><small>' + (a.unlocked ? (a.caredToday ? '今天已照料' : '今天还没照料') + ' · 共' + a.careCount + '次' : a.threshold + '成长值来到小院') + '</small></span>' + host.icon('chevron'), 'farm-animal-row', a.id); }).join('') + '</div><p class="farm-note">每日记录 1 次 · 图鉴 3 次 · 动作 7 次</p>';
  }
  function animalBody(s, d) {
    var a = find(s.animals, d.animalId); if (!a) return '';
    return '<div class="farm-detail-art">' + art(a.id) + '</div><div class="farm-intro"><h3>' + e(a.name) + '</h3><p>' + (a.unlocked ? '累计照料 · ' + a.careCount + '天' : a.threshold + '成长值开放') + '</p></div><div class="farm-milestones"><div' + (a.cardUnlocked ? ' class="achieved"' : '') + '>' + host.icon(a.cardUnlocked ? 'check' : 'archive') + '<b>图鉴卡</b><small>累计3次</small></div><div' + (a.actionUnlocked ? ' class="achieved"' : '') + '>' + host.icon(a.actionUnlocked ? 'check' : 'spark') + '<b>' + (a.id === 'rabbit' ? '开心跳跳' : '扑扑翅膀') + '</b><small>累计7次</small></div></div><div class="farm-bottom-action">' + b('farm-animal-care', host.icon('heart') + (a.caredToday ? '再陪它玩玩' : '照料一下'), 'btn primary', a.id, !a.unlocked || (!a.caredToday && blocked())) + '</div><p class="farm-note">' + (a.caredToday ? '今日已照料' : '免费 · 今日待照料') + '</p>';
  }
  function buildBody(s) { return tabs('build') + basket(s) + '<div class="farm-intro"><h3>小院布置</h3></div><div class="farm-catalog">' + s.catalog.map(function (item) { var placed = item.slot === 'house' ? item.owned : s.placements[item.slot] === item.id; return b('farm-item', '<div class="farm-catalog-art">' + art(item.id) + '<span class="farm-item-state">' + (placed ? item.slot === 'house' ? '已升级' : '已摆放' : item.owned ? '已拥有' : item.unlocked ? '可预览' : item.threshold + '成长值') + '</span></div><div class="farm-catalog-copy"><strong>' + e(item.name) + '</strong><small>' + e(SLOT_NAMES[item.slot]) + '</small><div class="farm-price-line">' + costs(item.cost) + '</div></div>', 'farm-catalog-item', item.id); }).join('') + '</div>'; }
  function itemBody(s, d) {
    var item = find(s.catalog, d.itemId); if (!item) return '';
    var placed = item.slot !== 'house' && s.placements[item.slot] === item.id, other = item.slot !== 'house' && find(s.catalog, s.placements[item.slot]);
    var description = item.slot === 'house' ? '小屋升级' : e(SLOT_NAMES[item.slot]) + (other && other.id !== item.id ? ' · 替换' + e(other.name) : ' · 装饰');
    var action = item.owned ? item.slot === 'house' ? '<p class="farm-owned-note">' + host.icon('check') + '已经完成这级升级</p>' : placed ? b('farm-remove', '收起装饰', 'btn outline', item.slot, blocked()) : b('farm-place', '摆在' + e(SLOT_NAMES[item.slot]), 'btn primary', item.id, blocked()) : b('farm-exchange', item.slot === 'house' ? '确认升级' : '确认兑换', 'btn primary', item.id, blocked() || !item.canBuy);
    return '<div class="farm-intro"><h3>' + e(item.name) + '</h3><p>' + description + '</p></div>' + (!item.owned ? '<div class="farm-cost-detail">' + costs(item.cost, s.inventory) + '</div><p class="farm-note">' + e(!item.unlocked ? item.threshold + '成长值开放 · 还差' + Math.max(0, item.threshold - context().growth.xp) : item.canBuy ? '可兑换' : '作物不足') + '</p>' : '') + '<div class="farm-bottom-action">' + action + '</div>';
  }
  function collectionBody(s) {
    return tabs('collection') + basket(s) + '<h3 class="farm-section-title">小动物图鉴</h3><div class="farm-collection-cards">' + s.animals.map(function (a) { return b('farm-animal', art(a.id) + '<strong>' + e(a.name) + '</strong><small>' + (a.cardUnlocked ? '图鉴已点亮' : '照料' + Math.min(a.careCount, 3) + '/3次') + '</small>', 'farm-album-card' + (a.cardUnlocked ? ' achieved' : ''), a.id); }).join('') + '</div><h3 class="farm-section-title">一路走来的回忆</h3><div class="farm-collection-links">' + b('pet-growth', host.icon('spark') + '伙伴成长足迹' + host.icon('chevron'), 'farm-link') + b('pet-hub', host.icon('archive') + '旧探索与道具' + host.icon('chevron'), 'farm-link') + b('pet-config', host.icon('settings') + '伙伴设置' + host.icon('chevron'), 'farm-link') + '</div>';
  }
  function panel(f) {
    var s = status(), d = f.data, view = d.view || 'yard', body = '', title = '伙伴的小院';
    if (!s.initialized) { body = '<div class="farm-intro"><h3>我的小院</h3></div>' + toolbar(s); }
    else if (view === 'yard') body = yard(s);
    else if (view === 'seed') { title = '播种'; body = seedBody(s, d); }
    else if (view === 'plot') { title = '我的田地'; body = plotBody(s, d); }
    else if (view === 'care') { title = '小院的朋友'; body = careBody(s); }
    else if (view === 'animal') { title = '照料小动物'; body = animalBody(s, d); }
    else if (view === 'build') { title = '背包与建设'; body = buildBody(s); }
    else if (view === 'item') { title = '看看布置效果'; body = itemBody(s, d); }
    else if (view === 'collection') { title = '小院收藏'; body = collectionBody(s); }
    var game = s.initialized, isYard = view === 'yard' && game;
    var content = isYard ? body : '<div class="sheet-body farm-panel-body' + (game ? ' farm-focus-panel' : '') + '">' + body + '</div>';
    if (game && !isYard) content = worldStage(s, view === 'item' ? d.itemId : '') + content;
    var all = '<p id="form-error" class="form-error farm-error" role="alert" hidden></p>' + retryNotice() + content;
    var actions = b('farm-home', host.icon('back') + '<span>积分首页</span>', 'text-button farm-home-link', '', false, '返回积分首页');
    return host.sheet(title, (context().local ? '本机小院' : '家庭共享小院') + (ready() ? '' : ' · 连接中断'), all, actions).replace('class="sheet"', 'class="sheet farm-sheet' + (game ? ' farm-game-sheet' + (isYard ? ' farm-yard-sheet' : ' farm-detail-sheet') : '') + '"');
  }
  function open(view, extra, replace) { var d = extra || {}; d.view = view; host.open(d, !!replace); }
  function handle(action, id) {
    if (!scopeReady() || action.indexOf('farm-') !== 0) return false;
    var s = status(), f = context().form, a, item, plotIds;
    if (action === 'farm-zoom-in' || action === 'farm-zoom-out' || action === 'farm-camera-reset') {
      if (controller && controller.camera) controller.camera(action === 'farm-camera-reset' ? { reset: true } : { zoomBy: action === 'farm-zoom-in' ? 1.2 : 1 / 1.2 });
    }
    else if (action === 'farm-lighting') { lighting = lighting === 'night' ? 'day' : 'night'; host.render(); }
    else if (action === 'farm-home') host.home();
    else if (action === 'farm-retry') host.retry();
    else if (action === 'farm-start') host.act({ type: 'farm.start' }, '小院已开启');
    else if (action === 'farm-open') open('yard');
    else if (action === 'farm-tab') open({ fields: 'yard', animals: 'care', build: 'build', collection: 'collection' }[id] || 'yard', {}, !!(f && f.kind === 'farm' && ['yard', 'care', 'build', 'collection'].indexOf(f.data.view) >= 0));
    else if (action === 'farm-care') open('care');
    else if (action === 'farm-plot') open('plot', { plotId: id });
    else if (action === 'farm-seeds') open('seed', { plotId: id || '', cropId: 'carrot' });
    else if (action === 'farm-crop') { if (f && f.kind === 'farm') { f.data.cropId = id; host.render(); } }
    else if (action === 'farm-plant') { if (f && f.kind === 'farm') { a = { type: 'farm.plant', cropId: f.data.cropId || 'carrot' }; if (f.data.plotId) a.plotIds = [f.data.plotId]; host.act(a, '种好啦，8小时后再来看看'); } }
    else if (action === 'farm-harvest') { a = { type: 'farm.harvest' }; if (id) a.plotIds = [id]; host.act(a, '收获已放进背包'); }
    else if (action === 'farm-water') { react('water', id); host.toast('浇浇水，陪它慢慢长大'); }
    else if (action === 'farm-pet-play') { host.petPlay(id); }
    else if (action === 'farm-animal') open('animal', { animalId: id });
    else if (action === 'farm-animal-care') { var animal = find(s.animals, id); if (animal && animal.unlocked) { if (animal.caredToday) { react('care', id); host.toast(animal.actionUnlocked ? (id === 'rabbit' ? '兔子开心地跳了起来' : '小鸡扑扑翅膀回应你') : animal.name + '很喜欢和你一起玩'); } else host.act({ type: 'farm.animalCare', animalId: id, care: 'feed' }, '今天的照料记下啦'); } }
    else if (action === 'farm-item') open('item', { itemId: id });
    else if (action === 'farm-exchange') { item = find(s.catalog, id); if (item) host.act({ type: 'farm.exchange', itemId: id }, item.slot === 'house' ? '小屋升级啦！' : item.name + '已加入收藏'); }
    else if (action === 'farm-place') { item = find(s.catalog, id); if (item) host.act({ type: 'farm.place', slot: item.slot, itemId: id }, '已经布置好啦'); }
    else if (action === 'farm-remove') host.act({ type: 'farm.place', slot: id, itemId: null }, '装饰已收进收藏');
    return true;
  }
  function sceneSelect(target) {
    if (!target || context().pending || context().auth) return;
    var s = status();
    if (target.type === 'pet') { host.touchPet(); return; }
    if (!s.initialized) { host.toast('开启小院后就能一起种田啦'); return; }
    if (context().form && context().form.kind === 'farm' && context().form.data.view === 'item') return;
    if (target.type === 'plot') open('plot', { plotId: target.id });
    else if (target.type === 'animal') open('animal', { animalId: target.id });
    else if (target.type === 'house') open('item', { itemId: s.houseLevel < 2 ? 'house2' : 'house3' });
    else if (target.type === 'slot') { var itemId = s.placements[target.id]; if (itemId) open('item', { itemId: itemId }); else open('build'); }
  }
  function viewInsets(target, mode) {
    var inset = { top: 0, right: 0, bottom: 0, left: 0 };
    if (mode !== 'expanded' || !target.getBoundingClientRect) return inset;
    var box = target.getBoundingClientRect(), panel = document.querySelector('.farm-focus-panel'), header = document.querySelector('.farm-game-sheet .sheet-header'), tray = document.querySelector('.farm-yard-tray');
    if (header) inset.top = Math.max(0, header.getBoundingClientRect().bottom - box.top + 10);
    if (panel) {
      var p = panel.getBoundingClientRect();
      if (p.width < box.width * .65 && p.left > box.left + box.width * .3) inset.right = Math.max(0, box.right - p.left + 10);
      else inset.bottom = Math.max(0, box.bottom - p.top + 10);
    } else if (tray) inset.bottom = Math.max(0, box.bottom - tray.getBoundingClientRect().top + 8);
    return inset;
  }
  function prepareFocus(c, mode, s, item) {
    var d = c.form && c.form.kind === 'farm' ? c.form.data : {}, key = [mode, d.view || '', d.plotId || '', d.animalId || '', d.itemId || ''].join(':');
    if (key === focusKey) return;
    focusKey = key; pendingFocus = null;
    if (mode !== 'expanded') return;
    if (d.view === 'item' && item) pendingFocus = { type: item.slot === 'house' ? 'house' : 'slot', id: item.slot === 'house' ? 'house' : item.slot };
    else if ((d.view === 'plot' || d.view === 'seed') && d.plotId) pendingFocus = { type: 'plot', id: d.plotId };
    else if (d.view === 'seed') { var empty = s.plots.filter(function (p) { return p.status === 'empty'; }); if (empty.length) pendingFocus = { type: 'plot', id: empty[0].id }; }
    else if (d.view === 'animal') pendingFocus = { type: 'animal', id: d.animalId };
    else if (d.view === 'care' || d.view === 'collection') pendingFocus = { type: 'pet', id: 'pet' };
  }
  function showSceneStatus(info) {
    if (info.ready) { sceneState = 'ready'; sceneError = ''; }
    else if (info.error || info.webgl === false) { sceneState = 'unavailable'; sceneError = info.error || '3D画面暂不可用'; }
    if (sceneState === 'ready' && controller && controller.focus && pendingFocus) { var focus = pendingFocus; pendingFocus = null; controller.focus(focus); }
    var controls = document.querySelectorAll('.farm-camera-button');
    for (var j = 0; j < controls.length; j++) controls[j].disabled = sceneState !== 'ready';
    var notices = document.querySelectorAll('.farm-scene-fallback');
    for (var i = 0; i < notices.length; i++) { notices[i].hidden = sceneState === 'ready'; if (sceneState === 'unavailable') notices[i].innerHTML = '<div>' + art('flowerpot') + '<strong>3D画面暂不可用</strong><p>按钮操作可用。</p></div>'; }
  }
  function beforeRender() { if (surface && surface.parentNode) surface.parentNode.removeChild(surface); }
  function afterRender() {
    if (!scopeReady()) { if (controller) controller.pause(true); return; }
    var generation = sceneEpoch;
    var c = context(), nodes = document.querySelectorAll('[data-farm-scene]'), target = null;
    for (var i = 0; i < nodes.length; i++) { if (!c.form || (c.form.kind === 'farm' && nodes[i].closest('.sheet'))) target = nodes[i]; }
    visible = !!target && !c.auth && c.view === 'points';
    if (!visible) { if (controller) controller.pause(true); return; }
    var mode = target.getAttribute('data-farm-scene'), s = status(), preview = target.getAttribute('data-preview-item'), item = preview && find(s.catalog, preview);
    if (item && s.initialized) { s = copy(s); if (item.slot === 'house') s.houseLevel = item.id === 'house3' ? 3 : 2; else s.placements[item.slot] = item.id; }
    prepareFocus(c, mode, s, item);
    var opts = { mode: mode, farm: s, pet: c.pet, growth: c.growth, viewInsets: viewInsets(target, mode), lighting: lighting, reducedMotion: c.reducedMotion, onSelect: function (target) { if (generation === sceneEpoch && scopeReady()) sceneSelect(target); }, onStatus: function (info) { if (generation === sceneEpoch && scopeReady()) showSceneStatus(info); } };
    if (!surface) { surface = document.createElement('div'); surface.className = 'farm-render-surface'; }
    target.insertBefore(surface, target.firstChild);
    try {
      if (!controller && root.FamilyFarmScene) controller = root.FamilyFarmScene.mount(surface, opts);
      else if (controller) controller.update(opts);
      if (controller) { controller.pause(document.hidden); controller.resize(); }
      else if (!root.FamilyFarmScene) showSceneStatus({ webgl: false, error: '场景文件未加载' });
    } catch (err) { if (controller) controller.dispose(); controller = null; showSceneStatus({ webgl: false, error: err.message }); }
    activeMode = mode; showSceneStatus({ ready: sceneState === 'ready' }); tickKey = timingKey(status());
  }
  function timingKey(s) { var c = context(); return JSON.stringify([s.initialized, c.familyDay, s.animals.map(function (a) { return [a.id, a.caredToday, a.careCount]; }), s.plots.map(function (p) { return [p.status, Math.ceil((p.remainingMs || 0) / 60000)]; }), c.connected, c.pending, c.retry && c.retry.uncertain]); }
  function tick() { if (!scopeReady() || !root.FamilyModel.farmStatus) return; var c = context(); if (c.view !== 'points' || c.auth || (c.form && c.form.kind !== 'farm')) return; var next = timingKey(status()); if (next !== tickKey) { tickKey = next; host.render(); } }
  function react(kind, target) { if (controller) controller.react(kind, target); }
  function complete(action) { if (/^farm\./.test(action.type)) { var s = status(); if (action.type === 'farm.harvest') { if (s.lastHarvest && s.lastHarvest.id === action.id) { var crops = s.lastHarvest.crops; host.toast(Object.keys(CROP_NAMES).filter(function (id) { return crops[id]; }).map(function (id) { return CROP_NAMES[id] + ' +' + crops[id]; }).join(' · ')); } else host.toast('收获结果已同步到背包'); } react(action.type === 'farm.harvest' ? 'harvest' : action.type === 'farm.animalCare' ? 'care' : 'celebrate', action.animalId); } }
  function dispose() { sceneEpoch++; if (controller) controller.dispose(); controller = null; if (surface && surface.parentNode) surface.parentNode.removeChild(surface); surface = null; visible = false; activeMode = ''; sceneState = 'loading'; sceneError = ''; tickKey = ''; focusKey = ''; pendingFocus = null; lighting = 'day'; }
  root.FamilyFarmUI = { setup: function (adapter) { host = adapter; }, home: home, panel: panel, handle: handle, beforeRender: beforeRender, afterRender: afterRender, tick: tick, react: react, complete: complete, dispose: dispose, status: status, diagnostics: function () { return { visible: visible, mode: activeMode, sceneState: sceneState, sceneError: sceneError, renderer: controller && controller.diagnostics ? controller.diagnostics() : null }; } };
  document.addEventListener('visibilitychange', function () { if (controller) controller.pause(document.hidden || !visible || !scopeReady()); });
  root.addEventListener('pagehide', function () { if (controller) controller.pause(true); });
  root.addEventListener('pageshow', function () { if (host) afterRender(); });
  root.addEventListener('resize', function () { if (host && visible) root.requestAnimationFrame(function () { afterRender(); }); });
}(window));
