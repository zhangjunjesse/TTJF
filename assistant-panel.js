/* The assistant owns its conversation; the host owns every business form. ES5. */
(function (root) {
  'use strict';
  var doc = root.document, config = {}, host = null, box = null, input = null, log = null;
  var opened = false, scope = '', epoch = 0, sequence = 0, active = null, poll = 0, frame = 0;
  var generation = '', messages = [], draft = null, serverPending = null, pendingTurn = null, failedTurnId = '';
  var hasMore = false, nextCursor = null, historyExpanded = false;
  var loaded = false, text = '', notice = '', error = '', retry = '', confirming = false;
  var opener = null, openingContext, hasOpeningContext = false, voice = null, voiceEpoch = 0;
  var listening = false, voiceNote = '', applying = false;
  var SPEECH = root.SpeechRecognition || root.webkitSpeechRecognition;

  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function trim(value) { return String(value || '').replace(/^\s+|\s+$/g, ''); }
  function copy(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function scopeKey() { var value = typeof config.scope === 'function' ? config.scope() : config.scope; return typeof value === 'object' ? JSON.stringify(value) : String(value == null ? '' : value); }
  function allowed() { return typeof config.canOpen !== 'function' || config.canOpen() !== false; }
  function current() { return opened && scope === scopeKey() && allowed(); }
  function busy() { return !!active || !!serverPending; }
  function icon(name) {
    var paths = {
      coins: '<ellipse cx="10" cy="6" rx="7" ry="3"/><path d="M3 6v5c0 1.7 3.1 3 7 3 2.6 0 5-.6 6.2-1.6M17 6v4m-11 3v3c0 1.7 3.1 3 7 3s7-1.3 7-3v-4c0-1.2-1.3-2.2-3.3-2.7"/>',
      book: '<path d="M4 4h13a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2Zm0 14a2 2 0 0 1 2-2h13M8 8h7"/>',
      bell: '<path d="M5 16h14l-1.7-2.5V10a5.3 5.3 0 1 0-10.6 0v3.5ZM10 19a2.3 2.3 0 0 0 4 0"/>',
      close: '<path d="m6 6 12 12M6 18 18 6"/>', mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>', send: '<path d="M12 19V5m-6 6 6-6 6 6"/>', clear: '<path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 10v7m4-7v7"/>', arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>'
    };
    return '<svg class="assistant-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths[name] + '</svg>';
  }
  function button(action, label, classes, extra) { return '<button type="button" data-assistant-action="' + action + '" class="' + (classes || 'assistant-button') + '"' + (extra || '') + '>' + label + '</button>'; }
  function focus(node) { if (!node || !node.focus) return; try { node.focus({ preventScroll: true }); } catch (e) { node.focus(); } }
  function visible(node) { return !!node && doc.documentElement.contains(node) && node.getClientRects().length > 0; }

  function build() {
    if (host) return;
    host = doc.createElement('div'); host.id = 'family-assistant-host'; host.className = 'assistant-panel-host'; host.hidden = true;
    host.innerHTML = '<div class="assistant-backdrop" data-assistant-action="close" aria-hidden="true"></div>' +
      '<section id="family-assistant-panel" class="assistant-panel" role="dialog" aria-modal="true" aria-labelledby="assistant-panel-title" aria-describedby="assistant-panel-description" tabindex="-1">' +
      '<header class="assistant-panel-header"><span class="assistant-brand assistant-orb" aria-hidden="true"></span><div class="assistant-heading"><h2 id="assistant-panel-title">家长助手</h2><span class="assistant-context" id="assistant-panel-context" hidden></span><p id="assistant-panel-description" class="assistant-sr-only">查积分、整理草稿、打开页面</p></div>' +
      button('clear', icon('clear'), 'assistant-tool assistant-clear', ' aria-label="清空助手对话" title="清空助手对话" hidden') + button('close', icon('close'), 'assistant-tool', ' aria-label="收起助手" title="收起助手"') + '</header>' +
      '<div class="assistant-workspace"><div class="assistant-welcome" hidden><h3>今天想做点什么？</h3></div>' +
      '<div id="assistant-chat-log" class="assistant-chat-log" role="log" aria-label="助手对话" aria-live="polite" aria-relevant="additions text"></div>' +
      '<div class="assistant-feedback" id="assistant-chat-feedback" hidden><p id="assistant-chat-error" role="alert"></p>' + button('retry', '重试', 'assistant-retry') + '</div>' +
      '<form id="assistant-chat-form" class="assistant-composer"><p id="assistant-chat-status" class="assistant-chat-status" role="status" aria-live="polite"></p><label for="assistant-chat-input" class="assistant-sr-only">给家长助手发消息</label>' +
      '<div class="assistant-input-row"><textarea id="assistant-chat-input" name="assistantMessage" rows="1" maxlength="1200" placeholder="给家长助手发消息…" enterkeyhint="enter" aria-describedby="assistant-composer-hint"></textarea>' +
      button('voice', icon('mic'), 'assistant-tool assistant-voice', ' aria-label="听写成文字" aria-pressed="false" title="听写成文字，核对后再发送"') +
      '<button id="assistant-chat-send" type="submit" class="assistant-send" aria-label="发送消息">' + icon('send') + '</button></div>' +
      '<p id="assistant-composer-hint" class="assistant-sr-only">草稿可在原页面核对后保存。最多输入 1200 字。</p><span id="assistant-chat-count" hidden></span></form>' + examples() + '</div>' +
      '<div id="assistant-clear-confirm" class="assistant-confirm-overlay" hidden><section class="assistant-confirm" role="alertdialog" aria-modal="true" aria-labelledby="assistant-clear-title" aria-describedby="assistant-clear-description"><h3 id="assistant-clear-title">清空这段对话？</h3><p id="assistant-clear-description">当前对话和未办理的助手草稿会清空，已保存的家庭记录会保留。</p><div>' + button('cancel-clear', '保留对话', 'assistant-button') + button('confirm-clear', '清空对话', 'assistant-button assistant-danger') + '</div></section></div></section>';
    doc.body.appendChild(host); box = doc.getElementById('family-assistant-panel'); input = doc.getElementById('assistant-chat-input'); log = doc.getElementById('assistant-chat-log');
    host.addEventListener('click', clicked); host.addEventListener('submit', submitted); input.addEventListener('input', typed);
    doc.addEventListener('keydown', keydown, true); doc.addEventListener('focusin', focusin, true);
    root.addEventListener('resize', scheduleFit); root.addEventListener('focus', resumed); doc.addEventListener('visibilitychange', resumed);
    if (root.visualViewport) { root.visualViewport.addEventListener('resize', scheduleFit); root.visualViewport.addEventListener('scroll', scheduleFit); }
    renderConversation(false); updateControls();
  }

  function contextLabel() { return typeof config.contextLabel === 'function' ? String(config.contextLabel() || '') : ''; }
  function contextValue() { return copy(hasOpeningContext ? openingContext : typeof config.context === 'function' ? config.context() : config.context || 'general'); }
  function parts(result) { return result && result.kind === 'steps' && Array.isArray(result.steps) ? result.steps : result ? [result] : []; }
  function actionAt(index) { var rows = draft && draft.actions || []; for (var i = 0; i < rows.length; i++) if (rows[i].index === index) return rows[i]; return null; }
  function resultTitle(result) {
    if (result.title) return String(result.title);
    if (result.kind === 'form') return '常用行为草稿';
    if (result.kind === 'route') return '打开相关页面';
    var type = result.action && result.action.type || '';
    return { 'points.add': '加分草稿', 'pointItem.save': '常用行为草稿', 'reward.save': '礼品草稿', 'task.save': '提醒草稿', 'redemption.request': '兑换申请草稿', 'redemption.approve': '兑换确认草稿' }[type] || '待核对的草稿';
  }
  function resultSummary(result) {
    if (result.summary || result.reason) return String(result.summary || result.reason);
    var payload = result.action && result.action.payload || {}, fields = result.fields || payload.item || payload.reward || payload.task || payload;
    return [fields.name || fields.title || '', fields.points == null ? '' : fields.points + ' 分', fields.date || '', fields.time || '', fields.reason || fields.note || '', result.question || ''].filter(function (part) { return part !== ''; }).join(' · ');
  }
  function routeCard(result, messageIndex, index, isDraft) {
    return '<div class="assistant-route"><div><strong>' + esc(resultTitle(result)) + '</strong>' + (result.reason ? '<p>' + esc(result.reason) + '</p>' : '') + '</div>' + button('route', '打开' + icon('arrow'), 'assistant-route-button', ' data-message-index="' + messageIndex + '" data-step-index="' + index + '" data-from-draft="' + !!isDraft + '" data-generation="' + esc(generation) + '"') + '</div>';
  }
  function resultCard(result, index, isCurrent, committed) {
    var action = isCurrent ? actionAt(index) : null, pending = !!action && action.status === 'pending';
    var label = committed || action && action.status === 'committed' ? '已办理' : isCurrent ? '待核对' : '历史草稿';
    return '<article class="assistant-draft-card' + (pending ? ' assistant-draft-pending' : '') + '" data-assistant-draft-index="' + index + '"><div class="assistant-draft-heading">' + (pending ? '' : '<span>' + esc(label) + '</span>') + '<h3>' + esc(resultTitle(result)) + '</h3></div><p>' + esc(resultSummary(result)) + '</p>' +
      (pending ? button('apply', (result.kind === 'form' ? '填写表单' : '核对草稿') + icon('arrow'), 'assistant-button assistant-draft-apply', ' data-step-index="' + index + '" data-turn-id="' + esc(draft.turnId) + '" data-generation="' + esc(generation) + '"' + (busy() ? ' disabled' : '')) : '') + '</article>';
  }
  function normalized(value) { return String(value || '').replace(/[\s\u200b，,。.!！?？：:；;·“”「」‘’'"+＋、()（）\-—]/g, ''); }
  function supplementalText(message, result) {
    if (!message.text) return '';
    var rows = parts(result), hasCard = rows.some(function (part) { return part.kind === 'action' || part.kind === 'form' || part.kind === 'route'; });
    if (!hasCard) return message.text;
    var known = normalized(rows.map(function (part) { return resultTitle(part) + resultSummary(part) + (part.question || '') + (part.answer || ''); }).join(''));
    var generated = normalized(rows.map(function (part) { return (part.title || '') + (part.answer || part.question || part.summary || part.reason || ''); }).join(''));
    var actual = normalized(message.text), content = actual.replace(/^(?:已(?:为你)?整理(?:好了)?(?:请核对)?|确认(?:本次)?(?:加分|保存|提醒|操作)?|请核对(?:后保存)?|草稿已整理)/, '');
    if (!content || actual === generated || known.indexOf(actual) >= 0 || known.indexOf(content) >= 0) return '';
    return message.text;
  }
  function currentDraftHTML() {
    var html = '<section class="assistant-current-draft" aria-label="当前草稿">';
    parts(draft.result).forEach(function (part, index) {
      if (part.kind === 'route') html += routeCard(part, -1, index, true);
      else if (part.kind === 'action' || part.kind === 'form') html += resultCard(part, index, true, false);
      else if (part.answer || part.question) html += '<p class="assistant-step-note">' + esc(part.answer || part.question) + '</p>';
    });
    return html + '</section>';
  }
  function sourceLabel(result) {
    result = result || {};
    if (result.source === 'fallback') return /超时/.test(result.label || '') ? 'AI 超时，使用本地' : 'AI 未完成，使用本地';
    if (result.source === 'model') return 'AI';
    if (result.source === 'local') return '本地';
    if (result.mode === 'connected') return 'AI';
    if (result.mode === 'local' || /本地/.test(result.label || '')) return '本地';
    return '';
  }
  function messageHTML(message, messageIndex) {
    var own = message.role === 'user', result = message.result, currentDraft = !own && draft && message.turnId === draft.turnId;
    var source = own ? '' : sourceLabel(result || currentDraft && draft.result);
    var html = '<article class="assistant-message' + (own ? ' assistant-message-user' : '') + (currentDraft ? ' assistant-message-current' : '') + '"><span class="assistant-sr-only">' + (own ? '你：' : '家长助手：') + '</span>' + (source ? '<span class="assistant-message-source">' + esc(source) + '</span>' : '') + '<div class="assistant-message-content">';
    var rows = parts(currentDraft ? draft.result : result);
    var hasCard = !own && rows.some(function (part) { return part.kind === 'action' || part.kind === 'form' || part.kind === 'route'; });
    var conversation = !own && rows.some(function (part) { return part.kind === 'answer' && part.scope === 'conversation'; });
    var content = own ? message.text : conversation ? '' : supplementalText(message, currentDraft ? draft.result : result);
    if (content) html += '<p class="assistant-message-text">' + esc(content) + '</p>';
    if (own && message.failed) html += '<span class="assistant-message-source">这条消息未完成</span>';
    if (currentDraft) html += currentDraftHTML();
    if (!own && result && !currentDraft) rows.forEach(function (part, index) {
      if (part.kind === 'route') html += routeCard(part, messageIndex, index, false);
      else if (part.kind === 'action' || part.kind === 'form') html += resultCard(part, index, false,
        !!message.committed || Array.isArray(message.committedIndexes) && message.committedIndexes.indexOf(index) >= 0);
      else if ((conversation || hasCard) && (part.answer || part.question)) html += '<p class="assistant-message-text">' + esc(part.answer || part.question) + '</p>';
    });
    return html + '</div></article>';
  }
  function hasTurn(turnId, role) { return messages.some(function (message) { return message.turnId === turnId && (!role || message.role === role); }); }
  function examples() {
    var prompts = [
      { icon: 'coins', label: '查积分', text: '我现在有多少积分？' },
      { icon: 'book', label: '建常用行为', text: '新建一个阅读的常用行为' },
      { icon: 'bell', label: '设提醒', text: '明天晚上八点提醒我阅读' }
    ];
    return '<div class="assistant-examples" role="group" aria-label="常用提问" hidden>' + prompts.map(function (prompt) {
      return button('example', icon(prompt.icon) + esc(prompt.label), 'assistant-example', ' data-prompt="' + esc(prompt.text) + '" title="' + esc(prompt.text) + '"');
    }).join('') + '</div>';
  }
  function renderConversation(toBottom) {
    if (!log) return;
    var oldTop = log.scrollTop, nearEnd = log.scrollHeight - log.clientHeight - oldTop < 80;
    var html = hasMore ? '<div class="assistant-history-tools">' + button('history', '查看更早对话', 'assistant-history-button', busy() ? ' disabled' : '') + '</div>' : '';
    html += messages.map(messageHTML).join('');
    if (pendingTurn && !hasTurn(pendingTurn.turnId)) html += '<article class="assistant-message assistant-message-user assistant-message-pending"><span class="assistant-sr-only">你：</span><div class="assistant-message-content"><p class="assistant-message-text">' + esc(pendingTurn.text) + '</p></div></article>';
    if (draft && draft.result && !messages.some(function (message) { return message.role === 'assistant' && message.turnId === draft.turnId; })) html += currentDraftHTML();
    var welcome = loaded && !html && !serverPending;
    box.classList.toggle('assistant-start', welcome);
    box.querySelector('.assistant-welcome').hidden = !welcome;
    box.querySelector('.assistant-examples').hidden = !welcome;
    log.hidden = welcome;
    log.innerHTML = html;
    if (toBottom || nearEnd) log.scrollTop = log.scrollHeight; else log.scrollTop = oldTop;
  }

  function updateControls() {
    if (!host) return;
    var sending = !!active && active.kind === 'turn' || !!serverPending, clearing = !!active && active.kind === 'clear';
    var status = voiceNote || (listening ? '正在听写，只会转成文字。' : clearing ? '正在清空对话…' : sending ? '正在整理，可以收起后再来看。' : active && active.kind === 'read' ? '正在同步对话…' : notice);
    doc.getElementById('assistant-chat-status').textContent = status;
    var context = contextLabel(), contextNode = doc.getElementById('assistant-panel-context');
    contextNode.textContent = context;
    contextNode.hidden = !context;
    doc.getElementById('assistant-chat-send').disabled = !loaded || !trim(text) || busy() || confirming || uncertainTurn();
    doc.getElementById('assistant-chat-send').setAttribute('aria-busy', String(sending));
    var clearButton = host.querySelector('[data-assistant-action="clear"]');
    clearButton.hidden = !(messages.length || draft || pendingTurn || serverPending || text || confirming);
    clearButton.disabled = !loaded || clearing;
    var microphone = host.querySelector('[data-assistant-action="voice"]');
    microphone.disabled = !SPEECH || clearing || confirming;
    microphone.setAttribute('aria-pressed', String(listening)); microphone.setAttribute('aria-label', listening ? '停止听写' : '听写成文字');
    microphone.title = SPEECH ? '听写成文字，核对后再发送' : '当前浏览器不支持听写，请输入文字';
    var count = doc.getElementById('assistant-chat-count');
    count.hidden = text.length < 1080;
    count.textContent = text.length + ' / 1200';
    doc.getElementById('assistant-chat-feedback').hidden = !error;
    doc.getElementById('assistant-chat-error').textContent = error;
    var retryButton = host.querySelector('[data-assistant-action="retry"]'); retryButton.hidden = !retry; retryButton.disabled = !!active;
    retryButton.textContent = retry === 'turn' ? '重试这条消息' : '重新同步';
    doc.getElementById('assistant-clear-confirm').hidden = !confirming;
    var applies = host.querySelectorAll('[data-assistant-action="apply"]');
    Array.prototype.forEach.call(applies, function (node) { node.disabled = busy() || confirming || !!pendingTurn || retry === 'read'; });
    var historyButton = host.querySelector('[data-assistant-action="history"]'); if (historyButton) historyButton.disabled = busy() || confirming;
  }
  function growInput() { if (!input) return; input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, Math.max(48, Math.min(144, (host.clientHeight || root.innerHeight) * 0.25))) + 'px'; }
  function fit() {
    frame = 0; if (!opened || !host) return;
    var viewport = root.visualViewport;
    if (viewport && Math.abs(viewport.scale - 1) >= 0.01) return;
    var height = viewport ? viewport.height : root.innerHeight, width = viewport ? viewport.width : root.innerWidth;
    host.style.top = Math.max(0, viewport ? viewport.offsetTop : 0) + 'px'; host.style.left = Math.max(0, viewport ? viewport.offsetLeft : 0) + 'px';
    host.style.width = Math.max(1, width) + 'px'; host.style.height = Math.max(1, height) + 'px';
    host.classList.toggle('assistant-viewport-short', height < 420); growInput();
  }
  function scheduleFit() { if (opened && !frame) frame = root.requestAnimationFrame(fit); }
  function cancelActive() {
    var previous = active; active = null; sequence++;
    if (!previous) return;
    root.clearTimeout(previous.timer); if (previous.handle && previous.handle.abort) { try { previous.handle.abort(); } catch (e) {} }
  }
  function stopPoll() { if (poll) root.clearTimeout(poll); poll = 0; }
  function scheduleRead() { stopPoll(); if (serverPending && current()) poll = root.setTimeout(function () { poll = 0; if (current() && !active) read(true); }, 1600); }
  function operation(kind, body, done) {
    cancelActive(); stopPoll();
    var task = { kind: kind, epoch: epoch, scope: scope, id: ++sequence, timer: 0, handle: null }; active = task;
    function finish(status, result) {
      if (active !== task || task.epoch !== epoch) return;
      root.clearTimeout(task.timer); active = null;
      if (task.scope !== scopeKey()) { reset(); return; }
      if (!current()) { close({ restoreFocus: false }); return; }
      done(status, result || {}); updateControls();
    }
    task.timer = root.setTimeout(function () { var handle = task.handle; finish(0, {}); if (handle && handle.abort) { try { handle.abort(); } catch (e) {} } }, 45000);
    updateControls();
    try { task.handle = config.request('POST', '/api/assistant/chat/' + kind, body, finish); }
    catch (e) { finish(0, {}); }
  }
  function snapshotOf(result) { var value = result && (result.snapshot || result); return value && typeof value.generation === 'string' && Array.isArray(value.messages) ? value : null; }
  function messageKey(message) { return message.role + ':' + (message.turnId || message.id || message.text); }
  function mergeMessages(older, newer) {
    var seen = {}; newer.forEach(function (message) { seen[messageKey(message)] = true; });
    return older.filter(function (message) { return !seen[messageKey(message)]; }).concat(newer);
  }
  function accept(snapshot, earlier, cleared) {
    var previousGeneration = generation, changed = generation !== snapshot.generation, wasLoaded = loaded, top = log.scrollTop, height = log.scrollHeight;
    if (generation && changed) { pendingTurn = null; text = ''; input.value = ''; }
    if (changed) historyExpanded = false;
    generation = snapshot.generation;
    messages = changed || !loaded ? copy(snapshot.messages) : earlier ? mergeMessages(copy(snapshot.messages), messages) : mergeMessages(messages, copy(snapshot.messages)); loaded = true;
    if (earlier || !historyExpanded) { hasMore = !!snapshot.hasMore; nextCursor = snapshot.nextCursor || null; }
    if (earlier) historyExpanded = true;
    draft = snapshot.draft && snapshot.draft.generation === generation ? copy(snapshot.draft) : null;
    serverPending = snapshot.pending ? copy(snapshot.pending) : null;
    if (!earlier) {
      var saved = snapshot.retryTurn;
      if (failedTurnId && pendingTurn && pendingTurn.turnId === failedTurnId) pendingTurn = null;
      failedTurnId = '';
      if (saved && saved.generation === generation && !serverPending && !hasTurn(saved.turnId, 'assistant')) {
        pendingTurn = copy(saved); failedTurnId = saved.turnId;
      }
    }
    if (pendingTurn && (pendingTurn.generation !== generation || hasTurn(pendingTurn.turnId, 'assistant'))) pendingTurn = null;
    error = ''; retry = '';
    if (pendingTurn && !serverPending) { error = failedTurnId ? '这条消息未完成，可以重试，也可以发送新消息。' : '这条消息的结果还未确认，可以重试。'; retry = 'turn'; }
    renderConversation(!wasLoaded); if (earlier) log.scrollTop = top + log.scrollHeight - height;
    scheduleRead(); growInput();
    if (previousGeneration && (changed || cleared) && typeof config.onCleared === 'function') config.onCleared(previousGeneration);
  }
  function failed(status, result, kind) {
    var snapshot = snapshotOf(result);
    if (snapshot && status === 409 && result.code !== 'ASSISTANT_CHAT_BUSY') {
      pendingTurn = null; accept(snapshot); notice = result.code === 'ASSISTANT_DRAFT_STALE' ? '这份草稿已变化，请核对最新内容。' : '对话已更新，已同步最新内容。'; renderConversation(true); return;
    }
    if (snapshot) accept(snapshot);
    error = status === 0 ? '连接未完成，消息会保留，可以重试。' : result.code === 'ASSISTANT_CHAT_BUSY' ? '另一条消息正在整理，稍后可以重试。' : status === 401 ? '请重新登录后再打开助手。' : status === 429 ? '消息发得有点快，请稍后再试。' : status >= 500 ? '助手暂时没有回应，可以稍后重试。' : '这次没有完成，请重试。';
    retry = kind === 'turn' && pendingTurn ? 'turn' : 'read'; notice = ''; renderConversation(false);
  }
  function read(quiet) {
    if (!current() || active) return;
    if (!quiet) { notice = ''; error = ''; retry = ''; }
    operation('read', generation ? { generation: generation } : {}, function (status, result) {
      var snapshot = snapshotOf(result);
      if (status === 200 && snapshot) { accept(snapshot); if (!pendingTurn && !serverPending) notice = ''; }
      else failed(status, result, 'read');
    });
  }
  function readEarlier() {
    if (!current() || busy() || !hasMore || !nextCursor) return;
    error = ''; retry = '';
    operation('read', { generation: generation, cursor: nextCursor }, function (status, result) {
      var snapshot = snapshotOf(result);
      if (status === 200 && snapshot && snapshot.generation === generation) accept(snapshot, true);
      else failed(status, result, 'read');
    });
  }
  function uuid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    var bytes = new Uint8Array(16); if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(bytes); else for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    var hex = Array.prototype.map.call(bytes, function (value) { return ('0' + value.toString(16)).slice(-2); }).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }
  function sendTurn(turn) {
    error = ''; retry = ''; notice = ''; voiceNote = ''; failedTurnId = ''; pendingTurn = turn; draft = null;
    operation('turn', { generation: turn.generation, turnId: turn.turnId, text: turn.text, context: turn.context }, function (status, result) {
      var snapshot = snapshotOf(result);
      if (status === 200 && snapshot) accept(snapshot); else failed(status, result, 'turn');
    });
    renderConversation(true);
  }
  function uncertainTurn() { return pendingTurn && pendingTurn.turnId !== failedTurnId && retry === 'turn'; }
  function send() {
    if (!current() || !loaded || busy() || confirming || !trim(text) || uncertainTurn()) return;
    stopVoice();
    var turn;
    try { turn = { generation: generation, turnId: uuid(), text: trim(text), context: contextValue() }; }
    catch (e) { error = '页面信息暂时不可用，请收起后重新打开助手。'; updateControls(); return; }
    text = ''; input.value = ''; growInput(); sendTurn(turn);
  }
  function clearConversation() {
    if (!current() || !loaded) return;
    confirming = false; stopVoice(); notice = ''; error = ''; retry = '';
    operation('clear', { generation: generation }, function (status, result) {
      var snapshot = snapshotOf(result);
      if (status === 200 && snapshot) { pendingTurn = null; text = ''; input.value = ''; accept(snapshot, false, true); notice = '对话已清空。'; focus(box); }
      else failed(status, result, 'clear');
    });
  }

  function stopVoice() {
    voiceEpoch++; var previous = voice; voice = null; listening = false;
    if (previous) { previous.onresult = previous.onerror = previous.onend = null; try { previous.abort(); } catch (e) {} }
  }
  function startVoice() {
    if (!current() || !SPEECH || confirming) return;
    if (voice) { try { voice.stop(); } catch (e) { stopVoice(); } listening = false; voiceNote = '正在整理听写…'; updateControls(); return; }
    var recognition, token = ++voiceEpoch, base = text, voiceScope = scope, heard = false;
    try { recognition = new SPEECH(); } catch (e) { voiceNote = '当前无法听写，可以继续打字。'; updateControls(); return; }
    voice = recognition; listening = true; voiceNote = ''; recognition.lang = 'zh-CN'; recognition.interimResults = true; recognition.continuous = false;
    function valid() { return voice === recognition && token === voiceEpoch && voiceScope === scopeKey() && current(); }
    recognition.onresult = function (event) {
      if (!valid()) return;
      var words = ''; for (var i = 0; i < event.results.length; i++) if (event.results[i][0]) words += event.results[i][0].transcript || '';
      if (!words) return;
      heard = true; text = ((base ? base + '\n' : '') + words).slice(0, 1200); input.value = text; growInput(); updateControls();
    };
    recognition.onerror = function (event) {
      if (!valid()) return;
      listening = false; voiceNote = event.error === 'not-allowed' || event.error === 'service-not-allowed' ? '听写未获授权，可以继续打字。' : event.error === 'no-speech' ? '没有听清，再试一次或输入文字。' : '听写未完成，可以继续打字或再试。'; updateControls();
    };
    recognition.onend = function () {
      if (!valid()) return;
      voice = null; listening = false; if (!voiceNote || voiceNote === '正在整理听写…') voiceNote = heard ? '听写已放入输入框，核对后再发送。' : '没有听清，再试一次或输入文字。'; updateControls();
    };
    try { recognition.start(); } catch (e) { stopVoice(); voiceNote = '当前无法听写，可以继续打字。'; }
    updateControls();
  }
  function typed() { if (voice) stopVoice(); text = input.value.slice(0, 1200); voiceNote = ''; notice = ''; growInput(); updateControls(); }
  function submitted(event) { event.preventDefault(); event.stopPropagation(); if (event.target.id === 'assistant-chat-form') send(); }
  function showConfirmation(show) { confirming = show; stopVoice(); voiceNote = ''; updateControls(); focus(show ? host.querySelector('[data-assistant-action="cancel-clear"]') : host.querySelector('[data-assistant-action="clear"]')); }
  function handoff(node, isRoute) {
    if (!current() || applying || confirming || node.disabled || node.getAttribute('data-generation') !== generation) return;
    var index = Number(node.getAttribute('data-step-index')), fromDraft = !isRoute || node.getAttribute('data-from-draft') === 'true';
    var result = fromDraft ? draft && parts(draft.result)[index] : parts((messages[Number(node.getAttribute('data-message-index'))] || {}).result)[index];
    var action = fromDraft ? actionAt(index) : null, meta = { generation: generation, index: index, readOnly: !!isRoute };
    if (!result || typeof config.applyResult !== 'function') return;
    if (!isRoute && (busy() || pendingTurn || retry === 'read' || !action || action.status !== 'pending' || node.getAttribute('data-turn-id') !== draft.turnId)) return;
    if (fromDraft) { meta.draft = copy(draft); meta.turnId = draft.turnId; if (action) meta.actionId = action.actionId; }
    result = copy(result); applying = true; close({ restoreFocus: false, reason: 'apply' });
    try { config.applyResult(result, meta); } finally { applying = false; }
  }
  function clicked(event) {
    event.stopPropagation(); var node = event.target;
    while (node && node !== host && !node.getAttribute('data-assistant-action')) node = node.parentNode;
    if (!node || node === host || !current() || node.disabled) return;
    var action = node.getAttribute('data-assistant-action');
    if (confirming && action !== 'cancel-clear' && action !== 'confirm-clear') return;
    if (action === 'close') close();
    else if (action === 'clear') showConfirmation(true);
    else if (action === 'cancel-clear') showConfirmation(false);
    else if (action === 'confirm-clear') clearConversation();
    else if (action === 'voice') startVoice();
    else if (action === 'history') readEarlier();
    else if (action === 'example') { stopVoice(); text = node.getAttribute('data-prompt') || ''; input.value = text; voiceNote = ''; notice = '已放进输入框，核对后再发送。'; growInput(); updateControls(); }
    else if (action === 'retry' && !active) { if (retry === 'turn' && pendingTurn && pendingTurn.generation === generation) sendTurn(pendingTurn); else read(false); }
    else if (action === 'apply' || action === 'route') handoff(node, action === 'route');
  }
  function focusables() {
    var container = confirming ? doc.getElementById('assistant-clear-confirm') : box;
    return Array.prototype.filter.call(container.querySelectorAll('button:not([disabled]),textarea:not([disabled]),[tabindex="0"]'), visible);
  }
  function focusin(event) { if (opened && current() && !box.contains(event.target)) focus(confirming ? host.querySelector('[data-assistant-action="cancel-clear"]') : box); }
  function keydown(event) {
    if (!opened) return;
    if (!current()) { close({ restoreFocus: false }); return; }
    if (event.key === 'Escape') {
      event.stopImmediatePropagation(); if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault(); if (confirming) showConfirmation(false); else close(); return;
    }
    if (event.key === 'Tab') {
      event.stopImmediatePropagation(); var nodes = focusables(), first = nodes[0], last = nodes[nodes.length - 1];
      if (!nodes.length) { event.preventDefault(); focus(box); }
      else if (!box.contains(doc.activeElement) || doc.activeElement === box || event.shiftKey && doc.activeElement === first || !event.shiftKey && doc.activeElement === last) { event.preventDefault(); focus(event.shiftKey ? last : first); }
    }
    if (event.target === input && event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopImmediatePropagation(); send(); }
  }
  function resumed() { if (opened && !doc.hidden) { if (!current()) close({ restoreFocus: false }); else if (!active) read(true); } }

  function init(options) { if (host) reset(); config = options || {}; build(); updateControls(); return api; }
  function open(options) {
    options = options || {}; if (!allowed() || typeof config.request !== 'function') return false;
    build(); if (opened && scope !== scopeKey()) reset();
    if (opened) { fit(); updateControls(); focus(box); if (!active) read(false); return true; }
    opener = options.trigger || doc.activeElement; hasOpeningContext = Object.prototype.hasOwnProperty.call(options, 'context'); openingContext = options.context;
    scope = scopeKey(); opened = true; host.hidden = false; doc.body.classList.add('assistant-panel-open');
    if (typeof config.onOpen === 'function') config.onOpen();
    input.value = text; fit(); updateControls(); focus(box); if (!active) read(false); return true;
  }
  function restore(node, savedScope, savedEpoch) {
    root.requestAnimationFrame(function () {
      if (opened || epoch !== savedEpoch || scopeKey() !== savedScope || !allowed()) return;
      if (typeof config.restoreFocus === 'function') config.restoreFocus(node);
      else if (visible(node)) focus(node);
    });
  }
  function close(options) {
    options = options || {}; if (!opened) return;
    var saved = opener, savedScope = scope; opened = false; epoch++; cancelActive(); stopPoll(); stopVoice(); confirming = false; voiceNote = '';
    host.hidden = true; doc.body.classList.remove('assistant-panel-open'); if (frame) root.cancelAnimationFrame(frame); frame = 0;
    if (typeof config.onClose === 'function') config.onClose({ reason: options.reason || 'close', restoreFocus: options.restoreFocus !== false });
    if (options.restoreFocus !== false) restore(saved, savedScope, epoch);
  }
  function reset() {
    close({ restoreFocus: false, reason: 'reset' }); epoch++; cancelActive(); stopPoll(); stopVoice();
    generation = ''; messages = []; draft = null; serverPending = null; pendingTurn = null; failedTurnId = ''; loaded = false;
    hasMore = false; nextCursor = null; historyExpanded = false;
    text = ''; notice = ''; error = ''; retry = ''; confirming = false; opener = null; openingContext = null; hasOpeningContext = false; scope = ''; voiceNote = '';
    if (input) input.value = ''; renderConversation(false); updateControls();
  }
  function getState() { return { open: opened, loaded: loaded, busy: busy(), generation: generation, messageCount: messages.length, draft: copy(draft), pendingTurnId: pendingTurn ? pendingTurn.turnId : '', listening: listening, confirming: confirming, hasMore: hasMore, error: error }; }
  var api = { init: init, mount: init, open: open, close: close, reset: reset, isOpen: function () { return opened; }, refresh: function () { read(false); }, read: function () { read(false); }, getState: getState };
  root.FamilyAssistantPanel = api;
}(typeof window !== 'undefined' ? window : this));
