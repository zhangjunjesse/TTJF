/* One live microphone per tab; credentials and audio stay in memory. */
(function (root) {
  'use strict';
  var owner = null;
  var RATE = 16000, FRAME_SAMPLES = 800, FRAME_BYTES = FRAME_SAMPLES * 2;
  var MAX_QUEUE = RATE * 2 * 3, MAX_SOCKET = RATE * 2 * 2;
  var SETUP_MS = 12000, CONNECT_MS = 8000, FLUSH_MS = 1000, FINAL_MS = 10000;

  function supported() {
    return root.isSecureContext !== false && !!(root.navigator && root.navigator.mediaDevices &&
      typeof root.navigator.mediaDevices.getUserMedia === 'function' &&
      (root.AudioContext || root.webkitAudioContext) && root.AudioWorkletNode && root.WebSocket &&
      root.location && /^(https?:)$/.test(root.location.protocol));
  }
  function invoke(recognition, name, event) {
    if (typeof recognition[name] === 'function') recognition[name](event || {});
  }
  function stopTracks(stream) {
    if (stream) stream.getTracks().forEach(function (track) { try { track.stop(); } catch (e) {} });
  }
  function hotwords(value) {
    if (typeof value === 'function') value = value();
    if (!Array.isArray(value)) return [];
    var words = [], length = 0;
    value.forEach(function (word) {
      if (typeof word !== 'string') return;
      word = word.trim().slice(0, 50);
      if (!word || /[\u0000-\u001f\u007f-\u009f]/.test(word) || words.indexOf(word) !== -1 || words.length >= 100 || length + word.length > 1000) return;
      words.push(word); length += word.length;
    });
    return words;
  }

  function create(options) {
    options = options || {};
    var current = null;
    var recognition = { provider: 'volc', finalized: false, onstart: null, onresult: null, onerror: null,
      onend: null, onspeechstart: null, onspeechend: null, start: start, stop: stop, abort: abort };

    function live(run) { return current === run && !run.ended; }
    function timer(run, name, delay, callback) {
      clearTimer(run, name);
      run.timers[name] = root.setTimeout(function () {
        delete run.timers[name];
        if (live(run)) callback();
      }, delay);
    }
    function clearTimer(run, name) {
      if (run.timers[name] != null) root.clearTimeout(run.timers[name]);
      delete run.timers[name];
    }
    function releaseLease(run) { if (owner === run && run.ended && !run.micPending) owner = null; }
    function disconnect(node) { if (node) { try { node.disconnect(); } catch (e) {} } }
    function releaseAudio(run) {
      if (run.audioReleased) return;
      run.audioReleased = true;
      clearTimer(run, 'flush'); clearTimer(run, 'duration');
      if (run.stream) run.stream.getTracks().forEach(function (track) {
        if (track.removeEventListener) track.removeEventListener('ended', run.trackEnded);
      });
      stopTracks(run.stream); run.stream = null;
      if (run.node) {
        run.node.onprocessorerror = null;
        run.node.port.onmessage = null;
        try { run.node.port.postMessage({ type: 'abort' }); run.node.port.close(); } catch (e) {}
      }
      disconnect(run.source); disconnect(run.node); disconnect(run.gain);
      run.source = run.node = run.gain = null;
      if (run.context) {
        if (run.context.removeEventListener) run.context.removeEventListener('statechange', run.contextChanged);
        try { var closing = run.context.close(); if (closing && closing.catch) closing.catch(function () {}); } catch (e) {}
      }
      run.context = null;
    }
    function closeConnection(run) {
      clearTimer(run, 'connect'); clearTimer(run, 'ticket'); clearTimer(run, 'drain');
      if (run.ticketRequest) { try { run.ticketRequest.abort(); } catch (e) {} }
      run.ticketRequest = null;
      if (run.socket) {
        run.socket.onopen = run.socket.onmessage = run.socket.onerror = run.socket.onclose = null;
        try { if (run.socket.readyState < 2) run.socket.close(1000, 'finished'); } catch (e) {}
      }
      run.socket = null; run.ready = false; run.startSent = false; run.ticket = ''; run.ticketDone = false;
    }
    function cleanup(run) {
      run.ended = true;
      Object.keys(run.timers).forEach(function (name) { clearTimer(run, name); });
      if (root.removeEventListener) {
        root.removeEventListener('pagehide', run.pageHidden);
        root.removeEventListener('offline', run.offline);
      }
      if (root.document && root.document.removeEventListener) root.document.removeEventListener('visibilitychange', run.visibility);
      closeConnection(run); releaseAudio(run);
      run.queue = []; run.queuedBytes = 0; run.lastText = '';
      releaseLease(run);
    }
    function result(text, final) {
      var row = [{ transcript: text }]; row.isFinal = final;
      return { resultIndex: 0, results: [row] };
    }
    function textResult(text, final) {
      var callback = final ? options.onFinalText : options.onPartialText;
      if (typeof callback === 'function') callback(text);
      else invoke(recognition, 'onresult', result(text, final));
    }
    function fail(run, error, code) {
      if (!live(run)) return;
      var hadText = !!run.lastText;
      cleanup(run);
      // A disconnected provider hypothesis must never turn into a saved draft.
      if (hadText) textResult('', false);
      invoke(recognition, 'onerror', { error: error, code: code, discarded: true });
      invoke(recognition, 'onend');
    }
    function transient(run, code) {
      if (!live(run)) return;
      if (!run.stopping && run.sentBytes === 0 && run.attempt === 0) {
        run.attempt++;
        closeConnection(run);
        if (run.timers.setup == null) timer(run, 'setup', SETUP_MS, function () { fail(run, 'network', 'VOICE_SETUP_TIMEOUT'); });
        timer(run, 'retry', 250, function () { requestTicket(run); });
      } else fail(run, 'network', code);
    }
    function microphoneError(run, error) {
      var name = error && error.name;
      fail(run, name === 'NotAllowedError' || name === 'SecurityError' ? 'not-allowed' : 'audio-capture',
        name === 'NotAllowedError' || name === 'SecurityError' ? 'MICROPHONE_PERMISSION_DENIED' :
        name === 'NotFoundError' || name === 'DevicesNotFoundError' ? 'MICROPHONE_NOT_FOUND' : 'MICROPHONE_UNAVAILABLE');
    }
    function contextError(run, error) {
      fail(run, error && error.name === 'NotAllowedError' ? 'not-allowed' : 'audio-capture',
        error && error.name === 'NotAllowedError' ? 'AUDIO_CONTEXT_BLOCKED' : 'AUDIO_CONTEXT_UNAVAILABLE');
    }
    function providerError(run, code) {
      if (/^(ASR_CONNECTION_FAILED|VOICE_CONNECT_FAILED|VOICE_UPSTREAM_UNAVAILABLE|ASR_UPSTREAM_UNAVAILABLE|NETWORK_ERROR)$/.test(code)) {
        transient(run, code); return;
      }
      fail(run, /^(NO_SPEECH|VOICE_NO_SPEECH)$/.test(code) ? 'no-speech' :
        /^(ASR_TIMEOUT|VOICE_TIMEOUT)$/.test(code) ? 'network' :
        /^(VOICE_BUSY|ASR_BUSY|RATE_LIMITED)$/.test(code) ? 'busy' : 'service-unavailable', code);
    }

    function requestTicket(run) {
      if (!live(run) || run.stopping && !run.audioStarted) return;
      if (typeof options.request !== 'function') { fail(run, 'service-unavailable', 'VOICE_TICKET_UNAVAILABLE'); return; }
      var attempt = run.attempt, settled = false;
      timer(run, 'ticket', CONNECT_MS, function () { transient(run, 'VOICE_TICKET_TIMEOUT'); });
      try {
        var handle = options.request('POST', '/api/assistant/voice/ticket', {}, function (status, body) {
          if (!live(run) || attempt !== run.attempt || settled) return;
          settled = true;
          run.ticketDone = true; run.ticketRequest = null; clearTimer(run, 'ticket');
          body = body || {};
          if (status < 200 || status >= 300) {
            var code = typeof body.code === 'string' ? body.code : 'VOICE_TICKET_FAILED';
            if (/^(VOICE_BUSY|RATE_LIMITED|NO_SPEECH|ASR_TIMEOUT|ASR_UNAVAILABLE)$/.test(code)) { providerError(run, code); return; }
            if (/CONFIG|DISABLED|FORBIDDEN|AUTH|PERMISSION|ASR_UNAVAILABLE/.test(code)) { fail(run, 'service-unavailable', code); return; }
            if (status === 0 || status === 408 || status === 502 || status === 503 || status === 504) { transient(run, code); return; }
            fail(run, status === 429 ? 'busy' : 'service-unavailable', code); return;
          }
          if (typeof body.ticket !== 'string' || !body.ticket || body.ticket.length > 2048) { fail(run, 'protocol', 'VOICE_TICKET_INVALID'); return; }
          run.ticket = body.ticket; connect(run);
        });
        if (live(run) && attempt === run.attempt && !run.ticketDone) {
          if (!handle) { fail(run, 'service-unavailable', 'VOICE_TICKET_UNAVAILABLE'); return; }
          run.ticketRequest = handle;
        } else if (!live(run) && handle) { try { handle.abort(); } catch (e) {} }
      } catch (e) { transient(run, 'VOICE_TICKET_NETWORK_ERROR'); }
    }
    function connect(run) {
      if (!live(run) || !run.audioStarted || !run.ticket || run.socket) return;
      var socket, attempt = run.attempt;
      try {
        socket = new root.WebSocket((root.location.protocol === 'https:' ? 'wss://' : 'ws://') +
          root.location.host + '/api/assistant/voice/stream?ticket=' + encodeURIComponent(run.ticket));
      } catch (e) { transient(run, 'VOICE_CONNECT_FAILED'); return; }
      run.socket = socket; run.ticket = ''; socket.binaryType = 'arraybuffer';
      function valid() { return live(run) && run.socket === socket && run.attempt === attempt; }
      timer(run, 'connect', CONNECT_MS, function () { transient(run, 'VOICE_CONNECT_TIMEOUT'); });
      socket.onopen = function () {
        if (!valid() || run.startSent) return;
        try { run.startSent = true; socket.send(JSON.stringify({ type: 'start', hotwords: run.hotwords })); }
        catch (e) { transient(run, 'VOICE_CONNECT_FAILED'); }
      };
      socket.onmessage = function (event) {
        if (!valid()) return;
        var message;
        try {
          if (typeof event.data !== 'string' || event.data.length > 65536) throw new Error('invalid message');
          message = JSON.parse(event.data);
          if (!message || typeof message !== 'object') throw new Error('invalid message');
        } catch (e) { fail(run, 'protocol', 'VOICE_MESSAGE_INVALID'); return; }
        if (message.type === 'ready') {
          if (!run.startSent) { fail(run, 'protocol', 'VOICE_MESSAGE_INVALID'); return; }
          if (run.ready) return;
          run.ready = true; clearTimer(run, 'setup'); clearTimer(run, 'connect'); drain(run); return;
        }
        if (message.type === 'error') {
          var code = typeof message.code === 'string' ? message.code : 'VOICE_PROVIDER_ERROR';
          providerError(run, code);
          return;
        }
        if (!run.ready || (message.type !== 'partial' && message.type !== 'final') || typeof message.text !== 'string' || message.text.length > 8000) {
          fail(run, 'protocol', 'VOICE_MESSAGE_INVALID'); return;
        }
        var text = message.text.trim(), final = message.type === 'final' && run.eosSent;
        if (final) {
          if (!text) { fail(run, 'no-speech', 'NO_SPEECH'); return; }
          recognition.finalized = true;
          cleanup(run); textResult(text, true); invoke(recognition, 'onend');
        } else if (run.sentBytes && text !== run.lastText) {
          run.lastText = text; textResult(text, false);
        }
      };
      socket.onerror = function () { if (valid()) transient(run, 'VOICE_DISCONNECTED'); };
      socket.onclose = function () { if (valid()) transient(run, 'VOICE_DISCONNECTED'); };
    }
    function drain(run) {
      if (!live(run) || !run.ready || !run.socket || run.eosSent) return;
      var socket = run.socket;
      if (socket.readyState !== 1) { transient(run, 'VOICE_DISCONNECTED'); return; }
      if (socket.bufferedAmount > MAX_SOCKET) { fail(run, 'service-unavailable', 'BACKPRESSURE'); return; }
      while (run.queue.length && socket.bufferedAmount <= MAX_SOCKET - FRAME_BYTES) {
        var frame = run.queue[0];
        try { socket.send(frame); } catch (e) { transient(run, 'VOICE_DISCONNECTED'); return; }
        run.queue.shift(); run.queuedBytes -= frame.byteLength; run.sentBytes += frame.byteLength;
      }
      if (run.stopping && run.flushed && !run.queue.length) {
        if (!run.sentBytes) { fail(run, 'no-speech', 'NO_SPEECH'); return; }
        try { socket.send(JSON.stringify({ type: 'end' })); run.eosSent = true; }
        catch (e) { fail(run, 'network', 'VOICE_DISCONNECTED'); }
      } else if (run.queue.length) timer(run, 'drain', 25, function () { drain(run); });
    }
    function pcm(run, message) {
      if (!live(run) || run.flushed) return;
      if (message.type === 'flushed') {
        if (!run.stopping) { fail(run, 'audio-capture', 'VOICE_PCM_INVALID'); return; }
        run.flushed = true; releaseAudio(run); drain(run); return;
      }
      if (message.type !== 'pcm' || !(message.buffer instanceof ArrayBuffer) || !message.buffer.byteLength || message.buffer.byteLength > FRAME_BYTES || message.buffer.byteLength % 2) {
        fail(run, 'audio-capture', 'VOICE_PCM_INVALID'); return;
      }
      run.queue.push(message.buffer); run.queuedBytes += message.buffer.byteLength;
      if (run.queuedBytes > MAX_QUEUE) { fail(run, 'service-unavailable', 'BACKPRESSURE'); return; }
      drain(run);
    }
    function capture(run) {
      if (!live(run) || run.audioStarted || !run.stream || !run.moduleReady || !run.resumed) return;
      if (run.context.state !== 'running') { fail(run, 'not-allowed', 'AUDIO_CONTEXT_BLOCKED'); return; }
      try {
        run.node = new root.AudioWorkletNode(run.context, 'family-voice-pcm', { numberOfInputs: 1,
          numberOfOutputs: 1, outputChannelCount: [1], channelCountMode: 'max',
          processorOptions: { targetSampleRate: RATE, frameSamples: FRAME_SAMPLES } });
        run.node.port.onmessage = function (event) { pcm(run, event.data || {}); };
        run.node.onprocessorerror = function () { fail(run, 'audio-capture', 'VOICE_PROCESSOR_ERROR'); };
        run.source = run.context.createMediaStreamSource(run.stream);
        run.gain = run.context.createGain(); run.gain.gain.value = 0;
        run.source.connect(run.node); run.node.connect(run.gain); run.gain.connect(run.context.destination);
      } catch (e) { fail(run, 'audio-capture', 'VOICE_CAPTURE_UNAVAILABLE'); return; }
      run.audioStarted = true;
      timer(run, 'duration', 65000, function () { fail(run, 'service-unavailable', 'VOICE_TOO_LONG'); });
      invoke(recognition, 'onstart'); connect(run);
    }
    function prepareAudio(run) {
      var Constructor = root.AudioContext || root.webkitAudioContext, context;
      try {
        // Keep the device's capture clock; the worklet performs rate conversion.
        try { context = new Constructor({ latencyHint: 'interactive' }); }
        catch (e) { if (e.name !== 'NotSupportedError' && e.name !== 'TypeError') throw e; context = new Constructor(); }
        run.context = context;
        if (!context.audioWorklet || !context.audioWorklet.addModule) { fail(run, 'not-supported', 'VOICE_WORKLET_UNSUPPORTED'); return; }
        run.contextChanged = function () {
          if (live(run) && run.audioStarted && !run.audioReleased && context.state !== 'running') fail(run, 'audio-capture', 'AUDIO_CONTEXT_INTERRUPTED');
        };
        if (context.addEventListener) context.addEventListener('statechange', run.contextChanged);
        // iOS requires this call in the pointer/key gesture, before any await.
        Promise.resolve(context.resume()).then(function () {
          if (!live(run)) return;
          run.resumed = true; capture(run);
        }, function (error) { if (live(run)) contextError(run, error); });
        Promise.resolve(context.audioWorklet.addModule('/voice-pcm-worklet.js')).then(function () {
          if (!live(run)) return;
          run.moduleReady = true; capture(run);
        }, function () { fail(run, 'audio-capture', 'VOICE_WORKLET_LOAD_FAILED'); });
      } catch (e) { contextError(run, e); return; }
      run.micPending = true;
      var promise;
      try {
        promise = root.navigator.mediaDevices.getUserMedia({ audio: { channelCount: { ideal: 1 },
          sampleRate: { ideal: RATE }, echoCancellation: true, autoGainControl: true, noiseSuppression: true }, video: false });
      } catch (e) { run.micPending = false; microphoneError(run, e); return; }
      Promise.resolve(promise).then(function (stream) {
        run.micPending = false;
        if (!live(run)) { stopTracks(stream); releaseLease(run); return; }
        run.stream = stream;
        if (!stream.getTracks().length || stream.getTracks().every(function (track) { return track.readyState === 'ended'; })) {
          fail(run, 'audio-capture', 'MICROPHONE_UNAVAILABLE'); return;
        }
        run.trackEnded = function () { if (live(run) && !run.audioReleased) fail(run, 'audio-capture', 'MICROPHONE_ENDED'); };
        stream.getTracks().forEach(function (track) { if (track.addEventListener) track.addEventListener('ended', run.trackEnded); });
        capture(run);
      }, function (error) {
        run.micPending = false;
        if (live(run)) microphoneError(run, error); else releaseLease(run);
      });
    }
    function start() {
      if (current && !current.ended) { var error = new Error('Voice input already started'); error.name = 'InvalidStateError'; throw error; }
      var run = { timers: {}, ended: false, stopping: false, micPending: false, audioStarted: false,
        audioReleased: false, resumed: false, moduleReady: false, ready: false, flushed: false,
        eosSent: false, ticketDone: false, attempt: 0, sentBytes: 0, queue: [], queuedBytes: 0, lastText: '' };
      current = run; recognition.finalized = false;
      if (owner) { fail(run, 'busy', 'VOICE_BUSY'); return; }
      if (!supported()) { fail(run, root.isSecureContext === false ? 'not-allowed' : 'not-supported',
        root.isSecureContext === false ? 'VOICE_INSECURE_CONTEXT' : 'VOICE_UNSUPPORTED'); return; }
      owner = run;
      try { run.hotwords = hotwords(options.hotwords); } catch (e) { run.hotwords = []; }
      run.pageHidden = function () { if (live(run)) abort(); };
      run.visibility = function () { if (root.document.hidden) fail(run, 'audio-capture', 'VOICE_INTERRUPTED'); };
      run.offline = function () { fail(run, 'network', 'VOICE_OFFLINE'); };
      if (root.addEventListener) { root.addEventListener('pagehide', run.pageHidden); root.addEventListener('offline', run.offline); }
      if (root.document && root.document.addEventListener) root.document.addEventListener('visibilitychange', run.visibility);
      timer(run, 'setup', SETUP_MS, function () { fail(run, 'network', 'VOICE_SETUP_TIMEOUT'); });
      prepareAudio(run);
      if (live(run)) requestTicket(run);
    }
    function stop() {
      var run = current;
      if (!run || !live(run) || run.stopping) return;
      run.stopping = true;
      // Releasing during permission/loading must never start a microphone later.
      if (!run.audioStarted) { cleanup(run); invoke(recognition, 'onend'); return; }
      clearTimer(run, 'retry');
      if (!run.socket && !run.ticketRequest && !run.ticket) { fail(run, 'network', 'VOICE_DISCONNECTED'); return; }
      timer(run, 'final', FINAL_MS, function () { fail(run, 'network', 'VOICE_FINAL_TIMEOUT'); });
      timer(run, 'flush', FLUSH_MS, function () { fail(run, 'audio-capture', 'VOICE_FLUSH_TIMEOUT'); });
      try { run.node.port.postMessage({ type: 'flush' }); } catch (e) { fail(run, 'audio-capture', 'VOICE_FLUSH_FAILED'); }
    }
    function abort() {
      var run = current;
      if (!run || !live(run)) return;
      cleanup(run); invoke(recognition, 'onend');
    }
    return recognition;
  }
  root.FamilyVolcVoice = { isSupported: supported, create: create };
}(typeof window !== 'undefined' ? window : this));
