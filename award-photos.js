(function () {
  'use strict';
  var limit = 3, maxBytes = 768 * 1024, viewer = null, releases = [];
  var uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  function createDraft() { return { items: [], nextKey: 0, replaceKey: null, notice: '' }; }
  function ids(draft) { return draft.items.map(function (item) { return item.photoId; }).filter(Boolean); }
  function ready(draft) { return draft.items.every(function (item) { return !!item.photoId; }); }
  function current(env) { return env.current ? env.current() : env.active(); }
  function releaseScope(env) { var scope = env.scope || {}; return JSON.stringify([scope.userId, scope.familyId]); }
  function photoRequest(env, path, body) {
    return new Promise(function (resolve) {
      var settled = false;
      function done(status, response) { if (!settled) { settled = true; resolve({ status: status, body: response || {} }); } }
      if (!current(env)) { done(0); return; }
      try {
        var xhr = env.request('POST', path, body, done);
        // The account boundary suppresses callbacks from an aborted scope.
        if (xhr === null) done(0);
        else if (xhr && xhr.addEventListener) {
          xhr.addEventListener('abort', function () { done(0); }, { once: true });
          xhr.addEventListener('loadend', function () { done(0); }, { once: true });
        }
      } catch (_) { done(0); }
    });
  }
  function queueRelease(photoIds, env) {
    var scope = releaseScope(env);
    photoIds.forEach(function (id) {
      if (uuid.test(id) && !releases.some(function (entry) { return entry.scope === scope && entry.photoId === id; })) {
        releases.push({ scope: scope, photoId: id, pending: null });
      }
    });
    return flush(env);
  }
  function release(entry, env) {
    if (entry.pending) return entry.pending;
    if (!current(env)) return Promise.resolve(false);
    var attempt = function (retry) {
      return photoRequest(env, '/api/award-photos/discard', { photoIds: [entry.photoId] }).then(function (result) {
        if (result.status >= 200 && result.status < 300) {
          var index = releases.indexOf(entry); if (index >= 0) releases.splice(index, 1);
          return true;
        }
        if (retry && current(env) && (!result.status || result.status >= 500)) return attempt(false);
        return false;
      });
    };
    entry.pending = attempt(true).then(function (ok) { entry.pending = null; return ok; });
    return entry.pending;
  }
  function flush(env) {
    var scope = releaseScope(env);
    return Promise.all(releases.filter(function (entry) { return entry.scope === scope; }).map(function (entry) {
      return release(entry, env);
    })).then(function (results) { return results.every(Boolean); });
  }
  function discard(draft, env, committedIds) {
    var items = draft.items.splice(0), photoIds = [];
    draft.notice = ''; draft.replaceKey = null;
    items.forEach(function (item) {
      item.abandoned = true;
      if ((committedIds || []).indexOf(item.photoId) < 0) photoIds.push(item.photoId || item.uploadId);
    });
    return queueRelease(photoIds, env);
  }
  function unavailable(draft, photoIds, env) {
    var changed = false;
    draft.items.forEach(function (item) {
      if (!item.photoId || photoIds.indexOf(item.photoId) < 0) return;
      queueRelease([item.photoId], env);
      item.photoId = ''; item.uploadId = ''; item.error = '照片已过期或失效，请重试、重拍或只记积分。'; changed = true;
    });
    return changed;
  }
  function button(action, label, key) {
    return '<button type="button" data-action="award-photo-' + action + '"' +
      (key == null ? '' : ' data-id="' + key + '"') + '>' + label + '</button>';
  }
  function editor(draft) {
    var rows = draft.items.map(function (item, i) {
      var label = '第' + (i + 1) + '张照片';
      var preview = item.dataUrl ? button('preview', '<img alt="查看' + label + '" src="' + item.dataUrl + '">', item.key) : '';
      var status = item.photoId ? '' : '<span role="status">' + (item.error || '正在准备照片…') + '</span>';
      var retry = item.error ? button('retry', '重试照片', item.key) : '';
      return '<li>' + preview + '<div>' + status + '<div class="award-photo-tools">' + retry +
        button('retake', '重拍', item.key) + button('remove', '移除', item.key) + '</div></div></li>';
    }).join('');
    var actions = draft.items.length < limit ? button('camera', rows ? '再拍一张' : '拍照') + button('album', '从相册选') : '';
    if (draft.items.some(function (item) { return item.error; })) actions += button('skip', '只记积分');
    return '<section class="award-photo-editor" aria-label="本次照片"><div class="award-photo-heading"><strong>照片 <small>（选填）</small></strong>' +
      (rows ? '<small>' + draft.items.length + ' / ' + limit + '</small>' : '') + '</div>' +
      (rows ? '<ul>' + rows + '</ul>' : '') + '<div class="award-photo-tools">' + actions + '</div>' +
      (draft.notice ? '<small role="status">' + draft.notice + '</small>' : '') +
      '<input type="file" accept="image/*" capture="environment" data-award-photo-input="camera" hidden>' +
      '<input type="file" accept="image/*" multiple data-award-photo-input="album" hidden></section>';
  }

  async function prepare(file) {
    var url = URL.createObjectURL(file), img = new Image();
    try {
      await new Promise(function (resolve, reject) {
        img.onload = resolve; img.onerror = reject; img.src = url;
      });
      var size = Math.min(1, 2200 / Math.max(img.naturalWidth, img.naturalHeight));
      var canvas = document.createElement('canvas');
      for (var attempt = 0; attempt < 4; attempt++) {
        canvas.width = Math.max(1, Math.round(img.naturalWidth * size));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * size));
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        var jpeg = canvas.toDataURL('image/jpeg', 0.86);
        if (jpeg.startsWith('data:image/jpeg;base64,') && jpeg.length - 23 <= Math.floor(maxBytes / 3) * 4) return jpeg;
        size *= 0.74;
      }
      throw new Error('image size');
    } finally { URL.revokeObjectURL(url); }
  }
  async function upload(item, draft, env) {
    if (item.uploading || item.abandoned) return;
    function active() { return !item.abandoned && env.active() && draft.items.indexOf(item) >= 0; }
    item.uploading = true;
    item.error = '';
    try {
      try { if (!item.dataUrl) item.dataUrl = await prepare(item.file); }
      catch (_) { if (active()) item.error = '读不到这张照片，请重拍或换一张。'; return; }
      if (!active()) return;
      item.file = null; env.refresh();
      // Free a removed/replaced selection before consuming another staging slot.
      if (!await flush(env)) { if (active()) item.error = '照片清理尚未完成，请重试照片。'; return; }
      if (!active()) return;
      if (!item.uploadId) item.uploadId = window.crypto.randomUUID();
      var result = await photoRequest(env, '/api/award-photos', { dataUrl: item.dataUrl, photoId: item.uploadId });
      if (!active()) return;
      if (result.status >= 200 && result.status < 300 && result.body.photoId === item.uploadId) item.photoId = result.body.photoId;
      else {
        if (['PHOTO_UNAVAILABLE', 'PHOTO_DISCARDED', 'PHOTO_ID_REUSED'].includes(result.body.code)) {
          queueRelease([item.uploadId], env); item.uploadId = '';
        }
        item.error = '照片没传成功，积分尚未记入。';
      }
    } catch (_) { if (active()) item.error = '照片没传成功，积分尚未记入。'; }
    finally { item.uploading = false; if (active()) env.refresh(); }
  }
  function change(input, draft, env) {
    if (!input || !input.hasAttribute('data-award-photo-input')) return false;
    var files = Array.from(input.files || []), replacement = draft.replaceKey;
    input.value = ''; draft.replaceKey = null;
    if (!files.length) return true;
    var count = replacement == null ? limit - draft.items.length : 1;
    draft.notice = files.length > count ? '每笔最多 3 张照片。' : '';
    var added = files.slice(0, count).map(function (file) {
      return { key: String(++draft.nextKey), file: file, photoId: '', dataUrl: '', error: '' };
    });
    if (replacement != null) {
      var index = draft.items.findIndex(function (item) { return item.key === replacement; });
      if (index < 0) return true;
      var removed = draft.items.splice(index, 1, added[0])[0];
      discard({ items: [removed] }, env);
    } else draft.items.push.apply(draft.items, added);
    env.refresh();
    added.forEach(function (item) { upload(item, draft, env); });
    return true;
  }
  function handle(action, key, draft, env) {
    if (!action.startsWith('award-photo-')) return false;
    var index = draft.items.findIndex(function (item) { return item.key === key; });
    if (['award-photo-camera', 'award-photo-album', 'award-photo-retake'].includes(action)) {
      draft.replaceKey = action === 'award-photo-retake' ? key : null;
      var kind = action === 'award-photo-album' ? 'album' : 'camera';
      // The confirmation sheet can cover an editor with its own file input.
      var inputs = document.querySelectorAll('.award-photo-editor [data-award-photo-input="' + kind + '"]');
      if (inputs.length) {
        var input = inputs[inputs.length - 1];
        if (env && env.beforePick) input = env.beforePick(input) || input;
        input.click();
      }
    } else if (action === 'award-photo-skip') {
      discard(draft, env); env.refresh();
    } else if (index >= 0) {
      if (action === 'award-photo-remove') { discard({ items: draft.items.splice(index, 1) }, env); draft.notice = ''; env.refresh(); }
      if (action === 'award-photo-retry' && draft.items[index].error) { upload(draft.items[index], draft, env); env.refresh(); }
      if (action === 'award-photo-preview') {
        var previews = draft.items.filter(function (item) { return !!item.dataUrl; });
        openViewer(previews.length, previews.indexOf(draft.items[index]), function (i, done) { done(previews[i].dataUrl); });
      }
    }
    return true;
  }
  function history(photoIds) {
    if (!Array.isArray(photoIds) || !photoIds.length || !photoIds.every(function (id) { return uuid.test(id); })) return '';
    return '<span class="award-photo-history">' + button('history', '查看照片 · ' + photoIds.length + ' 张', photoIds.join(',')) + '</span>';
  }
  function viewHistory(photoIds, env) {
    if (!photoIds.length || photoIds.length > limit || !photoIds.every(function (id) { return uuid.test(id); })) return;
    var cache = [];
    openViewer(photoIds.length, 0, function (index, done) {
      if (cache[index]) { done(cache[index]); return; }
      env.request('POST', '/api/award-photos/read', { photoId: photoIds[index] }, function (status, response) {
        if (!env.active()) return;
        var url = status === 200 && response.dataUrl;
        if (typeof url === 'string' && url.startsWith('data:image/jpeg;base64,')) cache[index] = url;
        done(cache[index]);
      });
    });
  }
  function closeViewer() { if (viewer) viewer.close(); }
  function openViewer(count, index, load) {
    closeViewer();
    var dialog = document.createElement('dialog'), generation = 0;
    dialog.className = 'award-photo-viewer';
    dialog.setAttribute('data-award-photo-viewer', '');
    dialog.setAttribute('aria-label', '查看照片');
    dialog.innerHTML = '<header><strong aria-live="polite"></strong><button type="button" data-photo-close>关闭</button></header>' +
      '<div class="award-photo-stage"><img alt="" hidden><span role="status"></span></div>' +
      '<footer><button type="button" data-photo-prev>上一张</button><button type="button" data-photo-zoom>放大</button>' +
      '<button type="button" data-photo-reload hidden>重新加载</button><button type="button" data-photo-next>下一张</button></footer>';
    document.body.appendChild(dialog); viewer = dialog;
    var select = function (selector) { return dialog.querySelector(selector); };
    var img = select('img'), stage = select('.award-photo-stage'), status = select('[role="status"]');
    var zoom = select('[data-photo-zoom]'), reload = select('[data-photo-reload]');
    function show() {
      var token = ++generation;
      select('strong').textContent = '照片 ' + (index + 1) + ' / ' + count;
      select('[data-photo-prev]').disabled = index === 0;
      select('[data-photo-next]').disabled = index === count - 1;
      stage.classList.remove('zoomed'); stage.scrollTo(0, 0);
      zoom.textContent = '放大'; zoom.disabled = true; reload.hidden = true;
      img.hidden = true; img.removeAttribute('src'); status.textContent = '照片加载中…';
      load(index, function (url) {
        if (token !== generation || viewer !== dialog || !dialog.open) return;
        status.textContent = url ? '' : '照片没有加载成功。';
        reload.hidden = !!url; zoom.disabled = !url;
        if (url) { img.alt = '第' + (index + 1) + '张照片'; img.src = url; img.hidden = false; }
      });
    }
    function move(by) { if (index + by >= 0 && index + by < count) { index += by; show(); } }
    select('[data-photo-close]').onclick = closeViewer;
    select('[data-photo-prev]').onclick = function () { move(-1); };
    select('[data-photo-next]').onclick = function () { move(1); };
    reload.onclick = show;
    zoom.onclick = function () { zoom.textContent = stage.classList.toggle('zoomed') ? '缩小' : '放大'; };
    var touch = null;
    stage.ontouchstart = function (event) { touch = event.touches.length === 1 ? event.touches[0] : null; };
    stage.ontouchcancel = function () { touch = null; };
    stage.ontouchend = function (event) {
      if (!touch || stage.classList.contains('zoomed') || window.visualViewport && window.visualViewport.scale > 1.01) return;
      var end = event.changedTouches[0], dx = end.clientX - touch.clientX, dy = end.clientY - touch.clientY;
      touch = null;
      if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.5) move(dx < 0 ? 1 : -1);
    };
    dialog.onkeydown = function (event) {
      event.stopPropagation();
      if (event.key === 'ArrowRight') move(1);
      if (event.key === 'ArrowLeft') move(-1);
    };
    dialog.onclose = function () { if (viewer === dialog) viewer = null; dialog.remove(); };
    dialog.showModal(); show();
  }
  window.FamilyAwardPhotos = { createDraft: createDraft, editor: editor, change: change, handle: handle, ids: ids,
    ready: ready, discard: discard, flush: flush, unavailable: unavailable, history: history, viewHistory: viewHistory, closeViewer: closeViewer };
}());
