'use strict';

const assert = require('node:assert/strict');
const Q = require('./saas-browser.cjs');
const partial = '这段背景音还未定稿';
const final = '我有多少积分';

function fixture() {
  const sessions = [];
  function connect(_config, events) {
    const session = { sizes: [], nonzero: false, finished: false, closed: false, events };
    sessions.push(session);
    queueMicrotask(events.onReady);
    return {
      write(pcm) {
        session.sizes.push(pcm.length);
        if (pcm.some(byte => byte !== 0)) session.nonzero = true;
        if (session.nonzero && !session.previewed) {
          session.previewed = true;
          events.onPartial(partial);
        }
      },
      finish() { session.finished = true; events.onFinal(final); },
      close() { session.closed = true; }
    };
  }
  return { sessions, connect };
}

async function setup(page) {
  await page.setViewport({width:390, height:844, deviceScaleFactor:1, isMobile:true, hasTouch:true});
  await page.evaluateOnNewDocument(() => {
    window.__qaBuzz = [];
    window.__qaVoiceTrace = [];
    Object.defineProperty(navigator, 'vibrate', {value: ms => {
      window.__qaBuzz.push(ms); window.__qaVoiceTrace.push({type:'vibrate', at:Date.now()}); return true;
    }});
    const armed = {}, entries = [];
    window.__qaVoiceGates = {
      entries,
      arm(kind) {
        if (!['worklet','microphone'].includes(kind) || armed[kind]) throw new Error('Invalid or already armed voice gate');
        const gate = {kind, entered:false, released:false, settled:false};
        gate.promise = new Promise(resolve => { gate.resolve = resolve; });
        entries.push(gate); armed[kind] = gate; return entries.length - 1;
      },
      release(index) { const gate = entries[index]; gate.released = true; gate.resolve(); }
    };
    const takeGate = kind => {
      const gate = armed[kind];
      if (gate) { delete armed[kind]; gate.entered = true; }
      return gate;
    };
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
      constructor(options) {
        super(options);
        const worklet = this.audioWorklet, addModule = worklet.addModule.bind(worklet);
        Object.defineProperty(worklet, 'addModule', {value:(...args) => {
          const gate = takeGate('worklet');
          if (!gate) return addModule(...args);
          return gate.promise.then(() => addModule(...args)).finally(() => { gate.settled = true; });
        }});
      }
      createMediaStreamSource(stream) {
        window.__qaVoiceTrace.push({type:'capture', at:Date.now()});
        return super.createMediaStreamSource(stream);
      }
    };
    // Keep real timers. The two duration checks can fire the captured limit once
    // after actual PCM arrives, without waiting a wall-clock minute.
    window.__qaVoiceLimitTimers = [];
    const setTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => {
      const timer = setTimeout(callback, delay, ...args);
      if (window.__qaArmVoiceLimit && delay === 60000 && typeof callback === 'function') {
        window.__qaVoiceLimitTimers.push({fire() { clearTimeout(timer); callback(...args); }});
      }
      return timer;
    };
    // A real MediaStream and AudioWorklet run against a generated tone. No device audio leaves the test.
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.__qaConstraints = constraints.audio;
      const gate = takeGate('microphone');
      const audio = window.__qaToneContext || (window.__qaToneContext = new NativeAudioContext({sampleRate:48000}));
      const source = audio.createOscillator();
      const destination = audio.createMediaStreamDestination();
      source.connect(destination);
      source.start();
      window.__qaMic = destination.stream.getAudioTracks()[0];
      try {
        await audio.resume();
        if (gate) await gate.promise;
        return destination.stream;
      } finally { if (gate) gate.settled = true; }
    };
  });
}

async function verify(page, env, provider) {
  const cdp = await page.createCDPSession();
  const gesture = (type, point) => cdp.send('Input.dispatchTouchEvent', {type, touchPoints:point ? [point] : []});
  const drafts = () => page.$eval('#assistant-chat-input', input => input.value);
  const turns = () => env.calls.filter(call => call.path === '/api/assistant/chat/turn').length;
  await page.evaluate(() => {
    // Observe the real adapter callback, preserving its microphone/worklet path.
    const create = FamilyVolcVoice.create;
    FamilyVolcVoice.create = options => {
      const recognition = create(options), start = recognition.start;
      recognition.start = () => {
        const onstart = recognition.onstart;
        recognition.onstart = event => {
          window.__qaVoiceTrace.push({type:'onstart', at:Date.now()});
          if (typeof onstart === 'function') onstart.call(recognition, event);
        };
        return start.call(recognition);
      };
      return recognition;
    };
  });
  Q.report.assistantCloudVoice = {readiness:[], duration:[]};
  async function press(selector = '[data-assistant-action="hold-voice"]') {
    await page.waitForFunction(s => !document.querySelector(s).disabled, {}, selector);
    const point = await page.$eval(selector, button => {
      const rect = button.getBoundingClientRect();
      return {x:rect.left + rect.width / 2, y:rect.top + rect.height / 2};
    });
    await gesture('touchStart', point);
    return point;
  }
  async function hold(selector) {
    const point = await press(selector);
    await page.waitForFunction(words => document.querySelector('.assistant-recording-text').textContent === words, {}, partial);
    await page.evaluate(() => { window.__qaNow += 1200; });
    return point;
  }
  async function released() {
    await page.waitForFunction(() => window.__qaMic.readyState === 'ended');
    await page.waitForSelector('.assistant-recording[hidden]');
    await page.waitForFunction(() => {
      const state = FamilyAssistantPanel.getState();
      return !state.listening && !state.holding && !state.voiceFinishing;
    });
  }
  await Q.check('holding the home launcher opens chat, streams live PCM and submits one final on release', async () => {
    await hold('.assistant-launcher');
    assert.equal(await drafts(), '');
    assert.equal(turns(), 0);
    const constraints = await page.evaluate(() => window.__qaConstraints);
    for (const key of ['echoCancellation','noiseSuppression','autoGainControl']) assert.equal(constraints[key], true);
    await gesture('touchEnd');
    await page.waitForSelector('.assistant-message-source');
    assert.equal(await page.$eval('.assistant-message-user .assistant-message-text', node => node.textContent), final);
    assert.equal(turns(), 1);
    await released();
    const session = provider.sessions[0];
    assert.equal(session.sizes[0], 1600);
    assert.deepEqual(session.events.hotwords, [], 'family names are not uploaded as cloud vocabulary');
    assert.ok(session.nonzero && session.finished && session.closed);
    assert.deepEqual(await page.evaluate(() => window.__qaBuzz), [12]);
  });
  await Q.check('holding the input and sliding up discards a streamed preview and stops the microphone', async () => {
    const point = await hold('#assistant-chat-input');
    await gesture('touchMove', {...point, y:point.y - 120});
    await page.waitForSelector('.assistant-recording[data-cancel="true"]');
    await gesture('touchEnd');
    await released();
    assert.equal(await drafts(), ''); assert.equal(turns(), 1);
    assert.equal(provider.sessions[1].finished, false);
    assert.deepEqual(await page.evaluate(() => window.__qaBuzz), [12, 12]);
  });
  await Q.check('a service failure after partial leaves no draft or extra turn', async () => {
    await hold();
    provider.sessions[2].events.onError(new Error('simulated service loss'));
    await page.waitForFunction(() => window.__qaMic.readyState === 'ended');
    await gesture('touchEnd');
    await released();
    assert.equal(await drafts(), ''); assert.equal(turns(), 1);
    assert.equal(provider.sessions.length, 3);
    assert.ok(provider.sessions.every(session => session.closed));
  });
  await Q.check('tapped dictation previews in the status and puts only the final in the editable draft', async () => {
    await page.click('#assistant-chat-input');
    await page.click('[data-assistant-action="voice"]');
    await page.waitForFunction(words => document.querySelector('#assistant-chat-status').textContent.includes(words), {}, partial);
    assert.equal(await drafts(), '');
    await page.click('[data-assistant-action="voice"]');
    await page.waitForFunction(words => document.querySelector('#assistant-chat-input').value === words, {}, final);
    await released();
    assert.equal(turns(), 1);
    assert.deepEqual(await page.evaluate(() => window.__qaBuzz), [12, 12, 12], 'only press-to-talk requests a vibration');
    assert.deepEqual(Q.report.pageErrors, []);
  });

  async function blankDraft() {
    await page.$eval('#assistant-chat-input', input => {
      input.value = ''; input.dispatchEvent(new Event('input', {bubbles:true})); input.blur();
    });
    await page.click('#assistant-panel-title');
  }
  async function recording() {
    return page.evaluate(() => {
      const overlay = document.querySelector('.assistant-recording');
      return {ready:overlay.dataset.ready, hidden:overlay.hidden,
        words:overlay.querySelector('.assistant-recording-text').textContent,
        hint:overlay.querySelector('.assistant-recording-hint').textContent,
        state:FamilyAssistantPanel.getState(), buzz:[...__qaBuzz], trace:[...__qaVoiceTrace]};
    });
  }
  async function gatedHold(kind, name) {
    await blankDraft();
    const before = await recording(), turnCount = turns(), sessionCount = provider.sessions.length;
    const gate = await page.evaluate(kind => __qaVoiceGates.arm(kind), kind);
    const point = await press();
    await page.waitForFunction(index => __qaVoiceGates.entries[index].entered, {}, gate);
    const preparing = await recording();
    assert.equal(preparing.hidden, false);
    assert.equal(preparing.ready, 'false', name + ': preparation is not capture readiness');
    assert.equal(preparing.state.holding, true);
    assert.equal(preparing.state.listening, false, name + ': listening starts at the capture callback');
    assert.equal(preparing.words, '正在准备麦克风…');
    assert.match(preparing.hint, /等待|稍等|准备|就绪/, name + ': asks the speaker to wait');
    assert.deepEqual(preparing.buzz, before.buzz, name + ': no haptic before capture');
    assert.deepEqual(preparing.trace.slice(before.trace.length), [], name + ': the capture graph and onstart are still gated');
    Q.report.assistantCloudVoice.readiness.push({name, stage:'preparing', ...preparing});
    return {before, turnCount, sessionCount, gate, point, name};
  }
  async function openGate(session) {
    await page.evaluate(index => __qaVoiceGates.release(index), session.gate);
    await page.waitForFunction(index => __qaVoiceGates.entries[index].settled, {}, session.gate);
  }
  async function captureReady(session) {
    await page.waitForSelector('.assistant-recording[data-ready="true"]');
    const ready = await recording(), trace = ready.trace.slice(session.before.trace.length);
    assert.equal(ready.state.listening, true);
    assert.notEqual(ready.words, '正在准备麦克风…');
    assert.deepEqual(trace.map(entry => entry.type), ['capture','onstart','vibrate'], 'one haptic follows the real capture onstart');
    assert.deepEqual(ready.buzz, [...session.before.buzz, 12]);
    Q.report.assistantCloudVoice.readiness.push({name:session.name, stage:'ready', ...ready});
    await page.waitForFunction(words => document.querySelector('.assistant-recording-text').textContent === words, {}, partial);
  }
  async function noLateCapture(session) {
    await openGate(session); await released();
    const stopped = await recording();
    assert.equal(stopped.state.holding, false); assert.equal(stopped.state.listening, false);
    assert.deepEqual(stopped.buzz, session.before.buzz, 'a cancelled preparation never vibrates later');
    assert.deepEqual(stopped.trace.slice(session.before.trace.length), [], 'late preparation never starts capture');
    assert.equal(await drafts(), ''); assert.equal(turns(), session.turnCount);
    assert.equal(provider.sessions.length, session.sessionCount, 'no cloud session starts after cancellation');
    Q.report.assistantCloudVoice.readiness.push({name:session.name, stage:'stopped', ...stopped});
  }
  await Q.check('worklet preparation waits for capture onstart before its listening cue and one haptic', async () => {
    const session = await gatedHold('worklet', 'delayed-worklet');
    await page.evaluate(() => { window.__qaNow += 1200; });
    await openGate(session); await captureReady(session);
    await gesture('touchMove', {...session.point, y:session.point.y - 120});
    await gesture('touchEnd'); await released();
    assert.equal(turns(), session.turnCount); assert.equal(await drafts(), '');
  });
  await Q.check('release before worklet readiness never captures, vibrates or submits after the gate opens', async () => {
    const session = await gatedHold('worklet', 'release-before-ready');
    await gesture('touchEnd');
    await page.waitForFunction(() => !FamilyAssistantPanel.getState().holding);
    await noLateCapture(session);
  });
  await Q.check('sliding to cancel pending microphone permission prevents every late cue and turn', async () => {
    const session = await gatedHold('microphone', 'cancel-before-ready');
    await gesture('touchMove', {...session.point, y:session.point.y - 120});
    await page.waitForSelector('.assistant-recording[data-cancel="true"]');
    await gesture('touchEnd');
    await page.waitForFunction(() => !FamilyAssistantPanel.getState().holding);
    await noLateCapture(session);
  });
  await Q.check('late microphone readiness followed by a short captured tail never auto-sends the final', async () => {
    const session = await gatedHold('microphone', 'short-tail-after-slow-start');
    await page.evaluate(() => { window.__qaNow += 1200; });
    await openGate(session); await captureReady(session);
    await page.evaluate(() => { window.__qaNow += 100; });
    await gesture('touchEnd'); await released();
    assert.equal(turns(), session.turnCount, 'waiting time is not captured speech duration');
    assert.ok(['', final].includes(await drafts()), 'a short tail is discarded or retained as the editable final');
    assert.equal(await page.$eval('#assistant-chat-input', input => input.readOnly), false);
    Q.report.assistantCloudVoice.readiness.push({name:session.name, stage:'released', draft:await drafts(), turns:turns()});
  });
  await Q.check('a slow worklet startup keeps even a long enough final editable for review', async () => {
    const session = await gatedHold('worklet', 'review-after-slow-start');
    await page.evaluate(() => { window.__qaNow += 1200; });
    await openGate(session); await captureReady(session);
    await page.evaluate(() => { window.__qaNow += 1200; });
    await gesture('touchEnd'); await released();
    assert.equal(turns(), session.turnCount, 'the lost beginning must be reviewed despite a sufficient captured interval');
    assert.equal(await drafts(), final);
    assert.equal(await page.$eval('#assistant-chat-input', input => input.readOnly), false);
    assert.match(await page.$eval('#assistant-chat-status', node => node.textContent), /核对/);
    Q.report.assistantCloudVoice.readiness.push({name:session.name, stage:'released', draft:await drafts(), turns:turns()});
  });

  async function armLimit() {
    await blankDraft();
    await page.evaluate(() => { window.__qaArmVoiceLimit = true; window.__qaVoiceLimitTimers = []; });
    return {turnCount:turns(), sessionCount:provider.sessions.length};
  }
  async function fireLimit() {
    await page.waitForFunction(() => __qaVoiceLimitTimers.length > 0);
    await page.evaluate(() => {
      window.__qaNow += 60000; window.__qaArmVoiceLimit = false;
      __qaVoiceLimitTimers.at(-1).fire();
    });
  }
  async function reviewAtLimit(before, mode) {
    await page.waitForFunction(words => document.querySelector('#assistant-chat-input').value === words, {}, final);
    await released();
    assert.equal(turns(), before.turnCount, 'the duration limit never sends an unchecked message');
    assert.equal(await page.$eval('#assistant-chat-input', input => input.readOnly), false);
    const message = await page.$eval('#assistant-chat-status', node => node.textContent);
    assert.match(message, /60\s*秒/, 'the duration limit is explained after the final arrives');
    const session = provider.sessions[before.sessionCount];
    assert.ok(session.nonzero && session.finished && session.closed, 'captured PCM is finalized before resources close');
    Q.report.assistantCloudVoice.duration.push({mode, message, draft:await drafts(), turns:turns(), microphoneEnded:true});
  }
  await Q.check('tapped dictation at 60 seconds finalizes into an editable draft and releases the microphone', async () => {
    const before = await armLimit();
    await page.click('#assistant-chat-input'); await page.click('[data-assistant-action="voice"]');
    await page.waitForFunction(words => document.querySelector('#assistant-chat-status').textContent.includes(words), {}, partial);
    await fireLimit(); await reviewAtLimit(before, 'dictation');
  });
  await Q.check('held recording at 60 seconds finalizes for review without submitting a turn', async () => {
    const before = await armLimit();
    await hold(); await fireLimit();
    await reviewAtLimit(before, 'hold'); await gesture('touchEnd');
  });
  assert.deepEqual(Q.report.pageErrors, []);
  await cdp.detach();
}

module.exports = { fixture, setup, verify };
