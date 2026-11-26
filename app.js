/* v0.9: app navigation with per-action parent authorization. */
(function () {
  'use strict';
  var Farm = window.FamilyFarmUI, M = window.FamilyModel, KEY = 'little-steps-demo-v1', PREF = 'little-steps-preferences';
  var DRAFT = 'little-steps-drafts-v03', PRIVATE = 'little-steps-parent-private-v03', SOUND = 'ttjf-saas-device-sound-v1';
  var saas = window.__TTJF_SAAS__ === true, SaaS = window.FamilySaas;
  var chat = saas ? window.FamilyAssistantPanel : null;
  var AwardPhotos = saas ? window.FamilyAwardPhotos : null, awardPhotoDrafts = {}, awardPhotoSelection = null;
  var local = !saas && (location.protocol === 'file:' || window.__FAMILY_OFFLINE__ === true), state = null, revision = 0, connected = false, serverReached = false;
  var syncBusy = false, pending = false, retryTx = null, submittedAwards = {}, setupTx = null, parentRevision = -1, recognition = null, toastTimer, wakeLock = null;
  var assistantSequence = 0, avatarSequence = 0, petTimer = null, familyDay = null, serverTime = 0, serverReceived = 0, avatarSelection = null;
  function monotonic() { return window.performance && window.performance.now ? window.performance.now() : Date.now(); }
  function farmClock() { return !local && serverTime ? new Date(serverTime + Math.max(0, monotonic() - serverReceived)) : new Date(); }
  var privateConfig = readStore(PRIVATE, null), drafts = readStore(DRAFT, {}), reminderSound = '';
  var meta = { parent: { configured: null, method: null }, assistant: { mode: 'local', label: '指令演示' } };
  var parentDevice = { enabled: null, loading: false, busy: false, sequence: 0 };
  var homePreferenceKey = 'ttjf-device-home-v1';
  var themeTag = document.querySelector('meta[name="theme-color"]');
  var defaultTheme = themeTag && themeTag.content;
  function syncThemeColor() {
    if (!themeTag) return;
    var edge = window.getComputedStyle(document.documentElement).getPropertyValue('--points-sheet-edge').trim();
    var color = edge || defaultTheme;
    if (themeTag.content !== color) themeTag.content = color;
  }
  function savedHomeMode() {
    try {
      var mode = localStorage.getItem(homePreferenceKey);
      return mode === 'points' || mode === 'companion' ? mode : null;
    } catch (e) { return null; }
  }
  function initialHomeMode() {
    var compact = window.innerWidth < 700 || window.innerHeight < 520;
    return savedHomeMode() || (compact ? 'points' : 'companion');
  }
  function freshUI() { return { view: 'points', day: 0, reminderMode: 'near', filter: 'all', history: 'points', form: null, stack: [], auth: null, sound: false, display: false, assistantBusy: false, petReaction: 'idle', petMessage: '', homeFeedback: '', careBusy: false, petTab: 'bag', petTouches: 0 }; }
  var ui = freshUI();
  function scopeReady() { return !saas || !!(SaaS && SaaS.ready() && state); }
  function scopeToken() { return saas && SaaS ? SaaS.capture() : null; }
  function scopeCurrent(token) { return !saas || !!(SaaS && SaaS.current(token) && scopeReady()); }
  function trackScope(dispose) { return saas && SaaS ? SaaS.track(dispose) : function () {}; }
  function awardPhotoKey(f) {
    var binding = f.assistantDraft;
    return binding ? 'assistant:' + binding.generation + ':' + binding.turnId + ':' + binding.actionId : draftKey(f);
  }
  function awardPhotos(f) {
    if (!AwardPhotos || !f || f.kind !== 'points') return null;
    var key = awardPhotoKey(f);
    if (f.awardPhotoKey && f.awardPhotoKey !== key) discardAwardPhotos(f);
    if (f.awardPhotoKey !== key || !f.awardPhotos || awardPhotoDrafts[key] !== f.awardPhotos) {
      f.awardPhotoKey = key; f.awardPhotos = awardPhotoDrafts[key] || AwardPhotos.createDraft();
      awardPhotoDrafts[key] = f.awardPhotos;
    }
    return f.awardPhotos;
  }
  function awardPhotosReady(f) { var draft = awardPhotos(f); return !draft || AwardPhotos.ready(draft); }
  function addAwardPhotoIds(action, f) {
    var draft = awardPhotos(f), ids = draft ? AwardPhotos.ids(draft) : [];
    if (ids.length) action.photoIds = ids; else delete action.photoIds;
    return action;
  }
  function updateAwardPhotoAction(auth) {
    if (!auth || auth.recoveryAward || auth.phase !== 'confirm' || auth.tx.action.type !== 'points.add') return;
    addAwardPhotoIds(auth.tx.action, auth.tx.form);
    auth.tx.signature = awardSignature(auth.tx.action); auth.tx.grant = null;
  }
  function recoverUnavailableAwardPhotos(tx) {
    if (!AwardPhotos || tx.action.type !== 'points.add' || !tx.form || tx.form !== ui.form || tx.form.kind !== 'points') return false;
    var draft = awardPhotos(tx.form), rejected = tx.action.photoIds || [];
    var changed = AwardPhotos.unavailable(draft, rejected, awardPhotoRequestEnvironment());
    var interrupted = submittedAwards[tx.action.id];
    if (!changed && !interrupted) return false;
    if (interrupted) {
      delete submittedAwards[tx.action.id]; tx.grant = null; tx.uncertain = false;
      if (retryTx === tx) retryTx = null;
      if (ui.auth && ui.auth.tx === tx) ui.auth = null;
      AwardPhotos.closeViewer(); render(false); showError('照片已过期或失效，请重试、重拍，或选择只记积分。'); return true;
    }
    tx.grant = null; tx.uncertain = false; tx.signature = ''; addAwardPhotoIds(tx.action, tx.form);
    var auth = ui.auth && ui.auth.tx === tx ? ui.auth : null;
    if (auth) {
      auth.phase = 'confirm'; auth.busy = false; auth.autoPin = null; auth.challengeId = null; auth.expiresAt = null;
      auth.question = ''; auth.pristinePresetReview = false; delete auth.localAnswer;
      updateAwardPhotoAction(auth);
    } else if (retryTx === tx) retryTx = null;
    AwardPhotos.closeViewer(); render(false); showError('照片已过期或失效，请重试、重拍，或选择只记积分。');
    return true;
  }
  function awardPhotoRequestEnvironment() {
    var scope = scopeToken();
    return { scope: scope, current: function () { return scopeCurrent(scope); }, request: function (method, url, data, done) {
      return scopeCurrent(scope) ? request(method, url, data, done) : null;
    } };
  }
  function awardPhotoEnvironment(f) {
    var env = awardPhotoRequestEnvironment(), draft = awardPhotos(f), key = f.awardPhotoKey;
    function active() { return env.current() && awardPhotoDrafts[key] === draft; }
    env.active = active;
    env.beforePick = function (input) { return prepareAwardPhotoInput(input, f, draft).input; };
    env.refresh = function () {
      if (!active() || !ui.form || awardPhotos(ui.form) !== draft) return;
      rememberDraft(); updateAwardPhotoAction(ui.auth); render(false);
    };
    return env;
  }
  function savedAwardPhotoDrafts() {
    // This snapshot only lives inside the session-verified resume object. Files and credentials never enter it.
    var saved = {};
    Object.keys(awardPhotoDrafts).forEach(function (key) {
      var draft = awardPhotoDrafts[key];
      saved[key] = { nextKey: draft.nextKey, replaceKey: null, notice: draft.notice, items: draft.items.map(function (item) {
        return { key: item.key, photoId: item.photoId, uploadId: item.uploadId, dataUrl: item.dataUrl,
          error: item.photoId ? '' : item.error || (item.dataUrl ? '照片上传已暂停，请重试。' : '照片准备已暂停，请重拍或重新选择。') };
      }) };
    });
    return saved;
  }
  function discardAwardPhotoInput() {
    var picker = awardPhotoSelection; if (!picker) return;
    if (picker.draft) picker.draft.replaceKey = null;
    awardPhotoSelection = null; picker.cancelled = true; picker.permitted = false; picker.form = null; picker.draft = null;
    if (picker.input) picker.input.value = '';
    if (picker.input && picker.input.parentNode === document.body) picker.input.parentNode.removeChild(picker.input);
  }
  function prepareAwardPhotoInput(input, f, draft) {
    var replacement = draft.replaceKey;
    discardAwardPhotoInput();
    // Native choosers can stay open while an upload or sync rebuilds the entire form.
    var held = input.cloneNode(false); held.hidden = true; held.value = '';
    held.removeAttribute('id'); held.removeAttribute('name'); held.removeAttribute('form');
    held.setAttribute('data-saas-photo-hold', 'true'); document.body.appendChild(held);
    draft.replaceKey = replacement;
    awardPhotoSelection = { input: held, scope: scopeToken(), form: f, draft: draft, key: f.awardPhotoKey,
      replaceKey: replacement, permitted: true, cancelled: false, received: false, consumed: false };
    held.__familyAwardPhotoTicket = awardPhotoSelection;
    return awardPhotoSelection;
  }
  function cancelAwardPhotoInput(input) {
    var picker = input.__familyAwardPhotoTicket;
    if (picker && picker === awardPhotoSelection && picker.input === input && !picker.consumed) {
      discardAwardPhotoInput();
      if (scopeReady()) reconcileSubmittedAwards();
    }
  }
  function receiveAwardPhotoInput(input) {
    var picker = input.__familyAwardPhotoTicket;
    if (picker && (picker.cancelled || picker !== awardPhotoSelection || picker.input !== input || picker.consumed)) return;
    if (!picker) {
      if (awardPhotoSelection || !scopeReady() || pending || !ui.form || ui.form.kind !== 'points' || (ui.auth && ui.auth.phase !== 'confirm')) return;
      var editor = document.querySelector('.award-photo-editor');
      if (!editor || !editor.contains(input)) return;
      rememberDraft(); AwardPhotos.change(input, awardPhotos(ui.form), awardPhotoEnvironment(ui.form)); return reconcileSubmittedAwards();
    }
    picker.received = true;
    if (!picker.permitted || !scopeCurrent(picker.scope)) return;
    if (pending || ui.form !== picker.form || awardPhotos(ui.form) !== picker.draft || (ui.auth && ui.auth.phase !== 'confirm')) { discardAwardPhotoInput(); return; }
    picker.consumed = true;
    rememberDraft(); AwardPhotos.change(input, picker.draft, awardPhotoEnvironment(picker.form));
    if (awardPhotoSelection === picker) discardAwardPhotoInput();
    return reconcileSubmittedAwards();
  }
  function restoreAwardPhotoInput() {
    var picker = awardPhotoSelection;
    if (!picker) return;
    if (!ui.form || ui.form.kind !== 'points' || awardPhotoKey(ui.form) !== picker.key) { discardAwardPhotoInput(); return; }
    picker.scope = scopeToken(); picker.form = ui.form; picker.draft = awardPhotos(ui.form); picker.permitted = true;
    picker.draft.replaceKey = picker.draft.items.some(function (item) { return item.key === picker.replaceKey; }) ? picker.replaceKey : null;
    if (picker.received) return receiveAwardPhotoInput(picker.input);
  }
  function discardAwardPhotos(f, committedIds) {
    if (!f || !f.awardPhotos) return;
    var draft = f.awardPhotos, shared = [ui.form].concat(ui.stack).some(function (other) {
      return other && other !== f && other.awardPhotos === draft;
    });
    if (!shared || committedIds) {
      if (awardPhotoSelection && awardPhotoSelection.draft === draft) discardAwardPhotoInput();
      AwardPhotos.discard(draft, awardPhotoRequestEnvironment(), committedIds);
      if (awardPhotoDrafts[f.awardPhotoKey] === draft) delete awardPhotoDrafts[f.awardPhotoKey];
    }
    f.awardPhotos = null; f.awardPhotoKey = null;
  }
  function discardOpenAwardPhotos() { [ui.form].concat(ui.stack).forEach(function (f) { discardAwardPhotos(f); }); }
  function clearFamily(keepAvatar) {
    if (chat) chat.reset();
    if (!keepAvatar) discardAvatar();
    if (AwardPhotos) AwardPhotos.closeViewer();
    if (!keepAvatar) discardAwardPhotoInput();
    clearTimeout(toastTimer); clearTimeout(petTimer); toastTimer = null; petTimer = null;
    stopRecognition();
    [ui.form].concat(ui.stack || []).forEach(function (f) { if (f) { invalidateAssistant(f); f.avatarRequest = null; f.avatarBusy = false; f.awardPhotos = null; f.awardPhotoKey = null; f.data = {}; } });
    if (ui.auth) { ui.auth.autoPin = null; ui.auth.tx.grant = null; clearParentSecrets(ui.auth.tx); }
    if (retryTx) { retryTx.grant = null; clearParentSecrets(retryTx); }
    if (setupTx) { setupTx.cancelled = true; clearParentSecrets(setupTx); }
    if (wakeLock) { var oldLock = wakeLock; wakeLock = null; try { var release = oldLock.release(); if (release && release.catch) release.catch(function () {}); } catch (e) {} }
    ['complete', 'points', 'redeem'].forEach(function (name) { var audio = document.getElementById('sound-' + name); if (audio) { try { audio.pause(); audio.currentTime = 0; } catch (e) {} } });
    if (Farm) Farm.dispose();
    if (window.FamilyWorldUI) window.FamilyWorldUI.reset();
    state = null; revision = 0; parentRevision = -1; connected = false; serverReached = false;
    syncBusy = false; pending = false; retryTx = null; submittedAwards = {}; setupTx = null; privateConfig = null; drafts = {}; awardPhotoDrafts = {}; reminderSound = '';
    familyDay = null; serverTime = 0; serverReceived = 0; assistantSequence++; avatarSequence++; ui = freshUI();
    meta = { parent: { configured: null, method: null }, assistant: { mode: 'local', label: '指令演示' } };
    parentDevice = { enabled: null, loading: false, busy: false, sequence: 0 };
    var notice = document.getElementById('toast'); if (notice) { notice.textContent = ''; notice.className = 'toast'; notice.style.display = 'none'; }
    document.getElementById('app').innerHTML = ''; document.body.className = 'saas-screen';
    syncThemeColor();
  }
  function ordinary(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(ordinary);
    var out = {};
    Object.keys(value).forEach(function (key) { if (!/^(password|currentPassword|confirmPassword|credential|pin|confirmPin|setupPin|setupConfirm|answer|grant|challenge|challengeId|autoPin|tx|action|actionId|signature|token|csrfToken)$/i.test(key)) out[key] = ordinary(value[key]); });
    return out;
  }
  function savedForm(f) { return f ? { kind: f.kind, data: ordinary(f.data), assistantDraft: f.assistantDraft && clone(f.assistantDraft), openedRevision: f.openedRevision, ledgerAward: !!f.ledgerAward, aiOpen: !!f.aiOpen, pickerState: ordinary(f.pickerState || null), focusKey: ordinary(f.focusKey || null), weekView: ordinary(f.weekView || null), scrollTop: f.scrollTop || 0 } : null; }
  function copyAwardAction(action) {
    var saved = {};
    ['id', 'type', 'itemId', 'name', 'points', 'reason', 'at', 'saveAsTemplate', 'photoIds'].forEach(function (key) {
      if (action[key] !== undefined) saved[key] = ordinary(action[key]);
    });
    return saved;
  }
  function awardSignature(action) { var unsigned = copyAwardAction(action); delete unsigned.id; return JSON.stringify(unsigned); }
  function rememberSubmittedAward(tx) {
    if (!saas || tx.action.type !== 'points.add' || submittedAwards[tx.action.id]) return;
    submittedAwards[tx.action.id] = { action: copyAwardAction(tx.action), revision: tx.revision, previousGrowth: ordinary(tx.previousGrowth),
      assistantDraft: tx.assistantDraft && { generation: tx.assistantDraft.generation, turnId: tx.assistantDraft.turnId },
      form: tx.form, ledgerAward: !!tx.ledgerAward };
  }
  function savedSubmittedAwards() {
    var saved = {};
    Object.keys(submittedAwards).forEach(function (id) {
      var award = submittedAwards[id];
      saved[id] = { action: copyAwardAction(award.action), revision: award.revision, previousGrowth: ordinary(award.previousGrowth),
        assistantDraft: award.assistantDraft && ordinary(award.assistantDraft), ledgerAward: award.ledgerAward,
        form: savedForm(award.form), currentForm: award.form === ui.form, stackIndex: ui.stack.indexOf(award.form) };
    });
    return saved;
  }
  function restoreSubmittedAwards(saved, restoredStack) {
    Object.keys(saved || {}).forEach(function (id) {
      var value = saved[id];
      if (!value.action || value.action.type !== 'points.add' || value.action.id !== id) return;
      var award = submittedAwards[id] = { action: copyAwardAction(value.action), revision: value.revision, previousGrowth: ordinary(value.previousGrowth),
        assistantDraft: value.assistantDraft && ordinary(value.assistantDraft), ledgerAward: !!value.ledgerAward,
        form: value.currentForm ? ui.form : restoredStack[value.stackIndex] || value.form };
      if (award.form && award.form.kind === 'points') awardPhotos(award.form);
      if (award.form === ui.form) retryTx = { action: copyAwardAction(award.action), signature: awardSignature(award.action), revision: revision,
        previousGrowth: award.previousGrowth, assistantDraft: award.assistantDraft, ledgerAward: award.ledgerAward,
        form: award.form, grant: null, uncertain: true };
    });
  }
  function reconcileSubmittedAwards() {
    var completed = false;
    Object.keys(submittedAwards).forEach(function (id) { if (reconcileSubmittedAward(submittedAwards[id])) completed = true; });
    return completed;
  }
  function reconcileSubmittedAward(award) {
    if (!award) return false;
    var id = award.action.id, record = find(state.points, 'points-' + id);
    if (!record) {
      // A newer ledger version excludes this request: its old revision can no longer commit.
      if (revision > award.revision && !(ui.auth && ui.auth.tx.action.id === id) && !(pending && retryTx && retryTx.action.id === id)) {
        delete submittedAwards[id]; if (retryTx && retryTx.action.id === id) retryTx = null;
      }
      return false;
    }
    if (pending && (!retryTx || !retryTx.inFlight || retryTx.action.id !== id)) return false;
    if (ui.auth && ui.auth.tx.action.id !== id) return false;
    // Wait for change or cancel before deciding whether this chooser has edited the completed draft.
    if (awardPhotoSelection && !awardPhotoSelection.consumed && ui.form && ui.form.kind === 'points' && awardPhotoKey(ui.form) === awardPhotoSelection.key) return false;
    var tx = retryTx && retryTx.action.id === id ? retryTx : award;
    rememberDraft();
    var source = award.form, detachedSource = source && [ui.form].concat(ui.stack).indexOf(source) < 0;
    var unchangedSource = awardFormMatchesRecord(source, record, id, detachedSource);
    if (source && unchangedSource) {
      ui.stack = ui.stack.filter(function (f) { return f !== source; });
      var retainedDraft = [ui.form].concat(ui.stack).some(function (f) { return f && f !== source && draftKey(f) === draftKey(source); });
      if (!retainedDraft) { delete drafts[draftKey(source)]; saveStore(DRAFT, drafts); }
    }
    tx.keepAwardDraft = !!ui.form && (ui.form !== source || !awardFormMatchesRecord(ui.form, record, id));
    if (tx.keepAwardDraft) {
      var retainedForms = [ui.form].concat(ui.stack);
      if (tx.form && (!unchangedSource || retainedForms.some(function (f) { return f && (f === tx.form || (tx.form.awardPhotos && tx.form.awardPhotos === f.awardPhotos)); }))) tx.form = null;
      retainedForms.forEach(function (f) {
        if (!f || !f.awardPhotos) return;
        f.awardPhotos.items = f.awardPhotos.items.filter(function (item) {
          if ((record.photoIds || []).indexOf(item.photoId) < 0) return true;
          item.abandoned = true; return false;
        });
      });
    }
    tx.action = copyAwardAction(tx.action);
    tx.action.name = record.name; tx.action.points = record.points; tx.action.reason = record.reason;
    tx.action.at = record.at;
    if (record.photoIds && record.photoIds.length) tx.action.photoIds = record.photoIds.slice(); else delete tx.action.photoIds;
    finishTransaction(tx); return true;
  }
  function awardFormMatchesRecord(f, record, awardId, ignorePhotos) {
    if (!f || f.kind !== 'points' || (!ignorePhotos && !awardPhotosReady(f))) return false;
    try {
      var action = makeAction(f, f.data);
      if (f.data.recordDate && f.data.recordTime) action.at = M.calendarTimestamp(f.data.recordDate, f.data.recordTime, calendarZone());
      var submitted = submittedAwards[awardId], usesDefaultTime = f.data.recordTimeEdited === false && submitted && submitted.form === f;
      return action.name === record.name && action.points === record.points && action.reason === record.reason &&
        (!action.at || Date.parse(action.at) === Date.parse(record.at) || usesDefaultTime) &&
        (action.saveAsTemplate ? record.itemId === 'item-' + awardId : (action.itemId || '') === record.itemId) &&
        (ignorePhotos || JSON.stringify(action.photoIds || []) === JSON.stringify(record.photoIds || []));
    } catch (e) { return false; }
  }
  function submittedAwardDraft(action) {
    if (action.type !== 'points.add' || !ui.form) return null;
    var matched = null;
    Object.keys(submittedAwards).some(function (id) {
      var award = submittedAwards[id], original = award.action;
      if (ui.form !== award.form && !((!ui.form.assistantDraft || ui.form.assistantDraft.actionId === id) &&
          (action.itemId || '') === (original.itemId || '') && action.name === original.name && action.points === original.points &&
          (action.reason || '') === (original.reason || '') && !!action.saveAsTemplate === !!original.saveAsTemplate && action.at === original.at)) return false;
      matched = award; return true;
    });
    return matched;
  }
  function suspendFamily() {
    rememberDraft(); rememberSheetFocus();
    if (retryTx && retryTx.action.type === 'points.add' && (retryTx.inFlight || retryTx.uncertain)) rememberSubmittedAward(retryTx);
    var main = document.getElementById('main'), saved = { view: ui.view, homeMode: ui.homeMode, day: ui.day, reminderMode: ui.reminderMode, filter: ui.filter, history: ui.history, sound: ui.sound, petTab: ui.petTab, homeFocus: ordinary(ui.homeFocus || null), homeScrollTop: ui.homeScrollTop || 0, recordHomeReturn: !!ui.recordHomeReturn, form: savedForm(ui.form), stack: ui.stack.map(savedForm), drafts: ordinary(drafts), awardPhotos: savedAwardPhotoDrafts(), submittedAwards: savedSubmittedAwards(), scrollTop: main ? main.scrollTop : 0, revision: revision };
    if (ui.auth && ui.auth.phase === 'confirm' && ui.auth.tx.action.type === 'points.add' && ui.auth.tx.form === ui.form && !ui.auth.busy && !pending && !ui.auth.challengeId && !ui.auth.tx.grant && !ui.auth.tx.uncertain) {
      saved.awardReview = { pristine: isPristinePresetReview(ui.auth), familyDay: today() };
    }
    if (AwardPhotos) AwardPhotos.closeViewer();
    if (awardPhotoSelection) {
      awardPhotoSelection.permitted = false;
    }
    if (avatarSelection) {
      avatarSelection.permitted = false;
      if (avatarSelection.input) { avatarSelection.input.hidden = true; avatarSelection.input.setAttribute('data-saas-avatar-hold', 'true'); document.body.appendChild(avatarSelection.input); }
    }
    return saved;
  }
  function restorableForm(f, submittedAward) {
    if (!f) return null;
    var d = f.data || {}, target, preserveAwardTime = !!(submittedAward && (d.recordTimeEdited === true || find(state.points, 'points-' + submittedAward.action.id)));
    if (f.kind === 'task' && d.id) { target = find(state.tasks, d.id); if (!target || target.deleted) return null; }
    if (f.kind === 'taskAction') { target = find(state.tasks, d.taskId); if (!target || target.deleted) return null; }
    if (f.kind === 'pointItem' && d.id) { target = find(state.pointItems, d.id); if (!target) return { kind: 'point-list', data: {}, openedRevision: revision }; }
    if (f.kind === 'points' && d.itemId) { target = find(state.pointItems, d.itemId); if (!target || !target.enabled) return { kind: 'behaviorPicker', data: {}, openedRevision: revision }; }
    if ((f.kind === 'reward' && d.id) || f.kind === 'request') { target = find(state.rewards, d.id || d.rewardId); if (!target || (f.kind === 'request' && !target.enabled)) return { kind: 'rewards', data: {}, openedRevision: revision }; }
    if (f.kind === 'approve') { target = find(state.requests, d.requestId); if (!target || target.status !== 'pending') return { kind: 'homeInbox', data: {}, openedRevision: revision }; }
    if (typeof f.openedRevision !== 'number') f.openedRevision = revision;
    if (f.kind === 'parentConfig') f.parentConfigured = meta.parent.configured;
    if (f.kind === 'points' && d.recordDate !== today() && preserveAwardTime !== true) { d.recordDate = today(); d.recordTime = clock(); }
    awardPhotos(f);
    return f;
  }
  function restoreFamily(saved) {
    if (!saved) { discardAvatar(); return; }
    ['view', 'homeMode', 'day', 'reminderMode', 'filter', 'history', 'petTab', 'homeFocus', 'homeScrollTop', 'recordHomeReturn'].forEach(function (key) { if (saved[key] !== undefined) ui[key] = saved[key]; });
    var sent = saved.submittedAwards || {}, sentRows = Object.keys(sent).map(function (id) { return sent[id]; }), restoredStack = [];
    drafts = ordinary(saved.drafts || {}); awardPhotoDrafts = saved.awardPhotos || {}; ui.stack = (saved.stack || []).map(function (f, index) {
      restoredStack[index] = restorableForm(f, sentRows.filter(function (award) { return !award.currentForm && award.stackIndex === index; })[0]);
      return restoredStack[index];
    }).filter(function (f) { return !!f; });
    ui.form = restorableForm(saved.form, sentRows.filter(function (award) { return award.currentForm; })[0]); if (!ui.form && saved.form) ui.form = ui.stack.pop() || null;
    restoreSubmittedAwards(sent, restoredStack);
    // Only an exact ledger record confirms an aborted request; an absent record can still arrive later.
    var completedAward = reconcileSubmittedAwards();
    if (!completedAward) {
      if (AwardPhotos) AwardPhotos.flush(awardPhotoRequestEnvironment());
      if (saved.awardReview && saved.revision === revision && saved.awardReview.familyDay === today() && ui.form && ui.form.kind === 'points') {
        // Recreate an unsent review, never a previous challenge, grant, or PIN.
        try { var award = makeAction(ui.form, ui.form.data); beginAction(award, '已加 ' + award.points + ' 分。', saved.awardReview.pristine, true); } catch (e) {}
      }
      if (!ui.auth) render(false);
      var main = document.getElementById('main'); if (main) main.scrollTop = saved.scrollTop || 0;
      if (ui.form) { restorePlayFocus(ui.form.focusKey); var body = document.querySelector('.sheet-body'); if (body) body.scrollTop = ui.form.scrollTop || 0; }
    }
    if (avatarSelection && ui.form && ui.form.kind === 'profile') {
      var picker = avatarSelection, replacement = document.querySelector('#editor-form #avatar-file');
      picker.scope = scopeToken(); picker.form = ui.form; picker.permitted = true;
      if (picker.input) { picker.input.hidden = false; picker.input.setAttribute('data-saas-avatar-hold', 'false'); if (replacement && replacement !== picker.input && replacement.parentNode) replacement.parentNode.replaceChild(picker.input, replacement); }
      if (picker.file) loadAvatar(picker.file);
    } else discardAvatar();
    var completedFromPicker = restoreAwardPhotoInput();
    if (saved.form && !ui.form && !completedAward && !completedFromPicker) toast('内容已更新');
  }
  function discardAvatar() {
    if (!avatarSelection) return;
    var picker = avatarSelection; avatarSelection = null; picker.cancelled = true; picker.permitted = false; picker.file = null; picker.form = null;
    if (picker.input && picker.input.parentNode === document.body) picker.input.parentNode.removeChild(picker.input);
  }
  function prepareAvatar(input) {
    discardAvatar();
    avatarSelection = { input: input, scope: scopeToken(), form: ui.form, file: null, permitted: true, cancelled: false };
    input.__familyAvatarTicket = avatarSelection; return avatarSelection;
  }
  function receiveAvatar(input) {
    var ticket = input.__familyAvatarTicket;
    if (ticket && (ticket.cancelled || ticket !== avatarSelection)) return;
    if (!ticket) { if (!scopeReady() || !ui.form || ui.form.kind !== 'profile') return; ticket = prepareAvatar(input); }
    ticket.file = input.files && input.files[0] || null;
    if (ticket.permitted && scopeCurrent(ticket.scope) && ui.form === ticket.form && ticket.file) loadAvatar(ticket.file);
  }
  var paths = {
    home: '<path d="m3 11 9-8 9 8M5 10v11h14V10M9 21v-8h6v8"/>',
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', check: '<path d="m5 12 4 4L19 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
    history: '<path d="M3 10a9 9 0 1 1 1.5 7M3 4v6h6M12 7v5l3 2"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-14 4h3m4 0h3"/>',
    gift: '<path d="M3 9h18v4H3zM5 13v8h14v-8M12 9v12M12 9C4 10 4 2 8 3c3 0 4 6 4 6Zm0 0c8 1 8-7 4-6-3 0-4 6-4 6Z"/>',
    edit: '<path d="m14 5 5 5M3 21l5-1L21 7a3.5 3.5 0 0 0-5-5L3 15z"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>', chevron: '<path d="m9 5 7 7-7 7"/>',
    back: '<path d="m15 5-7 7 7 7"/>', search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    settings: '<path d="M4 7h16M4 17h16"/><circle cx="8" cy="7" r="3" fill="currentColor"/><circle cx="16" cy="17" r="3" fill="currentColor"/>',
    people: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-1a6 6 0 0 1 12 0v1m0-15a3 3 0 0 1 0 6m3 3a5 5 0 0 1 3 5v1"/>',
    download: '<path d="M12 3v11m-4-4 4 4 4-4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
    logout: '<path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5m-1-8h12m-4-4 4 4-4 4"/>',
    mic: '<rect x="8" y="2" width="8" height="13" rx="4"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12M3 6h.1M3 12h.1M3 18h.1"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-11v1"/>',
    sound: '<path d="M11 4 5 9H2v6h3l6 5ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
    screen: '<rect x="2" y="3" width="20" height="15" rx="2"/><path d="M8 22h8m-4-4v4"/>',
    archive: '<path d="M3 3h18v5H3zM5 8v13h14V8M9 12h6"/>',
    pencil: '<path d="m14 3 7 7L9 22H2v-7ZM11 6l7 7M2 15l7 7"/>',
    burger: '<path d="M3 10a9 9 0 0 1 18 0ZM3 14h18M3 18h18c0 4-18 4-18 0Z"/>',
    mountain: '<path d="m2 20 8-15 6 10 3-5 4 10ZM7 11l3 2 3-2"/>',
    repeat: '<path d="M20 7a9 9 0 0 0-15-2L2 8m0-5v5h5M4 17a9 9 0 0 0 15 2l3-3m0 5v-5h-5"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
    leaf: '<path d="M20 3C8 2 2 8 5 15c4 8 16 2 15-12ZM4 21 17 7M8 17l-1-7m5 3 6 1"/>',
    water: '<path d="M12 2C8 8 4 11 4 15a8 8 0 0 0 16 0c0-4-4-7-8-13Z"/><path d="M8 15a4 4 0 0 0 4 4"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 1v3m0 16v3M1 12h3m16 0h3M4.2 4.2l2.1 2.1m11.4 11.4 2.1 2.1m0-15.6-2.1 2.1M6.3 17.7l-2.1 2.1"/>',
    snack: '<path d="M12 6c-5-6-12 2-8 10 3 8 5 3 8 5 3-2 5 3 8-5 4-8-3-16-8-10ZM12 6c0-3 2-4 4-4"/>',
    ball: '<circle cx="12" cy="12" r="9"/><path d="M3 12c7-3 11 1 15 7M9 3c-3 6 1 13 7 17m5-9c-4-1-8-6-9-8"/>',
    spark: '<path d="m12 2 2.8 7.2L22 12l-7.2 2.8L12 22l-2.8-7.2L2 12l7.2-2.8ZM20 2v4m-2-2h4"/>',
    assistant: '<path d="M7.5 3.5h9a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H10L5 21v-4.4a4 4 0 0 1-1.5-3.1v-6a4 4 0 0 1 4-4Z"/><path fill="currentColor" stroke="none" d="m12 6 1.3 3.3 3.2 1.2-3.2 1.2L12 15l-1.3-3.3-3.2-1.2 3.2-1.2Z"/>',
    camera: '<path d="M8 5 9 2h6l1 3h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13" r="5"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>'
  };
  function icon(name) { return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (paths[name] || paths.gift) + '</svg>'; }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function readStore(k, fallback) { if (saas) return fallback; try { return JSON.parse(localStorage.getItem(k)) || fallback; } catch (e) { return fallback; } }
  function saveStore(k, v) { if (saas) return true; try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function soundPreference(fallback) { try { var saved = localStorage.getItem(SOUND); return saved === 'true' ? true : saved === 'false' ? false : !!fallback; } catch (e) { return !!fallback; } }
  function saveSoundPreference(value) { try { localStorage.setItem(SOUND, value ? 'true' : 'false'); } catch (e) {} }
  function find(rows, id) { for (var i = 0; i < (rows || []).length; i++) if (rows[i].id === id) return rows[i]; return null; }
  function appClock() { return saas ? farmClock() : new Date(); }
  function calendarZone() { return saas ? 'Asia/Shanghai' : undefined; }
  function today() { return M.dateKey(appClock(), calendarZone()); }
  function day(n) { return M.addDays(today(), n, calendarZone()); }
  function pad(n) { return ('0' + n).slice(-2); }
  function clock() { return M.calendarParts(appClock(), calendarZone()).time; }
  function uid() { return 'ui-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10); }
  function niceDate(s) { var d = M.calendarParts(s, calendarZone()); return d.month + '月' + d.day + '日'; }
  function niceTime(s) { if (isNaN(new Date(s).getTime())) return ''; var d = M.calendarParts(s, calendarZone()); return d.month + '/' + d.day + ' ' + d.time; }
  function category(c) { return { daily: '日常', weekend: '周末', outing: '月底' }[c] || '日常'; }
  function button(action, text, cls, id, label) { return '<button type="button" class="' + (cls || 'btn') + '" data-action="' + action + '"' + (id != null ? ' data-id="' + esc(id) + '"' : '') + (label ? ' aria-label="' + esc(label) + '"' : '') + '>' + text + '</button>'; }
  function request(method, url, data, done) {
    if (saas) { if (!scopeReady()) return null; return SaaS.request(method, url, data, done, { business: true }); }
    var x = new XMLHttpRequest(), settled = false;
    function finish(status, result) { if (!settled) { settled = true; done(status, result); } }
    x.open(method, url, true); x.timeout = url === '/api/assistant' ? 20000 : 10000;
    if (data) x.setRequestHeader('Content-Type', 'application/json');
    x.onload = function () { var r; try { r = JSON.parse(x.responseText); } catch (e) { r = {}; } finish(x.status, r); };
    x.onerror = x.ontimeout = function () { finish(0, {}); };
    x.send(data ? JSON.stringify(data) : null);
  }
  function persist() { if (saas) return; if (!saveStore(KEY, state)) toast('本机存储不可用'); }
  function paintHomeFeedback() {
    var line = document.getElementById('home-feedback');
    if (line) {
      var defaultText = line.getAttribute('data-default-text');
      line.textContent = ui.homeFeedback || (defaultText == null ? currentPet().name : defaultText);
      line.setAttribute('data-feedback', ui.homeFeedback ? 'true' : 'false'); line.title = line.textContent;
    }
  }
  function clearToast() {
    clearTimeout(toastTimer); ui.homeFeedback = ''; paintHomeFeedback();
    var el = document.getElementById('toast'); el.className = 'toast'; el.style.display = 'none'; el.textContent = '';
  }
  function toast(text, isPointsReceipt) {
    if (!scopeReady()) return;
    var scope = scopeToken();
    clearToast();
    var el = document.getElementById('toast'), inline = ui.view === 'points' && !ui.form && !ui.auth && document.getElementById('home-feedback');
    if (inline) { ui.homeFeedback = text; paintHomeFeedback(); }
    else { el.textContent = text; el.style.display = ''; el.className = isPointsReceipt ? 'toast visible points-receipt' : 'toast visible'; }
    toastTimer = setTimeout(function () { if (scopeCurrent(scope)) clearToast(); }, inline ? 3200 : 4200);
  }
  function play(name) { if (!scopeReady() || !ui.sound) return; var a = document.getElementById('sound-' + name); if (a) { a.currentTime = 0; var p = a.play(); if (p && p.catch) p.catch(function () {}); } }
  function syncLabel() { return local ? '本机' : connected ? '共享 · 已连接' : serverReached ? '共享 · 连接中断' : '共享 · 连接中'; }
  function farmIsVisible() {
    return ui.view === 'points' && !ui.auth && (ui.form ? ui.form.kind === 'farm' : ui.homeMode === 'companion');
  }
  function updateConnectionStatus() { var status = document.getElementById('sync-status'), badge = document.getElementById('connection-state'); if (status) status.textContent = syncLabel(); if (badge) badge.textContent = local || connected ? '' : serverReached ? '连接中断' : '连接中'; refreshPetControls(); refreshPetPurchase(); if (Farm && farmIsVisible()) Farm.tick(); }
  function acceptParent(parent, atRevision) {
    if (!parent || typeof parent.configured !== 'boolean' || typeof atRevision !== 'number' || atRevision < parentRevision) return false;
    if (parent.configured && parent.method !== 'pin' && parent.method !== 'math') return false;
    parentRevision = atRevision; meta.parent = { configured: parent.configured, method: parent.configured ? parent.method : null }; return true;
  }
  function refreshParentEditor() { if (ui.form && ui.form.kind === 'parentConfig' && ui.form.parentConfigured == null && meta.parent.configured != null) { ui.form.parentConfigured = meta.parent.configured; ui.form.data.method = meta.parent.method || 'pin'; render(false); } }
  function setSnapshot(result) {
    if (saas && (!SaaS || !SaaS.ready() || !SaaS.owns(result))) return false;
    if (!result || !result.state || typeof result.revision !== 'number' || result.revision < revision) return false;
    var sample = typeof result.serverNow === 'string' ? Date.parse(result.serverNow) : NaN;
    // A delayed response from the same data version must not rewind the family day or clock.
    var freshClock = result.revision > revision || !serverTime || (isFinite(sample) && sample > serverTime);
    state = result.state; revision = result.revision; acceptParent(result.parent, revision);
    if (freshClock) {
      if (typeof result.familyDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(result.familyDay)) familyDay = result.familyDay;
      if (isFinite(sample)) { serverTime = sample; serverReceived = monotonic(); }
    }
    connected = !local; if (connected) serverReached = true; persist(); updateConnectionStatus(); return true;
  }
  function canRefreshLedgerView() { return !ui.auth && (!ui.form || ['homeWeek', 'recordDetail', 'petHub', 'farm'].indexOf(ui.form.kind) >= 0); }
  function sync() {
    if (!scopeReady() || local || syncBusy || pending) return;
    syncBusy = true;
    request('GET', '/api/state', null, function (status, result) {
      syncBusy = false;
      if (status === 200 && result.state && result.state.tasks && result.revision >= revision) {
        var changed = !connected || result.revision !== revision || (result.familyDay && result.familyDay !== familyDay);
        setSnapshot(result);
        if (reconcileSubmittedAwards()) return;
        if (setupTx && !setupTx.cancelled && setupTx.uncertain) {
          if (state.appliedActions.indexOf(setupTx.action.id) >= 0) {
            // The receipt retry must also confirm which assistant draft was resumed.
            if (setupTx.assistantResume) { render(false); showError('PIN已设置 · 重试后继续本次操作'); return; }
            finishSetup(setupTx); return;
          }
          if (meta.parent.configured === true) { failSetup(setupTx, '家长验证已设置'); return; }
        }
        if (retryTx && !submittedAwards[retryTx.action.id] && state.appliedActions.indexOf(retryTx.action.id) >= 0) { finishTransaction(retryTx); return; }
        refreshParentEditor();
        if (changed && canRefreshLedgerView()) render(false); else renderReminder();
        updateConnectionStatus();
      } else if (status !== 200 || !result.state || !result.state.tasks || typeof result.revision !== 'number') {
        connected = false; updateConnectionStatus();
      }
    });
  }
  function loadMeta() {
    if (!scopeReady()) return;
    if (local) { meta.parent = { configured: !!privateConfig, method: privateConfig ? privateConfig.method : null }; parentRevision = revision; return; }
    if (saas) loadParentDevice();
    request('GET', '/api/meta', null, function (status, result) { if (status === 200) { if (result.assistant) meta.assistant = result.assistant; acceptParent(result.parent, result.revision); refreshParentEditor(); if (!ui.form && !ui.auth) render(false); } });
  }
  function loadParentDevice() {
    if (!saas || !scopeReady() || parentDevice.busy) return;
    var device = parentDevice, sequence = ++device.sequence;
    device.loading = true;
    request('GET', '/api/parent/device', null, function (status, result) {
      if (parentDevice !== device || sequence !== device.sequence) return;
      device.loading = false;
      device.enabled = status === 200 && typeof result.enabled === 'boolean' ? result.enabled : null;
      if (device.enabled && ui.form && ui.form.kind === 'parentDevice') { ui.form = ui.stack.pop() || null; render(false); }
      else if (ui.form && ui.form.kind === 'parentConfig') {
        var control = document.getElementById('parent-device-settings');
        if (control) control.innerHTML = parentDeviceControl();
      } else if (ui.auth && ui.auth.phase === 'confirm') render(false);
    });
  }
  function saveParentDevice(enabled, credential) {
    if (!saas || !scopeReady() || parentDevice.busy || meta.parent.configured !== true) return;
    var device = parentDevice, f = ui.form, body = { enabled: enabled };
    if (enabled) body.credential = credential;
    device.sequence++; device.loading = false; device.busy = true; render(false);
    request('POST', '/api/parent/device', body, function (status, result) {
      if (parentDevice !== device) return;
      device.busy = false;
      if (status === 200 && typeof result.enabled === 'boolean') {
        device.enabled = result.enabled;
        if (ui.form === f && f.kind === 'parentDevice' && result.enabled) ui.form = ui.stack.pop() || null;
        render(false); toast(result.enabled ? '本机日常免验证已开启' : '本机日常验证已恢复');
      } else {
        if (status === 0) { device.enabled = null; loadParentDevice(); }
        render(false);
        if (ui.form === f) showError(status === 0 ? '本机设置结果待确认' : errorText(result));
      }
    });
    credential = ''; delete body.credential;
  }
  function canSkipParent(action) {
    return saas && meta.parent.configured === true && parentDevice.enabled === true && ['points.add', 'redemption.approve', 'reward.redeem'].indexOf(action.type) >= 0;
  }
  function errorText(result) {
    var codes = { RATE_LIMITED: '操作频繁', CHALLENGE_EXPIRED: '验证已过期', VERIFICATION_FAILED: '验证未通过', PASSWORD_INVALID: '账号密码不正确', INVALID_CREDENTIALS: '验证未通过', PARENT_REQUIRED: '待家长验证', PARENT_SETUP_REQUIRED: '家长验证未设置', PARENT_ALREADY_CONFIGURED: '家长验证已设置', GRANT_EXPIRED: '验证已过期', GRANT_INVALID: '验证已失效', ACTION_ID_REUSED: '操作已提交', BODY_TOO_LARGE: '内容超出限制', SAVE_FAILED: '保存失败', INTERNAL_ERROR: '服务暂不可用', ASSISTANT_UNAVAILABLE: '指令服务不可用' };
    if (result && codes[result.code]) return codes[result.code];
    var text = typeof result === 'string' ? result : result && (result.error || result.message) || '', match;
    if (/^(?:一次说一件事就好|请输入不超过)[\s\S]*1200\s*字/.test(text)) return '指令 · 1–1200字';
    if (/还差\s*\d+\s*分/.test(text)) return text.match(/还差\s*\d+\s*分/)[0];
    if (/周末美食/.test(text)) return '开放 · 周六、周日';
    if ((match = text.match(/每月最后(\d+)天/))) return '开放 · 月末' + match[1] + '天';
    var rules = [
      [/免费照料.*用完/, '免费余量 0'], [/库存不足/, '道具库存 0'], [/积分不足|积分不能为负/, '余额不足'], [/价格.*变化|总价.*变化/, '价格已更新'],
      [/场景.*未解锁/, '场景未解锁'], [/申请.*已|已经确认的兑换/, '申请已处理'], [/申请.*不存在/, '申请不存在'], [/礼品.*不存在|奖励.*不存在/, '礼品不存在'], [/奖励已停用/, '礼品已停用'],
      [/加分项.*不存在|常用项.*不存在/, '常用项不存在'], [/加分项已停用/, '常用项已停用'], [/已有常用项不能/, '常用项已选定'], [/新常用项标识/, '常用项已更新'], [/道具不存在/, '道具不存在'],
      [/事项不存在|已删除事项/, '提醒不存在'], [/已完成事项/, '提醒已完成'], [/过去日期/, '日期早于今天'], [/近期待办只能/, '日期范围 · 今天至后天'], [/加分时间只能/, '记录时间 · 今天至此刻'],
      [/本机.*PIN|浏览器.*PIN/, '本机PIN不可用'], [/PIN.*一致/, 'PIN不一致'], [/PIN|家长密码/, 'PIN格式无效'], [/头像|图片/, '头像无效'], [/日期/, '日期无效'], [/时间/, '时间无效'], [/数量/, '数量 · 1–10件'],
      [/指令|助手|模型/, '指令服务不可用'], [/不支持的操作|未识别此操作/, '操作不支持']
    ];
    for (var i = 0; i < rules.length; i++) if (rules[i][0].test(text)) return rules[i][1];
    var labels = ['孩子名字', '伙伴名字', '加分名称', '加分原因', '加分项名称', '行为名称', '预设原因', '奖励名称', '礼品名称', '提醒标题', '事项标题', '标题', '备注', '分值', '积分'];
    for (var j = 0; j < labels.length; j++) if (text.indexOf(labels[j]) >= 0) return labels[j] + (/请填写/.test(text) ? ' · 必填' : /太长/.test(text) ? ' · 超出字数' : /正整数/.test(text) ? ' · 正整数' : ' · 格式无效');
    return text ? '操作未完成' : '连接未完成';
  }
  function facts(rows, cls) { return '<dl class="value-list ' + (cls || '') + '">' + rows.map(function (row) { return '<div><dt>' + esc(row[0]) + '</dt><dd>' + esc(row[1]) + '</dd></div>'; }).join('') + '</dl>'; }
  function availabilityLabel(permission) { return permission.allowed ? '可兑换' : errorText(permission.reason); }
  function fieldError(input) {
    if (!input) return '内容无效';
    var label = input.parentNode.querySelector('span'), name = label ? label.textContent : input.name === 'answer' ? '验证答案' : '内容', v = input.validity;
    if (v.valueMissing) return name + ' · 必填';
    if (v.rangeUnderflow || v.rangeOverflow || v.stepMismatch) return name + ' · ' + (input.min || '0') + (input.max ? '–' + input.max : '以上') + (input.type === 'number' ? '整数' : '');
    return name + ' · 格式无效';
  }
  function showError(message) { var el = document.getElementById(ui.auth ? 'parent-error' : 'form-error'); if (el) { el.textContent = message; el.hidden = false; } else toast(message); }
  function isPublic(action) { return ['task.toggle', 'task.ack', 'task.snooze', 'redemption.request', 'redemption.cancel', 'pet.configure', 'pet.care', 'pet.scene', 'farm.start', 'farm.plant', 'farm.harvest', 'farm.exchange', 'farm.place', 'farm.animalCare'].indexOf(action.type) >= 0; }
  function conflict(tx, result) {
    if (submittedAwards[tx.action.id] && result.state) {
      setSnapshot(result); if (reconcileSubmittedAward(submittedAwards[tx.action.id])) return;
    }
    if (tx.assistantDraft && /^ASSISTANT_/.test(result.code || '')) {
      tx.grant = null; retryTx = null; ui.auth = null;
      render(false); showError('助手草稿已变化，请打开助手重新核对'); return;
    }
    if (result.state) setSnapshot(result);
    if (ui.auth && ui.auth.tx === tx) ui.auth.autoPin = null;
    clearParentSecrets(tx);
    tx.grant = null; tx.uncertain = false; tx.revision = revision; retryTx = tx.action.type === 'parent.configure' ? null : tx;
    ui.auth = null;
    if (ui.form) ui.form.openedRevision = revision;
    render(false);
    showError(tx.action.type === 'pet.care' ? '资源已更新' : '记录已更新 · 待确认');
  }
  function clearParentSecrets(tx) { if (!tx) return; if (tx.action && (tx.action.type === 'parent.setup' || tx.action.type === 'parent.configure')) { delete tx.action.pin; delete tx.action.confirmPin; tx.signature = ''; } }
  function cancelSetup() {
    var tx = setupTx; if (!tx) return;
    tx.cancelled = true; if (tx.auth) tx.auth.autoPin = null; clearParentSecrets(tx); setupTx = null;
    if (retryTx && tx.auth && retryTx === tx.auth.tx) { retryTx.grant = null; retryTx = null; }
  }
  function failSetup(tx, message) {
    clearParentSecrets(tx); if (setupTx === tx) setupTx = null; pending = false;
    if (tx.auth && ui.auth === tx.auth) { tx.auth.autoPin = null; tx.auth.tx.grant = null; if (retryTx === tx.auth.tx) retryTx = null; ui.auth = null; }
    if (ui.form) { ui.form.openedRevision = revision; if (ui.form.kind === 'parentConfig' && message === '家长验证已设置') ui.form.setupConflict = true; }
    render(false); if (!tx.cancelled) showError(message);
  }
  function finishSetup(tx, result) {
    var pin = tx.action.pin, auth = tx.auth;
    clearParentSecrets(tx); if (setupTx === tx) setupTx = null; pending = false;
    if (tx.cancelled) { render(false); return; }
    if (auth && ui.auth === auth && ui.form === tx.form) {
      var binding = ui.form && ui.form.assistantDraft, resumed = result && result.assistantResume;
      var resumedDraft = !tx.assistantResume || !!(binding && resumed &&
        binding.generation === tx.assistantResume.generation && binding.turnId === tx.assistantResume.turnId &&
        binding.actionId === tx.assistantResume.actionId && binding.type === tx.assistantResume.type && binding.sourceRevision === tx.revision &&
        resumed.generation === binding.generation && resumed.turnId === binding.turnId && resumed.actionId === binding.actionId &&
        resumed.type === binding.type && resumed.sourceRevision === revision && resumed.familyDay === binding.familyDay && resumed.familyDay === today());
      if (revision !== tx.revision + 1 || !resumedDraft) { auth.autoPin = null; auth.tx.grant = null; if (retryTx === auth.tx) retryTx = null; ui.auth = null; if (ui.form) ui.form.openedRevision = revision; render(false); showError(resumedDraft ? 'PIN已设置 · 记录已更新' : 'PIN已设置 · 助手草稿已变化，请打开助手重新核对'); return; }
      if (tx.assistantResume) binding.sourceRevision = resumed.sourceRevision;
      auth.tx.revision = tx.revision + 1; auth.tx.uncertain = false; auth.tx.grant = null; auth.tx.previousGrowth = M.growth(state); auth.tx.previousPetStatus = playStatus();
      if (ui.form) ui.form.openedRevision = revision;
      auth.autoPin = pin; auth.phase = 'loading'; auth.busy = false; issueChallenge(auth); return;
    }
    if (!auth && ui.form === tx.form) { ui.form = ui.stack.pop() || null; if (ui.form) ui.form.openedRevision = revision; }
    render(false); toast('家长验证已设置');
  }
  function submitSetup(tx) {
    if (pending || tx.cancelled || setupTx !== tx) return;
    pending = true; tx.busy = true; if (tx.auth && ui.auth === tx.auth) tx.auth.phase = 'setup-saving'; render(false);
    if (local) {
      if (tx.revision !== revision) { failSetup(tx, '记录已更新 · 待确认'); return; }
      saveLocalParent(tx.action.method, tx.action.pin, function (err) {
        pending = false; tx.busy = false;
        if (err) { failSetup(tx, errorText(err)); return; }
        state = clone(state); state.appliedActions.push(tx.action.id); revision++; parentRevision = revision; persist(); finishSetup(tx);
      }, true); return;
    }
    request('POST', '/api/action', { revision: tx.revision, action: tx.action, assistantResume: tx.assistantResume }, function (status, result) {
      pending = false; tx.busy = false;
      if (result.state) setSnapshot(result);
      if (tx.cancelled) { clearParentSecrets(tx); render(false); if (!status) sync(); return; }
      if (status === 200 && result.state) { finishSetup(tx, result); return; }
      if (status === 0) { tx.uncertain = true; connected = false; if (tx.auth && ui.auth === tx.auth) tx.auth.phase = 'setup-retry'; render(false); showError('设置结果待确认'); sync(); return; }
      failSetup(tx, result.code === 'ASSISTANT_DRAFT_STALE' ? '助手草稿已变化，请打开助手重新核对' : status === 409 ? result.code === 'PARENT_ALREADY_CONFIGURED' ? '家长验证已设置' : '记录已更新 · 待确认' : errorText(result));
    });
  }
  function startSetup(action, auth) {
    if (!scopeReady() || pending) return;
    if (saas && !SaaS.isOwner()) { showError('请家庭所有者设置家长验证'); return; }
    if (setupTx && setupTx.uncertain && setupTx.form === ui.form) { submitSetup(setupTx); return; }
    if (!local && !connected) { showError('未连接'); return; }
    if (action.method === 'pin' && (!/^\d{6}$/.test(action.pin || '') || action.pin !== action.confirmPin)) { showError(action.pin !== action.confirmPin ? 'PIN不一致' : 'PIN格式无效'); return; }
    action.id = uid(); setupTx = { action: action, revision: auth ? auth.tx.revision : revision, form: ui.form, auth: auth || null, busy: false, uncertain: false, cancelled: false };
    if (auth && auth.tx.assistantDraft) setupTx.assistantResume = { generation:auth.tx.assistantDraft.generation, turnId:auth.tx.assistantDraft.turnId, actionId:auth.tx.action.id, type:auth.tx.action.type };
    submitSetup(setupTx);
  }
  function beginAction(action, message, pristinePresetReview, restoringReview) {
    if (!scopeReady() || pending) return;
    if (action.type === 'points.add' && ui.form && ui.form.kind === 'points') {
      if (!restoringReview && !awardPhotosReady(ui.form)) { showError('请先处理照片：重试、重拍或移除后继续。'); return; }
      addAwardPhotoIds(action, ui.form);
    }
    if (saas && !SaaS.isOwner() && meta.parent.configured === false && !isPublic(action)) { showError('请家庭所有者设置家长验证'); return; }
    if (retryTx && retryTx.uncertain && /^farm\./.test(retryTx.action.type) && JSON.stringify(action) !== retryTx.signature) { showError('请先确认上次小院操作的结果'); return; }
    if (action.type === 'parent.setup') { startSetup(action, null); return; }
    if (action.type === 'parent.configure' && meta.parent.configured === false) { if (ui.form) ui.form.parentConfigured = false; render(false); showError('家长验证未设置'); return; }
    if (!local && !connected) { showError('未连接 · 草稿已保留'); return; }
    rememberDraft();
    if (reconcileSubmittedAwards()) return;
    var recoveringAward = submittedAwardDraft(action), binding = !recoveringAward && ui.form && ui.form.assistantDraft;
    if (binding && (binding.type !== action.type || binding.familyDay !== today() || binding.sourceRevision !== revision)) {
      showError('助手草稿已变化，请打开助手重新核对'); return;
    }
    if (ui.form && ui.form.openedRevision !== revision) {
      ui.form.openedRevision = revision; render(false); showError('记录已更新 · 待确认'); return;
    }
    var signature = action.type === 'points.add' ? awardSignature(action) : JSON.stringify(action), tx, reused = false, rebasedAwardTime = false;
    if (recoveringAward) {
      var correctedAt = action.at;
      rebasedAwardTime = !!recoveringAward.action.at && M.dateKey(recoveringAward.action.at, calendarZone()) !== today();
      // A new family day requires a new time. Keep the operation ID so either payload can be booked only once.
      action = copyAwardAction(recoveringAward.action);
      if (rebasedAwardTime) {
        if (correctedAt) action.at = correctedAt; else delete action.at;
        if (ui.form && ui.form.kind === 'points') ui.form.data.recordDate = today();
      }
      signature = awardSignature(action); recoveringAward.form = ui.form;
      tx = { action: action, signature: signature, revision: revision, message: message, grant: null, uncertain: true,
        previousGrowth: recoveringAward.previousGrowth, assistantDraft: recoveringAward.assistantDraft }; reused = true;
    }
    else if (retryTx && retryTx.signature === signature && !submittedAwards[retryTx.action.id] && (binding ? retryTx.action.id === binding.actionId : !retryTx.assistantDraft)) { tx = retryTx; reused = true; }
    else {
      action.id = binding ? binding.actionId : uid();
      tx = { action: action, signature: signature, revision: revision, message: message, grant: null, previousGrowth: M.growth(state) };
      if (binding) tx.assistantDraft = { generation: binding.generation, turnId: binding.turnId };
    }
    // A retry can be initiated from a newly reopened editor.
    tx.form = ui.form;
    tx.ledgerAward = action.type === 'points.add' && !!(ui.form && ui.form.ledgerAward);
    tx.ledgerRedemption = action.type === 'redemption.approve' && ledgerGiftFlow();
    if (!tx.uncertain) { tx.revision = revision; tx.previousGrowth = M.growth(state); tx.previousPetStatus = playStatus(); }
    try { if (action.type !== 'parent.configure' && (local || (action.type !== 'pet.care' && action.type.indexOf('farm.') !== 0))) M.apply(state, tx.action, appClock(), calendarZone()); } catch (e) { showError(errorText(e)); return; }
    retryTx = tx; invalidateAssistant(ui.form); if (ui.form) ui.form.avatarRequest = null; stopRecognition();
    if (isPublic(tx.action)) { submitTransaction(tx); return; }
    rememberSheetFocus();
    ui.auth = { tx: tx, recoveryAward: !!recoveringAward, rebasedAwardTime: rebasedAwardTime, phase: tx.action.type === 'points.add' || canSkipParent(tx.action) ? 'confirm' : meta.parent.configured === false ? 'setup' : 'loading', pristinePresetReview: !!pristinePresetReview && !reused, busy: false, challengeId: null, method: 'pin', question: '', expiresAt: null, autoPin: null };
    if (tx.uncertain && (tx.grant || tx.deviceAttempt)) { submitTransaction(tx); return; }
    render(false); if (ui.auth.phase === 'loading') issueChallenge(ui.auth);
  }
  function issueChallenge(auth) {
    if (auth !== ui.auth) return;
    auth.phase = 'loading'; auth.busy = true; auth.tx.grant = null; render(false);
    function ready() {
      auth.busy = false; auth.phase = 'verify';
      if (auth.method === 'pin' && auth.autoPin) { verifyParentAnswer(auth, auth.autoPin, true); return; }
      auth.autoPin = null; render(false);
    }
    if (local) {
      privateConfig = readStore(PRIVATE, privateConfig); loadMeta();
      if (!privateConfig) { auth.busy = false; auth.phase = 'setup'; render(false); return; }
      auth.method = privateConfig.method; auth.expiresAt = Date.now() + 120000;
      if (auth.method === 'math') { var a = 12 + Math.floor(Math.random() * 18), b = 3 + Math.floor(Math.random() * 7); auth.question = a + ' × ' + b + ' = ?'; auth.localAnswer = String(a * b); }
      ready(); return;
    }
    request('POST', '/api/parent/challenge', { revision: auth.tx.revision, action: auth.tx.action, assistantDraft: auth.tx.assistantDraft }, function (status, result) {
      if (ui.auth !== auth) return;
      auth.busy = false;
      if (status === 200 && result.challengeId) { auth.challengeId = result.challengeId; auth.method = result.method; auth.question = result.question || ''; auth.expiresAt = result.expiresAt; ready(); }
      else if (result.code === 'PHOTO_UNAVAILABLE' && recoverUnavailableAwardPhotos(auth.tx)) return;
      else if (result.code === 'PARENT_SETUP_REQUIRED') {
        acceptParent(result.parent || { configured: false, method: null }, typeof result.revision === 'number' ? result.revision : auth.tx.revision);
        auth.autoPin = null;
        if (auth.tx.action.type === 'parent.configure') { clearParentSecrets(auth.tx); retryTx = null; ui.auth = null; if (ui.form) ui.form.parentConfigured = false; render(false); showError('家长验证未设置'); }
        else { auth.phase = 'setup'; render(false); }
      } else if (status === 409) conflict(auth.tx, result);
      else { auth.phase = 'challenge-error'; render(false); showError(errorText(result)); if (result.code === 'ACTION_ID_REUSED' && submittedAwards[auth.tx.action.id]) sync(); }
    });
  }
  function randomSalt() { var values = new Uint8Array(16); window.crypto.getRandomValues(values); return Array.prototype.map.call(values, function (v) { return ('0' + v.toString(16)).slice(-2); }).join(''); }
  function digestPin(pin, salt, done) {
    if (!window.crypto || !window.crypto.subtle || !window.TextEncoder) { done(new Error('本机PIN不可用')); return; }
    window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + pin)).then(function (buf) { var out = Array.prototype.map.call(new Uint8Array(buf), function (v) { return ('0' + v.toString(16)).slice(-2); }).join(''); done(null, out); }, function () { done(new Error('本机PIN保存失败')); });
  }
  function saveLocalParent(method, pin, done, setupOnly) {
    function store(config) {
      if (setupOnly && readStore(PRIVATE, null)) { privateConfig = readStore(PRIVATE, privateConfig); loadMeta(); done({ code: 'PARENT_ALREADY_CONFIGURED' }); return; }
      if (!saveStore(PRIVATE, config)) { done(new Error('本机存储不可用')); return; }
      privateConfig = config; loadMeta(); done();
    }
    if (setupOnly && readStore(PRIVATE, null)) { privateConfig = readStore(PRIVATE, privateConfig); loadMeta(); done({ code: 'PARENT_ALREADY_CONFIGURED' }); return; }
    if (method === 'math') { store({ configured: true, method: 'math', attempts: 0, blockedUntil: 0 }); return; }
    var salt;
    try { salt = randomSalt(); } catch (e) { done(new Error('本机PIN不可用')); return; }
    digestPin(pin, salt, function (err, digest) {
      if (err) { done(err); return; }
      store({ configured: true, method: 'pin', salt: salt, digest: digest, attempts: 0, blockedUntil: 0 });
    });
  }
  function verifyLocal(auth, answer) {
    if (privateConfig.blockedUntil > Date.now()) { auth.busy = false; render(false); showError('操作频繁'); return; }
    if (Date.now() > auth.expiresAt) { auth.busy = false; auth.phase = 'challenge-error'; render(false); showError('验证已过期'); return; }
    function checked(ok) {
      if (ui.auth !== auth) return;
      auth.busy = false;
      if (!ok) { auth.autoPin = null; auth.phase = 'verify'; privateConfig.attempts = (privateConfig.attempts || 0) + 1; if (privateConfig.attempts >= 5) { privateConfig.blockedUntil = Date.now() + 60000; privateConfig.attempts = 0; } saveStore(PRIVATE, privateConfig); render(false); showError('验证未通过'); return; }
      auth.autoPin = null; privateConfig.attempts = 0; privateConfig.blockedUntil = 0; saveStore(PRIVATE, privateConfig);
      auth.tx.grant = { id: uid(), expiresAt: Date.now() + 60000, signature: auth.tx.signature }; submitTransaction(auth.tx);
    }
    if (auth.method === 'math') checked(answer.trim() === auth.localAnswer);
    else digestPin(answer, privateConfig.salt, function (err, digest) { checked(!err && digest === privateConfig.digest); });
  }
  function verifyParentAnswer(auth, answer, automatic) {
    if (ui.auth !== auth) return;
    auth.busy = true; if (automatic) auth.phase = 'verifying'; render(false);
    if (local) { verifyLocal(auth, answer); return; }
    request('POST', '/api/parent/verify', { challengeId: auth.challengeId, answer: answer }, function (status, result) {
      if (ui.auth !== auth) return; auth.busy = false;
      if (status === 200 && result.grant) { auth.autoPin = null; auth.tx.grant = result.grant; submitTransaction(auth.tx); }
      else if (status === 409) conflict(auth.tx, result);
      else { if (status !== 0) auth.autoPin = null; auth.phase = status === 0 || status === 410 ? 'challenge-error' : 'verify'; render(false); showError(errorText(result)); }
    });
  }
  function submitParent(form) {
    var auth = ui.auth; if (!auth || auth.busy || pending) return;
    if (auth.phase === 'confirm') {
      if (!auth.recoveryAward) {
        if (!awardPhotosReady(auth.tx.form)) { showError('请先处理照片：重试、重拍或移除后继续。'); return; }
        updateAwardPhotoAction(auth);
      }
      if (auth.tx.revision !== revision) { conflict(auth.tx, { revision: revision, state: state }); return; }
      if (canSkipParent(auth.tx.action)) { auth.tx.deviceAttempt = true; submitTransaction(auth.tx); return; }
      auth.phase = meta.parent.configured === false ? 'setup' : 'loading';
      render(false); if (auth.phase === 'loading') issueChallenge(auth); return;
    }
    if (auth.phase === 'setup-retry') { if (setupTx && setupTx.auth === auth) submitSetup(setupTx); return; }
    if (auth.phase === 'retry') { submitTransaction(auth.tx); return; }
    if (auth.phase === 'challenge-error') { issueChallenge(auth); return; }
    if (auth.phase === 'setup') {
      var pin = form.elements.setupPin.value, again = form.elements.setupConfirm.value;
      startSetup({ type: 'parent.setup', method: 'pin', pin: pin, confirmPin: again }, auth); return;
    }
    var answer = form.elements.answer ? form.elements.answer.value : '';
    if (!answer.trim()) { var answerInput = form.elements.answer; if (answerInput) { answerInput.setAttribute('aria-invalid', 'true'); answerInput.setAttribute('aria-describedby', 'parent-error'); } showError('验证答案 · 必填'); if (answerInput) answerInput.focus(); return; }
    verifyParentAnswer(auth, answer, false);
  }
  function submitTransaction(tx) {
    if (pending) return;
    if (local) {
      if (tx.revision !== revision) { conflict(tx, { revision: revision, state: state }); return; }
      if (!isPublic(tx.action) && (!tx.grant || tx.grant.expiresAt < Date.now() || tx.grant.signature !== tx.signature)) { if (ui.auth) issueChallenge(ui.auth); return; }
      if (tx.action.type === 'parent.configure') {
        pending = true;
        saveLocalParent(tx.action.method, tx.action.pin, function (err) { pending = false; if (err) { showError(errorText(err)); return; } state = clone(state); state.appliedActions.push(tx.action.id); revision++; finishTransaction(tx); });
      } else {
        try { state = M.apply(state, tx.action, appClock(), calendarZone()); revision++; finishTransaction(tx); } catch (e) { ui.auth = null; render(false); showError(errorText(e)); }
      }
      return;
    }
    if (submittedAwards[tx.action.id]) {
      submittedAwards[tx.action.id].action = copyAwardAction(tx.action);
      submittedAwards[tx.action.id].revision = tx.revision;
    }
    pending = true; retryTx = tx; tx.inFlight = true;
    if (ui.auth) ui.auth.phase = 'saving'; render(false);
    request('POST', '/api/action', { revision: tx.revision, action: tx.action, grant: tx.grant || undefined, assistantDraft: tx.assistantDraft }, function (status, result) {
      if (tx.finished) return;
      pending = false; tx.inFlight = false;
      if (status === 200 && result.state) { setSnapshot(result); if (!reconcileSubmittedAward(submittedAwards[tx.action.id])) finishTransaction(tx); }
      else if (result.code === 'PHOTO_UNAVAILABLE' && recoverUnavailableAwardPhotos(tx)) return;
      else if (status === 409) conflict(tx, result);
      else if (status === 0) { tx.uncertain = true; connected = false; if (ui.auth) ui.auth.phase = 'retry'; render(false); showError(tx.action.type === 'pet.care' ? '照料结果待确认' : '连接中断 · 结果待确认'); sync(); }
      else if (status === 403 && tx.deviceAttempt && !tx.grant && result.code === 'PARENT_REQUIRED' && ui.auth && ui.auth.tx === tx) {
        tx.deviceAttempt = false; tx.uncertain = false; parentDevice.enabled = false;
        loadParentDevice(); issueChallenge(ui.auth);
      }
      else if (status === 403 || status === 410) { tx.grant = null; tx.uncertain = false; if (ui.auth) { ui.auth.phase = 'challenge-error'; ui.auth.busy = false; } render(false); showError(errorText(result)); }
      else { tx.grant = null; tx.uncertain = false; ui.auth = null; render(false); showError(tx.action.type === 'pet.care' && !ui.form ? '照料未完成' : errorText(result)); if (tx.action.type === 'pet.care' || (result.code === 'ACTION_ID_REUSED' && submittedAwards[tx.action.id])) sync(); }
    });
  }
  function pointsReceipt(action) {
    var record = find(state.points, 'points-' + action.id);
    if (!record) return '';
    var recorded = M.calendarParts(record.at, calendarZone()), date = today();
    var label = recorded.date === date ? '今天' : recorded.date === M.addDays(date, -1, calendarZone()) ? '昨天' : recorded.date.replace(/-/g, '/');
    return '已记好：' + record.name + ' +' + record.points + ' 分 · ' + label + ' ' + recorded.time;
  }
  function finishTransaction(tx) {
    if (tx.finished) return;
    tx.finished = true;
    delete submittedAwards[tx.action.id];
    if (AwardPhotos) AwardPhotos.closeViewer();
    var giftFlow = ui.form === tx.form && ledgerGiftFlow();
    if (['points.add', 'pet.care', 'pet.scene'].indexOf(tx.action.type) >= 0 && ui.form && ui.form !== tx.form) rememberDraft();
    pending = false; tx.grant = null; if (retryTx === tx) retryTx = null;
    if (ui.auth && ui.auth.tx === tx) ui.auth = null;
    var keepFarm = tx.form && ui.form === tx.form && tx.form.kind === 'farm' && ['farm.harvest', 'farm.animalCare', 'farm.place', 'farm.exchange'].indexOf(tx.action.type) >= 0;
    var keepInbox = tx.form && ui.form === tx.form && tx.form.kind === 'homeInbox' && ['task.ack', 'task.snooze', 'task.toggle', 'redemption.cancel'].indexOf(tx.action.type) >= 0;
    if (tx.form && ui.form === tx.form) {
      if (keepInbox || keepFarm || (giftFlow && tx.form.kind === 'rewards' && tx.action.type === 'redemption.cancel')) ui.form.openedRevision = revision;
      else {
        if (!tx.form.assistantDraft) { delete drafts[draftKey(tx.form)]; saveStore(DRAFT, drafts); }
        ui.form = ui.stack.pop() || null;
        if (giftFlow && ui.form && ui.form.kind === 'rewards' && ['redemption.request', 'redemption.approve'].indexOf(tx.action.type) >= 0) ui.form.openedRevision = revision;
        if (tx.action.type === 'pointItem.save' && ui.form && ui.form.kind === 'point-list') { ui.form.data.aiText = ''; ui.form.aiStatus = '已保存'; }
      }
    }
    var message = tx.message || '已保存';
    if (tx.action.type === 'points.add') { discardAwardPhotos(tx.form, tx.action.photoIds || []); if (!tx.keepAwardDraft) { discardOpenAwardPhotos(); stopRecognition(); invalidateAssistant(ui.form); ui.form = null; ui.stack = []; ui.view = 'points'; } var g = growthInfo(), pet = currentPet(); message = '+' + tx.action.points + ' 分 · ' + (tx.previousGrowth && g.level > tx.previousGrowth.level ? '升级啦！' : '记好啦！'); ui.petReaction = 'celebrate'; ui.petMessage = message; }
    if (tx.action.type === 'pet.buy') { message = '补给已入背包'; if (ui.form && ui.form.kind === 'petHub') { ui.form.data.tab = 'bag'; ui.form.openedRevision = revision; } }
    if (tx.action.type === 'pet.care') {
      var status = playStatus(), before = tx.previousPetStatus, unlocked = status && status.unlockedScenes.filter(function (id) { return !before || before.unlockedScenes.indexOf(id) < 0; }), newest = unlocked && unlocked.length ? find(status.scenes, unlocked[unlocked.length - 1]) : null;
      message = status && status.farmMode ? careName(tx.action.care) + '完成 · 特别互动' : newest && newest.id !== 'home' ? '解锁' + newest.name + '！' : status && before && revision === tx.revision + 1 ? careName(tx.action.care) + '完成 · 探索+' + (status.exploration - before.exploration) : '照料完成 · 进度已同步';
      discardOpenAwardPhotos(); stopRecognition(); invalidateAssistant(ui.form); ui.form = null; ui.stack = []; ui.view = 'points'; ui.careBusy = true; ui.petReaction = newest && newest.id !== 'home' ? 'unlock' : tx.action.care; ui.petMessage = message;
    }
    if (tx.action.type === 'pet.scene') { var scene = find(playStatus().scenes, tx.action.sceneId); discardOpenAwardPhotos(); ui.form = null; ui.stack = []; ui.view = 'points'; message = '已到' + (scene ? scene.name : '新场景'); }
    if (tx.action.type === 'pet.configure') { clearTimeout(petTimer); ui.careBusy = false; ui.petReaction = 'idle'; ui.petMessage = ''; clearToast(); }
    persist(); render(false);
    var receipt = tx.action.type === 'points.add' && ui.homeMode === 'points' ? pointsReceipt(tx.action) : '';
    if (tx.ledgerRedemption) {
      var redeemed = find(state.redemptions, 'redeem-' + tx.action.id);
      if (redeemed) receipt = '已兑换「' + redeemed.name + '」 · 扣 ' + redeemed.points + ' 分，剩 ' + M.totals(state).available + ' 分';
    }
    if (keepInbox) clearToast(); else toast(receipt || message, !!receipt);
    if (Farm) Farm.complete(tx.action);
    if (tx.action.type === 'points.add') { play('points'); reactPet('celebrate', message); }
    if (tx.action.type === 'pet.care') reactPet(ui.petReaction, message);
    if (tx.action.type === 'points.add' || tx.action.type === 'pet.care' || tx.action.type === 'pet.scene') { var hero = document.querySelector('.companion-scene'); if (hero) hero.focus(); }
    if (tx.action.type === 'redemption.approve') play('redeem');
    if (tx.assistantDraft && chat && scopeReady() && !ui.auth) chat.open();
    if (tx.action.type === 'parent.configure') { clearParentSecrets(tx); loadMeta(); }
  }
  function draftKey(f) { return f.kind + ':' + (f.kind === 'points' || f.kind === 'petBuy' ? f.data.itemId || 'new' : f.data.id || f.data.rewardId || f.data.requestId || 'new'); }
  function fields(formId) { var form = document.getElementById(formId || 'editor-form'), out = {}; if (!form) return out; Array.prototype.forEach.call(form.elements, function (e) { if (e.name && !e.disabled && e.type !== 'file') out[e.name] = e.type === 'checkbox' ? e.checked : e.value; }); return out; }
  function rememberDraft() {
    if (!ui.form || ui.auth) return;
    var values = fields(), f = ui.form;
    Object.keys(values).forEach(function (key) { if (['pin', 'confirmPin', 'setupPin', 'setupConfirm', 'answer', 'credential'].indexOf(key) < 0) f.data[key] = values[key]; });
    if (!f.assistantDraft && ['points', 'petBuy', 'task', 'reward', 'pointItem', 'voice'].indexOf(f.kind) >= 0) { drafts[draftKey(f)] = clone(f.data); saveStore(DRAFT, drafts); }
  }
  function focusKey(element) { if (!element || !element.getAttribute) return null; return { tag: element.tagName, type: element.type || '', id: element.id || '', name: element.name || '', action: element.getAttribute('data-action') || '', dataId: element.getAttribute('data-id') || '' }; }
  function rememberSheetFocus() { if (!ui.form || ui.auth) return; var sheetEl = document.querySelector('.sheet'), body = document.querySelector('.sheet-body'); if (sheetEl && sheetEl.contains && sheetEl.contains(document.activeElement)) ui.form.focusKey = focusKey(document.activeElement); if (body) ui.form.scrollTop = body.scrollTop; if (sheetEl && ui.form.kind === 'homeWeek') ui.form.weekView = homeWeekView(sheetEl); }
  function restorePlayFocus(key) {
    var sheetEl = document.querySelector('.sheet') || document.querySelector('.app-shell'); if (!sheetEl) return;
    var nodes = sheetEl.querySelectorAll('button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),details > summary'), target = null;
    nodes = Array.prototype.filter.call(nodes, function (node) { return node.getClientRects().length > 0; });
    if (key) for (var i = 0; i < nodes.length; i++) { var candidate = focusKey(nodes[i]); if (candidate && candidate.tag === key.tag && candidate.type === key.type && candidate.id === key.id && candidate.name === key.name && candidate.action === key.action && candidate.dataId === key.dataId) { target = nodes[i]; break; } }
    if (!target) { for (var j = 0; j < nodes.length; j++) if (/^(INPUT|TEXTAREA|SELECT)$/.test(nodes[j].tagName)) { target = nodes[j]; break; } }
    if (!target) target = nodes[0];
    if (target) { try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); } }
  }
  function openForm(kind, data, restore, replace, deferRender) {
    if (AwardPhotos) AwardPhotos.closeViewer();
    discardAwardPhotoInput();
    if (avatarSelection && avatarSelection.form === ui.form) discardAvatar();
    rememberSheetFocus(); if (!ui.form) { ui.homeFocus = focusKey(document.activeElement); var main = document.getElementById('main'); ui.homeScrollTop = main ? main.scrollTop : 0; ui.recordHomeReturn = false; } rememberDraft(); stopRecognition(); invalidateAssistant(ui.form); if (ui.form) ui.form.avatarRequest = null;
    if (replace) discardAwardPhotos(ui.form);
    if (ui.form && !replace) ui.stack.push(ui.form);
    var f = { kind: kind, data: clone(data || {}), openedRevision: revision };
    if (kind === 'points') f.ledgerAward = ui.view === 'points' && ui.homeMode === 'points';
    if (kind === 'parentConfig') f.parentConfigured = meta.parent.configured;
    if (restore && drafts[draftKey(f)]) f.data = clone(drafts[draftKey(f)]);
    if (kind === 'task' && !f.data.id && f.data.date < today()) f.data.date = today();
    if (kind === 'points' && (!f.data.recordTime || f.data.recordDate !== today())) { f.data.recordTime = clock(); f.data.recordDate = today(); }
    awardPhotos(f);
    ui.form = f; ui.auth = null;
    if (kind === 'parentConfig' && saas) loadParentDevice();
    if (!deferRender) render(false);
  }
  function closeForm(exitPresetReview) {
    if (pending && !setupTx) return;
    if (AwardPhotos) AwardPhotos.closeViewer();
    discardAwardPhotoInput();
    if (setupTx) cancelSetup();
    if (ui.auth) {
      var exitToHome = exitPresetReview === true && isPristinePresetReview(ui.auth), tx = ui.auth.tx;
      ui.auth.autoPin = null; tx.grant = null; clearParentSecrets(tx);
      if (retryTx && (retryTx.action.type === 'parent.configure' || (exitToHome && retryTx === tx))) retryTx = null;
      ui.auth = null;
      if (!exitToHome) { render(false); return; }
      discardAwardPhotos(tx.form);
    }
    if (avatarSelection && avatarSelection.form === ui.form) discardAvatar();
    rememberDraft(); stopRecognition(); invalidateAssistant(ui.form); if (ui.form) ui.form.avatarRequest = null;
    var closed = ui.form, parent = ui.stack.pop() || null;
    ui.form = parent;
    discardAwardPhotos(closed);
    if (closed && closed.kind === 'parentConfig' && retryTx && retryTx.form === closed) { clearParentSecrets(retryTx); retryTx = null; }
    if (closed && parent && closed.kind === 'behaviorPicker' && parent.kind === 'points') parent.pickerState = { query: closed.data.query || '', page: closed.data.page || 0 };
    if (closed && parent && closed.kind === 'points' && parent.kind === 'behaviorPicker' && closed.pickerState) { parent.data.query = closed.pickerState.query || ''; parent.data.page = closed.pickerState.page || 0; }
    render(false);
  }
  function pointsData(item) {
    var d = item ? { itemId: item.id, name: item.name, points: item.points, reason: item.reason || '', recordTimeEdited: false } : { itemId: '', points: 5, saveAsTemplate: false, recordTimeEdited: false }, saved = drafts['points:' + (d.itemId || 'new')];
    if (saved && (saved.itemId || '') === (d.itemId || '')) d = clone(saved);
    d.itemId = item ? item.id : ''; d.saveAsTemplate = !item && d.saveAsTemplate === true;
    if (!d.recordTime || d.recordDate !== today()) { d.recordTime = clock(); d.recordDate = today(); d.recordTimeEdited = false; }
    return d;
  }
  function pointDraftChanged(item) {
    var d = drafts['points:' + item.id];
    if (!d) return false;
    if (d.itemId !== item.id || d.name !== item.name || Number(d.points) !== Number(item.points) || (d.reason || '') !== (item.reason || '')) return true;
    if (d.recordTimeEdited === true) return true;
    // Older drafts do not distinguish an untouched clock value from a parent's chosen time.
    return d.recordTimeEdited !== false && d.recordDate === today() && d.recordTime !== clock();
  }
  function reviewPointPreset(item, trigger) {
    var data = pointsData(item), failure = '';
    data.recordTime = clock(); data.recordDate = today(); data.recordTimeEdited = false;
    // Keep a real editable form, but do not mount or focus its fields before the review.
    openForm('points', data, false, false, true);
    ui.homeFocus = focusKey(trigger) || ui.homeFocus;
    try {
      var action = makeAction(ui.form, ui.form.data);
      beginAction(action, '已加 ' + action.points + ' 分。', true);
    } catch (e) { failure = errorText(e); }
    if (!ui.auth) { render(false); if (failure) showError(failure); }
  }
  function choosePoints(item) {
    rememberDraft(); var previous = ui.form, picker = previous && previous.kind === 'behaviorPicker' ? { query: previous.data.query || '', page: previous.data.page || 0 } : null, f;
    stopRecognition(); invalidateAssistant(previous);
    if (previous && previous.kind === 'points') f = previous;
    if (f) { f.data = pointsData(item); f.openedRevision = revision; f.aiStatus = ''; f.editVersion = (f.editVersion || 0) + 1; ui.form = f; if (picker) f.pickerState = picker; render(false); }
    else { openForm('points', pointsData(item)); if (picker) ui.form.pickerState = picker; }
    var input = document.querySelector('#editor-form [name="name"]'); if (input) input.focus();
  }
  function templateSavePreview() {
    var f = ui.form; if (!f || f.kind !== 'points' || f.data.itemId || !f.data.saveAsTemplate) return '';
    var d = f.data, name = (d.name || '').trim(), same = state.pointItems.filter(function (p) { return p.name === name; }), enabled = same.filter(function (p) { return p.enabled; })[0];
    return facts([['新增常用', name || '名称待填'], ['默认分值', d.points == null || String(d.points).trim() === '' ? '—' : '+' + d.points]], 'template-values') + (same.length ? '<div class="template-duplicate"><span>同名 · 另存一项</span>' + (enabled ? button('choose-point', '选用已有', 'text-button', enabled.id) : button('point-list', '查看已停用项', 'text-button')) + '</div>' : '');
  }
  function pointsAmount(value) { return (value == null || String(value).trim() === '' ? '—' : '+' + esc(value)) + '<small> 分</small>'; }
  function refreshTemplatePreview() {
    var f = ui.form; if (!f || f.kind !== 'points') return;
    var amount = document.querySelector('.entry-summary strong'); if (amount) amount.innerHTML = pointsAmount(f.data.points);
    var el = document.getElementById('template-save-preview'); if (el) el.innerHTML = templateSavePreview();
    var submit = document.querySelector('.sheet-save'); if (submit) { var label = '核对加分'; submit.textContent = pending ? '保存中' : label; submit.setAttribute('data-label', label); submit.setAttribute('aria-label', label); submit.disabled = pending || !awardPhotosReady(f); }
  }
  function field(label, name, value, extra, type) { return '<label class="field"><span>' + label + '</span><input name="' + name + '" type="' + (type || 'text') + '" value="' + esc(value) + '" ' + (extra || '') + '></label>'; }
  function area(label, name, value, extra) { return '<label class="field"><span>' + label + '</span><textarea name="' + name + '" rows="3" ' + (extra || '') + '>' + esc(value) + '</textarea></label>'; }
  function select(label, name, value, options) { return '<label class="field"><span>' + label + '</span><select name="' + name + '">' + options.map(function (o) { return '<option value="' + o[0] + '"' + (String(value) === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>'; }
  function sectionHeading(title, actions) { return '<div class="section-heading"><h2>' + title + '</h2><div class="heading-actions">' + (actions || '') + '</div></div>'; }
  function empty(text) { return '<p class="empty-state">' + esc(text) + '</p>'; }
  function activeRequest() { return (state.requests || []).filter(function (r) { return r.status === 'pending'; })[0]; }
  function homeViewportHeight() { return (window.visualViewport && window.visualViewport.height) || window.innerHeight; }
  function homeWide() {
    var width = window.innerWidth, height = homeViewportHeight();
    return width >= 700 || (width >= 480 && width > height && height <= 620);
  }
  function homeItemLimit() {
    if (ui.homeMode === 'points') return homeViewportHeight() > 450 ? 4 : 2;
    return window.innerWidth >= 700 && homeViewportHeight() > 450 ? 4 : 2;
  }
  function homeInboxKey() { return dueTasks().map(function (t) { return t.id + ':' + (t.snoozeUntil || ''); }).join('|') + '/' + (state.requests || []).filter(function (r) { return r.status === 'pending'; }).map(function (r) { return r.id; }).join('|') + '/' + revision; }
  function homeInboxButton() {
    var due = dueTasks().length, requests = (state.requests || []).filter(function (r) { return r.status === 'pending'; }).length, count = due + requests;
    return count ? button('home-inbox', icon(due ? 'clock' : 'gift') + '<span>' + (due && requests ? '待处理' : due ? '提醒' : '待审批') + '<b>' + count + '</b></span>', 'home-inbox-button', '', due + '条到点提醒，' + requests + '份待审批申请') : '';
  }
  function homeInboxTitle() { return '待处理 · ' + (dueTasks().length + (state.requests || []).filter(function (r) { return r.status === 'pending'; }).length) + ' 项'; }
  function focusInbox() {
    var target = document.querySelector('#home-inbox-body button:not([disabled])') || document.querySelector('.sheet [data-action="form-close"]');
    if (target) target.focus();
  }
  function homeInboxBody() {
    var list = dueTasks(), requests = (state.requests || []).filter(function (r) { return r.status === 'pending'; });
    return (list.length ? '<h3 class="inbox-heading">到点提醒</h3>' + list.map(function (t) { return '<section class="inbox-task"><h3>' + esc(t.title) + '</h3><p>' + niceDate(t.date) + ' ' + esc(t.time || '当天事项') + '</p><div class="reminder-banner-actions">' + button('task-ack', '知道了', 'btn', t.id) + button('task-snooze', '10分钟后', 'btn', t.id) + button('task-toggle', '完成', 'btn reminder-primary', t.id) + '</div></section>'; }).join('') : '') + (requests.length ? '<h3 class="inbox-heading">礼品申请</h3>' + requests.map(requestStrip).join('') : '') + (!list.length && !requests.length ? empty('待处理 0') : '');
  }
  var homeLabels = { points: '积分', companion: '伙伴' };
  function homeModeSwitch() {
    return '<div class="home-mode-switch" role="group" aria-label="首页视图">' + Object.keys(homeLabels).map(function (mode) {
      return '<button type="button" data-action="home-view" data-id="' + mode + '" aria-pressed="' + (ui.homeMode === mode) + '">' + homeLabels[mode] + '</button>';
    }).join('') + '</div>';
  }
  function header() {
    var avatarAction = state.childAvatar ? '更换头像' : '上传头像';
    if (ui.view === 'points') return '<header class="app-header home-header">' + button('profile-edit', '<span class="child-avatar">' + avatarImage(state.childAvatar, state.childName) + '<span class="avatar-camera-badge" aria-hidden="true">' + icon('camera') + '</span></span><span class="child-profile-copy"><strong>' + esc(state.childName) + '</strong><small class="profile-edit-hint">' + avatarAction + '</small><small id="connection-state" class="connection-state">' + (local || connected ? '' : serverReached ? '连接中断' : '连接中') + '</small></span>', 'child-profile home-profile', '', avatarAction + '，修改' + state.childName + '的昵称和头像') + homeModeSwitch() + '<div class="header-tools"><div id="home-inbox-slot">' + homeInboxButton() + '</div>' + button('preferences', icon('settings'), 'icon-button', '', '设置') + '</div></header>';
    return '<header class="app-header"><div class="brand-mark" aria-hidden="true">' + icon('star') + '</div><div class="app-title"><h1>小小向前</h1><span class="date-label">' + niceDate(today()) + ' · 星期' + ['日', '一', '二', '三', '四', '五', '六'][M.calendarParts(appClock(), calendarZone()).weekday] + '<small id="connection-state" class="connection-state">' + (local || connected ? '' : serverReached ? '连接中断' : '连接中') + '</small></span></div><div class="header-tools">' + (ui.display ? button('display', icon('close'), 'icon-button', '', '恢复自动锁定') : '') + button('preferences', icon('settings'), 'icon-button', '', '设置') + '</div></header>';
  }
  function navTab(view, glyph, label) {
    var current = ui.view === view;
    return button('nav', icon(glyph) + '<span>' + label + '</span>', 'nav-item' + (current ? ' active' : ''), view, label)
      .replace('<button ', '<button aria-current="' + (current ? 'page' : 'false') + '" ');
  }
  function navigation() {
    var dock = chat && !ui.form && !ui.auth;
    var tabs = navTab('points', 'home', '首页') + (dock ? chatEntry(true) : '') + navTab('reminders', 'calendar', '提醒');
    var voice = chat ? '' : button('voice', icon('mic') + '<span>指令</span>', 'voice-entry', '', '指令');
    return '<nav class="bottom-nav' + (dock ? ' assistant-dock' : '') + '" aria-label="主要模块"><div class="main-tabs">' + tabs + '</div>' + voice + '</nav>';
  }
  function chatEntry(inDock) {
    var mark = inDock ? '' : icon('assistant');
    return button('assistant-open', mark, inDock ? 'assistant-launcher assistant-orb' : 'assistant-sheet-entry', '', '打开家长助手')
      .replace('<button ', '<button title="' + (inDock ? '轻点聊天，长按说话' : '打开家长助手') + '"' +
        (inDock ? ' aria-description="轻点聊天，长按说话"' : '') + ' aria-haspopup="dialog" aria-controls="family-assistant-panel" ');
  }
  function assistantAvailable() {
    return scopeReady() && !ui.auth && !pending && !(ui.form && ['parentConfig', 'parentDevice'].indexOf(ui.form.kind) >= 0);
  }
  function openAssistant(element, press) {
    rememberDraft(); rememberSheetFocus(); stopRecognition();
    if (press) return chat.beginLauncherHold(element, press);
    return chat.open({trigger:element});
  }
  function bindLauncherHold() {
    var candidate = null, consumeClick = false;
    function clearPress() {
      if (!candidate) return;
      clearTimeout(candidate.timer);
      candidate.target.removeAttribute('data-hold-pending');
      candidate = null;
    }
    document.addEventListener('pointerdown', function (event) {
      if (!event.isPrimary || event.button !== 0) return;
      clearPress(); consumeClick = false;
      var target = event.target.closest && event.target.closest('.assistant-launcher');
      if (!target || chat.isOpen() || !assistantAvailable()) return;
      var press = {target:target, scope:scopeToken(), pointerId:event.pointerId, pointerType:event.pointerType,
        startX:event.clientX, startY:event.clientY, clientX:event.clientX, clientY:event.clientY};
      candidate = press; target.setAttribute('data-hold-pending', 'true');
      press.timer = setTimeout(function () {
        if (candidate !== press) return;
        clearPress();
        consumeClick = true;
        if (document.hidden || !document.contains(target) || !scopeCurrent(press.scope) || !assistantAvailable() || chat.isOpen()) return;
        openAssistant(target, press);
      }, chat.holdPressDelay);
    }, true);
    document.addEventListener('pointermove', function (event) {
      if (!candidate || candidate.pointerId !== event.pointerId) return;
      candidate.clientX = event.clientX; candidate.clientY = event.clientY;
      var dx = event.clientX - candidate.startX, dy = event.clientY - candidate.startY;
      if (dx * dx + dy * dy > chat.holdMoveTolerance * chat.holdMoveTolerance) {
        consumeClick = true; clearPress();
      }
    }, true);
    function ended(event) { if (candidate && candidate.pointerId === event.pointerId) clearPress(); }
    document.addEventListener('pointerup', ended, true);
    document.addEventListener('pointercancel', ended, true);
    document.addEventListener('lostpointercapture', ended, true);
    window.addEventListener('blur', clearPress);
    document.addEventListener('visibilitychange', function () { if (document.hidden) clearPress(); });
    document.addEventListener('contextmenu', function (event) {
      if (event.target.closest && event.target.closest('.assistant-launcher')) event.preventDefault();
    });
    // Stop the synthetic mouse press from focusing the dialog control now under the finger.
    document.addEventListener('touchend', function (event) {
      if (consumeClick && event.target.closest && event.target.closest('.assistant-launcher')) event.preventDefault();
    }, {capture:true, passive:false});
    // A release click can also land on the dialog that opened under the pointer.
    document.addEventListener('click', function (event) {
      if (!consumeClick || !event.detail) return;
      consumeClick = false; event.preventDefault(); event.stopImmediatePropagation();
    }, true);
  }
  function clearAssistantEditors(generation) {
    function belongs(form) { return form && form.assistantDraft && form.assistantDraft.generation === generation; }
    if (retryTx && retryTx.assistantDraft && retryTx.assistantDraft.generation === generation) retryTx = null;
    [ui.form].concat(ui.stack).forEach(function (form) { if (belongs(form)) discardAwardPhotos(form); });
    Object.keys(awardPhotoDrafts).forEach(function (key) {
      if (key.indexOf('assistant:' + generation + ':') !== 0) return;
      AwardPhotos.discard(awardPhotoDrafts[key], awardPhotoRequestEnvironment()); delete awardPhotoDrafts[key];
    });
    ui.stack = ui.stack.filter(function (form) { return !belongs(form); });
    if (belongs(ui.form)) { ui.form = ui.stack.pop() || null; render(false); }
  }
  function assistantContext() {
    var f = ui.form, d = f && f.data;
    return { view: ui.view, form: f ? f.kind : '', targetId: d ? d.id || d.itemId || d.requestId || d.rewardId || '' : '' };
  }
  function openAssistantRoute(route) {
    var routes = { pointItems:'point-list', rewards:'rewards', partner:'petHub', settings:'preferences' };
    if (Object.prototype.hasOwnProperty.call(routes, route)) openForm(routes[route], {});
    else if (route === 'redemptions') onAction('rewards-history');
    else if (route === 'points') onAction('records');
    else if (route === 'family') SaaS.openSettings();
    else if (route === 'reminders') onAction('nav', 'reminders');
    else if (route === 'parent') onAction('parent-config');
    else if (route === 'profile') onAction('profile-edit');
    else if (route === 'farm') onAction('farm-open');
    else return false;
    return true;
  }
  function applyAssistantCard(result, meta) {
    if (!assistantAvailable() || !result) return false;
    if (result.kind === 'route') return openAssistantRoute(result.route);
    var draft = meta && meta.draft;
    var binding = draft && draft.actions.filter(function (step) { return step.index === meta.index && step.status === 'pending'; })[0];
    if (!binding || draft.sourceRevision !== revision || draft.familyDay !== today()) {
      toast('家庭记录已变化，请在助手中重新核对'); sync(); return false;
    }
    var editor = assistantEditor(result);
    if (!editor) { toast('无法办理这项操作，请在助手中重新选择'); return false; }
    rememberDraft();
    var sameTarget = ui.form && ['id','itemId','rewardId','requestId','taskId'].every(function (field) {
      return (ui.form.data[field] || '') === (editor.data[field] || '');
    });
    if (sameTarget && ui.form.kind === editor.kind && editor.kind !== 'assistantReview') {
      // A partially filled form can contain a reason or time the parent didn't ask to replace.
      Object.keys(editor.patch).forEach(function (key) { ui.form.data[key] = editor.patch[key]; });
      ui.form.openedRevision = revision;
    } else openForm(editor.kind, editor.data);
    if (result.kind === 'form' && (result.missing || []).indexOf('points') >= 0 && !ui.form.data.templatePointsChosen && Number(ui.form.data.points) === 5) ui.form.data.points = '';
    ui.form.assistantDraft = { generation:draft.generation, turnId:draft.turnId, sourceRevision:draft.sourceRevision, familyDay:draft.familyDay, type:binding.type, actionId:binding.actionId };
    awardPhotos(ui.form);
    render(false);
    return true;
  }
  function assistantEditor(result) {
    var a = result.action || {}, p = a.payload || a, previous, patch, kind;
    if (result.kind === 'form' && result.form === 'pointItem') { kind = 'pointItem'; patch = result.fields || {}; previous = {points:'', enabled:true}; }
    else if (a.type === 'points.add') {
      kind = 'points'; patch = Object.assign({itemId:''}, p);
      delete patch.photoIds;
      if (patch.itemId) {
        var rule = find(state.pointItems, patch.itemId);
        if (!rule || !rule.enabled) return null;
        patch = Object.assign({name:rule.name, points:rule.points}, patch);
      }
    }
    else if (a.type === 'task.save') { kind = 'task'; patch = p.task; previous = patch && find(state.tasks, patch.id); }
    else if (a.type === 'reward.save') { kind = 'reward'; patch = p.reward; previous = patch && find(state.rewards, patch.id); }
    else if (a.type === 'pointItem.save') { kind = 'pointItem'; patch = p.item; previous = patch && find(state.pointItems, patch.id); }
    else if (a.type === 'redemption.request') { kind = 'request'; patch = {rewardId:p.rewardId}; }
    else if (a.type === 'redemption.approve') { kind = 'approve'; patch = {requestId:p.requestId, note:p.note || ''}; }
    else if (['task.toggle','task.ack','task.snooze'].indexOf(a.type) >= 0) { kind = 'taskAction'; patch = {type:a.type, taskId:p.taskId, minutes:p.minutes, title:result.title || '处理提醒'}; }
    else if (['pointItem.delete','redemption.cancel','reward.redeem','settings.update','task.delete','task.restore'].indexOf(a.type) >= 0) {
      kind = 'assistantReview'; patch = {command:Object.assign({}, p, {type:a.type}), title:result.title || '核对操作'};
    } else return null;
    if (!patch || (patch.id && !previous)) return null;
    return {kind:kind, patch:patch, data:Object.assign({}, previous || {}, patch)};
  }
  function assistantReviewBody(command) {
    if (!command) return empty('请重新打开助手核对');
    var target, rows = [];
    if (command.type === 'reward.redeem') {
      target = find(state.rewards, command.rewardId);
      rows = [['直接兑换', target && target.name], ['本次扣分', (target && target.points) + ' 分'], ['可兑换积分', M.totals(state).available + ' 分']];
    } else if (command.type === 'redemption.cancel') {
      target = find(state.requests, command.requestId);
      rows = [['取消待审批申请', target && target.name], ['本次扣分', '0 分']];
    } else if (command.type === 'pointItem.delete') {
      target = find(state.pointItems, command.itemId);
      rows = [['删除常用行为', target && target.name], ['历史积分', '已记入的积分保留']];
    } else if (command.type === 'settings.update') {
      var settings = command.settings || {};
      if (settings.monthEndDays !== undefined) rows.push(['月底可兑换天数', settings.monthEndDays]);
      if (settings.preferredReward !== undefined) {
        var reward = find(state.rewards, settings.preferredReward);
        rows.push(['心愿礼品', reward ? reward.name : '未选择']);
      }
      return facts(rows);
    } else {
      target = find(state.tasks, command.taskId);
      rows = [[command.type === 'task.restore' ? '恢复提醒' : '移除提醒', target && target.title]];
    }
    return target ? facts(rows) : empty('记录已更新，请返回助手重新核对');
  }
  function currentPet() { return state && state.pet || { kind: 'plant', name: '芽芽' }; }
  function reducedMotion() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function growthInfo() { return M.growth(state); }
  function playStatus() { return M.petStatus && (local || familyDay) ? M.petStatus(state, saas ? appClock() : local ? new Date() : familyDay, calendarZone()) : null; }
  function careName(care) { return { feed: '投喂', wash: '清洁', train: '训练' }[care] || '照料'; }
  function itemArt(id) { return window.FamilyPet && window.FamilyPet.renderItem ? window.FamilyPet.renderItem(id) : icon({ snack: 'snack', dew: 'water', ball: 'ball' }[id]); }
  function careButton(item, status, source, bag) {
    var awaiting = retryTx && retryTx.uncertain && retryTx.action.type === 'pet.care', same = awaiting && retryTx.action.care === item.care;
    if (same) source = retryTx.action.source;
    var busy = ui.careBusy || pending, ready = !!status && (local || connected), done = status && status.caredToday.indexOf(item.care) >= 0;
    var disabled = !ready || busy || (awaiting && !same), detail = !ready ? '未连接' : busy ? '照料中' : same ? '重试' : awaiting ? '核对中' : source === 'free' ? '共享免费·余' + status.freeRemaining : source === 'inventory' ? item.name + ' −1' : '库存0 · 补给';
    return '<button type="button" class="' + (bag ? 'btn outline pet-bag-use' : 'companion-interact pet-care-button') + '" data-action="pet-care" data-id="' + item.care + '" data-source="' + source + '" data-completed="' + !!done + '" aria-busy="' + !!busy + '"' + (disabled ? ' disabled' : '') + ' aria-label="' + careName(item.care) + '，' + esc(detail) + (done ? '，今日已完成' : '，今日未完成') + '"><span class="care-button-title">' + (bag ? '' : icon(done ? 'check' : { feed: 'snack', wash: 'water', train: 'ball' }[item.care])) + (bag ? same ? '重试本次' : '使用1件' : careName(item.care)) + '</span><small class="care-source">' + (bag && !busy && !awaiting && ready ? item.name + ' −1' : esc(detail)) + '</small></button>';
  }
  function careButtons(status) {
    var catalog = status ? status.catalog : [{ id: 'snack', care: 'feed', name: '' }, { id: 'dew', care: 'wash', name: '' }, { id: 'ball', care: 'train', name: '' }];
    return catalog.map(function (item) { return careButton(item, status, status && status.freeRemaining > 0 ? 'free' : status && status.inventory[item.id] > 0 ? 'inventory' : 'supply', false); }).join('');
  }
  function careControlsKey(status) { return JSON.stringify([status ? [status.familyDay, status.freeRemaining, status.inventory, status.caredToday] : null, local || connected, pending, ui.careBusy, retryTx && retryTx.uncertain && retryTx.action.type === 'pet.care' ? [retryTx.action.care, retryTx.action.source] : null]); }
  function refreshPetControls() { if (!state) return; var controls = document.querySelector('.companion-interactions'), status = playStatus(), key = careControlsKey(status); if (controls && controls.getAttribute('data-controls-key') !== key) { var focused = controls.contains(document.activeElement) ? focusKey(document.activeElement) : null; controls.innerHTML = careButtons(status); controls.setAttribute('data-controls-key', key); if (focused) restorePlayFocus(focused); } }
  function petDrawing(kind, stage, name, reaction, staticPreview, framing, sceneId) {
    if (staticPreview && kind === 'plant' && Farm && Farm.dragonPortrait) {
      var form = M.growthStages(kind)[stage - 1] || M.growthStages(kind)[0];
      return Farm.dragonPortrait(form.stage, 'default', (name || '芽芽') + ' · ' + form.name);
    }
    return window.FamilyPet ? window.FamilyPet.render({ kind: kind, stage: stage, name: name, reaction: reaction || 'idle', framing: framing || 'scene', sceneId: sceneId || (staticPreview ? 'home' : (playStatus() || {}).sceneId || state.petScene || 'home'), reducedMotion: !!staticPreview || reducedMotion() }) : '<div class="companion-loading">伙伴加载中</div>';
  }
  function avatarImage(value, name, extra) { return value ? '<img class="profile-avatar-image ' + (extra || '') + '" src="' + esc(value) + '" alt="' + esc(name || '孩子') + '的头像">' : '<span class="avatar-initial ' + (extra || '') + '" aria-hidden="true">' + esc(String(name || '小').slice(0, 1)) + '</span>'; }
  function companionPanel() {
    if (Farm && M.farmStatus) return Farm.home();
    var pet = currentPet(), g = growthInfo(), status = playStatus(), next = status && status.nextUnlock, goal = next ? next.name + ' 差' + next.remaining : status ? '全部地点已解锁' : '等待资源同步';
    return '<section class="companion-card" aria-label="成长伙伴"><div class="companion-heading">' + button('pet-growth', '<span id="home-feedback" class="pet-name" role="status" aria-live="polite" data-feedback="' + (ui.homeFeedback ? 'true' : 'false') + '" title="' + esc(ui.homeFeedback || pet.name) + '">' + esc(ui.homeFeedback || pet.name) + '</span><span class="pet-level">Lv.' + g.level + ' · ' + g.xp + ' 成长值' + (status ? ' · 探索' + status.exploration : '') + '</span>', 'pet-growth-entry', '', '查看' + pet.name + '的成长，' + g.stageName) + button('pet-hub', '<b>背包·探索</b><small>' + esc(goal) + '</small>', 'text-button pet-hub-entry', '', '背包和探索，' + goal) + '</div><div class="growth-track" role="progressbar" aria-label="本阶段成长进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(g.progress * 100) + '"><div style="width:' + Math.max(0, Math.min(100, g.progress * 100)) + '%"></div></div><button type="button" class="companion-scene" data-action="pet-touch" aria-label="免费摸摸' + esc(pet.name) + '"><div id="pet-art">' + petDrawing(pet.kind, g.stage, pet.name, ui.petReaction, false, 'hero') + '</div><span class="pet-touch-echo" aria-hidden="true">♥ 摸摸</span></button><p id="pet-dialogue" class="pet-announcement" aria-hidden="true">' + esc(ui.petMessage || '') + '</p><div class="companion-interactions" data-controls-key="' + esc(careControlsKey(status)) + '" aria-label="照料">' + careButtons(status) + '</div></section>';
  }
  function rankedItems() { return M.frequentPointItems(state, appClock()); }
  function behaviorTile(p, i, extra) {
    var symbol = extra === 'picker-behavior' ? '' : '<span class="behavior-symbol behavior-symbol-' + (i % 4) + '">' + icon(['leaf', 'pencil', 'sun', 'heart'][i % 4]) + '</span>';
    return button('choose-point', symbol + '<span class="behavior-copy"><b>' + esc(p.name) + '</b>' + (p.reason && extra !== 'picker-behavior' ? '<small>' + esc(p.reason) + '</small>' : '') + '</span><strong>+' + p.points + '</strong>', 'behavior-card ' + (extra || ''), p.id, p.name + '，加' + p.points + '分');
  }
  function homeSummary() {
    var date = today();
    if (ui.summaryState !== state || ui.summaryDate !== date || ui.summaryRevision !== revision) {
      ui.summary = window.FamilyHomePoints.analyze({ state: state, today: date, zone: calendarZone() });
      ui.summaryState = state; ui.summaryDate = date; ui.summaryRevision = revision;
    }
    return ui.summary;
  }
  function pointsPage() {
    var t = M.totals(state), wide = homeWide(), all = rankedItems(), items = all.slice(0, homeItemLimit()); ui.homeWide = wide; ui.homeItemLimit = homeItemLimit();
    if (ui.homeMode === 'points') {
      return window.FamilyHomePoints.render({ state: state, summary: homeSummary(), items: items, allCount: all.length, icon: icon, button: button });
    }
    return '<section data-home-mode="companion" class="growth-home interaction-home ' + (wide ? 'home-wide' : 'home-portrait') + '" data-home-layout="' + (wide ? 'landscape' : 'portrait') + '"><section class="credit-card" aria-label="积分操作">' + button('records', '<img class="credit-scene-art" data-credit-scene alt="" aria-hidden="true"><span class="credit-kicker credit-label">历史总积分</span><strong data-testid="earned-points" class="credit-value ' + (String(t.earned).length > 5 ? 'long-balance' : '') + '">' + t.earned + '</strong><span class="credit-redeemable"><span>可兑换积分</span><b data-testid="available-points" class="' + (String(t.available).length > 8 ? 'long-balance' : '') + '">' + t.available + '</b></span><span class="credit-history-hint">积分记录 ' + icon('list') + '</span>', 'credit-score', '', '历史总积分' + t.earned + '，可兑换积分' + t.available + '，查看记录') + '<div class="credit-actions">' + button('add-points', icon('star') + '<span>立即加分</span>', 'btn primary credit-add') + button('jump-rewards', icon('gift') + '<span>兑换</span>', 'btn credit-rewards', '', '礼品兑换') + '</div></section>' + companionPanel() + '<section class="frequent-behaviors home-behaviors"><div class="home-behavior-heading"><h2>棒棒哒</h2>' + button('all-behaviors', '全部行为 <small>' + all.length + '</small>' + icon('chevron'), 'text-button', '', '选择全部' + all.length + '个启用行为') + '</div><div class="home-behavior-buttons count-' + items.length + '">' + (items.length ? items.map(function (p, i) { return behaviorTile(p, i, 'home-behavior'); }).join('') : button('all-behaviors', icon('edit') + '<span>设置常用行为</span>', 'empty-behaviors')) + '</div></section></section>';
  }
  function pickerData() {
    var f = ui.form, query = (f.data.query || '').trim().toLowerCase(), all = rankedItems(), items = all.filter(function (p) { return !query || (p.name + ' ' + (p.reason || '')).toLowerCase().indexOf(query) >= 0; });
    var viewportHeight = (window.visualViewport && window.visualViewport.height) || window.innerHeight, shortScreen = window.innerHeight <= 440;
    var columns = window.innerWidth >= 700 ? 3 : 2, rowHeight = shortScreen ? 64 : 88, chrome = (shortScreen ? 80 : 106) + (f.data.searchOpen || query ? 56 : 0), footerHeight = shortScreen ? 57 : 66, gap = 8;
    var sheetEl = document.querySelector('.behavior-picker-sheet'), grid = sheetEl && sheetEl.querySelector('.picker-grid'), body = sheetEl && sheetEl.querySelector('.behavior-picker-body'), footer = sheetEl && sheetEl.querySelector('.picker-footer');
    if (grid && body && footer) {
      var gridStyle = window.getComputedStyle(grid), bodyStyle = window.getComputedStyle(body), sheetStyle = window.getComputedStyle(sheetEl), footerStyle = window.getComputedStyle(footer);
      columns = gridStyle.gridTemplateColumns.split(' ').length;
      rowHeight = parseFloat(gridStyle.gridAutoRows) || rowHeight; gap = parseFloat(gridStyle.rowGap) || 8;
      chrome = grid.getBoundingClientRect().top - sheetEl.getBoundingClientRect().top + body.scrollTop + (parseFloat(bodyStyle.paddingBottom) || 0) + (parseFloat(sheetStyle.paddingBottom) || 0);
      footerHeight = Math.max(parseFloat(footerStyle.minHeight) || 0, 48 + (parseFloat(footerStyle.paddingTop) || 0) + (parseFloat(footerStyle.paddingBottom) || 0) + 1);
    }
    var sheetHeight = sheetEl && sheetEl.getBoundingClientRect ? sheetEl.getBoundingClientRect().height : 0;
    if (sheetEl && sheetEl.classList.contains('ledger-sheet')) {
      // A one-result search shrinks the drawer; capacity still follows its allowed height.
      var container = sheetEl.parentElement, containerStyle = window.getComputedStyle(container), maxHeightStyle = window.getComputedStyle(sheetEl).maxHeight;
      var containerHeight = container.getBoundingClientRect().height - (parseFloat(containerStyle.paddingTop) || 0) - (parseFloat(containerStyle.paddingBottom) || 0);
      sheetHeight = Math.min(containerHeight, /px$/.test(maxHeightStyle) ? parseFloat(maxHeightStyle) : containerHeight);
    }
    var available = Math.min(740, viewportHeight - 12, sheetHeight || 740) - chrome;
    var rows = Math.max(1, Math.floor((available + gap) / (rowHeight + gap)));
    if (items.length > rows * columns) rows = Math.max(1, Math.floor((available - footerHeight + gap) / (rowHeight + gap)));
    var pageSize = rows * columns, pages = Math.max(1, Math.ceil(items.length / pageSize));
    f.data.page = Math.max(0, Math.min(pages - 1, Math.floor(Number(f.data.page) || 0)));
    return { all: all.length, total: items.length, query: query, page: f.data.page, pages: pages, pageSize: pageSize, items: items.slice(f.data.page * pageSize, (f.data.page + 1) * pageSize) };
  }
  function pickerResults(data) { return '<div class="picker-grid count-' + data.items.length + '">' + (data.items.length ? data.items.map(function (p, i) { return behaviorTile(p, i, 'picker-behavior'); }).join('') : '<div class="picker-empty"><p>' + (data.query ? '没有匹配项' : '暂无常用项') + '</p>' + button(data.query ? 'picker-clear' : 'points-new', data.query ? '清除' : icon('plus'), data.query ? 'btn outline' : 'icon-button nav-add', '', data.query ? '清除搜索' : '新增加分') + '</div>') + '</div>'; }
  function pickerFooter(data) {
    return '<button type="button" data-action="picker-prev" class="icon-button" aria-label="上一页"' + (data.page === 0 ? ' disabled' : '') + '>' + icon('back') + '</button><label class="picker-page-label">第 <input id="behavior-page" type="number" min="1" max="' + data.pages + '" inputmode="numeric" value="' + (data.page + 1) + '" aria-label="跳转到指定页"><span id="behavior-page-total"> / ' + data.pages + ' 页</span></label><button type="button" data-action="picker-next" class="icon-button" aria-label="下一页"' + (data.page + 1 >= data.pages ? ' disabled' : '') + '>' + icon('arrow') + '</button>';
  }
  function behaviorPickerContent() {
    var data = pickerData(), searchOpen = !!(ui.form.data.searchOpen || data.query);
    var actions = button('picker-search', icon('search'), 'icon-button' + (searchOpen ? ' active' : ''), '', searchOpen ? '收起搜索' : '搜索加分项').replace('<button ', '<button aria-controls="behavior-search-tools" aria-expanded="' + searchOpen + '" ');
    var heading = '<div class="picker-section-heading"><div class="picker-section-title"><h3>常用行为</h3>' + button('point-list', '管理', 'text-button picker-manage', '', '管理常用行为') + '</div>' + button('points-new', icon('plus') + '<span>自定义加分</span>', 'text-button picker-custom-award', '', '自定义加分') + '</div>';
    return sheet('加分', '', '<div class="behavior-picker-body">' + heading + '<div id="behavior-search-tools" class="picker-tools"' + (searchOpen ? '' : ' hidden') + '><div class="picker-search"><input id="behavior-search" type="search" value="' + esc(ui.form.data.query || '') + '" placeholder="搜索行为或原因" aria-label="搜索行为">' + button('picker-clear', icon('close'), 'icon-button', '', '清除搜索') + '</div></div><div id="behavior-picker-results" class="behavior-picker-results">' + pickerResults(data) + '</div></div><div id="behavior-picker-footer" class="sheet-footer picker-footer"' + (data.pages === 1 ? ' hidden' : '') + '>' + pickerFooter(data) + '</div>', false, actions);
  }
  function updatePicker(commitPage) {
    if (!ui.form || ui.form.kind !== 'behaviorPicker' || ui.auth) return;
    var data = pickerData(), results = document.getElementById('behavior-picker-results'), footer = document.getElementById('behavior-picker-footer');
    var resultFocus = results && results.contains(document.activeElement) ? focusKey(document.activeElement) : null;
    if (results) results.innerHTML = pickerResults(data);
    if (footer) {
      var previous = footer.querySelector('[data-action="picker-prev"]'), next = footer.querySelector('[data-action="picker-next"]'), page = document.getElementById('behavior-page'), total = document.getElementById('behavior-page-total'), active = document.activeElement;
      if (data.pages === 1 && footer.contains(active)) { var search = document.getElementById('behavior-search'); if (search) search.focus(); }
      footer.hidden = data.pages === 1;
      if (previous) previous.disabled = data.page === 0; if (next) next.disabled = data.page + 1 >= data.pages;
      if (page) { page.max = data.pages; if (commitPage || document.activeElement !== page) page.value = data.page + 1; }
      if (total) total.textContent = ' / ' + data.pages + ' 页';
      if (data.pages > 1 && page && ((active === previous && previous.disabled) || (active === next && next.disabled))) page.focus();
    }
    if (resultFocus) restorePlayFocus(resultFocus);
  }
  function ledgerGiftFlow() {
    if (ui.view !== 'points' || ui.homeMode !== 'points' || !ui.form) return false;
    var kind = ui.form.kind;
    return kind === 'rewards' || ((kind === 'request' || kind === 'approve' || (kind === 'records' && ui.form.data.source === 'rewards')) &&
      ui.stack.some(function (f) { return f.kind === 'rewards'; }));
  }
  function giftFilters(ledger) {
    var filters = [['all', '全部'], ['daily', '日常'], ['weekend', '周末'], ['outing', '月底']];
    return '<div class="filter-tabs' + (ledger ? ' ledger-gift-filters' : '') + '" role="group" aria-label="礼品类别">' + filters.map(function (item) {
      var selected = ui.filter === item[0];
      return button('reward-filter', item[1], 'filter-tab' + (selected ? ' active' : ''), item[0]).replace('<button ', '<button aria-pressed="' + selected + '" ');
    }).join('') + '</div>';
  }
  function giftAvailability(permission, reward, balance) {
    var rule = availabilityLabel(permission), missing = reward.points - balance;
    return missing > 0 && !/^还差/.test(rule) ? rule + ' · 还差 ' + missing + ' 分' : rule;
  }
  function giftDetail(reward, price, balance, available) {
    return '<div class="gift-detail"><span class="reward-symbol ' + esc(reward.category) + '">' + icon(reward.icon) + '</span><h3>' + esc(reward.name) + '</h3><strong class="gift-price">' + price + '<small> 分</small></strong></div>' +
      (available && balance >= price ? '<div class="gift-balance-line"><span>现有 ' + balance + ' 分</span><strong>兑换后剩 ' + (balance - price) + ' 分</strong></div>' :
        '<div class="gift-balance-line"><span>现有积分</span><strong>' + balance + ' 分</strong></div>');
  }
  function rewardsBody() {
    var req = activeRequest(), balance = M.totals(state).available, now = appClock(), zone = calendarZone(), ledger = ledgerGiftFlow();
    var rewards = state.rewards.filter(function (r) { return r.enabled && (ui.filter === 'all' || ui.filter === r.category); });
    var ready = [], later = [];
    rewards.forEach(function (r) {
      var permission = M.availability(state, r.id, now, zone), rule = ledger ? giftAvailability(permission, r, balance) : availabilityLabel(permission);
      var cost = '<span class="reward-cost">' + r.points + '<small> 分</small></span>';
      var symbol = '<span class="reward-symbol ' + esc(r.category) + '">' + icon(r.icon) + '</span>';
      var hint = '<small class="reward-rule">' + esc(rule) + '</small>';
      var info = '<span class="reward-info"><strong>' + esc(r.name) + '</strong>' + (ledger ? (permission.allowed ? '' : hint) : cost + hint) + '</span>';
      var card = button('redeem', symbol + info + (ledger ? cost : '') + icon('chevron'), 'reward-card', r.id, ledger ? r.name + '，' + r.points + ' 分，' + rule : '');
      if (ledger && !permission.allowed) later.push(card); else ready.push(card);
    });
    var pendingRequest = req ? requestStrip(req, ledger) : '';
    if (!ledger) return '<div class="rewards-sheet-heading"><p>可用 <strong>' + balance + '</strong> 分</p>' + button('rewards-history', icon('list') + '<span>兑换记录</span>', 'text-button rewards-history-entry', '', '查看兑换记录') + '</div>' + pendingRequest + giftFilters(false) + '<div class="rewards-grid">' + ready.join('') + '</div>' + (rewards.length ? '' : empty('礼品 0'));
    var wallet = '<div class="gift-wallet"><div><span class="gift-balance-label">可兑换积分</span><strong class="gift-balance">' + balance + '<small> 分</small></strong></div>' +
      button('rewards-history', icon('history'), 'gift-history', '', '查看兑换记录') + '</div>';
    function group(title, cards) {
      return cards.length ? '<section class="gift-group"><h3 class="gift-group-title">' + title + '</h3><div class="rewards-grid">' + cards.join('') + '</div></section>' : '';
    }
    return wallet + pendingRequest + giftFilters(true) + group('现在能换', ready) + group('暂时不能换', later) +
      (rewards.length ? '' : empty(ui.filter === 'all' ? '还没有礼品' : '这个类别还没有礼品'));
  }
  function growthBody() {
    var pet = currentPet(), g = growthInfo(), stages = M.growthStages(pet.kind);
    return facts([['成长值', g.xp], ['成长阶段', g.stageName], ['成长星', g.stars]], 'growth-values') + '<div class="growth-journey">' + stages.map(function (stage) { var at = stage.at, i = stage.stage - 1; return '<div class="journey-step ' + (g.stage === i + 1 ? 'current' : g.xp >= at ? 'unlocked' : '') + '"><div class="journey-pet">' + petDrawing(pet.kind, i + 1, pet.name, 'idle', true) + '</div><div><span>阶段 ' + (i + 1) + ' · 成长值 ' + at + '</span><h3>' + esc(stage.name) + '</h3><small>' + (g.xp >= at ? (g.stage === i + 1 ? '当前' : '已到达') : '还差 ' + (at - g.xp)) + '</small></div><span class="journey-badge">' + icon(g.xp >= at ? 'check' : 'lock') + '</span></div>'; }).join('') + '</div>';
  }
  function reactPet(reaction, message) {
    if (!scopeReady()) return;
    var scope = scopeToken();
    var pet = currentPet(), g = growthInfo(), words = { pet: '嘿嘿，最喜欢你的摸摸啦！', feed: '啊呜！这口真好吃～', wash: '泡泡飞起来啦，我也香香啦！', train: '接住！再一起玩一会儿吧！', celebrate: '我们又一起进步啦！', unlock: '新地点解锁！' };
    clearTimeout(petTimer); ui.petReaction = reaction; ui.petMessage = message || words[reaction] || words.pet;
    if (Farm) Farm.react(reaction, 'pet');
    var art = document.getElementById('pet-art'), dialogue = document.getElementById('pet-dialogue');
    if (art) art.innerHTML = petDrawing(pet.kind, g.stage, pet.name, reaction, false, 'hero');
    if (dialogue) { dialogue.textContent = ui.petMessage; if (dialogue.parentNode.classList) dialogue.parentNode.classList.add('pet-speaking'); }
    if (reaction !== 'celebrate') play('complete'); if (!message && !document.querySelector('.pet-home-card')) toast(ui.petMessage);
    petTimer = setTimeout(function () { if (!scopeCurrent(scope)) return; ui.petReaction = 'idle'; ui.petMessage = ''; ui.careBusy = false; var current = currentPet(), art = document.getElementById('pet-art'), dialogue = document.getElementById('pet-dialogue'); if (dialogue) { dialogue.textContent = ''; if (dialogue.parentNode.classList) dialogue.parentNode.classList.remove('pet-speaking'); } if (art) art.innerHTML = petDrawing(current.kind, growthInfo().stage, current.name, 'idle', false, 'hero'); refreshPetControls(); if (ui.form && ui.form.kind === 'petHub' && !ui.auth) render(false); }, 2700);
  }
  function touchPet() {
    if (!scopeReady()) return;
    var scope = scopeToken();
    ui.petTouches++;
    if (pending || ui.careBusy || ui.petReaction === 'celebrate' || ui.petReaction === 'unlock') { var scene = document.querySelector('.companion-scene'); if (scene) { scene.classList.add('pet-touched'); setTimeout(function () { if (scopeCurrent(scope)) scene.classList.remove('pet-touched'); }, 450); } return; }
    reactPet('pet');
  }
  function requestStrip(req, ledger) {
    var reward = find(state.rewards, req.rewardId), price = reward ? reward.points : req.points;
    if (ledger) return '<div class="request-strip" data-request-id="' + esc(req.id) + '"><div class="request-copy"><span class="status-label">等家长确认</span><strong>' + esc(reward ? reward.name : req.name) + '<em>' + price + ' 分</em></strong><small>尚未扣分</small></div><div class="request-actions">' + button('redemption-approve', '家长确认', 'btn primary', req.id) + button('redemption-cancel', '取消申请', 'btn outline', req.id) + '</div></div>';
    return '<div class="request-strip" data-request-id="' + esc(req.id) + '"><div class="request-copy"><span class="status-label">待审批</span><strong>' + esc(reward ? reward.name : req.name) + '<em>' + price + ' 分</em></strong><small>已扣分 0</small></div><div class="request-actions">' + button('redemption-approve', '家长确认', 'btn primary', req.id) + button('redemption-cancel', '取消申请', 'btn danger', req.id) + '</div></div>';
  }
  function taskRow(t) {
    var status = t.done ? '已完成' : t.snoozeUntil && new Date(t.snoozeUntil).getTime() > appClock().getTime() ? '稍后至 ' + niceTime(t.snoozeUntil).split(' ')[1] : t.ackAt ? '已知道' : '';
    if (t.type === 'task' && t.date < today()) status = '原定' + niceDate(t.date) + (status ? ' · ' + status : ' · 尚未完成');
    return '<div class="task-row ' + (t.done ? 'is-done' : '') + (t.date < today() && !t.done ? ' is-overdue' : '') + '" data-task-id="' + esc(t.id) + '">' + button('task-toggle', icon('check'), 'task-complete ' + (t.done ? 'done' : ''), t.id, (t.done ? '撤销完成：' : '完成：') + t.title).replace('<button ', '<button aria-pressed="' + !!t.done + '" ') + button('task-edit', '<span class="task-copy"><strong>' + esc(t.title) + '</strong><span class="task-time"><b>' + esc(t.time || '当天') + '</b>' + (t.type === 'event' ? '<small>' + niceDate(t.date) + '</small>' : '') + (status ? '<small>' + esc(status) + '</small>' : '') + '</span>' + (t.note ? '<span class="task-note">' + esc(t.note) + '</span>' : '') + '</span>' + icon('chevron'), 'task-open', t.id, '编辑提醒：' + t.title) + '</div>';
  }
  function reminderPage() {
    var all = state.tasks.filter(function (t) {
      if (t.deleted) return false;
      if (ui.reminderMode === 'events') return t.type === 'event' && (t.date >= today() || !t.done);
      return t.type === 'task' && (t.date === day(ui.day) || (ui.day === 0 && t.date < today() && !t.done));
    }).sort(function (a, b) { return (a.date + (a.time || '99')).localeCompare(b.date + (b.time || '99')); });
    var active = all.filter(function (t) { return !t.done; }), done = all.filter(function (t) { return t.done; });
    var preparation = ui.reminderMode === 'near' && ui.day === 0 ? state.tasks.filter(function (t) {
      return t.type === 'event' && !t.deleted && !t.done && t.date >= today() && t.date <= M.addDays(today(), Number(t.remindDays || 0), calendarZone());
    }).sort(function (a, b) { return (a.date + (a.time || '99')).localeCompare(b.date + (b.time || '99')); }) : [];
    return '<section class="reminders-screen"><div class="reminder-heading"><div><h2>提醒</h2></div>' + button('task-new', icon('plus'), 'icon-button nav-add', '', '新增提醒') + '</div><div class="reminder-toolbar"><div class="day-tabs">' + (ui.reminderMode === 'near' ? ['今天', '明天', '后天'].map(function (s, i) { return button('day', s + '<small>' + Number(day(i).slice(-2)) + '</small>', 'day-tab ' + (ui.day === i ? 'active' : ''), String(i)); }).join('') : '<span class="events-label">重要事件</span>') + '</div>' + button('reminder-mode', ui.reminderMode === 'near' ? '重要事件' : '回到近期', 'text-button', ui.reminderMode === 'near' ? 'events' : 'near') + '</div><div class="reminder-list">' + active.map(taskRow).join('') + (active.length ? '' : empty(ui.reminderMode === 'events' ? '暂无待处理的重要事件' : ['今天', '明天', '后天'][ui.day] + '没有待办')) + '</div>' + (preparation.length ? '<section class="advance-events" data-region="advance-events"><div class="section-heading"><h3>提前准备</h3><small>重要事件</small></div>' + preparation.map(taskRow).join('') + '</section>' : '') + (done.length ? '<details class="completed-list"><summary>已完成 ' + done.length + ' 项</summary>' + done.map(taskRow).join('') + '</details>' : '') + '</section>';
  }
  function dueTasks() {
    if (!state || !scopeReady()) return [];
    return state.tasks.filter(function (t) { if (t.deleted || t.done || !t.time || t.ackAt) return false; var at; try { at = new Date(t.snoozeUntil || M.calendarTimestamp(t.date, t.time, calendarZone())).getTime(); } catch (e) { return false; } return isFinite(at) && at <= appClock().getTime(); }).sort(function (a, b) { return (a.snoozeUntil || a.date + 'T' + a.time).localeCompare(b.snoozeUntil || b.date + 'T' + b.time); });
  }
  function reminderBanner() {
    var list = dueTasks(), t = list[0]; if (!t) return '';
    return '<section class="reminder-banner" aria-label="到点提醒"><div class="reminder-banner-copy">' + icon('clock') + '<div><small>' + (list.length > 1 ? list.length + ' 条提醒待处理' : '到点提醒') + '</small><strong>' + esc(t.title) + '</strong></div></div><div class="reminder-banner-actions">' + button('task-ack', '知道了', 'btn', t.id) + button('task-snooze', '10分钟后', 'btn', t.id) + button('task-toggle', '完成', 'btn reminder-primary', t.id) + '</div></section>';
  }
  function renderReminder() {
    if (!scopeReady()) return;
    var el = document.getElementById('reminder-slot'), inbox = document.getElementById('home-inbox-slot');
    if (el) el.innerHTML = ui.view === 'points' ? '' : reminderBanner();
    var inboxKey = homeInboxKey();
    if (inbox && inbox.getAttribute('data-key') !== inboxKey) { inbox.innerHTML = homeInboxButton(); inbox.setAttribute('data-key', inboxKey); }
    if (ui.form && ui.form.kind === 'homeInbox' && !ui.auth && ui.inboxKey !== inboxKey) { ui.inboxKey = inboxKey; var body = document.getElementById('home-inbox-body'); if (body) { var focused = body.contains(document.activeElement); body.innerHTML = homeInboxBody(); var title = document.getElementById('sheet-title'); if (title) title.textContent = homeInboxTitle(); ui.form.openedRevision = revision; if (focused) focusInbox(); } }
    var list = dueTasks(), key = list.map(function (t) { return t.id + ':' + (t.snoozeUntil || t.date + t.time); }).join('|');
    if (key && key !== reminderSound && document.visibilityState !== 'hidden') { reminderSound = key; play('complete'); } if (!key) reminderSound = '';
  }
  function recordsBody() {
    var t = M.totals(state), kind = ui.history, rows = kind === 'points' ? state.points : kind === 'purchases' ? state.petPurchases || [] : state.redemptions;
    var types = [['points', '加分记录'], ['redemptions', '礼品兑换'], ['purchases', '道具购买']];
    var tabs = types.map(function (item) {
      var selected = kind === item[0];
      return button('history', item[1], 'day-tab' + (selected ? ' active' : ''), item[0]).replace('<button ', '<button aria-pressed="' + selected + '" ');
    }).join('');
    var metrics = [['历史总积分', t.earned], ['已使用', t.spent], ['可兑换积分', t.available]].map(function (item) {
      return '<span' + (String(item[1]).length > 6 ? ' class="points-ledger-total-long"' : '') + '>' + item[0] + '<b>' + item[1] + '</b></span>';
    }).join('');
    var entries = rows.slice().reverse().map(function (record) { return pointsLedgerRow(record, kind); }).join('');
    var emptyCopy = { points: ['还没有加分记录', '每次加分的名称、分值和原因会保留在这里。'], redemptions: ['还没有礼品兑换记录', '家长确认兑换后，可以在这里查看礼品和花费。'], purchases: ['还没有道具购买记录', '购买过的道具、数量和花费会保留在这里。'] };
    if (!rows.length) entries = '<div class="points-ledger-empty">' + icon('list') + '<p>' + emptyCopy[kind][0] + '</p><span>' + emptyCopy[kind][1] + '</span></div>';
    return '<section class="points-ledger"><div class="ledger-summary' + (String(t.earned).length > 6 ? ' points-ledger-summary-long' : '') + '" aria-label="积分概览">' + metrics + '</div><div class="day-tabs history-tabs" role="group" aria-label="记录类型">' + tabs + '</div>' + (rows.length ? '<p class="points-ledger-count">共 ' + rows.length + ' 笔</p>' : '') + '<div class="record-list"' + (rows.length ? ' role="list"' : '') + '>' + entries + '</div></section>';
  }
  function pointsLedgerRow(record, kind) {
    var positive = kind === 'points', detail = '', meta = '';
    if (kind === 'purchases') meta = record.quantity + ' 件 × ' + record.unitPoints + ' 分/件';
    else if (positive) { detail = record.reason || ''; meta = detail.trim() ? '' : '未填写原因'; }
    else { detail = record.note || ''; meta = category(record.category) + '礼品'; }
    var repeated = detail.trim() === String(record.name).trim();
    var photos = positive && record.photoIds && record.photoIds.length ? '<span class="points-record-photo-count">' + record.photoIds.length + ' 张照片</span>' : '';
    var content = '<span class="points-ledger-copy"><strong>' + esc(record.name) + '</strong><span class="points-ledger-meta"><time datetime="' + esc(record.at) + '">' + esc(niceTime(record.at)) + '</time>' + (meta ? '<span>' + esc(meta) + '</span>' : '') + '</span></span><b class="record-number ' + (positive ? 'is-earned' : 'is-spent') + (String(record.points).length > 6 ? ' points-ledger-amount-long' : '') + '">' + (positive ? '+' : '−') + record.points + '<small> 分</small></b>' + (detail.trim() && !repeated ? '<span class="points-ledger-note">' + esc(detail) + '</span>' : '') + photos + icon('chevron');
    var recordKind = positive ? 'points' : kind === 'purchases' ? 'purchase' : 'redemption';
    return '<div role="listitem">' + button('record-detail', content, 'points-record-link record-row', recordKind + ':' + record.id, record.name + '，' + niceTime(record.at) + '，' + (positive ? '加' : '使用') + record.points + '分，查看详情') + '</div>';
  }
  function detailRecord(data) {
    if (!data || !state) return null;
    var rows = data.recordKind === 'points' ? state.points : data.recordKind === 'redemption' ? state.redemptions : data.recordKind === 'purchase' ? state.petPurchases || [] : null;
    return rows ? find(rows, data.recordId) : null;
  }
  function openRecordDetail(key, trigger) {
    if (typeof key !== 'string') return;
    var separator = key.indexOf(':'), data = { recordKind: key.slice(0, separator), recordId: key.slice(separator + 1) };
    if (separator < 0 || !detailRecord(data)) return;
    var returnFocus = focusKey(trigger);
    openForm('recordDetail', data, false, false, true);
    ui.recordHomeReturn = true;
    if (returnFocus) { if (ui.stack.length) ui.stack[ui.stack.length - 1].focusKey = returnFocus; else ui.homeFocus = returnFocus; }
    render(false);
  }
  function recordPhotoEnvironment(form) {
    var env = awardPhotoRequestEnvironment();
    env.root = document.querySelector('.points-record-detail');
    env.active = function () { return env.current() && ui.form === form && !ui.auth && !!detailRecord(form.data); };
    return env;
  }
  function recordDetailBody(data) {
    var record = detailRecord(data);
    if (!record) return '<p class="points-summary-empty">这条记录已不存在</p>';
    var positive = data.recordKind === 'points', purchase = data.recordKind === 'purchase', parts = M.calendarParts(record.at, calendarZone());
    var kind = positive ? '加分' : purchase ? '道具购买' : '礼品兑换', reason = positive ? record.reason : record.note;
    var date = parts.year + '年' + parts.month + '月' + parts.day + '日';
    var metadata = '<div><dt>日期</dt><dd><time datetime="' + esc(parts.date) + '">' + esc(date) + '</time></dd></div><div><dt>时间</dt><dd><time datetime="' + esc(record.at) + '">' + esc(parts.time) + '</time></dd></div>';
    if (purchase) metadata += '<div><dt>数量</dt><dd>' + record.quantity + ' 件</dd></div><div><dt>单价</dt><dd>' + record.unitPoints + ' 分 / 件</dd></div>';
    else if (!positive) metadata += '<div><dt>类别</dt><dd>' + esc(category(record.category)) + '礼品</dd></div>';
    var note = purchase ? '' : '<section class="points-record-detail-note" aria-labelledby="points-record-note-title"><h4 id="points-record-note-title">' + (positive ? '原因' : '备注') + '</h4><p>' + esc(reason || (positive ? '未填写原因' : '未填写备注')) + '</p></section>';
    return '<section class="points-record-detail" data-record-kind="' + esc(data.recordKind) + '" data-record-id="' + esc(record.id) + '"><div class="points-record-detail-heading"><span class="points-record-detail-kind">' + kind + '</span><h3>' + esc(record.name) + '</h3><strong class="points-record-detail-amount' + (positive ? '' : ' is-spent') + (String(record.points).length > 8 ? ' points-detail-amount-long' : '') + '">' + (positive ? '+' : '−') + record.points + '<small> 分</small></strong></div><dl class="points-record-detail-meta">' + metadata + '</dl>' + note + (positive && AwardPhotos ? AwardPhotos.details(record.photoIds) : '') + '</section>';
  }
  function menuRow(action, title, note, symbol, options) {
    options = options || {};
    var toggle = typeof options.checked === 'boolean';
    var end = options.inline && note ? '<small class="preferences-row-value">' + esc(note) + '</small>' : '';
    if (options.value) end += '<span class="preferences-row-action">' + esc(options.value) + '</span>';
    else if (toggle) end += '<span class="preferences-switch" aria-hidden="true"><span></span></span>';
    else if (options.chevron !== false) end += icon('chevron');
    var row = button(action, '<span class="menu-symbol">' + icon(symbol) + '</span><span class="preferences-row-copy"><b>' + esc(title) + '</b>' + (!options.inline && note ? '<small>' + esc(note) + '</small>' : '') + '</span>' + end, 'menu-row' + (action === 'parent-config' ? ' parent-entry' : '') + (action === 'saas-logout' ? ' preferences-logout' : ''), null, options.label);
    return toggle ? row.replace('<button ', '<button role="switch" aria-checked="' + options.checked + '" aria-busy="' + !!options.busy + '" ') : row;
  }
  function preferencesBody() {
    var speech = !!(window.SpeechRecognition || window.webkitSpeechRecognition), wake = navigator.wakeLock && navigator.wakeLock.request;
    var existingCapabilities = document.querySelector('.sheet[data-form-kind="preferences"] .preferences-capabilities'), capabilitiesOpen = existingCapabilities && existingCapabilities.open;
    var defaultMode = savedHomeMode(), defaultNote = defaultMode ? '当前默认：' + homeLabels[defaultMode] : '按窗口大小自动选择';
    var parentNote = meta.parent.configured === false ? '未设置' : meta.parent.configured == null ? '待确认' : meta.parent.method === 'math' ? '算术题' : 'PIN';
    var displayNote = ui.wakePending ? (ui.display ? '正在关闭' : '申请中') : (!wake && !ui.display ? '不支持' : '');
    var family = (saas ? menuRow('saas-account', '账号与家庭', SaaS.identity().family.name, 'people') : '') +
      menuRow('family-settings', '家庭设置', state.childName, 'settings') +
      menuRow('parent-config', '家长验证', parentNote, 'lock', { inline: true });
    var device = menuRow('home-default', '默认首页', defaultNote, 'home', { value: '设为' + homeLabels[ui.homeMode], label: '将「' + homeLabels[ui.homeMode] + '」设为本机默认首页，' + defaultNote }) +
      (defaultMode ? menuRow('home-auto', '恢复自动选择首页', '下次按窗口大小选择', 'repeat') : '') +
      menuRow('sound', '提醒声音', '', 'sound', { checked: !!ui.sound, label: '提醒声音' }) +
      menuRow('display', '屏幕常亮', displayNote, 'screen', { inline: true, checked: wake || ui.display ? !!ui.display : undefined, busy: !!ui.wakePending, chevron: false, label: displayNote ? '屏幕常亮，' + displayNote : '屏幕常亮' });
    var capabilities = '<details class="preferences-capabilities"' + (capabilitiesOpen ? ' open' : '') + '><summary id="preferences-capabilities-toggle" tabindex="0"><span class="menu-symbol">' + icon('info') + '</span><b>功能状态</b><span class="preferences-row-value">听写与指令</span>' + icon('chevron') + '</summary>' + facts([['听写', !speech ? '不支持' : window.isSecureContext === false ? '不可用' : recognition ? '听写中' : '未开启'], ['免触摸唤醒', '未开启'], ['指令', meta.assistant.formOnly ? '新建常用行为已接入 AI' : assistantLabel('general')]], 'capability-values') + '</details>';
    return '<div class="preferences-panel"><section class="preferences-section" aria-labelledby="preferences-family-heading"><h3 id="preferences-family-heading">家庭与安全</h3><div class="menu-group">' + family + '</div></section><section class="preferences-section" aria-labelledby="preferences-device-heading"><h3 id="preferences-device-heading">本机偏好</h3><div class="menu-group">' + device + '</div></section><section class="preferences-section preferences-secondary" aria-label="记录与功能"><div class="menu-group">' + menuRow('export', '导出家庭记录', 'JSON', 'download', { inline: true, chevron: false }) + capabilities + '</div></section><p id="sync-status" class="sync-status">' + syncLabel() + '</p>' + (saas ? menuRow('saas-logout', '退出登录', '', 'logout', { chevron: false }) : '') + '</div>';
  }
  function parentDeviceControl() {
    var busy = parentDevice.loading || parentDevice.busy, configured = meta.parent.configured === true;
    var note = !configured ? '先设置家长验证' : busy ? '正在确认本机设置' : parentDevice.enabled == null ? '状态待确认，点此重试' : '仅当前账号和家庭；加分、兑换仍需确认';
    var row = menuRow('parent-device-toggle', '本机日常免验证', note, 'lock', { checked: parentDevice.enabled === true, busy: busy, label: '本机日常免验证，' + note });
    return row.replace('<button ', '<button' + (busy || !configured ? ' disabled' : '') + ' ');
  }
  function listManagement(kind) {
    var isReward = kind === 'reward-list', rows = isReward ? state.rewards : state.pointItems;
    return '<div class="manage-list">' + rows.map(function (r) { return button(isReward ? 'reward-edit' : 'point-item-edit', '<span><b>' + esc(r.name) + '</b><small>' + r.points + ' 分 · ' + (isReward ? category(r.category) + ' · ' : '') + (r.enabled ? '启用中' : '已停用') + '</small></span>' + icon('chevron'), 'manage-row', r.id); }).join('') + '</div>';
  }
  function assistantLabel(context) {
    if (meta.assistant.formOnly && context !== 'pointItemCreate') return '指令演示';
    return meta.assistant.mode === 'connected' ? meta.assistant.label : '指令演示';
  }
  function rememberAssistantResult(result, context) {
    if (meta.assistant.formOnly && context !== 'pointItemCreate') return;
    meta.assistant.mode = result.mode || 'local';
    meta.assistant.label = result.label || '指令演示';
  }
  function contextAI(f, context) {
    if (chat) return '';
    if (!f.aiOpen) return '';
    var creating = context === 'pointItemCreate';
    var placeholder = creating ? ' placeholder="例如：以后自己读书满二十分钟，奖励五分"' : '';
    return '<section class="context-ai" data-context="' + context + '"><div class="context-ai-heading"><strong>' + icon('spark') + (creating ? '一句话填写' : '指令填写') + '</strong><span>' + esc(assistantLabel(context)) + '</span></div><div class="context-ai-input"><label class="field"><span>' + (creating ? '想鼓励什么行为？' : '指令') + '</span><textarea name="aiText" rows="1" maxlength="1000"' + placeholder + '>' + esc(f.data.aiText || '') + '</textarea></label><div class="context-ai-actions">' + button('listen-context', icon('mic'), 'icon-button', '', recognition ? '停止听写' : '听写') + '<button type="button" data-action="ai-fill" data-id="' + context + '" class="btn outline ai-fill-button" aria-busy="' + !!f.aiBusy + '"' + (f.aiBusy ? ' disabled' : '') + '>' + (f.aiBusy ? '整理中' : creating ? '帮我填好' : '填写') + '</button></div></div><p id="context-ai-status" class="context-ai-status" role="status">' + esc(f.aiStatus || '') + '</p><p id="voice-status" class="context-voice-status" aria-live="polite"></p></section>';
  }
  function invalidateAssistant(f) { if (!f) return; if (f.aiBusy) f.aiStatus = '已暂停'; f.aiRequest = null; f.voiceRequest = null; f.aiBusy = false; if (f.kind === 'voice') ui.assistantBusy = false; }
  function assistantMessage(result) {
    var text = String(result && (result.answer || result.question) || ''), match, reward;
    if (result && result.kind === 'answer') {
      if ((match = text.match(/^现在可用 (\d+) 分，累计获得 (\d+) 分。$/))) return '可用积分 ' + match[1] + '\n累计获得 ' + match[2];
      if ((match = text.match(/^兑换“([\s\S]*)”需要 (\d+) 分，还差 (\d+) 分。$/))) return match[1] + '\n所需积分 ' + match[2] + '\n还差 ' + match[3] + ' 分';
      if ((match = text.match(/^积分已经够换“([\s\S]*)”了。([\s\S]*)$/))) { var named = state.rewards.filter(function (r) { return r.name === match[1]; }); reward = named.length === 1 ? named[0] : null; return match[1] + (reward ? '\n所需积分 ' + reward.points : '') + '\n积分充足 · ' + (/^可以先提出/.test(match[2]) ? '可申请' : errorText(match[2])); }
      if (text.indexOf('现在可以申请兑换：') === 0) return '可兑换\n' + text.slice(9).replace(/。$/, '');
      if (text.indexOf('现在没有符合积分和日期条件的礼品') === 0) return '可兑换礼品 0';
      if ((match = text.match(/^(\d{4}-\d{2}-\d{2}) 没有未完成的事项。$/))) return match[1] + '\n待办 0';
      if (/^\d{4}-\d{2}-\d{2}：/.test(text)) return text.replace('：', '\n').replace(/。$/, '');
      return '查询结果不可用';
    }
    if (/^(?:可以说|可以帮你|说一句)/.test(text)) return '指令未识别';
    if (/^正在编辑“[\s\S]*”，请核对要修改的常用项[。]?$|^候选目标与当前编辑项不同/.test(text)) return '目标不匹配';
    if (/^AI\s+暂时没能完成整理/.test(text)) return 'AI 暂不可用';
    if (/^这项操作请使用页面上的对应按钮/.test(text)) return '指令不适用';
    if (/^(?:一次说一件事就好|请输入不超过)[\s\S]*1200\s*字/.test(text)) return errorText(text);
    if (/^一次先(?:管理|记录|处理)/.test(text)) return '指令包含多项';
    if (/太长[。.!！]?$/.test(text)) return errorText(text);
    var questions = [
      [/验证|密码|PIN/, '家长验证不可代答'], [/多个分值|多少分|多少积分/, '分值是多少？'], [/正整数/, '分值 · 正整数'], [/^这次具体做了什么[？?]|^(?:这次)?加分的?(?:具体)?原因是什么[？?]/, '具体原因是什么？'],
      [/哪一个常用|哪个常用|常用.*名字|加分项叫什么/, '常用项名称？'], [/名称、分值、预设原因/, '修改哪一项？'], [/哪个礼品|礼品.*名字/, '礼品名称？'], [/哪条提醒|哪一条提醒|处理哪条|要改哪/, '提醒名称？'],
      [/哪一天|几点|时间没有听清/, /时间|几点/.test(text) ? '提醒时间？' : '提醒日期？'], [/提醒做什么/, '提醒事项？'], [/(?:事项|提醒|礼品|奖励|加分项|常用项).*不存在|没有找到.*(?:事项|提醒|礼品|奖励|加分项|常用项)/, '对象未找到'], [/另一个|不同|核对要修改/, '目标不匹配'],
      [/当前场景|管理常用|这里管理|当前加分|对应按钮|操作请使用/, '指令不适用'], [/没有理解|更具体|哪一项信息/, '指令未识别']
    ];
    for (var i = 0; i < questions.length; i++) if (questions[i][0].test(text)) return questions[i][1];
    var problem = errorText(text); return problem === '操作未完成' || problem === '连接未完成' ? '指令待补全' : problem;
  }
  function assistantState() { var safe = clone(state); delete safe.childAvatar; return safe; }
  function updateAIStatus(f, message) {
    f.aiStatus = message; if (ui.form !== f || ui.auth) return;
    var status = document.getElementById('context-ai-status'), fill = document.querySelector('[data-action="ai-fill"]');
    if (status) status.textContent = message;
    if (fill) { fill.disabled = !!f.aiBusy; fill.setAttribute('aria-busy', String(!!f.aiBusy)); fill.textContent = f.aiBusy ? '整理中' : fill.getAttribute('data-id') === 'pointItemCreate' ? '帮我填好' : '填写'; }
  }
  function fillNewPointItem(f, patch, missing) {
    if (!patch || patch.id) { updateAIStatus(f, '目标不匹配'); return; }
    var changed = ['name', 'points', 'reason', 'enabled'].filter(function (key) { return patch[key] !== undefined; });
    changed.forEach(function (key) { f.data[key] = patch[key]; });
    if (patch.points !== undefined) f.data.templatePointsChosen = true;
    // The initial five is a manual-entry default. An incomplete instruction
    // should ask for a score unless the parent has already supplied one.
    if (missing && missing.indexOf('points') >= 0 && !f.data.templatePointsChosen && Number(f.data.points) === 5) f.data.points = '';
    f.aiStatus = !String(f.data.name || '').trim() ? '这个行为叫什么？' : !f.data.points ? '每次奖励多少分？' : '草稿已填写，请核对后保存。';
    render(false);
    changed.forEach(function (key) {
      var input = document.querySelector('#editor-form [name="' + key + '"]');
      if (input) input.classList.add('ai-field-filled');
    });
  }
  function contextualInterpret(context) {
    var f = ui.form; if (!f || f.aiBusy || ui.auth || pending) return;
    if (context === 'points' && f.kind !== 'points') return;
    if (context === 'pointItems' && f.kind !== 'pointItem' && f.kind !== 'point-list') return;
    if (context === 'pointItemCreate' && (f.kind !== 'pointItem' || f.data.id)) return;
    rememberDraft(); stopRecognition();
    var text = (f.data.aiText || '').trim(); if (!text) { updateAIStatus(f, '指令 · 必填'); return; }
    var token = ++assistantSequence, editVersion = f.editVersion || 0, options = { context: context, targetId: f.kind === 'pointItem' ? f.data.id || '' : '' };
    f.aiRequest = token; f.aiBusy = true; updateAIStatus(f, '整理中');
    function receive(status, result) {
      if (f.aiRequest !== token) return;
      f.aiBusy = false; f.aiRequest = null;
      if (ui.form !== f || ui.auth) return;
      if ((f.editVersion || 0) !== editVersion || (f.data.aiText || '').trim() !== text) { updateAIStatus(f, '已保留手动输入'); return; }
      if (status !== 200 || !result) { updateAIStatus(f, errorText(result || {})); return; }
      if (result.result) result = result.result;
      rememberAssistantResult(result, context);
      if (context === 'pointItemCreate' && result.kind === 'form' && result.form === 'pointItem') {
        fillNewPointItem(f, result.fields, result.missing); return;
      }
      if (result.kind !== 'action' || !result.action) { updateAIStatus(f, assistantMessage(result)); return; }
      var a = result.action, p = a.payload || {}, data, previous;
      if (context === 'pointItemCreate' && a.type === 'pointItem.save') { fillNewPointItem(f, p.item); return; }
      if (context === 'points' && a.type === 'points.add') {
        if (p.itemId !== undefined) f.data.itemId = p.itemId || ''; if (f.data.itemId) f.data.saveAsTemplate = false; ['name', 'points', 'reason'].forEach(function (key) { if (p[key] !== undefined) f.data[key] = p[key]; });
        f.aiStatus = '草稿已填写'; render(false); return;
      }
      if (context === 'pointItems' && a.type === 'pointItem.save' && p.item) {
        data = clone(p.item); previous = data.id ? find(state.pointItems, data.id) : null;
        if (f.kind === 'pointItem') {
          if (data.id && data.id !== f.data.id) { updateAIStatus(f, '目标不匹配'); return; }
          ['name', 'points', 'reason', 'enabled'].forEach(function (key) { if (data[key] !== undefined) f.data[key] = data[key]; });
          f.aiStatus = '草稿已填写'; render(false); return;
        }
        var merged = previous ? clone(previous) : { points: 5, enabled: true, reason: '' };
        Object.keys(data).forEach(function (key) { merged[key] = data[key]; });
        f.aiStatus = '草稿已填写';
        openForm('pointItem', merged); ui.form.aiStatus = '草稿已填写'; render(false); return;
      }
      updateAIStatus(f, '指令不适用');
    }
    if (!local) request('POST', '/api/assistant', { text: text, context: options.context, targetId: options.targetId }, receive);
    else { try { receive(200, window.FamilyAssistant.interpret(text, assistantState(), new Date(), options)); } catch (e) { receive(400, { error: e.message }); } }
  }
  function profileBody(f) {
    var d = f.data;
    return '<div class="profile-photo-editor"><div class="profile-photo-preview">' + avatarImage(d.childAvatar, d.childName) + '</div><div>' + button('avatar-choose', icon('camera') + (d.childAvatar ? '更换头像' : '上传头像'), 'btn primary') + (d.childAvatar ? button('avatar-remove', '移除头像', 'btn outline') : '') + '</div><input id="avatar-file" type="file" name="avatarFile" accept="image/jpeg,image/png,image/webp" class="file-picker" aria-label="选择头像图片" tabindex="-1"><p class="profile-photo-help">支持 JPG、PNG、WebP，最大 8 MB<br>自动裁剪为方形，保存后显示在首页</p><p id="avatar-status" role="status">' + esc(f.avatarStatus || '') + '</p></div>' + field('孩子昵称', 'childName', d.childName || '', 'required maxlength="40"');
  }
  function loadAvatar(file) {
    var f = ui.form; if (!scopeReady() || !f || f.kind !== 'profile' || !file) return;
    rememberDraft();
    var types = ['image/jpeg', 'image/png', 'image/webp'], token = ++avatarSequence, scope = scopeToken(); f.avatarRequest = token;
    var reader = null, image = null, url = '', release = function () {};
    function active() { return scopeCurrent(scope) && ui.form === f && f.avatarRequest === token; }
    function cleanup() { release(); if (reader) { reader.onload = reader.onerror = null; try { if (reader.readyState === 1) reader.abort(); } catch (e) {} } if (image) { image.onload = image.onerror = null; image.src = ''; } if (url) { URL.revokeObjectURL(url); url = ''; } }
    function status(message, busy) { if (!active()) return; f.avatarBusy = !!busy; f.avatarStatus = message; var el = document.getElementById('avatar-status'); if (el) el.textContent = message; var save = document.querySelector('.sheet-save'); if (save && !ui.auth) { save.disabled = !!(busy || pending); save.setAttribute('aria-busy', String(!!(busy || pending))); save.textContent = busy ? '处理中' : '保存'; } }
    if (types.indexOf(file.type) < 0) { status('格式 · JPEG / PNG / WebP'); return; }
    if (file.size > 8 * 1024 * 1024) { status('图片超过 8 MB'); return; }
    status('照片处理中', true);
    reader = new FileReader(); release = trackScope(cleanup);
    reader.onerror = function () { cleanup(); status('图片读取失败'); };
    reader.onload = function () {
      if (!active()) { cleanup(); return; }
      var bytes = new Uint8Array(reader.result), jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255, png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10, webp = bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80;
      if (!((file.type === 'image/jpeg' && jpeg) || (file.type === 'image/png' && png) || (file.type === 'image/webp' && webp))) { cleanup(); status('图片格式无效'); return; }
      url = URL.createObjectURL(file); image = new Image();
      image.onerror = function () { cleanup(); status('图片无法读取'); };
      image.onload = function () {
        if (!active()) { cleanup(); return; }
        var w = image.naturalWidth, h = image.naturalHeight;
        if (!w || !h || w * h > 16000000) { cleanup(); status('图片超过 1600 万像素'); return; }
        try {
          var canvas = document.createElement('canvas'); canvas.width = 192; canvas.height = 192;
          var ctx = canvas.getContext('2d'), side = Math.min(w, h); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 192, 192); ctx.drawImage(image, (w - side) / 2, (h - side) / 2, side, side, 0, 0, 192, 192);
          var avatar = canvas.toDataURL('image/jpeg', 0.86);
          if (avatar.length > 160000 || avatar.indexOf('data:image/jpeg;base64,') !== 0) throw new Error('头像处理失败');
          cleanup(); if (!active()) return;
          if (avatarSelection && avatarSelection.form === f) avatarSelection.file = null;
          f.data.childAvatar = avatar; f.avatarBusy = false; f.editVersion = (f.editVersion || 0) + 1; f.avatarStatus = '头像已选定'; render(false);
        } catch (e) { cleanup(); status('头像处理失败'); }
      };
      image.src = url;
    };
    reader.readAsArrayBuffer(file.slice(0, 16));
  }
  function petDailyMarks(status) {
    return '<div class="pet-daily-marks">' + ['feed', 'wash', 'train'].map(function (care) { var done = status.caredToday.indexOf(care) >= 0; return '<span data-care="' + care + '" data-completed="' + done + '">' + icon(done ? 'check' : { feed: 'snack', wash: 'water', train: 'ball' }[care]) + careName(care) + '<small>' + (done ? '已完成' : '未完成') + '</small></span>'; }).join('') + '</div>' + facts([['今日全项奖励', '+1里程 · ' + (status.dailyBonusEarned ? '已获得' : '待完成')]], 'pet-bonus-note');
  }
  function petArchiveBody(status, f) {
    var tab = f.data.tab === 'explore' ? 'explore' : 'bag'; f.data.tab = tab; f.openedRevision = revision;
    var tabs = '<div class="pet-tabs" aria-label="旧收藏">' + [['bag', '旧道具'], ['explore', '旧探索收藏']].map(function (o) { return button('pet-tab', o[1], 'mode-tab ' + (tab === o[0] ? 'active' : ''), o[0]); }).join('') + '</div>';
    var note = '<p class="farm-legacy-note">探索里程 · ' + status.exploration + '</p>';
    if (tab === 'explore') return tabs + note + '<div class="pet-scene-list">' + status.scenes.map(function (scene) { return '<div class="pet-scene-card ' + (scene.unlocked ? 'unlocked' : 'locked') + '"><span class="scene-badge">' + icon(scene.unlocked ? 'star' : 'lock') + '</span><div><h3>' + esc(scene.name) + '</h3><small>' + scene.threshold + '里程 · ' + (scene.unlocked ? '已收藏' : '未到达') + '</small></div></div>'; }).join('') + '</div>';
    return tabs + note + '<div class="pet-supplies">' + status.catalog.map(function (item) { return '<div class="pet-supply-card" data-item-id="' + item.id + '"><span class="pet-item-art" aria-hidden="true">' + itemArt(item.id) + '</span><div><h3>' + esc(item.name) + '</h3><p>库存 ' + status.inventory[item.id] + ' 件</p></div>' + (status.inventory[item.id] > 0 ? careButton(item, status, 'inventory', true) : '<small>已用完</small>') + '</div>'; }).join('') + '</div>';
  }
  function petHubBody(f) {
    var status = playStatus(), tab = f.data.tab || 'bag'; ui.petTab = tab;
    if (status && status.farmMode) return petArchiveBody(status, f);
    var tabs = '<div class="pet-tabs" aria-label="伙伴">' + [['bag', '背包'], ['supply', '补给'], ['explore', '探索收藏']].map(function (o) { return button('pet-tab', o[1], 'mode-tab ' + (tab === o[0] ? 'active' : ''), o[0]); }).join('') + '</div>';
    if (!status) return tabs + empty('未连接');
    f.openedRevision = revision;
    var summary = '<div class="pet-resource-summary"><strong>今日共享免费 ' + status.freeRemaining + ' / ' + status.freeLimit + ' 次</strong><span>探索里程 ' + status.exploration + '</span><small>' + (local ? '本机日期 · ' : '家庭日 · ') + esc(status.familyDay) + '</small></div>' + (!local && !connected ? '<p class="availability-note">连接中断 · 未同步</p>' : '');
    if (tab === 'explore') {
      return tabs + summary + petDailyMarks(status) + (status.nextUnlock ? facts([['下一站', status.nextUnlock.name], ['所差里程', status.nextUnlock.remaining]], 'pet-next-goal') : '<p class="status-line">收藏完成 · 6 / 6</p>') + '<div class="pet-scene-list">' + status.scenes.map(function (scene, i) { return '<div class="pet-scene-card ' + (scene.unlocked ? 'unlocked' : 'locked') + '" data-scene-id="' + scene.id + '"><span class="scene-badge" aria-hidden="true">' + icon(scene.unlocked ? ['heart', 'leaf', 'spark', 'sun', 'star', 'mountain', 'star'][i] : 'lock') + '</span><div><h3>' + esc(scene.name) + '</h3><small>' + scene.threshold + '里程 · ' + (scene.unlocked ? (i ? '已收藏' : '已解锁') : '还差' + Math.max(0, scene.threshold - status.exploration)) + '</small></div><button type="button" class="btn outline" data-action="pet-scene" data-id="' + scene.id + '"' + (!scene.unlocked || scene.id === status.sceneId || (!local && !connected) ? ' disabled' : '') + '>' + (scene.id === status.sceneId ? '当前' : scene.unlocked ? '前往' : '未解锁') + '</button></div>'; }).join('') + '</div>';
    }
    return tabs + summary + (tab === 'bag' ? petDailyMarks(status) : '') + '<div class="pet-supplies">' + status.catalog.map(function (item) { return '<div class="pet-supply-card" data-item-id="' + item.id + '"><span class="pet-item-art" aria-hidden="true">' + itemArt(item.id) + '</span><div><h3>' + esc(item.name) + '</h3><p>' + careName(item.care) + ' · 库存 ' + status.inventory[item.id] + ' 件</p>' + (tab === 'supply' ? '<small>' + item.points + '积分 / 件</small>' : '') + '</div>' + (tab === 'bag' && status.inventory[item.id] > 0 ? careButton(item, status, 'inventory', true) : button('pet-buy', tab === 'supply' ? '购买' : '补给', 'btn outline', item.id, '购买' + item.name)) + '</div>'; }).join('') + '</div>' + (tab === 'bag' ? button('pet-home', '照料伙伴', 'btn primary full') : '');
  }
  function petPurchaseMath(f) {
    var status = playStatus(), item = status && find(status.catalog, f.data.itemId), quantity = Number(f.data.quantity), t = M.totals(state), valid = item && isFinite(quantity) && quantity >= 1 && quantity <= 10 && quantity === Math.floor(quantity), cost = valid ? quantity * item.points : 0;
    if (!item) return empty('未连接');
    if (!valid) return '<p class="availability-note">数量 · 1–10件整数</p>';
    return '<p class="pet-purchase-price">' + item.points + ' 分 × ' + quantity + ' 件 = <strong data-testid="pet-buy-total">' + cost + ' 分</strong></p><div class="redemption-math"><div><span>可用</span><b>' + t.available + '</b></div><span>−</span><div><span>总价</span><b>' + cost + '</b></div><span>=</span><div><span>购买后</span><b data-testid="pet-buy-balance">' + (t.available - cost) + '</b></div></div>' + (t.available < cost ? '<p class="availability-note">余额不足 · 差 ' + (cost - t.available) + ' 分</p>' + button('add-points', '去加分', 'btn outline full') : '') + (!local && !connected ? '<p class="availability-note">未连接</p>' : '');
  }
  function refreshPetPurchase() {
    if (!ui.form || ui.form.kind !== 'petBuy' || ui.auth) return;
    var f = ui.form, el = document.getElementById('pet-buy-summary'), status = playStatus(), item = status && find(status.catalog, f.data.itemId), quantity = Number(f.data.quantity), submit = document.querySelector('.sheet-save');
    if (el) el.innerHTML = petPurchaseMath(f);
    if (submit) { submit.disabled = pending || !item || !isFinite(quantity) || quantity < 1 || quantity > 10 || Math.floor(quantity) !== quantity || M.totals(state).available < quantity * item.points || (!local && !connected); submit.setAttribute('aria-busy', String(!!pending)); }
  }
  function openPetPurchase(itemId) {
    var status = playStatus(); if (!status || !find(status.catalog, itemId)) { showError('未连接'); return; }
    if (status.farmMode) { showError('小院陪伴免费，补给已停止出售'); return; }
    if (!ui.form || ui.form.kind !== 'petHub') openForm('petHub', { tab: 'supply' });
    openForm('petBuy', { itemId: itemId, quantity: 1 }, true);
  }
  function petConfigBody(f) {
    var d = f.data, g = growthInfo();
    return '<div class="pet-choices">' + [['plant', '芽芽', '晶叶龙伙伴'], ['capybara', '团团', '太空水豚']].map(function (o) { return '<button type="button" class="pet-choice ' + (d.kind === o[0] ? 'selected' : '') + '" data-action="pet-kind" data-id="' + o[0] + '" aria-pressed="' + (d.kind === o[0] ? 'true' : 'false') + '"><div>' + petDrawing(o[0], g.stage, o[1], 'idle', true) + '</div><strong>' + o[2] + '</strong><small>' + (d.kind === o[0] ? '已选' : '选择') + '</small></button>'; }).join('') + '</div>' + field('伙伴昵称', 'petName', d.petName !== undefined ? d.petName : d.name || '', 'required maxlength="40"');
  }
  function editorContent() {
    var f = ui.form, d = f.data, body = '', title = '', sub = '', submit = '', footer = '', actions = '', submitBlocked = false, r, permission, total = M.totals(state);
    if (f.kind === 'behaviorPicker') return behaviorPickerContent();
    if (f.kind === 'farm' && Farm) return Farm.panel(f);
    if (f.kind === 'homeInbox') { title = homeInboxTitle(); f.openedRevision = revision; ui.inboxKey = homeInboxKey(); body = '<div id="home-inbox-body">' + homeInboxBody() + '</div>'; }
    else if (f.kind === 'homeWeek') { title = '近七日积分'; body = window.FamilyHomePoints.summaryBody({ summary: homeSummary(), icon: icon, button: button }); }
    else if (f.kind === 'records') { title = d.source === 'rewards' ? '兑换记录' : '积分记录'; body = recordsBody(); }
    else if (f.kind === 'recordDetail') { title = d.recordKind === 'points' ? '加分详情' : d.recordKind === 'purchase' ? '购买详情' : '兑换详情'; body = recordDetailBody(d); }
    else if (f.kind === 'preferences') { title = '设置'; body = preferencesBody(); }
    else if (f.kind === 'rewards') { title = '礼品兑换'; body = rewardsBody(); actions = button('reward-list', icon('edit'), 'icon-button', '', '管理礼品') + button('reward-new', icon('plus'), 'icon-button nav-add', '', '新增礼品'); }
    else if (f.kind === 'petGrowth') { title = '成长足迹'; body = growthBody(); }
    else if (f.kind === 'petHub') { title = '伙伴'; body = petHubBody(f); actions = button('pet-growth', icon('spark'), 'icon-button', '', '成长足迹') + button('pet-config', icon('settings'), 'icon-button', '', '伙伴设置'); }
    else if (f.kind === 'petBuy') {
      var supplyStatus = playStatus(), supplyItem = supplyStatus && find(supplyStatus.catalog, d.itemId);
      title = '购买补给'; submit = supplyItem ? '确认购买' : '';
      body = supplyItem ? '<div class="pet-buy-item"><span class="pet-item-art" aria-hidden="true">' + itemArt(supplyItem.id) + '</span><div><h3>' + esc(supplyItem.name) + '</h3><p>' + careName(supplyItem.care) + ' · ' + supplyItem.points + ' 积分 / 件</p></div></div>' + field('数量（1–10件）', 'quantity', d.quantity, 'required min="1" max="10" step="1" inputmode="numeric"', 'number') + '<div id="pet-buy-summary" aria-live="polite">' + petPurchaseMath(f) + '</div>' : empty('未连接');
    }
    else if (f.kind === 'profile') { title = '孩子资料'; submit = '保存资料'; body = profileBody(f); }
    else if (f.kind === 'petConfig') { title = '伙伴设置'; submit = '保存伙伴'; body = petConfigBody(f); }
    else if (f.kind === 'point-list' || f.kind === 'reward-list') { title = f.kind === 'point-list' ? '常用行为' : '礼品'; body = (f.kind === 'point-list' ? contextAI(f, 'pointItems') : '') + listManagement(f.kind); actions = f.kind === 'point-list' ? button('point-item-new', icon('plus') + '<span>新建</span>', 'text-button template-create', '', '新建常用行为') : button('reward-new', icon('plus'), 'icon-button nav-add', '', '新增礼品'); }
    else if (f.kind === 'points') {
      title = '立即加分'; submit = '核对加分';
      body = contextAI(f, 'points') + '<div class="entry-summary"><span><small>本次加分</small>' + esc(state.childName) + '</span><strong>' + pointsAmount(d.points == null ? 5 : d.points) + '</strong></div><input type="hidden" name="itemId" value="' + esc(d.itemId || '') + '">' + field('行为名称', 'name', d.name || '', 'required maxlength="120"') + '<div class="field-pair">' + field('本次分值', 'points', d.points == null ? 5 : d.points, 'required min="1" step="1" inputmode="numeric"', 'number') + field('今天 · 记录时间', 'recordTime', d.recordTime || '', 'max="' + clock() + '"', 'time') + '</div>' + area('具体原因（选填）', 'reason', d.reason || '', 'maxlength="2000"') + (!d.itemId ? '<label class="template-toggle"><input type="checkbox" name="saveAsTemplate"' + (d.saveAsTemplate ? ' checked' : '') + '><span>同时存为常用</span></label><div id="template-save-preview" class="template-save-preview" aria-live="polite">' + templateSavePreview() + '</div>' : '');
      if (AwardPhotos) body += AwardPhotos.editor(awardPhotos(f));
      submitBlocked = !awardPhotosReady(f);
    } else if (f.kind === 'request' || f.kind === 'approve') {
      var req = f.kind === 'approve' ? find(state.requests, d.requestId) : null;
      r = find(state.rewards, req ? req.rewardId : d.rewardId);
      title = f.kind === 'approve' ? '确认兑换' : '申请兑换'; submit = f.kind === 'approve' ? '确认兑换' : '提交申请';
      if (!r || (f.kind === 'approve' && (!req || req.status !== 'pending'))) { body = empty('申请已更新'); submit = ''; }
      else {
        permission = M.availability(state, r.id, appClock(), calendarZone());
        if (ledgerGiftFlow()) {
          var existing = activeRequest();
          body = giftDetail(r, r.points, total.available, permission.allowed);
          if (f.kind === 'request' && permission.allowed) {
            body += '<p class="gift-request-note">家长确认后才扣分。</p>';
            if (existing && existing.rewardId !== r.id) body += '<p class="gift-request-note">这次申请会替换正在等待确认的「' + esc(existing.name) + '」。</p>';
          }
          if (f.kind === 'approve') submit = canSkipParent({ type: 'redemption.approve' }) ? '核对兑换' : '去家长验证';
        } else {
          body = '<div class="redeem-preview"><span class="reward-symbol ' + r.category + '">' + icon(r.icon) + '</span><h3>' + esc(r.name) + '</h3><strong>' + r.points + '<small> 分</small></strong></div><div class="redemption-math"><div><span>可用</span><b>' + total.available + '</b></div><span>−</span><div><span>兑换扣分</span><b>' + r.points + '</b></div><span>=</span><div><span>兑换后</span><b>' + (total.available - r.points) + '</b></div></div>' + (f.kind === 'request' ? facts([['本次申请扣分', '0'], ['审批', '家长']]) : '');
        }
        if (!permission.allowed) body += '<p class="availability-note">' + esc(ledgerGiftFlow() ? giftAvailability(permission, r, total.available) : availabilityLabel(permission)) + '</p>';
        if (f.kind === 'approve') body += area('备注（选填）', 'note', d.note || '');
        submitBlocked = !permission.allowed;
      }
    } else if (f.kind === 'taskAction') {
      title = { 'task.ack': '确认收到', 'task.snooze': '稍后提醒', 'task.toggle': '完成状态' }[d.type] || '处理提醒'; submit = '确认';
      var taskActionTarget = find(state.tasks, d.taskId);
      submit = d.type === 'task.ack' ? '确认收到' : d.type === 'task.snooze' ? '稍后提醒' : taskActionTarget && taskActionTarget.done ? '撤销完成' : '标记完成';
      body = facts([['提醒', taskActionTarget ? taskActionTarget.title : '已更新'], ['操作', d.type === 'task.ack' ? '确认收到' : d.type === 'task.snooze' ? '10分钟后' : taskActionTarget && taskActionTarget.done ? '撤销完成' : '完成']]);
      if (!taskActionTarget || taskActionTarget.deleted) submit = '';
    } else if (f.kind === 'task') {
      title = d.id ? '编辑提醒' : '新增提醒'; submit = '保存提醒';
      body = '<div class="form-type-toggle">' + button('form-task-type', '近期待办', 'day-tab ' + (d.type !== 'event' ? 'active' : ''), 'task') + button('form-task-type', '重要事件', 'day-tab ' + (d.type === 'event' ? 'active' : ''), 'event') + '</div><input type="hidden" name="type" value="' + esc(d.type || 'task') + '">' + field('事项', 'title', d.title || '', 'required maxlength="120"') + (d.type !== 'event' ? '<div class="date-shortcuts">' + ['今天', '明天', '后天'].map(function (label, i) { return button('form-day', label, 'day-tab ' + (d.date === day(i) ? 'active' : ''), String(i)); }).join('') + '</div>' : '') + '<div class="field-pair">' + field('日期', 'date', d.date || today(), 'required' + (!d.id ? ' min="' + today() + '"' : '') + (d.type !== 'event' ? ' max="' + day(2) + '"' : ''), 'date') + field('时间（选填）', 'time', d.time || '', '', 'time') + '</div>' + (d.type === 'event' ? field('提前天数', 'remindDays', d.remindDays || 0, 'min="0" max="365" step="1" inputmode="numeric"', 'number') : '') + area('备注（选填）', 'note', d.note || '', 'maxlength="2000"') + (d.id ? '<div class="task-edit-actions">' + button('task-tomorrow', '改到明天', 'btn outline', d.id) + button('task-copy', '复制提醒', 'btn outline', d.id) + button('task-delete', '取消提醒', 'btn danger', d.id) + '</div>' : '');
    } else if (f.kind === 'reward') {
      title = d.id ? '编辑礼品' : '添加礼品'; submit = '保存礼品';
      body = field('礼品名称', 'name', d.name || '', 'required maxlength="120"') + field('所需积分', 'points', d.points || '', 'required min="1" step="1" inputmode="numeric"', 'number') + '<div class="field-pair">' + select('兑换日期', 'category', d.category || 'daily', [['daily', '每天'], ['weekend', '周末'], ['outing', '月底']]) + select('状态', 'enabled', d.enabled === false || d.enabled === 'false' ? 'false' : 'true', [['true', '启用'], ['false', '停用']]) + '</div>';
    } else if (f.kind === 'pointItem') {
      title = d.id ? '编辑常用行为' : '新建常用行为'; submit = '保存常用行为';
      body = '<p class="template-help">设置以后可选的行为和默认分值，本次不增加积分。</p>' + contextAI(f, d.id ? 'pointItems' : 'pointItemCreate') + field('行为名称', 'name', d.name || '', 'required maxlength="120"') + field('默认分值', 'points', d.points == null ? 5 : d.points, 'required min="1" step="1" inputmode="numeric"', 'number') + area('预设原因', 'reason', d.reason || '', 'maxlength="2000"') + select('状态', 'enabled', d.enabled === false || d.enabled === 'false' ? 'false' : 'true', [['true', '启用'], ['false', '停用']]);
      if (d.id) body += button('point-item-delete', icon('trash') + '删除常用行为', 'btn danger', d.id);
    } else if (f.kind === 'familySettings') {
      title = '家庭设置'; submit = '保存设置';
      body = field('孩子名字', 'childName', d.childName || state.childName, 'required maxlength="40"') + field('月底兑换天数', 'monthEndDays', d.monthEndDays || state.settings.monthEndDays, 'required min="1" max="31" step="1" inputmode="numeric"', 'number');
    } else if (f.kind === 'parentConfig') {
      var initial = f.parentConfigured === false, parentSetup = setupTx && setupTx.form === f && !setupTx.auth ? setupTx : null, method = d.method || meta.parent.method || 'pin';
      title = initial ? '设置家长验证' : '修改家长验证'; sub = local ? '本机' : '共享'; submit = initial ? '保存设置' : '保存修改';
      if (saas && initial && !SaaS.isOwner()) { body = '<p class="status-line">请家庭所有者设置家长验证</p>'; submit = ''; }
      else if (f.parentConfigured == null) { body = '<p class="status-line">家长验证 · 待确认</p>'; submit = ''; }
      else if (f.setupConflict) { body = '<p class="status-line">家长验证已设置</p>'; submit = ''; }
      else if (parentSetup && parentSetup.uncertain) { body = facts([['验证方式', parentSetup.action.method === 'math' ? '算术题' : 'PIN']]) + '<p class="status-line">设置结果待确认</p>'; submit = '重试设置'; }
      else {
        body = (!initial ? facts([['当前方式', meta.parent.method === 'math' ? '算术题' : 'PIN']]) : '') + select('验证方式', 'method', method, [['pin', '6位 PIN'], ['math', '算术题']]) + field(initial ? '设置PIN' : '新PIN', 'pin', '', 'required inputmode="numeric" autocomplete="new-password" minlength="6" maxlength="6" pattern="[0-9]{6}"' + (method === 'math' ? ' disabled' : ''), 'password').replace('<label ', '<label' + (method === 'math' ? ' hidden' : '') + ' ') + field(initial ? '确认PIN' : '确认新PIN', 'confirmPin', '', 'required inputmode="numeric" autocomplete="new-password" minlength="6" maxlength="6" pattern="[0-9]{6}"' + (method === 'math' ? ' disabled' : ''), 'password').replace('<label ', '<label' + (method === 'math' ? ' hidden' : '') + ' ');
      }
      if (saas) body += '<section id="parent-device-settings" class="parent-device-settings" aria-label="本机日常免验证">' + parentDeviceControl() + '</section>';
    } else if (f.kind === 'parentDevice') {
      var pinCredential = meta.parent.method === 'pin';
      title = '开启本机日常免验证'; submit = '验证并开启';
      body = '<p class="status-line">仅此账号在当前家庭使用这台浏览器时生效。加分和兑换仍需逐笔确认。</p>' + field(pinCredential ? '当前家长PIN' : '账号密码', 'credential', '', 'required maxlength="' + (pinCredential ? '12' : '128') + '" autocomplete="' + (pinCredential ? 'off' : 'current-password') + '"' + (pinCredential ? ' inputmode="numeric" minlength="6" pattern="[0-9]{6,12}"' : ''), 'password');
    } else if (f.kind === 'assistantReview') {
      title = d.title; submit = '确认办理'; body = assistantReviewBody(d.command);
    } else if (f.kind === 'voice') {
      title = '指令'; sub = assistantLabel('general'); submit = ui.assistantBusy ? '整理中' : '发送';
      body = '<div class="voice-box">' + button('listen', icon('mic') + (recognition ? '停止听写' : '听写'), 'btn voice-start') + '<p id="voice-status">' + (recognition ? '听写中' : '') + '</p></div>' + area('指令内容', 'speech', d.speech || '', 'required maxlength="1000"') + (d.answer ? '<div class="assistant-answer" role="status">' + esc(d.answer) + '</div>' : '');
    }
    var isEditor = ['points', 'petBuy', 'request', 'approve', 'task', 'taskAction', 'reward', 'pointItem', 'point-list', 'profile', 'petConfig', 'familySettings', 'parentConfig', 'parentDevice', 'assistantReview', 'voice'].indexOf(f.kind) >= 0;
    if (!chat && ['points', 'pointItem', 'point-list'].indexOf(f.kind) >= 0) actions = button('ai-toggle', icon('spark'), 'icon-button' + (f.aiOpen ? ' active' : ''), '', '指令填写').replace('<button ', '<button aria-expanded="' + !!f.aiOpen + '" ') + actions;
    if (submit) {
      var submitBusy = pending || (f.kind === 'voice' && ui.assistantBusy) || (f.kind === 'profile' && f.avatarBusy) || (['parentConfig', 'parentDevice'].indexOf(f.kind) >= 0 && parentDevice.busy);
      var submitLabel = f.kind === 'points' ? '核对加分' : f.kind === 'request' ? '申请兑换' : f.kind === 'approve' ? '确认兑换' : f.kind === 'petBuy' ? '确认购买' : /^保存|^设置/.test(submit) ? '保存' : submit;
      var giftFooter = ledgerGiftFlow() && (f.kind === 'request' || f.kind === 'approve');
      var saveButton = '<button type="submit" form="editor-form" class="btn primary sheet-save" aria-label="' + esc(submit) + '" data-label="' + esc(submit) + '" aria-busy="' + !!submitBusy + '"' + (submitBusy || submitBlocked ? ' disabled' : '') + '>' + (pending ? '保存中' : f.kind === 'profile' && f.avatarBusy ? '处理中' : giftFooter ? submit : submitLabel) + '</button>';
      if (giftFooter) footer = saveButton; else actions += saveButton;
    }
    if (f.assistantDraft) {
      var message = f.kind === 'pointItem' && !d.points ? '请填写这项行为的默认分值。' : '助手草稿已填写，请核对后保存。';
      body = '<p class="status-line" id="assistant-form-status" role="status">' + message + '</p>' + body;
    }
    var inside = '<p id="form-error" class="form-error" role="alert" hidden></p><div class="sheet-body">' + body + '</div>' + (footer ? '<div class="sheet-footer">' + footer + '</div>' : '');
    return sheet(title, sub, isEditor ? '<form id="editor-form" class="sheet-form" novalidate>' + inside + '</form>' : inside, false, actions);
  }
  function actionSummary(action) {
    var rows = [], req, r, target, t = M.totals(state);
    if (action.type === 'points.add') { rows = [['孩子', state.childName], ['行为', action.name], ['本次加分', '+' + action.points + ' 分'], ['记录时间', action.at ? niceTime(action.at) : '确认完成时'], ['原因', action.reason || '未填写']]; if (action.saveAsTemplate) rows.push(['新增常用', action.name]); }
    else if (action.type === 'redemption.approve') { req = find(state.requests, action.requestId); r = req && find(state.rewards, req.rewardId); rows = [['礼品', r ? r.name : '已更新'], ['本次扣分', '−' + action.expectedPoints], ['兑换后余额', t.available - action.expectedPoints]]; if (action.note) rows.push(['备注', action.note]); }
    else if (action.type === 'reward.redeem') { r = find(state.rewards, action.rewardId); var cost = action.expectedPoints == null && r ? r.points : action.expectedPoints; rows = [['礼品', r ? r.name : '已更新'], ['本次扣分', '−' + cost], ['兑换后余额', t.available - cost]]; }
    else if (action.type === 'pet.buy') { var status = playStatus(); target = status && find(status.catalog, action.itemId); rows = [['道具', target ? target.name : action.itemId], ['单价', (target ? target.points : 3) + ' 分 / 件'], ['数量', action.quantity], ['本次扣分', '−' + action.expectedPoints], ['购买后余额', t.available - action.expectedPoints]]; }
    else if (action.type === 'reward.save') rows = [['礼品', action.reward.name], ['所需积分', action.reward.points], ['兑换日期', category(action.reward.category)], ['状态', action.reward.enabled ? '启用' : '停用']];
    else if (action.type === 'pointItem.save') { rows = [['常用加分项', action.item.name], ['默认分值', action.item.points], ['状态', action.item.enabled ? '启用' : '停用']]; if (action.item.reason) rows.push(['预设原因', action.item.reason]); }
    else if (action.type === 'pointItem.delete') { target = find(state.pointItems, action.itemId); rows = [['要删除的行为', target ? target.name : '已更新']]; }
    else if (action.type === 'task.save') { rows = [['提醒', action.task.title], ['日期', action.task.date], ['时间', action.task.time || '全天']]; if (action.task.note) rows.push(['备注', action.task.note]); }
    else if (action.type === 'task.delete') { target = find(state.tasks, action.taskId); rows = [['取消提醒', target ? target.title : '已更新']]; }
    else if (action.type === 'profile.update') rows = [['孩子', action.childName], ['头像', action.childAvatar ? '照片' : '文字']];
    else if (action.type === 'parent.configure') rows = [['验证方式', action.method === 'math' ? '算术题' : 'PIN']];
    else rows = [['孩子', action.childName || state.childName], ['月底兑换天数', action.settings ? action.settings.monthEndDays : state.settings.monthEndDays]];
    return facts(rows, 'authorization-values');
  }
  function isLedgerAward(auth) { return !!(auth && auth.tx.ledgerAward && auth.tx.action.type === 'points.add'); }
  function isPristinePresetReview(auth) {
    return !!(isLedgerAward(auth) && auth.pristinePresetReview && auth.phase === 'confirm' && !auth.busy && !pending && !setupTx && !auth.challengeId && !auth.expiresAt && !auth.tx.uncertain && !auth.tx.grant && auth.tx.form === ui.form && ui.stack.length === 0);
  }
  function ledgerAwardSummary(action) {
    return '<div class="ledger-award-summary"><div class="ledger-award-child"><span class="ledger-award-avatar">' + avatarImage(state.childAvatar, state.childName) + '</span><span>' + esc(state.childName) + '</span></div><h3 class="ledger-award-name">' + esc(action.name) + '</h3><strong class="ledger-award-amount">+' + esc(action.points) + '<small>分</small></strong><div class="ledger-award-meta"><span>记录时间</span><time' + (action.at ? ' datetime="' + esc(action.at) + '"' : '') + '>' + esc(action.at ? niceTime(action.at) : '确认完成时') + '</time></div>' + (action.reason ? '<p class="ledger-award-reason">' + esc(action.reason) + '</p>' : '') + (action.saveAsTemplate ? '<p class="ledger-award-template">同时存为常用行为</p>' : '') + '</div>';
  }
  function parentContent() {
    var a = ui.auth, confirming = a.phase === 'confirm', setup = a.phase === 'setup' || a.phase === 'setup-saving' || a.phase === 'setup-retry';
    var deletingItem = a.tx.action.type === 'pointItem.delete', ledgerAward = isLedgerAward(a), skipParent = canSkipParent(a.tx.action), redeeming = ['redemption.approve', 'reward.redeem'].indexOf(a.tx.action.type) >= 0;
    var prompt = confirming ? ledgerAward ? '下一步由家长验证' : '请核对本次加分，确认后由家长验证。' : setup ? '请家长设置 6 位 PIN，保护每一次加分和兑换。' : a.method === 'math' ? '请家长完成算术验证后继续。' : '请家长输入 PIN，验证后完成本次操作。';
    if (confirming && skipParent) prompt = redeeming ? '请核对礼品和本次扣分，确认后完成兑换。' : '请核对本次加分，确认后记入积分。';
    if (a.recoveryAward) prompt = '上次加分结果待确认，下面是原操作。请先核对并完成原操作，你的修改已保留。';
    if (a.rebasedAwardTime) prompt = '上次加分结果待确认，记录时间已改为今天。请核对后继续完成本次加分，其他修改已保留。';
    if (deletingItem) prompt = (setup ? '请先设置家长 PIN。' : '') + '删除后，这个行为会从常用列表中移除。过去的加分记录和积分都会保留。';
    var ledgerReview = ledgerAward || a.tx.ledgerRedemption, summaryContent;
    if (ledgerAward) summaryContent = ledgerAwardSummary(a.tx.action);
    else if (a.tx.ledgerRedemption) {
      var requestForApproval = find(state.requests, a.tx.action.requestId);
      var gift = requestForApproval && find(state.rewards, requestForApproval.rewardId);
      summaryContent = gift ? giftDetail(gift, a.tx.action.expectedPoints, M.totals(state).available, true) : actionSummary(a.tx.action);
      if (gift && a.tx.action.note) summaryContent += '<p class="gift-request-note">' + esc(a.tx.action.note) + '</p>';
    } else summaryContent = actionSummary(a.tx.action);
    var summary = '<div class="authorization-summary">' + summaryContent + '</div>';
    var body = (ledgerReview ? summary : '') + '<p id="parent-dialog-prompt" class="parent-dialog-prompt">' + prompt + '</p>', submit = '验证并完成';
    if (confirming) submit = redeeming ? skipParent ? '确认兑换' : '去家长验证' : ledgerAward && !skipParent ? '去家长验证' : '确认加' + a.tx.action.points + '分';
    else if (a.phase === 'setup') { body += field('设置PIN', 'setupPin', '', 'required inputmode="numeric" autocomplete="new-password" minlength="6" maxlength="6" pattern="[0-9]{6}"', 'password') + field('确认PIN', 'setupConfirm', '', 'required inputmode="numeric" autocomplete="new-password" minlength="6" maxlength="6" pattern="[0-9]{6}"', 'password'); submit = '设置并完成'; }
    else if (a.phase === 'verify') { body += (a.method === 'math' ? '<p class="math-question">' + esc(a.question) + '</p>' : '') + field(a.method === 'math' ? '答案' : a.tx.action.type === 'parent.configure' ? '当前PIN' : '家长PIN', 'answer', '', 'required inputmode="numeric" autocomplete="off"' + (a.method === 'pin' ? ' minlength="6" maxlength="12" pattern="[0-9]{6,12}"' : ''), a.method === 'pin' ? 'password' : 'text'); }
    else if (a.phase === 'loading') submit = '准备中';
    else if (a.phase === 'verifying') submit = '验证中';
    else if (a.phase === 'saving' || a.phase === 'setup-saving') submit = '保存中';
    else if (a.phase === 'setup-retry') { body += '<p class="status-line">设置结果待确认</p>'; submit = '重试设置'; }
    else if (a.phase === 'retry') { body += '<p class="status-line">结果待确认</p>'; submit = '重试保存'; }
    else submit = '重新验证';
    if (!ledgerReview) body += summary;
    if (AwardPhotos && a.tx.action.type === 'points.add' && a.tx.form && a.tx.form.kind === 'points') {
      if (confirming && !a.recoveryAward) body += AwardPhotos.editor(awardPhotos(a.tx.form));
      else if (a.tx.action.photoIds && a.tx.action.photoIds.length) body += '<p class="award-photo-count">本次照片 ' + a.tx.action.photoIds.length + ' 张</p>';
    }
    var parentBusy = !!(a.busy || pending), photoBlocked = confirming && !a.recoveryAward && !awardPhotosReady(a.tx.form), dangerous = deletingItem || a.tx.action.type === 'task.delete';
    if (dangerous) {
      var verb = deletingItem ? '删除' : '取消';
      if (a.phase === 'verify') submit = '验证并' + verb;
      else if (a.phase === 'setup') submit = '设置并' + verb;
      else if (a.phase === 'saving') submit = verb + '中';
      else if (a.phase === 'retry') submit = '重试' + verb;
    }
    var title = deletingItem ? '确认删除常用行为' : confirming ? redeeming ? '确认兑换' : ledgerAward ? '核对加分' : '确认本次加分' : setup ? '设置家长PIN' : a.tx.action.type === 'parent.configure' ? '修改家长PIN' : '家长验证';
    var actions = isPristinePresetReview(a) ? button('points-cancel', icon('close'), 'icon-button ledger-award-cancel', '', '取消本次加分') : '';
    return sheet(title, ledgerReview ? '' : confirming ? redeeming ? '核对礼品与扣分' : '核对孩子、行为、分值与时间' : local ? '本机' : '共享', '<form id="parent-form" class="sheet-form" novalidate><p id="parent-error" class="form-error" role="alert" hidden></p><div class="sheet-body">' + body + '</div><div class="sheet-footer">' + button('parent-cancel', '返回修改', 'btn outline') + '<button type="submit"' + (confirming ? ' data-action="points-confirm"' : '') + ' class="btn ' + (dangerous ? 'danger-primary' : 'primary') + '" aria-busy="' + parentBusy + '"' + (parentBusy || photoBlocked ? ' disabled' : '') + '>' + submit + '</button></div></form>', true, actions);
  }
  function isAppPage() {
    if (!ui.form) return ui.view === 'reminders';
    return ['farm', 'petHub', 'petBuy', 'petGrowth', 'petConfig'].indexOf(ui.form.kind) < 0;
  }
  function sheet(title, sub, content, auth, actions) {
    if (chat && !auth && assistantAvailable()) actions = chatEntry(false) + (actions || '');
    var nested = auth || ui.stack.length > 0, dialogClass = auth ? ' global-dialog ' + (ui.auth.phase === 'confirm' ? 'points-confirm-dialog' : 'parent-dialog') : '';
    if (auth && isLedgerAward(ui.auth)) dialogClass += ' ledger-award-dialog';
    if (auth && ui.auth.tx.ledgerRedemption) dialogClass += ' ledger-award-dialog ledger-gift-auth';
    if (!auth && ui.form && ui.form.kind === 'behaviorPicker') dialogClass += ' behavior-picker-sheet';
    if (!auth && isAppPage()) dialogClass += ' ledger-sheet';
    if (auth && isAppPage() && !isLedgerAward(ui.auth) && !ui.auth.tx.ledgerRedemption) dialogClass += ' ledger-parent-sheet';
    if (!auth && ledgerGiftFlow()) dialogClass += ' ledger-gift-sheet';
    var backdropAction = auth ? isPristinePresetReview(ui.auth) ? 'points-cancel' : 'parent-cancel' : 'form-close';
    return '<div class="sheet-overlay' + (auth ? ' global-dialog-overlay' : '') + '"><div class="sheet-backdrop" data-action="' + backdropAction + '"></div><section class="sheet' + dialogClass + '" data-form-kind="' + (auth ? 'parent:' : '') + (ui.form ? ui.form.kind : '') + '" role="dialog" aria-modal="true" aria-labelledby="sheet-title"' + (auth ? ' data-auth-phase="' + ui.auth.phase + '" aria-describedby="parent-dialog-prompt"' : '') + '><div class="sheet-grip" aria-hidden="true"></div><header class="sheet-header"><div class="sheet-nav-start">' + button(auth ? 'parent-cancel' : 'form-close', icon(nested ? 'back' : 'close'), 'icon-button', '', auth ? '返回修改' : nested ? '返回上一级' : '关闭面板') + '</div><div class="sheet-heading"><h2 id="sheet-title">' + title + '</h2>' + (sub ? '<p>' + esc(sub) + '</p>' : '') + '</div><div class="sheet-nav-actions">' + (actions || '') + '</div></header>' + content + '</section></div>';
  }
  function homeWeekView(sheetEl) {
    var view = { days: {}, focusDate: null };
    Array.prototype.forEach.call(sheetEl.querySelectorAll('details.points-summary-day[data-date]'), function (dayEl) {
      var date = dayEl.getAttribute('data-date');
      view.days[date] = dayEl.open;
      if (dayEl.querySelector('summary') === document.activeElement) view.focusDate = date;
    });
    return view;
  }
  function restoreHomeWeekView(view) {
    if (!view) return false;
    var target = null;
    Array.prototype.forEach.call(document.querySelectorAll('.sheet details.points-summary-day[data-date]'), function (dayEl) {
      var date = dayEl.getAttribute('data-date');
      if (typeof view.days[date] === 'boolean') dayEl.open = view.days[date];
      if (date === view.focusDate) target = dayEl.querySelector('summary');
    });
    if (!target) return false;
    try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); }
    return true;
  }
  function render(reset) {
    if (!scopeReady()) return;
    if (chat && chat.isOpen() && !assistantAvailable()) chat.close({restoreFocus:false});
    var chatOpen = chat && chat.isOpen();
    if (!ui.homeMode) ui.homeMode = initialHomeMode();
    var old = document.getElementById('main'), scroll = old ? old.scrollTop : 0;
    var oldSheet = document.querySelector('.sheet'), oldBody = document.querySelector('.sheet-body'), oldKind = oldSheet && oldSheet.getAttribute ? oldSheet.getAttribute('data-form-kind') : '', oldAuthPhase = oldSheet && oldSheet.getAttribute ? oldSheet.getAttribute('data-auth-phase') : '', nextKind = (ui.auth ? 'parent:' : '') + (ui.form ? ui.form.kind : ''), sameSheet = !!oldSheet && oldKind === nextKind, key = sameSheet ? focusKey(document.activeElement) : ui.form && ui.form.focusKey, sheetScroll = sameSheet && oldBody ? oldBody.scrollTop : ui.form && ui.form.scrollTop || 0;
    var weekView = nextKind === 'homeWeek' ? sameSheet ? homeWeekView(oldSheet) : ui.form.weekView : null;
    var homeRefresh = !reset && ui.view === 'points' && !oldSheet && !ui.form && !ui.auth && old && old.querySelector && old.querySelector('[data-home-mode="' + ui.homeMode + '"]'), homeKey = homeRefresh ? focusKey(document.activeElement) : null;
    var homeReturn = !reset && ui.view === 'points' && oldSheet && !ui.form && !ui.auth && ui.recordHomeReturn;
    var selection = sameSheet && document.activeElement && typeof document.activeElement.selectionStart === 'number' ? { start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null;
    document.body.className = 'view-' + ui.view + (ui.form || ui.auth ? ' sheet-open' : '') + (ui.display ? ' display-mode' : '');
    if (Farm) Farm.beforeRender();
    document.getElementById('app').innerHTML = '<div class="app-shell"' + (ui.form || ui.auth ? ' aria-hidden="true"' : '') + '>' + header() + '<div id="reminder-slot">' + (ui.view === 'points' ? '' : reminderBanner()) + '</div><main id="main" class="app-main" tabindex="-1">' + (ui.view === 'points' ? pointsPage() : reminderPage()) + '</main>' + navigation() + '</div>' + (ui.auth ? parentContent() : ui.form ? editorContent() : '');
    var main = document.getElementById('main');
    if (main) {
      var gallery = ui.view === 'points' && main.querySelector && main.querySelector('.pet-home-card.is-previewing');
      if (gallery && main.classList) main.classList.add('home-gallery');
      if (homeKey && (homeKey.action === 'farm-pet-preview' || homeKey.action === 'farm-pet-current')) homeKey.action = gallery ? 'farm-pet-current' : 'farm-pet-preview';
      main.scrollTop = homeRefresh ? scroll : homeReturn ? ui.homeScrollTop || 0 : reset || ui.view === 'points' ? 0 : scroll;
    }
    if (!ui.form && !ui.auth) ui.recordHomeReturn = false;
    var notice = document.getElementById('toast');
    if (ui.view === 'points' && !ui.form && !ui.auth && notice.className.indexOf('visible') >= 0) toast(notice.textContent, notice.className.indexOf('points-receipt') >= 0);
    if (chatOpen) key = null;
    if (ui.auth) { restorePlayFocus(sameSheet && oldAuthPhase === ui.auth.phase ? key : null); }
    else if (!chatOpen && ui.form && ui.form.kind === 'homeInbox') focusInbox();
    else if (!chatOpen && ui.form && (ledgerGiftFlow() || ['points', 'behaviorPicker', 'point-list', 'pointItem', 'records', 'recordDetail', 'homeWeek', 'preferences', 'rewards', 'petHub', 'petBuy', 'petGrowth', 'petConfig', 'farm'].indexOf(ui.form.kind) >= 0)) {
      // Enter a gift detail on its back button; the optional note only opens the keyboard when selected.
      if (ledgerGiftFlow() && !key && ['request', 'approve'].indexOf(ui.form.kind) >= 0) restorePlayFocus(focusKey(document.querySelector('.sheet-nav-start button')));
      else if (!restoreHomeWeekView(weekView)) restorePlayFocus(key);
      var body = document.querySelector('.sheet-body'); if (body) body.scrollTop = sheetScroll;
      if (selection && document.activeElement && document.activeElement.setSelectionRange) { try { document.activeElement.setSelectionRange(selection.start, selection.end); } catch (e) {} }
    }
    else if (!chatOpen && oldSheet && !ui.form && !ui.auth && ui.homeFocus) restorePlayFocus(ui.homeFocus);
    else if (!chatOpen && homeRefresh && homeKey && homeKey.action) restorePlayFocus(homeKey);
    if (AwardPhotos && ui.form && ui.form.kind === 'recordDetail' && !ui.auth) {
      if (detailRecord(ui.form.data)) AwardPhotos.hydrateDetails(document.querySelector('.points-record-detail'), recordPhotoEnvironment(ui.form));
      else AwardPhotos.closeViewer();
    }
    refreshPetPurchase(); fitViewport();
    var showsFarm = farmIsVisible();
    if (Farm && !showsFarm) Farm.releaseScene();
    if (window.FamilyWorldUI) {
      var scenePet = currentPet();
      if (ui.form && ui.form.kind === 'petConfig') scenePet = { kind: ui.form.data.kind || scenePet.kind, name: scenePet.name };
      window.FamilyWorldUI.business({ view: ui.view, kind: ui.form && ui.form.kind, auth: !!ui.auth, ledgerPage: (ui.view === 'reminders' || ui.homeMode === 'points') && isAppPage(), farm: Farm && Farm.status(), pet: scenePet, growth: growthInfo() });
      if (ui.form && ui.form.kind === 'behaviorPicker') updatePicker();
    }
    if (Farm && showsFarm) Farm.afterRender();
    syncThemeColor();
  }
  function makeAction(f, v) {
    if (f.kind === 'assistantReview') return clone(f.data.command);
    if (f.kind === 'points') { var action = { type: 'points.add', itemId: v.itemId || undefined, name: v.name.trim(), points: Number(v.points), reason: (v.reason || '').trim() }; if (v.saveAsTemplate === true && !v.itemId) action.saveAsTemplate = true; if (v.recordTime) action.at = M.calendarTimestamp(today(), v.recordTime, calendarZone()); return addAwardPhotoIds(action, f); }
    if (f.kind === 'petBuy') { var status = playStatus(), supply = status && find(status.catalog, f.data.itemId), quantity = Number(v.quantity); if (!supply || !isFinite(quantity) || quantity < 1 || quantity > 10 || quantity !== Math.floor(quantity)) throw new Error('数量无效'); return { type: 'pet.buy', itemId: supply.id, quantity: quantity, expectedPoints: quantity * supply.points }; }
    if (f.kind === 'request') return { type: 'redemption.request', rewardId: f.data.rewardId };
    if (f.kind === 'approve') { var req = find(state.requests, f.data.requestId), reward = req && find(state.rewards, req.rewardId); if (!reward || req.status !== 'pending') throw new Error('申请已更新'); return { type: 'redemption.approve', requestId: req.id, expectedPoints: reward.points, note: (v.note || '').trim() }; }
    if (f.kind === 'taskAction') return { type: f.data.type, taskId: f.data.taskId, minutes: f.data.type === 'task.snooze' ? 10 : undefined };
    if (f.kind === 'task') return { type: 'task.save', task: { id: f.data.id, type: v.type, title: v.title.trim(), date: v.date, time: v.time, note: (v.note || '').trim(), remindDays: Number(v.remindDays || 0) } };
    if (f.kind === 'reward') return { type: 'reward.save', reward: { id: f.data.id, name: v.name.trim(), points: Number(v.points), category: v.category, enabled: v.enabled === 'true', icon: { daily: 'pencil', weekend: 'burger', outing: 'mountain' }[v.category] } };
    if (f.kind === 'pointItem') {
      if (f.data.id && !find(state.pointItems, f.data.id)) throw new Error('常用项不存在');
      return { type: 'pointItem.save', item: { id: f.data.id, name: v.name.trim(), points: Number(v.points), reason: (v.reason || '').trim(), enabled: v.enabled === 'true' } };
    }
    if (f.kind === 'profile') return { type: 'profile.update', childName: (v.childName || '').trim(), childAvatar: f.data.childAvatar || '' };
    if (f.kind === 'petConfig') return { type: 'pet.configure', kind: f.data.kind, name: (v.petName || '').trim() };
    if (f.kind === 'familySettings') return { type: 'settings.update', childName: v.childName.trim(), settings: { monthEndDays: Number(v.monthEndDays), preferredReward: state.settings.preferredReward } };
    if (f.kind === 'parentConfig') { if (f.parentConfigured == null || f.setupConflict) throw new Error('家长验证待确认'); if (v.method === 'pin' && !/^\d{6}$/.test(v.pin || '')) throw new Error('PIN格式无效'); if (v.method === 'pin' && v.pin !== v.confirmPin) throw new Error('PIN不一致'); var config = { type: f.parentConfigured ? 'parent.configure' : 'parent.setup', method: v.method }; if (v.method === 'pin') { config.pin = v.pin; config.confirmPin = v.confirmPin; } return config; }
    throw new Error('未识别此操作');
  }
  function interpret() {
    if (ui.assistantBusy || !ui.form) return;
    var f = ui.form, text = (f.data.speech || '').trim(); if (!text) { showError('指令 · 必填'); return; }
    stopRecognition(); var token = ++assistantSequence; f.voiceRequest = token; ui.assistantBusy = true; render(false);
    function receive(status, result) {
      if (f.voiceRequest !== token || ui.form !== f || ui.auth) return;
      f.voiceRequest = null; ui.assistantBusy = false;
      if (status !== 200 || !result) { render(false); showError(errorText(result || {})); return; }
      if ((f.data.speech || '').trim() !== text) { render(false); showError('指令已修改'); return; }
      if (result.result) result = result.result;
      rememberAssistantResult(result, 'general');
      if (result.kind !== 'action' || !result.action) { f.data.answer = assistantMessage(result); render(false); return; }
      var editor = assistantEditor(result);
      if (!editor) { f.data.answer = '指令不适用'; render(false); return; }
      openForm(editor.kind, editor.data, false);
    }
    if (!local) { request('POST', '/api/assistant', { text: text, context: 'general' }, receive); }
    else { try { if (!window.FamilyAssistant) throw new Error('指令服务不可用'); receive(200, window.FamilyAssistant.interpret(text, assistantState(), new Date(), { context: 'general' })); } catch (e) { receive(400, { error: e.message }); } }
  }
  function stopRecognition() { if (recognition) { var previous = recognition; recognition = null; try { previous.abort(); } catch (e) {} } }
  function listen(targetName) {
    targetName = targetName || 'speech';
    if (recognition) { stopRecognition(); render(false); return; }
    var Speech = window.SpeechRecognition || window.webkitSpeechRecognition, status = document.getElementById('voice-status');
    if (!Speech || window.isSecureContext === false) { if (status) status.textContent = !Speech ? '听写不支持' : '听写不可用'; var input = document.querySelector('[name="' + targetName + '"]'); if (input) input.focus(); return; }
    try {
      var f = ui.form, scope = scopeToken(), r = new Speech(); recognition = r; r.lang = 'zh-CN'; r.interimResults = true; r.continuous = false;
      r.onstart = function () { if (!scopeCurrent(scope) || ui.form !== f || recognition !== r || ui.auth) return; var el = document.getElementById('voice-status'); if (el) el.textContent = '听写中'; };
      r.onresult = function (event) { if (!scopeCurrent(scope) || ui.form !== f || recognition !== r || ui.auth) return; var text = ''; for (var i = 0; i < event.results.length; i++) text += event.results[i][0].transcript; f.data[targetName] = text; var input = document.querySelector('[name="' + targetName + '"]'); if (input) input.value = text; rememberDraft(); };
      r.onerror = function () { if (!scopeCurrent(scope) || ui.form !== f || recognition !== r || ui.auth) return; var el = document.getElementById('voice-status'); if (el) el.textContent = '听写未完成'; };
      r.onend = function () { if (!scopeCurrent(scope) || recognition !== r) return; recognition = null; if (ui.form !== f || ui.auth) return; var el = document.getElementById('voice-status'); if (el && el.textContent === '听写中') el.textContent = '听写已停止'; };
      r.start();
    } catch (e) { recognition = null; if (status) status.textContent = '听写不可用'; }
  }
  function refreshWakeStatus() { if (ui.form && ui.form.kind === 'preferences' && !ui.auth) render(false); }
  function displayMode() {
    if (!scopeReady()) return;
    var scope = scopeToken();
    if (ui.wakePending) { toast('申请中'); return; }
    if (wakeLock && !wakeLock.released) {
      var previous = wakeLock; ui.wakePending = true;
      previous.release().then(function () { if (!scopeCurrent(scope)) return; if (wakeLock === previous) { wakeLock = null; ui.display = false; } ui.wakePending = false; refreshWakeStatus(); toast('常亮已关闭'); }, function () { if (!scopeCurrent(scope)) return; ui.wakePending = false; refreshWakeStatus(); toast('常亮关闭失败'); }); return;
    }
    ui.display = false;
    if (!(navigator.wakeLock && navigator.wakeLock.request)) { refreshWakeStatus(); toast('常亮不支持'); return; }
    ui.wakePending = true; refreshWakeStatus();
    navigator.wakeLock.request('screen').then(function (lock) {
      if (!scopeCurrent(scope)) { try { var release = lock.release(); if (release && release.catch) release.catch(function () {}); } catch (e) {} return; }
      wakeLock = lock; ui.wakePending = false; ui.display = !lock.released;
      lock.addEventListener('release', function () { if (!scopeCurrent(scope)) return; if (wakeLock === lock) { wakeLock = null; ui.display = false; ui.wakePending = false; refreshWakeStatus(); } });
      refreshWakeStatus(); toast(ui.display ? '常亮已开启' : '常亮已关闭');
    }, function () { if (!scopeCurrent(scope)) return; ui.wakePending = false; ui.display = false; refreshWakeStatus(); toast('常亮未获允许'); });
  }
  function exportData() { var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = '家庭积分提醒-' + today() + '.json'; document.body.appendChild(a); a.click(); a.parentNode.removeChild(a); setTimeout(function () { URL.revokeObjectURL(url); }, 1000); toast('记录已导出'); }
  function onAction(action, id, element) {
    if (!scopeReady()) return;
    if (AwardPhotos && action.indexOf('award-photo-') === 0) {
      if (pending) return;
      if (action === 'award-photo-history' && !ui.auth) {
        var photoView = ui.form, photoRecord = photoView && photoView.kind === 'recordDetail' && photoView.data.recordKind === 'points' && detailRecord(photoView.data);
        if (photoRecord && (photoRecord.photoIds || []).join(',') === id) AwardPhotos.viewHistory(photoRecord.photoIds.slice(), recordPhotoEnvironment(photoView), element ? Number(element.getAttribute('data-photo-index')) || 0 : 0);
      } else if (ui.form && ui.form.kind === 'points' && (!ui.auth || (ui.auth.phase === 'confirm' && !ui.auth.busy))) {
        rememberDraft(); AwardPhotos.handle(action, id, awardPhotos(ui.form), awardPhotoEnvironment(ui.form));
      }
      return;
    }
    if (AwardPhotos) AwardPhotos.closeViewer();
    discardAwardPhotoInput();
    if (action === 'assistant-open' && chat && assistantAvailable()) {
      openAssistant(element); return;
    }
    if (saas && action === 'saas-account') { SaaS.openSettings(); return; }
    if (saas && action === 'saas-logout') { SaaS.logout(); return; }
    if (action === 'pet-touch' && !ui.auth) { touchPet(); return; }
    if (action === 'points-cancel') { if (isPristinePresetReview(ui.auth)) closeForm(true); return; }
    if (action === 'form-close' || action === 'parent-cancel') { closeForm(); return; }
    if (action === 'points-confirm') { submitParent(document.getElementById('parent-form')); return; }
    if (pending) return;
    if (ui.auth) return;
    if (Farm && Farm.handle(action, id, element)) return;
    var item, task, copy;
    if (action === 'nav') { discardAvatar(); rememberDraft(); discardOpenAwardPhotos(); stopRecognition(); invalidateAssistant(ui.form); if (ui.form) ui.form.avatarRequest = null; ui.view = id === 'reminders' ? 'reminders' : 'points'; ui.form = null; ui.stack = []; render(true); }
    else if (action === 'home-view' && !ui.form && ui.view === 'points' && (id === 'points' || id === 'companion')) {
      if (ui.homeMode === id) return;
      var switchFocus = focusKey(element);
      ui.homeMode = id; render(true);
      if (switchFocus) restorePlayFocus(switchFocus);
    }
    else if (action === 'home-default' && ui.form && ui.form.kind === 'preferences') {
      try { localStorage.setItem(homePreferenceKey, ui.homeMode); }
      catch (e) { toast('浏览器无法保存本机首页'); return; }
      render(false); toast('本机下次打开「' + homeLabels[ui.homeMode] + '」');
    }
    else if (action === 'home-auto' && ui.form && ui.form.kind === 'preferences') {
      try { localStorage.removeItem(homePreferenceKey); }
      catch (e) { toast('浏览器无法更改本机首页'); return; }
      render(false); toast('下次打开时按窗口大小选择首页');
    }
    else if (action === 'home-week') openForm('homeWeek', {});
    else if (action === 'home-inbox') openForm('homeInbox', {});
    else if (action === 'all-behaviors') openForm('behaviorPicker', { query: '', page: 0 });
    else if (action === 'picker-search' && ui.form && ui.form.kind === 'behaviorPicker') { ui.form.data.searchOpen = !(ui.form.data.searchOpen || ui.form.data.query); if (!ui.form.data.searchOpen) { ui.form.data.query = ''; ui.form.data.page = 0; } render(false); var pickerSearch = document.getElementById('behavior-search'); if (ui.form.data.searchOpen && pickerSearch) pickerSearch.focus(); }
    else if (action === 'picker-clear') { if (ui.form && ui.form.kind === 'behaviorPicker') { ui.form.data.query = ''; ui.form.data.page = 0; var search = document.getElementById('behavior-search'); if (search) search.value = ''; updatePicker(); if (search) search.focus(); } }
    else if (action === 'picker-prev' || action === 'picker-next') { if (ui.form && ui.form.kind === 'behaviorPicker') { ui.form.data.page = (Number(ui.form.data.page) || 0) + (action === 'picker-next' ? 1 : -1); updatePicker(); } }
    else if (action === 'jump-rewards') openForm('rewards', {});
    else if (action === 'profile-edit') openForm('profile', { childName: state.childName, childAvatar: state.childAvatar || '' });
    else if (action === 'avatar-choose') { var fileInput = document.getElementById('avatar-file'); if (fileInput) { if (saas) prepareAvatar(fileInput); fileInput.click(); } }
    else if (action === 'avatar-remove') { discardAvatar(); rememberDraft(); ui.form.avatarRequest = null; ui.form.avatarBusy = false; ui.form.data.childAvatar = ''; ui.form.avatarStatus = '头像已移除'; render(false); }
    else if (action === 'pet-hub') openForm('petHub', { tab: ui.petTab || 'bag' });
    else if (action === 'pet-tab') { if (ui.form && ui.form.kind === 'petHub' && ['bag', 'supply', 'explore'].indexOf(id) >= 0) { ui.form.data.tab = id; render(false); } }
    else if (action === 'pet-home') { rememberDraft(); discardOpenAwardPhotos(); ui.form = null; ui.stack = []; ui.view = 'points'; ui.homeMode = 'companion'; render(false); var petTarget = document.querySelector('.companion-scene'); if (petTarget) petTarget.focus(); }
    else if (action === 'pet-buy') openPetPurchase(id);
    else if (action === 'pet-scene') beginAction({ type: 'pet.scene', sceneId: id });
    else if (action === 'pet-care') {
      if (ui.careBusy || (!local && !connected)) return;
      var careStatus = playStatus(), careItem = careStatus && careStatus.catalog.filter(function (p) { return p.care === id; })[0], source = element && element.getAttribute('data-source');
      if (!careItem) { showError('资源同步中'); return; }
      if (retryTx && retryTx.uncertain && retryTx.action.type === 'pet.care' && retryTx.action.care !== id) { showError('照料结果待确认'); sync(); return; }
      if (source === 'supply') { openPetPurchase(careItem.id); return; }
      if (source !== 'free' && source !== 'inventory') { showError('资源待选择'); return; }
      beginAction({ type: 'pet.care', care: id, source: source });
    }
    else if (action === 'pet-growth') openForm('petGrowth', {});
    else if (action === 'pet-config') openForm('petConfig', currentPet());
    else if (action === 'pet-kind') { rememberDraft(); var petName = ui.form.data.petName !== undefined ? ui.form.data.petName : ui.form.data.name; ui.form.data.kind = id; if (!petName || petName === '芽芽' || petName === '团团') petName = id === 'plant' ? '芽芽' : '团团'; ui.form.data.petName = petName; render(false); }
    else if (action === 'ai-toggle' && ui.form) { rememberDraft(); ui.form.aiOpen = !ui.form.aiOpen; if (!ui.form.aiOpen) { stopRecognition(); invalidateAssistant(ui.form); } render(false); if (ui.form.aiOpen) { var aiInput = document.querySelector('[name="aiText"]'); if (aiInput) aiInput.focus(); } }
    else if (action === 'ai-fill') contextualInterpret(id);
    else if (action === 'listen-context') listen('aiText');
    else if (action === 'add-points') openForm('behaviorPicker', { query: '', page: 0 });
    else if (action === 'points-new') choosePoints(null);
    else if (action === 'choose-point') {
      item = find(state.pointItems, id);
      if (item && item.enabled) {
        var homePreset = !ui.form && ui.view === 'points' && ui.homeMode === 'points' && element && element.classList && element.classList.contains('points-home-behavior');
        if (homePreset && !(retryTx && retryTx.uncertain) && !pointDraftChanged(item)) reviewPointPreset(item, element);
        else choosePoints(item);
      }
    }
    else if (action === 'records') { ui.history = 'points'; openForm('records', {}); }
    else if (action === 'record-detail') openRecordDetail(id, element);
    else if (action === 'preferences' || action === 'point-list' || action === 'reward-list') openForm(action, {});
    else if (action === 'rewards-history') { ui.history = 'redemptions'; openForm('records', { source: 'rewards' }); }
    else if (action === 'reward-filter') { ui.filter = id; render(false); }
    else if (action === 'history') { ui.history = id; render(false); }
    else if (action === 'redeem') openForm('request', { rewardId: id });
    else if (action === 'redemption-approve') openForm('approve', { requestId: id, note: '' });
    else if (action === 'redemption-cancel') beginAction({ type: 'redemption.cancel', requestId: id }, '申请已取消');
    else if (action === 'reward-new') openForm('reward', { category: 'daily', enabled: true }, true);
    else if (action === 'reward-edit') { item = find(state.rewards, id); if (item) openForm('reward', item); }
    else if (action === 'point-item-new') openForm('pointItem', { points: 5, enabled: true }, true);
    else if (action === 'point-item-edit') { item = find(state.pointItems, id); if (item) openForm('pointItem', item); }
    else if (action === 'point-item-delete' && ui.form && ui.form.kind === 'pointItem' && ui.form.data.id === id) beginAction({ type: 'pointItem.delete', itemId: id }, '常用行为已删除');
    else if (action === 'day') { ui.day = Number(id); render(false); }
    else if (action === 'reminder-mode') { ui.reminderMode = id; render(false); }
    else if (action === 'task-new') openForm('task', { type: ui.reminderMode === 'events' ? 'event' : 'task', date: day(ui.day), time: '', note: '' }, true);
    else if (action === 'task-edit') { task = find(state.tasks, id); if (task) openForm('task', task); }
    else if (action === 'task-toggle') { task = find(state.tasks, id); beginAction({ type: 'task.toggle', taskId: id }, task && task.done ? '已撤销完成' : '提醒已完成'); }
    else if (action === 'task-ack') beginAction({ type: 'task.ack', taskId: id }, '已收到');
    else if (action === 'task-snooze') beginAction({ type: 'task.snooze', taskId: id, minutes: 10 }, '已延后10分钟');
    else if (action === 'task-delete') beginAction({ type: 'task.delete', taskId: id }, '提醒已取消。');
    else if (action === 'task-tomorrow') { rememberDraft(); task = clone(ui.form.data); task.date = day(1); ui.form.data = task; render(false); toast('日期 · 明天'); }
    else if (action === 'task-copy') { rememberDraft(); copy = clone(ui.form.data); delete copy.id; copy.date = day(1); copy.done = false; openForm('task', copy); }
    else if (action === 'form-task-type') { rememberDraft(); ui.form.data.type = id; if (id === 'task' && (ui.form.data.date > day(2) || ui.form.data.date < today())) ui.form.data.date = today(); render(false); }
    else if (action === 'form-day') { rememberDraft(); ui.form.data.date = day(Number(id)); render(false); }
    else if (action === 'family-settings') openForm('familySettings', { childName: state.childName, monthEndDays: state.settings.monthEndDays });
    else if (action === 'parent-config') openForm('parentConfig', { method: meta.parent && meta.parent.method || 'pin' });
    else if (action === 'parent-device-toggle' && saas && ui.form && ui.form.kind === 'parentConfig' && !parentDevice.loading && !parentDevice.busy && meta.parent.configured === true) {
      if (parentDevice.enabled == null) loadParentDevice();
      else if (parentDevice.enabled) saveParentDevice(false);
      else openForm('parentDevice', {});
    }
    else if (action === 'voice') openForm('voice', {}, true);
    else if (action === 'listen') listen();
    else if (action === 'sound') { ui.sound = !ui.sound; if (saas) saveSoundPreference(ui.sound); else saveStore(PREF, { sound: ui.sound }); render(false); if (ui.sound) play('complete'); }
    else if (action === 'display') displayMode();
    else if (action === 'export') exportData();
  }
  if (chat) bindLauncherHold();
  document.addEventListener('click', function (event) { var el = event.target; while (el && el !== document) { if (el.getAttribute && el.getAttribute('data-action')) { event.preventDefault(); onAction(el.getAttribute('data-action'), el.getAttribute('data-id'), el); return; } el = el.parentNode; } });
  function draftInput(event) {
    var input = event.target, form = input.form;
    if (form && (form.id === 'editor-form' || form.id === 'parent-form')) {
      if (input.getAttribute('aria-invalid') === 'true') { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); }
      var error = document.getElementById(form.id === 'parent-form' ? 'parent-error' : 'form-error'); if (error) error.hidden = true;
    }
    if (input.id === 'behavior-search' && ui.form && ui.form.kind === 'behaviorPicker') { if (ui.form.data.query === input.value) return; ui.form.data.query = input.value; ui.form.data.page = 0; updatePicker(); return; }
    if (form && form.id === 'editor-form' && ui.form) {
      if (input.name !== 'aiText' && input.name !== 'speech') ui.form.editVersion = (ui.form.editVersion || 0) + 1;
      if (ui.form.kind === 'points' && input.name === 'recordTime') { ui.form.data.recordTimeEdited = true; ui.form.data.recordDate = today(); }
      if (ui.form.kind === 'pointItem' && !ui.form.data.id && input.name === 'points') ui.form.data.templatePointsChosen = true;
      rememberDraft();
      if (ui.form.kind === 'points') refreshTemplatePreview();
      if (ui.form.kind === 'petBuy') refreshPetPurchase();
    }
  }
  document.addEventListener('input', draftInput);
  document.addEventListener('cancel', function (event) { if (AwardPhotos && event.target.getAttribute('data-award-photo-input')) cancelAwardPhotoInput(event.target); }, true);
  document.addEventListener('change', function (event) {
    if (AwardPhotos && event.target.getAttribute('data-award-photo-input')) { receiveAwardPhotoInput(event.target); return; }
    if (event.target.id === 'behavior-page' && ui.form && ui.form.kind === 'behaviorPicker') { if (ui.form.data.page !== Number(event.target.value) - 1) { ui.form.data.page = Number(event.target.value) - 1; updatePicker(true); } return; }
    if (event.target.id === 'avatar-file') { if (saas) receiveAvatar(event.target); else loadAvatar(event.target.files && event.target.files[0]); return; }
    draftInput(event);
    if (event.target.name === 'method' && ui.form && ui.form.kind === 'parentConfig') { ['pin', 'confirmPin'].forEach(function (name) { var pin = document.querySelector('[name="' + name + '"]'); if (pin) { pin.disabled = event.target.value === 'math'; pin.parentNode.hidden = pin.disabled; if (pin.disabled) pin.value = ''; } }); }
  });
  document.addEventListener('submit', function (event) {
    if (!scopeReady()) return;
    if (event.target.id === 'parent-form') { event.preventDefault(); submitParent(event.target); return; }
    if (event.target.id !== 'editor-form') return; event.preventDefault(); if (pending || (ui.form && ui.form.kind === 'voice' && ui.assistantBusy)) return;
    rememberDraft();
    if (setupTx && setupTx.uncertain && setupTx.form === ui.form && !setupTx.auth) { submitSetup(setupTx); return; }
    if (ui.form.kind === 'profile' && ui.form.avatarBusy) { showError('照片处理中'); return; }
    if (!awardPhotosReady(ui.form)) { showError('请先处理照片：重试、重拍或移除后继续。'); return; }
    if (ui.form.kind === 'point-list') { contextualInterpret('pointItems'); return; }
    if (['parentConfig', 'parentDevice'].indexOf(ui.form.kind) >= 0 && parentDevice.busy) return;
    if (!event.target.checkValidity()) { var bad = event.target.querySelector(':invalid'); if (bad) { bad.setAttribute('aria-invalid', 'true'); bad.setAttribute('aria-describedby', 'form-error'); } showError(fieldError(bad)); if (bad) bad.focus(); return; }
    if (ui.form.kind === 'parentDevice') {
      var credentialInput = event.target.elements.credential, credential = credentialInput ? credentialInput.value : '';
      if (credentialInput) credentialInput.value = '';
      saveParentDevice(true, credential); credential = ''; return;
    }
    if (ui.form.kind === 'voice') { interpret(); return; }
    try { var action = makeAction(ui.form, fields()), message = action.type === 'points.add' ? '已加 ' + action.points + ' 分。' : action.type === 'redemption.request' ? '申请已提交' : action.type === 'redemption.approve' ? '兑换成功 · −' + action.expectedPoints + ' 分' : '已保存。'; beginAction(action, message); } catch (e) { showError(errorText(e)); }
  });
  document.addEventListener('keydown', function (event) {
    if (chat && chat.isOpen()) return;
    if (event.key === 'Enter' && event.target.id === 'behavior-page' && ui.form && ui.form.kind === 'behaviorPicker') { event.preventDefault(); if (ui.form.data.page !== Number(event.target.value) - 1) { ui.form.data.page = Number(event.target.value) - 1; updatePicker(true); } return; }
    if (event.key === 'Escape' && (ui.form || ui.auth)) closeForm(isPristinePresetReview(ui.auth));
    if (event.key === 'Tab' && (ui.form || ui.auth)) { var sheetEl = document.querySelector('.sheet'), nodes = sheetEl ? sheetEl.querySelectorAll('button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]') : []; nodes = Array.prototype.filter.call(nodes, function (node) { return node.getClientRects().length > 0; }); if (nodes.length) { var first = nodes[0], last = nodes[nodes.length - 1]; if (!sheetEl.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); } else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } } }
  });
  // Safari may pan the visible area after it resizes. Move only the form and
  // scroll its own content, so editing never resets the draft or the caret.
  var formViewportFrame = 0;
  function fitFormViewport() {
    formViewportFrame = 0;
    var viewport = window.visualViewport, root = document.documentElement;
    // Keep the previous anchor while pinch-zooming so native panning still works.
    if (viewport && Math.abs(viewport.scale - 1) >= 0.01) return;
    if (viewport) root.style.setProperty('--form-viewport-top', Math.max(0, viewport.offsetTop) + 'px');

    var field = document.activeElement;
    if (!field || !/^(INPUT|TEXTAREA|SELECT)$/.test(field.tagName)) return;
    var scroller = field.closest('.sheet-body, .behavior-picker-body, .saas-main');
    if (!scroller) return;
    var box = scroller.getBoundingClientRect(), input = field.getBoundingClientRect();
    if (input.height > box.height) {
      if (input.top >= box.bottom || input.bottom <= box.top) scroller.scrollTop += input.top - box.top;
      return;
    }
    var margin = Math.min(8, (box.height - input.height) / 2);
    if (input.top < box.top + margin) scroller.scrollTop += input.top - box.top - margin;
    else if (input.bottom > box.bottom - margin) scroller.scrollTop += input.bottom - box.bottom + margin;
  }
  function scheduleFormViewport() {
    if (!formViewportFrame) formViewportFrame = window.requestAnimationFrame(fitFormViewport);
  }
  function fitViewport() {
    var root = document.documentElement, height = homeViewportHeight(), width = window.innerWidth;
    var viewport = window.visualViewport;
    if (root.style && root.style.setProperty) {
      root.style.setProperty('--app-height', height + 'px');
      // A pinch magnifies the form. Only space lost to the keyboard should shrink it.
      var formHeight = viewport ? height * viewport.scale : height;
      var covered = viewport ? Math.max(0, root.clientHeight - formHeight) : 0;
      root.style.setProperty('--form-height', formHeight + 'px');
      root.style.setProperty('--form-covered-height', covered + 'px');
      if (root.classList) root.classList.toggle('short-form-viewport', formHeight < 260);
    }
    var home = ui.view === 'points' && document.querySelector('.home-portrait');
    if (home && home.classList && home.classList.toggle) {
      home.classList.toggle('home-roomy', height >= 650);
      home.classList.toggle('home-tall', height >= 700);
    }
    var gallery = ui.view === 'points' && document.querySelector('.home-gallery');
    if (gallery && gallery.classList && gallery.classList.toggle) {
      gallery.classList.toggle('gallery-focused', width < 700 || height <= 620);
      gallery.classList.toggle('gallery-landscape', width >= 480 && width > height && height <= 620);
    }
    if (state && ui.view === 'points' && (ui.homeWide !== homeWide() || ui.homeItemLimit !== homeItemLimit()) && !ui.form && !ui.auth) render(false);
    if (ui.form && ui.form.kind === 'behaviorPicker') updatePicker();
  }
  function resizeViewport() {
    fitViewport();
    syncThemeColor();
    scheduleFormViewport();
  }
  window.addEventListener('resize', resizeViewport);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', resizeViewport);
    window.visualViewport.addEventListener('scroll', scheduleFormViewport);
  }
  document.addEventListener('focusin', scheduleFormViewport);
  window.addEventListener('storage', function (event) { if (local && event.key === PRIVATE) { privateConfig = readStore(PRIVATE, privateConfig); loadMeta(); if (!ui.auth && !ui.form) render(false); } if (local && event.key === KEY && !pending) { var saved = readStore(KEY, null); if (saved && saved.tasks) { state = M.normalize(saved); revision++; if (canRefreshLedgerView()) render(false); } } });
  if (!M) { document.getElementById('app').innerHTML = '<p class="loading-screen">数据模块未加载</p>'; return; }
  if (chat) chat.init({
    onOpen:syncThemeColor, onClose:syncThemeColor,
    request:request, applyResult:applyAssistantCard, canOpen:assistantAvailable, context:assistantContext, onCleared:clearAssistantEditors,
    scope:scopeToken,
    speechHints:function () {
      if (!state) return [];
      return [state.childName].concat(state.pointItems.concat(state.rewards).filter(function (item) {
        return item.enabled && !item.deleted;
      }).map(function (item) { return item.name; })).filter(Boolean);
    },
    contextLabel:function () {
      var heading = document.getElementById('sheet-title');
      return ui.form && heading ? heading.textContent : ui.view === 'reminders' ? '提醒' : '';
    },
    restoreFocus:function () {
      var el = document.querySelector('.sheet [data-action="assistant-open"], .assistant-launcher');
      if (el) el.focus({preventScroll:true});
    }
  });
  if (!saas) {
    state = readStore(KEY, null); if (!state || state.version !== 1 || !state.tasks) state = M.createSeed(new Date());
    state = M.normalize(state);
  }
  if (drafts['points:new'] && drafts['points:new'].itemId) { var legacyPointDraft = clone(drafts['points:new']), legacyKey = 'points:' + legacyPointDraft.itemId; if (!drafts[legacyKey]) drafts[legacyKey] = clone(legacyPointDraft); delete legacyPointDraft.itemId; legacyPointDraft.saveAsTemplate = false; drafts['points:new'] = legacyPointDraft; saveStore(DRAFT, drafts); }
  var preferences = readStore(PREF, {}); ui.sound = !!preferences.sound; ui.display = false;
  if (Farm) Farm.setup({
      context: function () { if (!scopeReady()) return { ready: false, state: null, local: false, connected: false }; return { ready: true, state: state, earnedPoints: M.totals(state).earned, availablePoints: M.totals(state).available, now: farmClock(), familyDay: saas || local ? today() : familyDay || today(), pet: currentPet(), growth: growthInfo(), petMessage: ui.petMessage, reducedMotion: reducedMotion(), local: local, connected: connected, pending: pending, retry: retryTx, form: ui.form, auth: ui.auth, view: ui.view, feedback: ui.homeFeedback }; },
      icon: icon, render: function () { render(false); }, act: beginAction,
      open: function (data, replace) { openForm('farm', data, false, replace); },
      home: function () { rememberDraft(); discardOpenAwardPhotos(); ui.form = null; ui.stack = []; ui.view = 'points'; render(false); restorePlayFocus({ tag: 'BUTTON', type: 'button', id: '', name: '', action: 'farm-open', dataId: '' }); },
      sheet: function (title, sub, body, actions) { return sheet(title, sub, body, false, actions); },
      toast: toast, petPlay: function (kind) { if (['feed', 'wash', 'train'].indexOf(kind) >= 0 && !pending && !ui.careBusy) reactPet(kind); }, touchPet: touchPet,
      retry: function () { if (retryTx && retryTx.uncertain && /^farm\./.test(retryTx.action.type) && !pending && (local || connected)) submitTransaction(retryTx); }
    });
  if (saas) {
    fitViewport();
    if (SaaS) SaaS.start({ clear: clearFamily, suspend: suspendFamily, refresh: sync, enter: function (result, saved) { if (!setSnapshot(result)) { SaaS.recheck(); return; } lastDay = today(); ui.sound = soundPreference(saved && saved.sound); loadMeta(); if (saved) restoreFamily(saved); else { discardAvatar(); render(false); } } });
    else document.getElementById('app').innerHTML = '<p class="loading-screen">账号模块未加载 · 请刷新</p>';
  } else { persist(); loadMeta(); render(false); sync(); }
  var lastDay = today();
  setInterval(function () { if (!scopeReady()) return; sync(); renderReminder(); if (Farm && farmIsVisible()) Farm.tick(); if (lastDay !== today()) { lastDay = today(); if (!ui.auth && (!ui.form || ui.form.kind === 'homeWeek' || (local && ui.form.kind === 'petHub'))) render(false); } }, 5000);
  window.FamilyDemo = { getState: function () { return clone(state); }, getUI: function () { if (!scopeReady()) return { ready: false, view: 'account', connected: false, revision: 0, form: null, auth: false, pending: false, aiBusy: false, screenAwake: false, farmView: null, farmStatus: null, farmRender: Farm ? Farm.diagnostics() : null }; return { ready: true, view: ui.view, homeMode: ui.homeMode, connected: connected, revision: revision, form: ui.form ? ui.form.kind : null, auth: !!ui.auth, authPhase: ui.auth ? ui.auth.phase : null, parentConfigured: meta.parent.configured, parentMethod: meta.parent.method, parentDeviceEnabled: parentDevice.enabled, parentDeviceBusy: !!(parentDevice.loading || parentDevice.busy), setupUncertain: !!(setupTx && setupTx.uncertain), pending: pending, assistantMode: meta.assistant.mode, aiBusy: ui.assistantBusy || !!(ui.form && ui.form.aiBusy), petReaction: ui.petReaction, petKind: currentPet().kind, growth: growthInfo(), homeLayout: homeWide() ? 'landscape' : 'portrait', frequentItemIds: rankedItems().slice(0, homeItemLimit()).map(function (p) { return p.id; }), picker: ui.form && ui.form.kind === 'behaviorPicker' ? pickerData() : null, inboxCount: dueTasks().length + (state.requests || []).filter(function (r) { return r.status === 'pending'; }).length, screenAwake: !!ui.display, homeFeedback: ui.homeFeedback, familyDay: saas || local ? today() : familyDay, petStatus: playStatus(), careBusy: ui.careBusy || !!(pending && retryTx && retryTx.action.type === 'pet.care'), petTab: ui.form && ui.form.kind === 'petHub' ? ui.form.data.tab : ui.petTab, pointsMode: ui.form && ui.form.kind === 'points' ? ui.form.data.itemId ? 'common' : 'custom' : null, saveAsTemplate: !!(ui.form && ui.form.kind === 'points' && !ui.form.data.itemId && ui.form.data.saveAsTemplate), petTouches: ui.petTouches, farmView: ui.form && ui.form.kind === 'farm' ? ui.form.data.view : null, farmStatus: Farm && M.farmStatus ? Farm.status() : null, farmRender: Farm ? Farm.diagnostics() : null }; } };
}());
