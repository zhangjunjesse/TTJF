/* Farm-world presentation only. Forms and server-authorized actions stay in their hosts. */
(function (root) {
  'use strict';
  var sceneSource = document.currentScript && document.currentScript.getAttribute('data-scene-src');
  var sceneWaiters = [], sceneLoading = false, sceneFailed = false, waitingForSession = false;
  // Both scene hosts share the download. Callbacks read the current route again
  // so finishing a download can never restore a family or page the user left.
  function loadScene(whenLoaded) {
    if (!sceneSource || sceneFailed || root.FamilyFarmScene) return false;
    if (sceneWaiters.indexOf(whenLoaded) < 0) sceneWaiters.push(whenLoaded);
    if (!sceneLoading) {
      sceneLoading = true;
      var script = document.createElement('script');
      script.src = sceneSource;
      script.onload = script.onerror = function () {
        sceneLoading = false;
        sceneFailed = !root.FamilyFarmScene;
        sceneWaiters.splice(0).forEach(function (resume) { resume(); });
      };
      document.head.appendChild(script);
    }
    return true;
  }
  var controller = null, stage = null, surface = null, route = 'farm', projection = null, epoch = 0, resizeFrame = 0;
  var media = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var places = {
    welcome: ['欢迎回到小小向前', '把每天的小进步，种成一座小农场。', '从这里出发'],
    points: ['星星工坊', '认真做好的每一件小事，都值得被记住。', '收集今天的进步'],
    reminders: ['林间告示板', '把重要的小事放在这里，慢慢完成。', '今天的安排'],
    rewards: ['心愿集市', '用一点一滴的积累，换一份期待。', '让愿望开花'],
    history: ['成长档案馆', '走过的每一步，都在这里留下足迹。', '回看一路的成长'],
    companion: ['伙伴营地', '一起照料、探索，也一起长大。', '陪伴的小日子'],
    settings: ['小院管理屋', '把小院调整成适合一家人的样子。', '整理我们的生活'],
    family: ['家庭小屋', '一家人在同一座小院里，分享成长。', '有家人的地方'],
    voice: ['风车传话站', '说说你的想法，一起安排接下来的小事。', '把想法说出来'],
    authorization: ['家长守护屋', '请家长确认这一步，再一起继续。', '安心地向前']
  };
  var formPlaces = {
    behaviorPicker: 'points', points: 'points', 'point-list': 'points', pointItem: 'points',
    rewards: 'rewards', 'reward-list': 'rewards', reward: 'rewards', request: 'rewards', approve: 'rewards',
    records: 'history', recordDetail: 'history', homeWeek: 'history', petGrowth: 'history', homeInbox: 'reminders', task: 'reminders', taskAction: 'reminders',
    petHub: 'companion', petBuy: 'companion', petConfig: 'companion',
    preferences: 'settings', profile: 'family', familySettings: 'family', parentConfig: 'authorization', parentDevice: 'authorization', voice: 'voice'
  };
  var accountPlaces = {
    account: 'family', families: 'family', onboarding: 'family', create: 'family', join: 'family', invite: 'family',
    'family-settings': 'family', 'rename-family': 'family', 'transfer-owner': 'family', 'leave-family': 'family',
    'delete-family': 'family', members: 'family', confirm: 'family', password: 'authorization', 'delete-account': 'authorization'
  };
  function businessRoute(view, kind, auth) {
    if (auth) return 'authorization';
    if (kind === 'farm') return 'farm';
    if (kind) return formPlaces[kind] || 'settings';
    return view === 'reminders' ? 'reminders' : 'farm';
  }
  // This is an anonymous illustration, never a fabricated family balance or saved state.
  function publicProjection() {
    return { farm: { initialized: true, houseLevel: 1, plots: [], animals: [], placements: {} },
      pet: { kind: 'plant', name: '芽芽' }, growth: { stage: 1, stars: 0, xp: 0 } };
  }
  function ensureStage() {
    if (stage) return;
    stage = document.createElement('div'); stage.id = 'world-stage'; stage.hidden = true;
    stage.setAttribute('aria-hidden', 'true');
    stage.innerHTML = '<div class="world-stage-surface"></div><div class="world-stage-shade"></div>' +
      '<div class="world-caption"><span class="world-eyebrow"></span><h2></h2><p></p></div>' +
      '<div class="world-scene-fallback"><span>小院正在醒来…</span></div>';
    document.body.insertBefore(stage, document.getElementById('app'));
    surface = stage.querySelector('.world-stage-surface');
  }
  function insets() {
    var panel = document.querySelector('.sheet') || document.querySelector('.saas-card') || document.querySelector('.reminders-screen');
    var box = panel && panel.getBoundingClientRect(), w = root.innerWidth, h = root.innerHeight;
    if (!box) return { top: 0, right: 0, bottom: 0, left: 0 };
    return box.left >= w * .35 && box.width < w * .7 ?
      { top: 70, right: Math.max(0, w - box.left), bottom: 80, left: 0 } :
      { top: 0, right: 0, bottom: Math.max(0, h - box.top), left: 0 };
  }
  function updateStatus(info, generation) {
    if (generation !== epoch || !stage) return;
    stage.setAttribute('data-scene-state', info.ready ? 'ready' : info.error ? 'unavailable' : 'loading');
    var fallback = stage.querySelector('.world-scene-fallback');
    fallback.hidden = !!info.ready;
    fallback.textContent = info.error ? '小院画面暂不可用 · 各项操作仍可使用' : '小院正在醒来…';
    // The surrounding controls carry all semantics; a decorative canvas never enters a modal's tab order.
    var canvas = surface.querySelector('canvas'); if (canvas) canvas.tabIndex = -1;
  }
  function refresh() {
    if (!stage || stage.hidden || !projection) return;
    if (!root.FamilyFarmScene && (waitingForSession || loadScene(refresh))) {
      updateStatus({}, epoch);
      return;
    }
    var generation = epoch, options = {
      presentation: route, mode: 'home', farm: projection.farm, pet: projection.pet, growth: projection.growth,
      reducedMotion: !!(media && media.matches), viewInsets: insets(),
      onStatus: function (info) { updateStatus(info, generation); }
    };
    try {
      if (!controller && root.FamilyFarmScene) controller = root.FamilyFarmScene.mount(surface, options);
      else if (controller) controller.update(options);
      if (controller) { controller.pause(document.hidden); controller.resize(); }
      else updateStatus({ error: 'SCENE_MISSING' }, generation);
      var canvas = surface.querySelector('canvas'); if (canvas) canvas.tabIndex = -1;
    } catch (error) {
      if (controller) controller.dispose(); controller = null;
      updateStatus({ error: 'SCENE_UNAVAILABLE' }, generation);
    }
  }
  function scheduleResize() {
    if (resizeFrame) return;
    resizeFrame = root.requestAnimationFrame(function () { resizeFrame = 0; refresh(); });
  }
  function show(next, value, context) {
    route = next; document.body.setAttribute('data-world-route', route);
    document.body.setAttribute('data-world-context', context);
    document.body.setAttribute('data-world-layout', value.ledgerPage ? 'page' : 'scene');
    // Ledger sheets keep their real home behind them. The farm owns its own renderer.
    if (route === 'farm' || value.ledgerPage) { reset(); return; }
    ensureStage(); stage.hidden = false; projection = value;
    var copy = places[route];
    stage.querySelector('.world-eyebrow').textContent = copy[2];
    stage.querySelector('h2').textContent = copy[0]; stage.querySelector('.world-caption p').textContent = copy[1];
    refresh();
  }
  function reset() {
    epoch++; projection = null;
    if (resizeFrame) root.cancelAnimationFrame(resizeFrame); resizeFrame = 0;
    if (controller) controller.dispose(); controller = null;
    if (stage) { stage.hidden = true; surface.textContent = ''; }
  }
  root.FamilyWorldUI = {
    business: function (options) { waitingForSession = false; show(businessRoute(options.view, options.kind, options.auth), options, 'business'); },
    account: function (view) { waitingForSession = view === 'checking' || view === 'loading-family'; show(accountPlaces[view] || 'welcome', publicProjection(), 'account'); },
    loadScene: loadScene,
    reset: reset,
    diagnostics: function () { return { route: route, visible: !!stage && !stage.hidden, renderer: controller && controller.diagnostics() }; }
  };
  root.addEventListener('resize', scheduleResize);
  if (root.visualViewport) root.visualViewport.addEventListener('resize', scheduleResize);
  if (media) { if (media.addEventListener) media.addEventListener('change', scheduleResize); else if (media.addListener) media.addListener(scheduleResize); }
  document.addEventListener('visibilitychange', function () { if (controller) controller.pause(document.hidden || !stage || stage.hidden); });
  root.addEventListener('pagehide', function () { if (controller) controller.pause(true); });
  root.addEventListener('pageshow', scheduleResize);
}(window));
