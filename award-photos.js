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
  function esc(value) { return String(value).replace(/[&<>"']/g, function (char) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]; }); }
  function icon(name) {
    var paths = {
      camera: '<path d="M8.5 5 10 3h4l1.5 2H19a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/><circle cx="12" cy="12" r="4"/>',
      album: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 16 5-5 4 4 3-3 6 6"/>',
      close: '<path d="m6 6 12 12M6 18 18 6"/>',
      expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
      retry: '<path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7"/>',
      left: '<path d="m14 6-6 6 6 6"/>',
      right: '<path d="m10 6 6 6-6 6"/>',
      zoom: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5M7.5 10.5h6m-3-3v6"/>',
      fit: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M9 12h6"/>'
    };
    return '<svg class="award-photo-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + paths[name] + '</svg>';
  }
  function button(action, label, key, attributes) {
    return '<button type="button" data-action="award-photo-' + action + '"' +
      (key == null ? '' : ' data-id="' + esc(key) + '"') + (attributes || '') + '>' + label + '</button>';
  }
  function editor(draft) {
    var count = draft.items.length, errors = [];
    var rows = draft.items.map(function (item, i) {
      var label = '第' + (i + 1) + '张照片';
      var state = item.photoId ? 'ready' : item.error ? 'failed' : 'pending';
      var status = state === 'ready' ? '<span class="award-photo-expand">' + icon('expand') + '</span>' :
        '<span class="award-photo-state">' + (state === 'failed' ? '未上传' : '<i class="award-photo-spinner" aria-hidden="true"></i>准备中') + '</span>';
      var content = '<span class="award-photo-order" aria-hidden="true">' + (i + 1) + '</span>' + status;
      var preview = item.dataUrl ? button('preview', '<img alt="" src="' + esc(item.dataUrl) + '" decoding="async">' + content,
        item.key, ' class="award-photo-preview" aria-label="查看' + label + '"') :
        '<div class="award-photo-placeholder" aria-label="' + label + '正在准备">' + icon('album') + content + '</div>';
      if (item.error) errors.push('<div class="award-photo-error" role="status"><p><b>照片 ' + (i + 1) + '</b>' + esc(item.error) + '</p>' +
        button('retry', icon('retry') + '<span>重试</span>', item.key, ' class="award-photo-retry" aria-label="重试上传' + label + '"') + '</div>');
      return '<li class="award-photo-card is-' + state + '"' + (state === 'pending' ? ' aria-busy="true"' : '') + '><div class="award-photo-thumb">' + preview +
        button('remove', '<span>' + icon('close') + '</span>', item.key, ' class="award-photo-remove" aria-label="移除' + label + '"') + '</div>' +
        button('retake', icon('camera') + '<span>重拍</span>', item.key, ' class="award-photo-retake" aria-label="重拍' + label + '"') + '</li>';
    }).join('');
    var actions = count < limit ? button('camera', icon('camera') + '<span>' + (count ? '再拍一张' : '拍照记录') + '</span>', null,
      ' class="award-photo-camera"') : '';
    var album = count < limit ? button('album', icon('album') + '<span>从相册选</span>', null,
      ' class="award-photo-album" aria-label="从相册选择照片"') : '';
    return '<section class="award-photo-editor' + (count ? ' has-photos' : ' is-empty') + '" aria-label="本次照片"><div class="award-photo-heading"><strong>照片 <small>选填</small></strong>' +
      '<small class="award-photo-count' + (count === limit ? ' award-photo-quota' : '') + '" data-photo-count data-count="' + count + '" aria-label="已选' + count + '张，最多' + limit + '张">' + count + ' / ' + limit + '</small>' + album + '</div>' +
      (rows ? '<ul class="award-photo-grid">' + rows + '</ul>' : '') + (actions ? '<div class="award-photo-pickers">' + actions + '</div>' : '') +
      (errors.length ? '<div class="award-photo-errors">' + errors.join('') + button('skip', '只记积分', null, ' class="award-photo-skip"') + '</div>' : '') +
      (draft.notice ? '<small class="award-photo-notice" role="status">' + esc(draft.notice) + '</small>' : '') +
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
        openViewer(previews.length, previews.indexOf(draft.items[index]), function (i, done) { done(previews[i].dataUrl); }, env.active);
      }
    }
    return true;
  }
  function validPhotoIds(photoIds) {
    return Array.isArray(photoIds) && photoIds.length > 0 && photoIds.length <= limit && photoIds.every(function (id) { return uuid.test(id); });
  }
  function details(photoIds) {
    if (!validPhotoIds(photoIds)) return '';
    var thumbnails = photoIds.map(function (id, index) {
      return '<li>' + button('history', '<img alt="" decoding="async" hidden><span class="award-photo-detail-placeholder">' + icon('album') +
        '<span class="award-photo-detail-state">加载中</span></span><span class="award-photo-order" aria-hidden="true">' + (index + 1) +
        '</span><span class="award-photo-expand">' + icon('expand') + '</span>', photoIds.join(','),
        ' class="award-photo-detail-thumb" id="record-photo-' + id + '" data-photo-id="' + id + '" data-photo-index="' + index + '" aria-label="查看第' + (index + 1) + '张照片"') + '</li>';
    }).join('');
    return '<section class="award-photo-details" data-award-photo-details aria-label="加分照片"><div class="award-photo-heading"><strong>照片</strong><small>' +
      photoIds.length + ' 张</small></div><ul class="award-photo-grid">' + thumbnails + '</ul></section>';
  }
  function hydrateDetails(root, env) {
    if (!root || !env || !env.active()) return;
    root.querySelectorAll('.award-photo-detail-thumb[data-photo-id]').forEach(function (thumb) {
      var photoId = thumb.getAttribute('data-photo-id');
      if (!uuid.test(photoId) || thumb.getAttribute('data-photo-loaded')) return;
      thumb.setAttribute('data-photo-loaded', 'pending'); thumb.setAttribute('aria-busy', 'true');
      var img = thumb.querySelector('img'), placeholder = thumb.querySelector('.award-photo-detail-placeholder');
      function active() { return env.active() && thumb.isConnected && root.contains(thumb); }
      function failed() {
        if (!active()) return;
        thumb.setAttribute('data-photo-loaded', 'failed'); thumb.removeAttribute('aria-busy');
        thumb.classList.add('is-unavailable'); placeholder.querySelector('.award-photo-detail-state').textContent = '未载入';
      }
      try {
        env.request('POST', '/api/award-photos/read', { photoId: photoId }, function (status, response) {
          if (!active()) return;
          var url = status === 200 && response && response.dataUrl;
          if (typeof url !== 'string' || !url.startsWith('data:image/jpeg;base64,')) { failed(); return; }
          img.onload = function () {
            if (!active()) return;
            thumb.setAttribute('data-photo-loaded', 'ready'); thumb.removeAttribute('aria-busy');
            placeholder.hidden = true; img.hidden = false;
          };
          img.onerror = failed; img.src = url;
        });
      } catch (_) { failed(); }
    });
  }
  function viewHistory(photoIds, env, startIndex) {
    if (!validPhotoIds(photoIds) || !env.active()) return;
    var cache = [];
    // Reuse only decoded photos from this live detail; no account-wide image cache.
    if (env.root && env.root.isConnected) env.root.querySelectorAll('.award-photo-detail-thumb[data-photo-loaded="ready"]').forEach(function (thumb) {
      var position = Number(thumb.getAttribute('data-photo-index')), img = thumb.querySelector('img');
      var url = img && img.getAttribute('src');
      if (thumb.getAttribute('data-id') === photoIds.join(',') && photoIds[position] === thumb.getAttribute('data-photo-id') &&
        typeof url === 'string' && url.startsWith('data:image/jpeg;base64,')) cache[position] = url;
    });
    openViewer(photoIds.length, startIndex || 0, function (index, done) {
      if (cache[index]) { done(cache[index]); return; }
      try {
        env.request('POST', '/api/award-photos/read', { photoId: photoIds[index] }, function (status, response) {
          if (!env.active()) return;
          var url = status === 200 && response && response.dataUrl;
          if (typeof url === 'string' && url.startsWith('data:image/jpeg;base64,')) cache[index] = url;
          done(cache[index]);
        });
      } catch (_) { done(); }
    }, env.active);
  }
  function closeViewer() { if (viewer) viewer.close(); }
  function openViewer(count, index, load, scopeActive) {
    if (!count) return;
    closeViewer();
    index = Math.max(0, Math.min(count - 1, Math.floor(Number(index) || 0)));
    var dialog = document.createElement('dialog'), generation = 0, returnFocus = document.activeElement;
    var returnAction = returnFocus && returnFocus.getAttribute('data-action');
    var returnId = returnFocus && returnFocus.getAttribute('data-id'), returnIndex = returnFocus && returnFocus.getAttribute('data-photo-index');
    dialog.className = 'award-photo-viewer';
    dialog.setAttribute('data-award-photo-viewer', '');
    dialog.setAttribute('aria-label', '查看照片');
    dialog.innerHTML = '<header class="award-photo-viewer-header"><strong aria-live="polite" aria-atomic="true"></strong>' +
      '<button type="button" data-photo-close aria-label="关闭照片">' + icon('close') + '</button></header>' +
      '<div class="award-photo-stage"><div class="award-photo-canvas"><img alt="" hidden></div><span role="status" aria-live="polite"></span></div>' +
      '<footer class="award-photo-viewer-footer"><button type="button" data-photo-prev aria-label="上一张照片">' + icon('left') + '</button>' +
      '<div class="award-photo-viewer-tools"><button type="button" data-photo-zoom aria-pressed="false">' + icon('zoom') + '<span>放大</span></button>' +
      '<button type="button" data-photo-reload hidden>' + icon('retry') + '<span>重新加载</span></button></div>' +
      '<button type="button" data-photo-next aria-label="下一张照片">' + icon('right') + '</button></footer>';
    document.body.appendChild(dialog); viewer = dialog;
    var select = function (selector) { return dialog.querySelector(selector); };
    var img = select('img'), stage = select('.award-photo-stage'), surface = select('.award-photo-canvas'), status = select('[role="status"]');
    var zoom = select('[data-photo-zoom]'), reload = select('[data-photo-reload]');
    function setZoom(enlarged) {
      stage.classList.toggle('zoomed', enlarged);
      zoom.setAttribute('aria-pressed', String(enlarged));
      zoom.innerHTML = icon(enlarged ? 'fit' : 'zoom') + '<span>' + (enlarged ? '缩小' : '放大') + '</span>';
      if (enlarged) {
        var ratio = Math.min(stage.clientWidth / img.naturalWidth, stage.clientHeight / img.naturalHeight) * 2.25;
        var width = Math.round(img.naturalWidth * ratio), height = Math.round(img.naturalHeight * ratio);
        surface.style.width = Math.max(width, stage.clientWidth) + 'px'; surface.style.height = Math.max(height, stage.clientHeight) + 'px';
        img.style.width = width + 'px'; img.style.height = height + 'px';
        stage.scrollTo((surface.offsetWidth - stage.clientWidth) / 2, (surface.offsetHeight - stage.clientHeight) / 2);
      } else {
        surface.style.width = ''; surface.style.height = ''; img.style.width = ''; img.style.height = ''; stage.scrollTo(0, 0);
      }
    }
    function show() {
      var token = ++generation;
      select('strong').textContent = '照片 ' + (index + 1) + ' / ' + count;
      select('[data-photo-prev]').disabled = index === 0;
      select('[data-photo-next]').disabled = index === count - 1;
      setZoom(false); zoom.disabled = true; reload.hidden = true;
      img.onload = null; img.onerror = null; img.hidden = true; img.removeAttribute('src'); status.textContent = '照片加载中…';
      function active() { return token === generation && viewer === dialog && dialog.open; }
      function failed() { if (active()) { status.textContent = '照片未载入'; reload.hidden = false; zoom.hidden = true; } }
      zoom.hidden = false;
      try {
        load(index, function (url) {
          if (!active()) return;
          if (!url) { failed(); return; }
          img.onload = function () { if (active()) { status.textContent = ''; img.hidden = false; zoom.disabled = false; } };
          img.onerror = failed; img.alt = '第' + (index + 1) + '张照片'; img.src = url;
        });
      } catch (_) { failed(); }
    }
    function move(by) {
      if (index + by < 0 || index + by >= count) return;
      var focused = document.activeElement, previous = select('[data-photo-prev]'), next = select('[data-photo-next]');
      index += by; show();
      // A disabled end arrow loses keyboard focus in Chromium.
      if (focused === next && next.disabled) previous.focus({ preventScroll: true });
      else if (focused === previous && previous.disabled) next.focus({ preventScroll: true });
      else if (focused === zoom) select('[data-photo-close]').focus({ preventScroll: true });
    }
    select('[data-photo-close]').onclick = closeViewer;
    select('[data-photo-prev]').onclick = function () { move(-1); };
    select('[data-photo-next]').onclick = function () { move(1); };
    reload.onclick = show;
    zoom.onclick = function () { setZoom(!stage.classList.contains('zoomed')); };
    stage.ondblclick = function (event) { if (!zoom.disabled) { event.preventDefault(); setZoom(!stage.classList.contains('zoomed')); } };
    var touch = null;
    stage.ontouchstart = function (event) { touch = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null; };
    stage.ontouchcancel = function () { touch = null; };
    stage.ontouchend = function (event) {
      var start = touch; touch = null;
      if (!start || event.touches.length || stage.classList.contains('zoomed') || window.visualViewport && window.visualViewport.scale > 1.01) return;
      var end = event.changedTouches[0], dx = end.clientX - start.x, dy = end.clientY - start.y;
      if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.5) move(dx < 0 ? 1 : -1);
    };
    dialog.onkeydown = function (event) {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); closeViewer(); }
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); move(event.key === 'ArrowRight' ? 1 : -1); }
      if ((event.key === '+' || event.key === '=') && !zoom.disabled) { event.preventDefault(); setZoom(true); }
      if (event.key === '-' || event.key === '0') { event.preventDefault(); setZoom(false); }
    };
    function resized() { if (dialog.open && stage.classList.contains('zoomed')) setZoom(true); }
    dialog.oncancel = function (event) { event.preventDefault(); event.stopPropagation(); closeViewer(); };
    dialog.onclose = function () {
      ++generation; window.removeEventListener('resize', resized); img.removeAttribute('src'); dialog.remove();
      if (viewer === dialog) {
        viewer = null; document.documentElement.classList.remove('award-photo-viewing');
        if (scopeActive && !scopeActive()) return;
        if (returnFocus && !returnFocus.isConnected && returnAction) document.querySelectorAll('button[data-action]').forEach(function (candidate) {
          if (candidate.getAttribute('data-action') === returnAction && candidate.getAttribute('data-id') === returnId &&
            candidate.getAttribute('data-photo-index') === returnIndex) returnFocus = candidate;
        });
        if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
      }
    };
    window.addEventListener('resize', resized); document.documentElement.classList.add('award-photo-viewing');
    dialog.showModal(); show();
  }
  window.FamilyAwardPhotos = { createDraft: createDraft, editor: editor, change: change, handle: handle, ids: ids,
    ready: ready, discard: discard, flush: flush, unavailable: unavailable, details: details,
    hydrateDetails: hydrateDetails, viewHistory: viewHistory, closeViewer: closeViewer };
}());
