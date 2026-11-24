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
    Object.defineProperty(navigator, 'vibrate', {value: ms => { window.__qaBuzz.push(ms); return true; }});
    // A real MediaStream and AudioWorklet run against a generated tone. No device audio leaves the test.
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.__qaConstraints = constraints.audio;
      const audio = window.__qaToneContext || (window.__qaToneContext = new AudioContext({sampleRate:48000}));
      const source = audio.createOscillator();
      const destination = audio.createMediaStreamDestination();
      source.connect(destination);
      source.start();
      await audio.resume();
      window.__qaMic = destination.stream.getAudioTracks()[0];
      return destination.stream;
    };
  });
}

async function verify(page, env, provider) {
  const cdp = await page.createCDPSession();
  const gesture = (type, point) => cdp.send('Input.dispatchTouchEvent', {type, touchPoints:point ? [point] : []});
  const drafts = () => page.$eval('#assistant-chat-input', input => input.value);
  const turns = () => env.calls.filter(call => call.path === '/api/assistant/chat/turn').length;
  async function hold() {
    const selector = '[data-assistant-action="hold-voice"]';
    await page.waitForFunction(s => !document.querySelector(s).disabled, {}, selector);
    const point = await page.$eval(selector, button => {
      const rect = button.getBoundingClientRect();
      return {x:rect.left + rect.width / 2, y:rect.top + rect.height / 2};
    });
    await gesture('touchStart', point);
    await page.waitForFunction(words => document.querySelector('.assistant-recording-text').textContent === words, {}, partial);
    await page.evaluate(() => { window.__qaNow += 1200; });
    return point;
  }
  async function released() {
    await page.waitForFunction(() => window.__qaMic.readyState === 'ended');
    await page.waitForSelector('.assistant-recording[hidden]');
  }
  await Q.check('live PCM displays a preview and submits one final after touch release', async () => {
    await hold();
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
  await Q.check('sliding up discards a streamed preview and stops the microphone', async () => {
    const point = await hold();
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
  await cdp.detach();
}

module.exports = { fixture, setup, verify };
