'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runEvaluation, FIXED_NOW, EXIT, parseArgs } = require('../tools/eval-assistant-intent.cjs');

function directory(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ttjf-assistant-eval-'));
  t.after(() => {
    assert.equal(path.dirname(base), fs.realpathSync(os.tmpdir()));
    fs.rmSync(base, { recursive: true, force: true });
  });
  return base;
}

function tool(name, args) {
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: null, tool_calls: [
    { id: 'offline-controlled-call', type: 'function', function: { name, arguments: JSON.stringify(args) } }
  ] } }] });
}

function natural(content) {
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
}

function options(outDir, fetch, extra = {}) {
  return { outDir, providerOptions: { apiKey: 'OFFLINE_SYNTHETIC_KEY', fetch }, ...extra };
}

function record(summary, index = 0) {
  return JSON.parse(fs.readFileSync(path.join(summary.runDir, summary.results[index].file), 'utf8'));
}

test('intent runner saves independent repetitions, checks actual fields, and labels injected responses as offline evidence', async t => {
  const outDir = directory(t);
  const fetch = async () => tool('draft_award', { name: '睡觉不做噩梦', points: 100 });
  const summary = await runEvaluation(options(outDir, fetch, { caseIds: ['sleep-copula'], repeat: 2 }));
  assert.equal(summary.exitCode, EXIT.passed);
  assert.deepEqual(summary.counts, { passed: 2, behavior_failure: 0, api_error: 0 });
  assert.equal(summary.externalModelRun, false);
  assert.equal(summary.evidenceType, 'controlled_provider_runner_check');
  assert.equal(record(summary).evidenceType, 'controlled_provider_runner_check');
  assert.equal(summary.fixedNow, FIXED_NOW);
  assert.equal(record(summary).turns[0].result.source, 'model');
  assert.equal(record(summary).turns[0].result.action.payload.name, '睡觉不做噩梦');
  assert.equal(record(summary).turns[0].api[0].httpStatus, 200);
  assert.ok(record(summary).turns[0].durationMs >= 0);
  assert.notEqual(summary.results[0].file, summary.results[1].file);
  const again = await runEvaluation(options(outDir, fetch, { caseIds: ['sleep-copula'] }));
  assert.notEqual(again.runDir, summary.runDir);
  assert.equal(JSON.parse(fs.readFileSync(path.join(summary.runDir, 'summary.json'), 'utf8')).counts.passed, 2);
});

test('intent runner fails a dropped negation and a deleted literal 是 even when the score is valid', async t => {
  const summary = await runEvaluation(options(directory(t), async (_url, request) => {
    const input = JSON.parse(JSON.parse(request.body).messages[1].content);
    return input.instruction.includes('噩梦') ? tool('draft_award', { name: '睡觉做噩梦', points: 100 }) : tool('draft_award', { name: '练习写字', points: 5 });
  }, { caseIds: ['sleep-copula', 'write-shi'] }));
  assert.equal(summary.exitCode, EXIT.behavior);
  assert.equal(summary.counts.behavior_failure, 2);
  for (let index = 0; index < 2; index++) {
    const checks = record(summary, index).turns[0].checks;
    assert.equal(checks.find(check => check.name === 'behavior_name').passed, false);
    assert.equal(checks.find(check => check.name === 'score').passed, true);
  }
});

test('intent runner distinguishes service failures from returned intent failures and never persists exception secrets', async t => {
  const summary = await runEvaluation(options(directory(t), async () => { throw new Error('OFFLINE_SYNTHETIC_KEY private-host and stack'); }, { caseIds: ['clock'] }));
  assert.equal(summary.exitCode, EXIT.api);
  assert.deepEqual(summary.counts, { passed: 0, behavior_failure: 0, api_error: 1 });
  const value = record(summary);
  assert.equal(value.status, 'api_error');
  assert.equal(value.turns[0].api[0].errorCode, 'NETWORK_ERROR');
  for (const name of fs.readdirSync(summary.runDir)) {
    assert.doesNotMatch(fs.readFileSync(path.join(summary.runDir, name), 'utf8'), /OFFLINE_SYNTHETIC_KEY|private-host|stack/);
  }
});

test('intent runner accepts a natural clarification and keeps the real pending draft while a new behavior is clarified', async t => {
  let calls = 0;
  const summary = await runEvaluation(options(directory(t), async (_url, request) => {
    const input = JSON.parse(JSON.parse(request.body).messages[1].content);
    assert.equal(input.context.familyDay, '2026-11-25');
    assert.equal(input.context.localTime, '09:37');
    calls++;
    if (calls === 1) return tool('draft_award', { name: '自己刷牙', points: 1 });
    assert.equal(input.draft.action.payload.name, '自己刷牙');
    assert.equal(input.draftStatus.actions[0].status, 'pending');
    assert.ok(input.messages.some(row => row.role === 'user' && row.text === '自己刷牙加一分'));
    if (calls === 2) return natural('你说自己洗澡加衣，是想给自己洗澡加1分吗？');
    assert.equal(input.instruction, '5分');
    assert.ok(input.messages.some(row => row.role === 'assistant' && row.text.includes('洗澡加1分')));
    return tool('draft_award', { name: '自己洗澡', points: 5 });
  }, { caseIds: ['bath-clarify'] }));
  assert.equal(summary.exitCode, EXIT.passed, JSON.stringify(record(summary)));
  assert.equal(calls, 3);
  assert.equal(record(summary).turns[2].result.action.payload.name, '自己洗澡');
  assert.ok(record(summary).turns.every(turn => turn.checks.find(check => check.name === 'business_state_unchanged').passed));
});

test('intent runner replays ordinal clarification followed by 最近三天 and separates earnings from spending', async t => {
  let followupSeen = false;
  const summary = await runEvaluation(options(directory(t), async (_url, request) => {
    const input = JSON.parse(JSON.parse(request.body).messages[1].content);
    if (input.instruction === '最近三天') {
      followupSeen = true;
      assert.ok(input.messages.some(row => row.role === 'user' && row.text === '第三天加了多少分'));
      assert.ok(input.messages.some(row => row.role === 'assistant' && row.text.includes('哪天开始')));
    }
    return input.instruction.startsWith('第三天') ? tool('ask_clarification', { question: '请问从哪天开始计算第三天？' }) : tool('read_ledger', { days: 3 });
  }, { groups: ['date'] }));
  assert.equal(summary.exitCode, EXIT.passed, JSON.stringify(summary.results));
  assert.equal(followupSeen, true);
  assert.equal(record(summary).turns.length, 2);
  assert.equal(record(summary).turns[1].result.data.earned, 17);
  const result = record(summary, 1).turns[0].result;
  assert.equal(result.data.earned, 17);
  assert.equal(result.data.spent, 4);
  assert.equal(result.data.earned - result.data.spent, 13);
  assert.deepEqual(result.data.rows.map(row => row.id), ['recent-third', 'recent-spend', 'recent-second', 'recent-first']);
});

test('intent runner also accepts a natural question asking for the ordinal starting date', async t => {
  const summary = await runEvaluation(options(directory(t), async (_url, request) => {
    const input = JSON.parse(JSON.parse(request.body).messages[1].content);
    return input.instruction.startsWith('第三天') ? natural('你说的第三天，是从哪一天开始算的？') : tool('read_ledger', { days: 3 });
  }, { caseIds: ['ordinal-needs-start'] }));
  assert.equal(summary.exitCode, EXIT.passed, JSON.stringify(record(summary)));
  assert.equal(record(summary).turns[0].result.kind, 'answer');
});

test('intent runner rejects declarations and questions about the wrong missing information', async t => {
  for (const content of ['第三天要从开始日期算起。', '你想加多少分？']) {
    const summary = await runEvaluation(options(directory(t), async () => natural(content), { caseIds: ['ordinal-needs-start'] }));
    assert.equal(summary.exitCode, EXIT.behavior, content);
    assert.equal(record(summary).skippedTurns, 1);
    assert.ok(record(summary).turns[0].checks.some(check => !check.passed));
  }
});

test('intent runner rejects a seven-day query posing as a recent-three-day answer', async t => {
  const summary = await runEvaluation(options(directory(t), async () => tool('read_ledger', { days: 7 }), { caseIds: ['recent-three-days'] }));
  assert.equal(summary.exitCode, EXIT.behavior);
  assert.equal(record(summary).turns[0].checks.find(check => check.name === 'actual_earned_total').passed, false);
});

test('intent runner reports both API and behavioral failures with a nonzero mixed exit code', async t => {
  let calls = 0;
  const summary = await runEvaluation(options(directory(t), async () => {
    if (++calls === 1) return tool('draft_award', { name: '睡觉不做噩梦是', points: 100 });
    return new Response('', { status: 503 });
  }, { caseIds: ['sleep-copula', 'write-shi'] }));
  assert.equal(summary.exitCode, EXIT.mixed);
  assert.equal(summary.counts.behavior_failure, 1);
  assert.equal(summary.counts.api_error, 1);
  assert.equal(record(summary, 1).turns[0].api[0].httpStatus, 503);
});

test('intent runner checks a new activity with filler words without requiring a canned natural answer', async t => {
  const outDir = directory(t);
  const good = await runEvaluation(options(outDir, async () => tool('draft_award', { name: '主动收拾书包', points: 3 }), { caseIds: ['bag-filler'] }));
  assert.equal(good.exitCode, EXIT.passed);
  const bad = await runEvaluation(options(outDir, async () => tool('draft_award', { name: '主动收拾书包，呃', points: 3 }), { caseIds: ['bag-filler'] }));
  assert.equal(bad.exitCode, EXIT.behavior);
  assert.equal(record(bad).turns[0].checks.find(check => check.name === 'behavior_name').passed, false);
});

test('intent runner saves an open response and a review rubric without treating automatic checks as a content grade', async t => {
  const content = '叫它「纸袋星舟」吧。它载着一颗纽扣穿过窗边的银河，最后把一朵想家的星云送回枕头旁。';
  const summary = await runEvaluation(options(directory(t), async () => natural(content), { groups: ['open'] }));
  assert.equal(summary.exitCode, EXIT.passed);
  assert.equal(record(summary).turns[0].result.answer, content);
  assert.equal(record(summary).review.status, 'pending');
  assert.ok(record(summary).review.criteria.length > 0);
  assert.equal(summary.pendingHumanReviews.length, 1);
  assert.match(summary.assessmentScope, /automatic assertions only/);
});

test('intent runner rejects business candidates for an ordinary creative request', async t => {
  const summary = await runEvaluation(options(directory(t), async () => tool('draft_award', { name: '玩纸袋', points: 3 }), { groups: ['open'] }));
  assert.equal(summary.exitCode, EXIT.behavior);
  assert.equal(record(summary).review.status, 'blocked_by_automated_failure');
  assert.equal(record(summary).turns[0].checks.find(check => check.name === 'no_business_candidate').passed, false);
  assert.deepEqual(summary.pendingHumanReviews, []);
});

test('intent runner redacts credentials echoed in a successful response and model metadata, including JSON escapes', async t => {
  const secret = 'OFFLINE_"\\SYNTHETIC_CREDENTIAL';
  const summary = await runEvaluation({ outDir: directory(t), groups: ['open'], providerOptions: {
    apiKey: secret, model: 'offline-model-' + secret,
    fetch: async () => natural('纸袋飞船有一个临时的测试名 ' + secret + '，它穿过一片星云，最后平安回到了窗台。')
  } });
  assert.equal(summary.exitCode, EXIT.passed);
  for (const name of fs.readdirSync(summary.runDir)) {
    const text = fs.readFileSync(path.join(summary.runDir, name), 'utf8');
    assert.equal(text.includes('OFFLINE_'), false, name);
  }
  assert.match(record(summary).turns[0].result.answer, /\[REDACTED\]/);
  assert.match(JSON.parse(fs.readFileSync(path.join(summary.runDir, 'summary.json'), 'utf8')).model, /\[REDACTED\]/);
});

test('intent runner does not silently use local interpretation without model credentials', async t => {
  let calls = 0;
  const summary = await runEvaluation({ outDir: directory(t), caseIds: ['clock'], providerOptions: { apiKey: '', fetch: async () => { calls++; } } });
  assert.equal(summary.status, 'configuration_error');
  assert.equal(summary.exitCode, EXIT.api);
  assert.equal(summary.externalModelRun, false);
  assert.equal(summary.evidenceType, 'controlled_provider_runner_check');
  assert.equal(calls, 0);
  assert.deepEqual(summary.results, []);
});

test('intent runner supports short case selection and explicitly marked local baselines', async t => {
  assert.deepEqual(parseArgs(['--case', 'sleep-copula,write-shi', '--repeat', '2']), { caseIds: ['sleep-copula', 'write-shi'], repeat: 2 });
  const summary = await runEvaluation({ outDir: directory(t), mode: 'local', caseIds: ['clock'] });
  assert.equal(summary.externalModelRun, false);
  assert.equal(summary.evidenceType, 'local_rule_baseline');
  assert.equal(record(summary).turns[0].result.source, 'local');
  assert.equal(summary.apiCalls, 0);
});
