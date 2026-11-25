/* v0.14 account boundary and in-memory session-verified resume. ES5. */
(function (root) {
  'use strict';
  if (root.__TTJF_SAAS__ !== true) return;
  var epoch = 0, user = null, families = [], family = null, csrf = '', ready = false;
  var requests = [], disposers = [], hooks = null, started = false, checking = false, suspended = false, probing = false;
  var view = 'checking', message = '', busy = false, form = {}, members = [], invitations = [], confirmation = null;
  var fragment = null, resume = null, createId = '', channel = null, lastSignal = '', logoutLock = false, logoutId = '', settledLogouts = [];
  var SIGNAL = 'ttjf-saas-auth-change-v1';
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function uid() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2); }
  function capture() { return { epoch: epoch, userId: user ? user.id : null, familyId: family ? family.id : null }; }
  function current(token) { return !!token && token.epoch === epoch && token.userId === (user ? user.id : null) && token.familyId === (family ? family.id : null); }
  function owns(result) { return !!user && !!family && result && result.userId === user.id && result.familyId === family.id; }
  function track(dispose) {
    var token = capture(), entry = { dispose: dispose, token: token }; disposers.push(entry);
    return function () { var index = disposers.indexOf(entry); if (index >= 0) disposers.splice(index, 1); };
  }
  function boundary(clearAccount, keepResume) {
    // Invalidate first: abort/release can synchronously invoke an old callback.
    epoch++; ready = false; checking = false; probing = false; busy = false;
    if (!keepResume) resume = null;
    var old = requests; requests = [];
    old.forEach(function (x) { try { x.abort(); } catch (e) {} });
    old = disposers; disposers = [];
    old.forEach(function (entry) { try { entry.dispose(); } catch (e) {} });
    if (hooks) hooks.clear(!!keepResume);
    form = {}; members = []; invitations = []; confirmation = null; createId = ''; message = '';
    if (clearAccount) { user = null; families = []; family = null; csrf = ''; }
  }
  function errorText(status, result) {
    var labels = { INVALID_CREDENTIALS: '邮箱或密码不正确', EMAIL_UNVERIFIED: '邮箱待验证', RATE_LIMITED: '操作频繁 · 稍后再试', OWNER_REQUIRED: '仅家庭所有者可操作', FAMILY_FORBIDDEN: '家庭权限已变更', TOKEN_INVALID: '链接无效', TOKEN_EXPIRED: '链接已过期', INVITATION_INVALID: '邀请无效或邮箱不符', AUTH_REQUIRED: '请重新登录', PASSWORD_INVALID: '当前密码不正确', VALIDATION_ERROR: '请检查输入格式', EMAIL_INVALID: '邮箱格式无效', INVALID_EMAIL: '邮箱格式无效', INVALID_PASSWORD: '密码 · 10–128位', PASSWORD_MISMATCH: '当前密码不正确', CURRENT_PASSWORD_INVALID: '当前密码不正确', REQUEST_ID_REUSED: '提交信息已变更', OWNER_MUST_TRANSFER: '请先移交所有权', ACCOUNT_OWNS_FAMILIES: '仍有家庭未移交或删除', CONFIRMATION_MISMATCH: '确认内容不一致', TRANSFER_TARGET_INVALID: '所选成员不可接收' };
    return labels[result && result.code] || (status === 0 ? '连接未完成 · 可重试' : status === 409 ? '信息已更新 · 请重试' : status >= 500 ? '服务暂不可用' : '操作未完成');
  }
  function request(method, url, data, done, options) {
    options = options || {};
    if (options.business && (!user || !user.verified || !family)) return null;
    var token = capture(), x = new XMLHttpRequest(), settled = false;
    function finish(status, result) {
      if (settled) return; settled = true;
      var index = requests.indexOf(x); if (index >= 0) requests.splice(index, 1);
      if (!current(token)) return;
      result = result || {};
      // Expired sessions have no user identity to echo. Never process an old 401.
      if (!options.auth && (status === 401 || (status === 403 && /^(FAMILY_FORBIDDEN|EMAIL_UNVERIFIED|CSRF_INVALID)$/.test(result.code || '')))) {
        var preferred = family && user ? { userId: user.id, familyId: family.id } : null;
        boundary(true); checkSession(status === 401 ? '请重新登录' : errorText(status, result), preferred); return;
      }
      if (options.business && status !== 0 && !owns(result)) {
        // A proxy may reject a photo before the request reaches the family API.
        // Keep the draft and discard the unscoped response body.
        if ((url === '/api/award-photos' || url === '/api/award-photos/read') &&
            (status === 413 || status >= 500) && !result.userId && !result.familyId) {
          done(status, {}); return;
        }
        boundary(true); view = 'error'; message = '家庭校验未完成'; render(); return;
      }
      done(status, result || {});
    }
    x.open(method, url, true); x.timeout = url === '/api/assistant' || url === '/api/assistant/chat/turn' ? 20000 : 10000;
    x.setRequestHeader('Accept', 'application/json');
    if (family) x.setRequestHeader('X-Family-ID', family.id);
    if (method !== 'GET' && csrf) x.setRequestHeader('X-CSRF-Token', csrf);
    if (data != null) x.setRequestHeader('Content-Type', 'application/json');
    x.onload = function () { var result; try { result = JSON.parse(x.responseText); } catch (e) { result = {}; } finish(x.status, result); };
    x.onerror = x.ontimeout = function () { finish(0, {}); };
    x.onabort = function () { settled = true; };
    requests.push(x);
    try { x.send(data == null ? null : JSON.stringify(data)); } catch (e) { finish(0, {}); }
    return x;
  }
  function signal(kind, operation) {
    var value = kind ? kind + ':' + operation : uid(); lastSignal = value;
    try { root.localStorage.setItem(SIGNAL, value); } catch (e) {}
    if (channel) { try { channel.postMessage(value); } catch (e) {} }
  }
  function rememberLogout(operation) { settledLogouts.push(operation); if (settledLogouts.length > 32) settledLogouts.shift(); }
  function lockLogout(operation, failed) {
    boundary(true); logoutLock = true; logoutId = operation;
    family = null; fragment = null; resume = null; suspended = !!document.hidden;
    view = failed ? 'logout-error' : 'logout-wait'; message = failed ? '退出结果待确认' : ''; render();
  }
  function changed(value) {
    if (!started || typeof value !== 'string' || !value || value === lastSignal) return;
    lastSignal = value;
    var event = /^(logout-start|logout-settled|logout-failed):(.+)$/.exec(value);
    if (event) {
      if (settledLogouts.indexOf(event[2]) >= 0) return;
      if (event[1] === 'logout-start') {
        // Both tabs choose the same winning operation; one logout request stays alive.
        if (logoutLock) {
          if (event[2] <= logoutId) { if (event[2] !== logoutId) rememberLogout(event[2]); return; }
          rememberLogout(logoutId);
        }
        lockLogout(event[2], false);
        return;
      }
      if (logoutLock && logoutId !== event[2]) return;
      if (event[1] === 'logout-failed') { lockLogout(event[2], true); return; }
      rememberLogout(event[2]); logoutLock = false; logoutId = ''; boundary(true); suspended = !!document.hidden; view = 'checking'; render();
      if (!document.hidden) checkSession('账号状态已更新', null);
      return;
    }
    if (logoutLock) return;
    if (!suspended) hide();
    if (!document.hidden) { checking = false; checkSession('账号状态已更新'); }
  }
  function readFragment() {
    var match = /^#(verify|reset|invite)=([^&]+)$/.exec(root.location.hash || '');
    if (!match) return false;
    var token = ''; try { token = decodeURIComponent(match[2]); } catch (e) {}
    fragment = token && token.length <= 2048 ? { kind: match[1], token: token } : null;
    try { root.history.replaceState(null, '', root.location.pathname + root.location.search); } catch (e) { root.location.hash = ''; }
    return true;
  }
  function chosen(id) { for (var i = 0; i < families.length; i++) if (families[i].id === id) return families[i]; return null; }
  function sameSession(result, saved) {
    if (!saved) return false;
    if (!saved.userId) return !result.authenticated;
    if (!result.authenticated || !result.user || result.user.id !== saved.userId || result.csrfToken !== saved.csrf || !!result.user.verified !== saved.verified) return false;
    if (!saved.familyId) return true;
    var rows = result.families || [];
    for (var i = 0; i < rows.length; i++) if (rows[i].id === saved.familyId) return rows[i].role === saved.role;
    return false;
  }
  function adoptSession(result, preferred, saved) {
    if (saved && !sameSession(result, saved)) { boundary(true); saved = null; }
    if (!result.authenticated || !result.user || !result.csrfToken) {
      user = null; families = []; csrf = ''; family = null;
      view = fragment && (fragment.kind === 'verify' || fragment.kind === 'reset') ? fragment.kind : 'login';
      if (saved && ['login', 'register', 'forgot', 'pending', 'reset', 'verify'].indexOf(saved.view) >= 0) { view = saved.view; form = saved.form; }
      resume = null; render(); return;
    }
    user = result.user; csrf = result.csrfToken; families = Array.isArray(result.families) ? result.families : []; family = null;
    if (saved) {
      family = saved.familyId ? chosen(saved.familyId) : null;
      if (saved.view === 'business' && family && user.verified) { enterFamily(family.id, saved); return; }
      if (saved.view !== 'checking' && saved.view !== 'loading-family') {
        view = saved.view; form = saved.form; createId = saved.createId; resume = null;
        if (view === 'members' || view === 'transfer-owner') { listMembers(view); return; }
        if (['confirm', 'logout', 'logout-error'].indexOf(view) >= 0) view = 'account';
        render(); return;
      }
    }
    resume = null;
    if (fragment && fragment.kind !== 'invite') { view = fragment.kind; render(); return; }
    if (!user.verified) { view = 'unverified'; render(); return; }
    if (fragment && fragment.kind === 'invite') { view = 'invite'; render(); return; }
    var target = preferred && preferred.userId === user.id && chosen(preferred.familyId);
    if (target) enterFamily(target.id);
    else if (families.length === 1) enterFamily(families[0].id);
    else { view = families.length ? 'families' : 'onboarding'; render(); }
  }
  function checkSession(note, preferred) {
    if (checking || logoutLock) return;
    var saved = resume;
    if (preferred === undefined) preferred = family && user ? { userId: user.id, familyId: family.id } : saved;
    boundary(true, !!saved); suspended = false; view = 'checking'; message = note || ''; checking = true; render();
    request('GET', '/api/session', null, function (status, result) {
      checking = false;
      if (status !== 200) { view = 'error'; message = errorText(status, result); render(); return; }
      adoptSession(result, preferred, saved);
    }, { auth: true });
  }
  function enterFamily(id, saved) {
    var next = chosen(id); if (logoutLock || !next || !user || !user.verified) return;
    boundary(false, !!saved); family = next; view = 'loading-family'; render();
    request('GET', '/api/state', null, function (status, result) {
      if (status !== 200 || !result.state || !Array.isArray(result.state.tasks) || typeof result.revision !== 'number') { view = 'family-error'; message = errorText(status || 0, result); render(); return; }
      ready = true; view = 'business'; message = ''; resume = null;
      if (hooks) hooks.enter(result, saved && saved.business);
    }, { business: true });
  }
  function probeSession() {
    if (!started || logoutLock || checking || probing || document.hidden || suspended || !user) return;
    probing = true;
    var expected = { userId: user.id, csrf: csrf, verified: !!user.verified, familyId: family && family.id, role: family && family.role };
    request('GET', '/api/session', null, function (status, result) {
      probing = false;
      if (status !== 200) { hide(); view = 'error'; message = errorText(status, result); render(); return; }
      if (!sameSession(result, expected)) { boundary(true); suspended = false; adoptSession(result); return; }
      user = result.user; families = result.families || []; if (family) family = chosen(family.id);
      if (ready && hooks && hooks.refresh) hooks.refresh();
    }, { auth: true });
  }
  function screen(next, note) { view = next; message = note || ''; confirmation = null; render(); }
  function leaveBusiness(next) { boundary(false); view = next; render(); }
  function openSettings() { if (ready) leaveBusiness('account'); }
  function logout() {
    if (busy) return;
    var refresh = logoutLock || !csrf, operation = uid(), credential = csrf;
    if (logoutLock) { if (operation <= logoutId) operation = logoutId + '-' + operation; rememberLogout(logoutId); }
    boundary(true); csrf = credential; logoutLock = true; logoutId = operation;
    family = null; fragment = null; resume = null; view = 'logout'; busy = true; render(); signal('logout-start', operation);
    function finish(status, result) {
      busy = false;
      if ((status >= 200 && status < 300) || status === 401) {
        rememberLogout(operation); logoutLock = false; logoutId = ''; boundary(true); view = 'login'; message = '已退出'; signal('logout-settled', operation);
      } else { view = 'logout-error'; message = errorText(status, result); signal('logout-failed', operation); }
      render();
    }
    function send() { request('POST', '/api/auth/logout', {}, finish, { auth: true }); }
    // A retry after hiding/reloading may no longer have a CSRF token. Read only
    // the current session credential here; never adopt or render its private state.
    if (refresh) request('GET', '/api/session', null, function (status, result) {
      if (status !== 200) { finish(status === 401 ? 401 : 0, result); return; }
      if (result.authenticated === false) { finish(200, result); return; }
      if (result.authenticated !== true || !result.user || !result.csrfToken) { finish(0, result); return; }
      csrf = result.csrfToken; send();
    }, { auth: true });
    else send();
  }
  function submitRequest(url, data, success, method) {
    if (busy) return; busy = true; message = ''; render();
    request(method || 'POST', url, data, function (status, result) {
      busy = false;
      if (status >= 200 && status < 300) success(result);
      else { message = errorText(status, result); render(); }
    }, { auth: url.indexOf('/api/auth/') === 0 && url !== '/api/auth/change-password' && url !== '/api/auth/delete-account' });
  }
  function listMembers(nextView) {
    if (!family) { screen('families'); return; }
    screen(nextView || 'members'); busy = true; render();
    var path = '/api/families/' + encodeURIComponent(family.id);
    request('GET', path + '/members', null, function (status, result) {
      busy = false;
      if (status !== 200) { message = errorText(status, result); render(); return; }
      members = result.members || []; render();
      if (family.role === 'owner') request('GET', path + '/invitations', null, function (code, body) {
        if (code === 200) invitations = body.invitations || []; else message = errorText(code, body);
        if (view === 'members') render();
      });
    });
  }
  function tokenFrom(value) { var match = /#invite=([^&\s]+)/.exec(value); if (match) { try { return decodeURIComponent(match[1]); } catch (e) { return ''; } } return value.trim(); }
  function button(action, text, primary, id) { return '<button type="button" class="btn ' + (primary ? 'primary' : 'outline') + '" data-saas="' + action + '"' + (id != null ? ' data-id="' + esc(id) + '"' : '') + (busy ? ' disabled' : '') + '>' + esc(text) + '</button>'; }
  function field(label, name, type, value, extra) { return '<label class="field" for="saas-' + name + '"><span>' + label + '</span><input id="saas-' + name + '" name="' + name + '" type="' + type + '" value="' + esc(value || '') + '" ' + (extra || '') + (busy ? ' disabled' : '') + '></label>'; }
  function email() { return field('邮箱', 'email', 'email', form.email || (view === 'unverified' && user ? user.email : ''), 'required maxlength="254" autocomplete="email" autocapitalize="none" spellcheck="false" inputmode="email"'); }
  function password(label, name, existing) { return field(label, name, 'password', '', 'required maxlength="128"' + (existing ? '' : ' minlength="10"') + ' autocomplete="' + (existing ? 'current-password' : 'new-password') + '"'); }
  function formMarkup(kind, body, title) { return '<form id="saas-form" data-saas-form="' + kind + '" novalidate>' + body + '<button type="submit" class="btn primary full" aria-busy="' + busy + '"' + (busy ? ' disabled' : '') + '>' + (busy ? '处理中' : title) + '</button></form>'; }
  function back() { return button('back', family ? '返回账号' : user ? '返回家庭' : '返回登录'); }
  function memberMarkup() {
    var owner = family && family.role === 'owner';
    return '<ul class="saas-list">' + members.map(function (m) { return '<li><div><strong>' + esc(m.email) + '</strong><small>' + (m.role === 'owner' ? '所有者' : '家长') + (user && m.userId === user.id ? ' · 我' : '') + '</small></div>' + (owner && m.role === 'parent' && m.userId !== user.id ? button('remove-member', '移除', false, m.userId) : '') + '</li>'; }).join('') + '</ul>' + (owner ? '<h2>邀请家长</h2>' + formMarkup('invitation', email(), '发送邀请') + '<ul class="saas-list">' + invitations.map(function (inv) { return '<li><div><strong>' + esc(inv.email) + '</strong><small>' + esc({ pending: '待接受', accepted: '已接受', revoked: '已撤销', expired: '已过期' }[inv.status] || inv.status || '待接受') + '</small></div>' + (!inv.status || inv.status === 'pending' ? button('revoke-invite', '撤销', false, inv.id) : '') + '</li>'; }).join('') + '</ul>' : '') + '<div class="saas-actions">' + button('members', '刷新') + back() + '</div>';
  }
  function render() {
    if (!started || view === 'business') return;
    var app = document.getElementById('app'); if (!app) return;
    var active = document.activeElement, focusId = active && active.id, start = active && active.selectionStart, end = active && active.selectionEnd;
    var oldMain = document.getElementById('main'), scroll = oldMain ? oldMain.scrollTop : 0;
    var title = '小小向前', body = '', footer = '';
    if (view === 'checking' || view === 'loading-family' || view === 'logout') { title = view === 'logout' ? '退出中' : '连接中'; }
    else if (view === 'error') { title = '连接未完成'; body = button('retry-session', '重试', true); }
    else if (view === 'family-error') { title = '家庭加载未完成'; body = button('retry-family', '重试', true) + button('families', '选择家庭') + button('logout', '退出登录'); }
    else if (view === 'logout-error' || view === 'logout-wait') { title = view === 'logout-wait' ? '退出处理中' : '退出未完成'; body = button('logout', '重试退出', true); }
    else if (view === 'login') {
      title = '登录'; body = formMarkup('login', email() + password('密码', 'password', true), '登录');
      footer = button('register', '注册账号') + button('forgot', '忘记密码') + (fragment && fragment.kind === 'invite' ? '<p class="saas-short-status">登录后接受邀请</p>' : '');
    } else if (view === 'register') { title = '注册'; body = formMarkup('register', email() + password('密码 · 10–128位', 'password') + password('确认密码', 'confirmPassword'), '注册'); footer = button('login', '返回登录'); }
    else if (view === 'pending' || view === 'unverified') {
      title = '邮箱待验证'; body = '<p class="saas-identity">' + esc(user ? user.email : form.email) + '</p>' + button('resend', '重发验证邮件', true) + button('retry-session', '已验证 · 刷新');
      footer = user ? button('delete-account', '删除账号') + button('logout', '退出登录') : button('login', '返回登录');
    } else if (view === 'forgot') { title = '找回密码'; body = formMarkup('forgot', email(), '发送重置邮件'); footer = button('login', '返回登录'); }
    else if (view === 'verify') { title = '验证邮箱'; body = button('verify', '确认验证', true); footer = button(user ? 'account' : 'login', user ? '返回账号' : '返回登录'); }
    else if (view === 'reset') { title = '重置密码'; body = formMarkup('reset', password('新密码 · 10–128位', 'password') + password('确认密码', 'confirmPassword'), '确认重置'); footer = button('login', '返回登录'); }
    else if (view === 'invite') { title = '接受家庭邀请'; body = '<p class="saas-identity">' + esc(user.email) + '</p>' + button('accept-invite', '加入家庭', true); footer = button('dismiss-invite', '暂不加入') + button('logout', '退出登录'); }
    else if (view === 'onboarding' || view === 'families') {
      title = families.length ? '选择家庭' : '我的家庭';
      body = '<ul class="saas-list">' + families.map(function (f) { return '<li><div><strong>' + esc(f.name) + '</strong><small>' + (f.role === 'owner' ? '所有者' : '家长') + '</small></div>' + button('select-family', family && family.id === f.id ? '返回家庭' : '进入', true, f.id) + '</li>'; }).join('') + '</ul><div class="saas-actions">' + button('create', '创建家庭', !families.length) + button('join', '加入家庭') + '</div>';
      footer = family ? button('account', '返回账号') : button('account', '账号设置') + button('logout', '退出登录');
    } else if (view === 'create') { title = '创建家庭'; body = formMarkup('create', field('家庭名称', 'name', 'text', form.name, 'required maxlength="80" autocomplete="off"') + field('孩子称呼', 'childName', 'text', form.childName, 'required maxlength="40" autocomplete="off"'), '创建'); footer = back(); }
    else if (view === 'join') { title = '加入家庭'; body = formMarkup('join', field('邀请链接', 'invite', 'text', form.invite, 'required maxlength="2048" autocomplete="off" autocapitalize="none" spellcheck="false"'), '加入'); footer = back(); }
    else if (view === 'account') {
      title = '账号与家庭'; body = '<p class="saas-identity">' + esc(user ? user.email : '') + '</p><div class="saas-menu">' + button('families', family ? family.name + ' · 切换家庭' : '选择家庭') + (family ? button('family-settings', '家庭设置') + button('members', '家庭成员') : '') + button('password', '修改密码') + button('delete-account', '删除账号') + button('logout', '退出登录') + '</div>'; footer = family ? button('retry-family', '返回看板', true) : button('families', '我的家庭');
    } else if (view === 'family-settings' && family) {
      title = '家庭设置'; body = '<p class="saas-identity">' + esc(family.name) + '</p><div class="saas-menu">' + (family.role === 'owner' ? button('rename-family', '修改家庭名称') + button('transfer-owner', '移交所有权') + button('delete-family', '删除家庭') : button('leave-family', '退出家庭')) + button('members', '家庭成员') + '</div>'; footer = back();
    } else if (view === 'rename-family' && family) { title = '修改家庭名称'; body = formMarkup('rename-family', field('家庭名称', 'name', 'text', form.name, 'required maxlength="80" autocomplete="off"'), '保存名称'); footer = button('family-settings', '返回'); }
    else if (view === 'transfer-owner' && family) {
      title = '移交所有权'; var targets = members.filter(function (m) { return m.role === 'parent' && m.userId !== user.id && m.verified !== false; });
      body = targets.length ? formMarkup('transfer-owner', '<label class="field" for="saas-userId"><span>新所有者</span><select id="saas-userId" name="userId" required' + (busy ? ' disabled' : '') + '><option value="">请选择</option>' + targets.map(function (m) { return '<option value="' + esc(m.userId) + '"' + (form.userId === m.userId ? ' selected' : '') + '>' + esc(m.email) + '</option>'; }).join('') + '</select></label>' + password('账号密码', 'currentPassword', true), '确认移交') : '<p class="saas-short-status">' + (busy ? '加载中' : '可接收成员 0') + '</p>'; footer = button('family-settings', '返回');
    } else if (view === 'leave-family' && family) { title = '退出家庭'; body = '<p class="saas-identity">' + esc(family.name) + '</p>' + button('confirm-leave', '确认退出家庭', true); footer = button('family-settings', '返回'); }
    else if (view === 'delete-family' && family) { title = '删除家庭'; body = '<p class="saas-identity">' + esc(family.name) + '</p>' + formMarkup('delete-family', field('确认家庭名称', 'name', 'text', form.name, 'required maxlength="80" autocomplete="off"') + password('账号密码', 'currentPassword', true), '确认删除家庭'); footer = button('family-settings', '返回'); }
    else if (view === 'delete-account' && user) { title = '删除账号'; body = '<p class="saas-identity">' + esc(user.email) + '</p>' + formMarkup('delete-account', field('确认邮箱', 'email', 'email', form.email, 'required maxlength="254" autocomplete="off" autocapitalize="none"') + password('账号密码', 'currentPassword', true), '确认删除账号'); footer = button(user.verified ? 'account' : 'unverified', '返回'); } else if (view === 'members') { title = '家庭成员'; body = memberMarkup(); }
    else if (view === 'password') { title = '修改密码'; body = formMarkup('password', password('当前密码', 'currentPassword', true) + password('新密码 · 10–128位', 'password') + password('确认新密码', 'confirmPassword'), '保存密码'); footer = back(); }
    else if (view === 'confirm' && confirmation) { title = confirmation.kind === 'member' ? '移除成员' : '撤销邀请'; body = '<p class="saas-identity">' + esc(confirmation.email) + '</p>' + button('confirm-remove', title, true) + button('members', '返回'); }
    document.body.className = 'saas-screen';
    app.innerHTML = '<main id="main" class="saas-main" tabindex="-1"><section class="saas-card" aria-labelledby="saas-title"><p class="saas-brand">小小向前</p><h1 id="saas-title" tabindex="-1">' + title + '</h1><p id="saas-status" class="saas-short-status" role="status" aria-live="polite">' + esc(message) + '</p><div class="saas-content">' + body + '</div><div class="saas-footer">' + footer + '</div></section></main>';
    if (root.FamilyWorldUI) root.FamilyWorldUI.account(view);
    var main = document.getElementById('main'); if (main) main.scrollTop = scroll;
    var target = focusId && document.getElementById(focusId);
    if (!target || target.disabled) target = document.getElementById('saas-title');
    if (target && target.focus) { try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); } if (target.setSelectionRange && typeof start === 'number') { try { target.setSelectionRange(start, end); } catch (e) {} } }
  }
  function afterFamily(result) {
    var selected = result.family;
    if (!selected || !selected.id) { message = '家庭加载未完成'; render(); return; }
    signal(); checkSession('', { userId: user.id, familyId: selected.id });
  }
  function act(action, id) {
    if (!started || busy) return;
    if (action === 'logout') { logout(); return; }
    if (logoutLock) return;
    if (action === 'retry-session') { checkSession(); return; }
    if (action === 'retry-family') { if (family) enterFamily(family.id, resume); else screen('families'); return; }
    if (['family-settings', 'rename-family', 'transfer-owner', 'delete-family', 'leave-family'].indexOf(action) >= 0) {
      if (!family || !user || !user.verified) return;
      if (['rename-family', 'transfer-owner', 'delete-family'].indexOf(action) >= 0 && family.role !== 'owner') return;
      form = action === 'rename-family' ? { name: family.name } : {};
      if (action === 'transfer-owner') listMembers(action); else screen(action); return;
    }
    if (action === 'confirm-leave' && family) { var departed = family.id; submitRequest('/api/families/' + encodeURIComponent(departed) + '/leave', {}, function () { signal(); checkSession('', null); }); return; }
    if (action === 'delete-account') { if (user) { form = {}; screen(action); } return; }
    if (action === 'unverified') { if (user && !user.verified) screen(action); return; }
    if (action === 'select-family') { enterFamily(id); return; }
    if (action === 'members') { confirmation = null; listMembers(); return; }
    if (action === 'resend') { submitRequest('/api/auth/resend-verification', { email: user ? user.email : form.email }, function () { message = '验证邮件已请求'; render(); }); return; }
    if (action === 'verify' && fragment && fragment.kind === 'verify') { submitRequest('/api/auth/verify-email', { token: fragment.token }, function () { fragment = null; signal(); checkSession('邮箱已验证'); }); return; }
    if (action === 'accept-invite' && fragment && user && user.verified) { submitRequest('/api/invitations/accept', { token: fragment.token }, function (result) { fragment = null; afterFamily(result); }); return; }
    if (action === 'dismiss-invite') { fragment = null; screen(families.length ? 'families' : 'onboarding'); return; }
    if (action === 'remove-member' || action === 'revoke-invite') {
      if (!family || family.role !== 'owner') return;
      var rows = action === 'remove-member' ? members : invitations;
      for (var i = 0; i < rows.length; i++) if ((rows[i].userId || rows[i].id) === id) { confirmation = { kind: action === 'remove-member' ? 'member' : 'invite', id: id, email: rows[i].email }; view = 'confirm'; message = ''; render(); return; }
    }
    if (action === 'confirm-remove' && confirmation && family && family.role === 'owner') {
      var path = '/api/families/' + encodeURIComponent(family.id) + (confirmation.kind === 'member' ? '/members/' : '/invitations/') + encodeURIComponent(confirmation.id);
      submitRequest(path, {}, function () { signal(); confirmation = null; listMembers(); }, 'DELETE'); return;
    }
    if (action === 'back') action = family ? 'account' : user ? 'families' : 'login';
    if (['login', 'register', 'forgot', 'create', 'join', 'account', 'families', 'password'].indexOf(action) >= 0) {
      if (['create', 'join', 'families'].indexOf(action) >= 0 && (!user || !user.verified)) { screen(user ? 'unverified' : 'login'); return; }
      if ((action === 'account' || action === 'password') && !user) action = 'login';
      if (ready) leaveBusiness(action); else { form = {}; createId = ''; screen(action); }
    }
  }
  function submit(element) {
    if (busy || logoutLock || !element) return;
    if (!element.checkValidity()) { var invalid = element.querySelector(':invalid'); message = invalid && invalid.validity && invalid.validity.valueMissing ? '请填写必填项' : '请检查输入格式'; var status = document.getElementById('saas-status'); if (status) status.textContent = message; if (invalid) { invalid.setAttribute('aria-describedby', 'saas-status'); invalid.focus(); } return; }
    var values = {}, nodes = element.elements;
    for (var i = 0; i < nodes.length; i++) if (nodes[i].name) values[nodes[i].name] = nodes[i].value;
    if (values.email != null) form.email = values.email.trim();
    if (values.confirmPassword != null && values.password !== values.confirmPassword) { message = '两次密码不一致'; render(); return; }
    var kind = element.getAttribute('data-saas-form');
    if (kind === 'login') submitRequest('/api/auth/login', { email: form.email, password: values.password }, function (result) { var token = fragment; boundary(true); fragment = token; signal(); adoptSession(result); });
    else if (kind === 'register') submitRequest('/api/auth/register', { email: form.email, password: values.password }, function () { screen('pending', '验证邮件已请求'); });
    else if (kind === 'forgot') submitRequest('/api/auth/forgot-password', { email: form.email }, function () { message = '重置邮件已请求'; render(); });
    else if (kind === 'reset' && fragment && fragment.kind === 'reset') submitRequest('/api/auth/reset-password', { token: fragment.token, password: values.password }, function () { boundary(true); fragment = null; signal(); screen('login', '密码已重置'); });
    else if (kind === 'password') submitRequest('/api/auth/change-password', { currentPassword: values.currentPassword, password: values.password }, function () { signal(); screen('account', '密码已修改'); });
    else if (kind === 'rename-family' && family && family.role === 'owner') { form.name = values.name.trim(); submitRequest('/api/families/' + encodeURIComponent(family.id), { name: form.name }, function () { signal(); checkSession(); }, 'PATCH'); }
    else if (kind === 'transfer-owner' && family && family.role === 'owner') { form.userId = values.userId; submitRequest('/api/families/' + encodeURIComponent(family.id) + '/transfer-owner', { userId: values.userId, currentPassword: values.currentPassword }, function () { signal(); checkSession(); }); }
    else if (kind === 'delete-family' && family && family.role === 'owner') { form.name = values.name; submitRequest('/api/families/' + encodeURIComponent(family.id), { name: values.name, currentPassword: values.currentPassword }, function () { signal(); checkSession('', null); }, 'DELETE'); }
    else if (kind === 'delete-account' && user) submitRequest('/api/auth/delete-account', { email: form.email, currentPassword: values.currentPassword }, function () { boundary(true); fragment = null; suspended = false; signal(); checkSession('账号已删除', null); });
    else if (kind === 'create') {
      form.name = values.name.trim(); form.childName = values.childName.trim(); if (!createId) createId = uid();
      submitRequest('/api/families', { name: form.name, childName: form.childName, requestId: createId }, afterFamily);
    } else if (kind === 'join') { form.invite = values.invite; submitRequest('/api/invitations/accept', { token: tokenFrom(values.invite) }, afterFamily); }
    else if (kind === 'invitation' && family && family.role === 'owner') submitRequest('/api/families/' + encodeURIComponent(family.id) + '/invitations', { email: form.email }, function () { form.email = ''; listMembers(); message = '邀请邮件已请求'; render(); });
  }
  function hide() {
    if (!started || suspended) return;
    // Logout screens contain no private DOM; let their authentication request settle.
    if (logoutLock) { suspended = true; return; }
    if (!resume) resume = { userId: user && user.id, familyId: family && family.id, role: family && family.role, csrf: csrf, verified: !!(user && user.verified), view: view, form: JSON.parse(JSON.stringify(form)), createId: createId, business: ready && hooks && hooks.suspend ? hooks.suspend() : null };
    boundary(true, true); suspended = true; view = 'checking'; render();
  }
  root.FamilySaas = {
    start: function (adapter) {
      hooks = adapter; started = true; readFragment();
      var value = ''; try { value = root.localStorage.getItem(SIGNAL) || ''; } catch (e) {}
      var event = /^(logout-start|logout-settled|logout-failed):(.+)$/.exec(value);
      if (event) {
        lastSignal = value;
        if (event[1] !== 'logout-settled') { lockLogout(event[2], event[1] === 'logout-failed'); return; }
        rememberLogout(event[2]);
      }
      checkSession();
    },
    capture: capture, current: current, owns: owns, track: track, request: request,
    ready: function () { return ready && !suspended && !document.hidden; },
    isOwner: function () { return !!family && family.role === 'owner'; },
    identity: function () { return { user: user, family: family }; },
    openSettings: openSettings, recheck: checkSession, logout: logout,
    status: function () { return { epoch: epoch, ready: ready && !suspended, view: view, userId: user ? user.id : null, familyId: family ? family.id : null, pending: requests.length }; }
  };
  document.addEventListener('click', function (event) { var el = event.target; while (el && el !== document) { if (el.getAttribute && el.getAttribute('data-saas')) { event.preventDefault(); act(el.getAttribute('data-saas'), el.getAttribute('data-id')); return; } el = el.parentNode; } });
  document.addEventListener('submit', function (event) { if (event.target.id === 'saas-form') { event.preventDefault(); submit(event.target); } });
  document.addEventListener('input', function (event) { var input = event.target; if (input.form && input.form.id === 'saas-form' && ['email', 'name', 'childName', 'invite', 'userId'].indexOf(input.name) >= 0) form[input.name] = input.value; });
  document.addEventListener('visibilitychange', function () { if (document.hidden) hide(); else if (started && suspended) checkSession(); });
  root.addEventListener('pagehide', hide);
  root.addEventListener('pageshow', function (event) { if (started && (suspended || (event && event.persisted))) { if (!suspended) hide(); checkSession(); } });
  root.addEventListener('focus', function () { if (started && !document.hidden && !checking) { if (suspended) checkSession(); else probeSession(); } });
  root.addEventListener('storage', function (event) { if (event.key === SIGNAL) changed(event.newValue); });
  root.addEventListener('hashchange', function () { if (started && readFragment()) checkSession(); });
  if (root.BroadcastChannel) { try { channel = new root.BroadcastChannel(SIGNAL); channel.onmessage = function (event) { changed(event.data); }; } catch (e) {} }
}(window));
