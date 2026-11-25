'use strict';

// Run a short group with the normal AI_* environment, for example:
// node --env-file-if-exists=.env.saas.local tools/eval-assistant-intent.cjs --group award
// Only synthetic in-memory records are used. No SaaS server or database is opened.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const Model = require('../model.js');
const { createAssistantService } = require('../assistant-service.cjs');

const ROOT = path.resolve(__dirname, '..');
const FIXED_NOW = '2026-11-25T09:37:00+08:00';
const FAMILY_DAY = '2026-11-25';
const EXIT = Object.freeze({ passed: 0, behavior: 1, api: 2, mixed: 3 });
const rowsOf = result => result?.kind === 'steps' ? result.steps : result ? [result] : [];
const draftsOf = result => rowsOf(result).filter(row => row.kind === 'action' || row.kind === 'form');
const wordingOf = result => rowsOf(result).map(row => row.question || row.answer || row.summary || row.title || '').join('\n');
const normalizedName = text => typeof text === 'string' ? text.replace(/[\s“”「」『』"'，,。.!！]/g, '') : text;

function createFixture() {
  const state = Model.createEmptyFamily({ childName: '合成评测孩子' }, new Date(FIXED_NOW));
  // The outside-range and future rows catch accidental all-time and off-by-one queries.
  state.points = [
    ['outside-range', '2026-11-22', 100],
    ['recent-first', '2026-11-23', 2],
    ['recent-second', '2026-11-24', 5],
    ['recent-third', '2026-11-25', 10],
    ['future-row', '2026-11-26', 1000]
  ].map(([id, date, points]) => ({ id, name: '合成阅读记录', points, reason: '仅用于意图评测', at: date + 'T08:00:00+08:00' }));
  state.rewards = [{ id: 'synthetic-eraser', name: '合成橡皮', points: 4, category: 'daily', icon: 'pencil', enabled: true }];
  state.redemptions = [{ id: 'recent-spend', rewardId: 'synthetic-eraser', name: '合成橡皮', points: 4,
    category: 'daily', note: '仅用于区分加分和净变化', at: '2026-11-24T10:00:00+08:00' }];
  return state;
}

function noCandidates(result, check) {
  check('no_business_candidate', draftsOf(result).length === 0, 0, draftsOf(result).length);
}

function award(name, points) {
  return (result, check) => {
    const drafts = draftsOf(result), candidate = drafts[0];
    check('exactly_one_candidate', drafts.length === 1, 1, drafts.length);
    check('one_time_award', candidate?.action?.type === 'points.add', 'points.add', candidate?.action?.type || candidate?.form || null);
    const payload = candidate?.action?.payload;
    check('behavior_name', normalizedName(payload?.name) === normalizedName(name), name, payload?.name ?? null);
    check('score', payload?.points === points, points, payload?.points ?? null);
  };
}

function clarify(result, check, pattern) {
  noCandidates(result, check);
  const texts = rowsOf(result).filter(row => row.kind === 'clarify' || row.kind === 'answer' && row.scope === 'conversation').map(row => row.question || row.answer || '');
  // Both natural replies and ask_clarification are valid. A statement merely
  // mentioning the missing field is insufficient; it must actually ask for it.
  const questions = texts.filter(text => /[?？]|哪(?:天|一天|个|一日)|何时|从何|多少|几分|是否|是不是|吗|呢|(?:请|麻烦|需要)(?:[^。！？?\n]{0,80})(?:告诉|补充|说明|提供|选择|确认|核对|明确)/.test(text));
  check('asks_for_clarification', questions.length > 0, 'question or request for missing information', texts);
  check('clarification_addresses_missing_information', questions.some(question => pattern.test(question)), pattern.source, questions);
  return questions;
}

function recentThreeDays(result, check) {
  noCandidates(result, check);
  const query = rowsOf(result).find(row => ['ledger', 'week'].includes(row.query?.type));
  check('reads_actual_records', !!query, 'ledger or summary query', rowsOf(result).map(row => row.query || null));
  check('three_day_start', query?.data?.from === '2026-11-23', '2026-11-23', query?.data?.from ?? null);
  check('three_day_end', query?.data?.to === FAMILY_DAY, FAMILY_DAY, query?.data?.to ?? null);
  check('actual_earned_total', query?.data?.earned === 17, 17, query?.data?.earned ?? null);
  check('actual_spent_total', query?.data?.spent === 4, 4, query?.data?.spent ?? null);
  check('earned_differs_from_net', query?.data?.earned - query?.data?.spent === 13 && query?.data?.earned !== 13, 'earned 17, spent 4, net 13', query?.data ? { earned: query.data.earned, spent: query.data.spent } : null);
}

function clock(result, check) {
  noCandidates(result, check);
  check('answers_fixed_family_time', rowsOf(result).some(row => row.kind === 'answer' && /(?:09|9)[:：]37|(?:九|9)[点时](?:三十七|37)/.test(row.answer || '')), '09:37 Asia/Shanghai', wordingOf(result));
}

const CASES = [
  { id: 'sleep-copula', group: 'award', turns: [
    { text: '睡觉不做噩梦是加100分。', expect: award('睡觉不做噩梦', 100) }
  ] },
  { id: 'sleep-comma', group: 'award', turns: [
    { text: '睡觉不做噩梦，加一百分。', expect: award('睡觉不做噩梦', 100) }
  ] },
  { id: 'write-shi', group: 'award', turns: [
    { text: '练习写“是”字加5分', expect: award('练习写“是”字', 5) }
  ] },
  { id: 'bag-filler', group: 'award', turns: [
    { text: '主动收拾书包，呃，加三分', expect: award('主动收拾书包', 3) }
  ] },
  { id: 'ordinal-needs-start', group: 'date', turns: [
    { text: '第三天加了多少分', expect(result, check) {
      clarify(result, check, /从|开始|起点|起始|哪天|哪一天|日期|参照|基准/);
      check('no_unanchored_query', !rowsOf(result).some(row => row.query), 'ask for the starting date before querying', rowsOf(result).map(row => row.query || null));
    } },
    { text: '最近三天', expect: recentThreeDays }
  ] },
  { id: 'recent-three-days', group: 'date', turns: [
    { text: '最近三天加了多少分', expect: recentThreeDays }
  ] },
  { id: 'bath-clarify', group: 'dialogue', turns: [
    { text: '自己刷牙加一分', expect: award('自己刷牙', 1) },
    { text: '自己洗澡加衣', expect(result, check) {
      const questions = clarify(result, check, /洗澡/);
      check('checks_possible_one_point', questions.some(question => /洗澡/.test(question) && /(?:1|一)\s*(?:积分|分)/.test(question)), 'ask whether the new bathing behavior means +1 point', questions);
    } },
    { text: '5分', expect: award('自己洗澡', 5) }
  ] },
  { id: 'bath-cancel', group: 'dialogue', turns: [
    { text: '自己洗澡加5分', expect: award('自己洗澡', 5) },
    { text: '这笔先不记了', expect(result, check) {
      noCandidates(result, check);
      check('cancels_pending_draft', result.cancelDraft === true, true, result.cancelDraft ?? false);
    } }
  ] },
  { id: 'explicit-no-award', group: 'negative', turns: [
    { text: '不要给自己洗澡加分，这次先不记。', expect: noCandidates }
  ] },
  { id: 'clock', group: 'time', turns: [
    { text: '现在几点钟', expect: clock }
  ] },
  { id: 'open-creative', group: 'open', review: {
    scope: 'Automatic checks verify response form only; they do not grade relevance, helpfulness, or creativity.',
    criteria: ['是否围绕旧纸袋作为宇宙飞船展开，而非返回通用功能介绍', '是否给出一个名字及两句话的小冒险；措辞和故事内容不预设答案', '是否把创意内容当作虚构，而未声称办理了家庭业务']
  }, turns: [
    { text: '家里的旧纸袋想当一艘宇宙飞船。请给它起个名字，再编一段两句话的小冒险。', expect(result, check) {
      noCandidates(result, check);
      check('no_unrequested_record_query', !rowsOf(result).some(row => row.query), 'conversation without a family-record query', rowsOf(result).map(row => row.query || null));
      const replies = rowsOf(result).filter(row => row.kind === 'answer' && row.scope === 'conversation' && typeof row.answer === 'string');
      check('substantive_conversation_reply', replies.some(row => row.answer.trim().length >= 24), 'nonempty conversational reply of at least 24 characters; content quality requires review', wordingOf(result));
    } }
  ] }
];

function selectCases(groups = [], caseIds = []) {
  const knownGroups = new Set(CASES.map(item => item.group));
  if (groups.some(group => group !== 'all' && !knownGroups.has(group))) throw new Error('UNKNOWN_GROUP');
  if (caseIds.some(id => !CASES.some(item => item.id === id))) throw new Error('UNKNOWN_CASE');
  const selected = CASES.filter(item => (!groups.length || groups.includes('all') || groups.includes(item.group)) && (!caseIds.length || caseIds.includes(item.id)));
  if (!selected.length) throw new Error('NO_CASES_SELECTED');
  return selected;
}

function sourceHashes() {
  const files = ['tools/eval-assistant-intent.cjs', 'assistant-service.cjs', 'assistant-chat.cjs', 'assistant-tools.cjs', 'assistant.js', 'model.js', 'config/assistant/system.md', 'config/assistant/tools.json'];
  return Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex')]));
}

function outputWriter(runDir, apiKey) {
  const serialize = value => {
    return JSON.stringify(value, (_name, item) => typeof item === 'string' && apiKey ? item.split(apiKey).join('[REDACTED]') : item, 2) + '\n';
  };
  return (name, value) => {
    const target = path.join(runDir, name), temporary = target + '.tmp';
    fs.writeFileSync(temporary, serialize(value));
    fs.renameSync(temporary, target);
  };
}

function observedFetch(fetchImpl, calls) {
  return async (...args) => {
    const started = performance.now(), record = { httpStatus: null, durationMs: 0, errorCode: null };
    calls.push(record);
    try {
      const response = await fetchImpl(...args);
      record.httpStatus = response.status;
      return response;
    } catch (error) {
      record.errorCode = error?.name === 'AbortError' || args[1]?.signal?.aborted ? 'TIMEOUT_OR_ABORT' : 'NETWORK_ERROR';
      throw error;
    } finally { record.durationMs = Math.round(performance.now() - started); }
  };
}

function pendingStatus(draft) {
  if (!draft) return undefined;
  const actions = rowsOf(draft).map((row, index) => ({ row, index })).filter(({ row }) => ['action', 'form'].includes(row.kind));
  return { familyDay: FAMILY_DAY, sourceRevision: 1, actions: actions.map(({ row, index }) => ({ index, type: row.action?.type || 'pointItem.save', status: 'pending' })) };
}

async function runCase(item, attempt, context) {
  const { service, mode, evidenceType, calls, write, progress } = context;
  const state = createFixture(), original = JSON.stringify(state), messages = [];
  let draft = null;
  const record = { id: item.id, group: item.group, attempt, evidenceType, status: 'running', startedAt: new Date().toISOString(),
    ...(item.review ? { review: { status: 'pending', ...item.review } } : {}), turns: [] };
  const filename = item.id + '-r' + String(attempt).padStart(2, '0') + '.json';
  write(filename, record);
  for (const [index, turn] of item.turns.entries()) {
    progress({ caseId: item.id, attempt, turn: index + 1, turns: item.turns.length });
    const started = performance.now(), callOffset = calls.length;
    const observation = { index: index + 1, input: turn.text, status: 'running', checks: [] };
    record.turns.push(observation); write(filename, record);
    try {
      observation.result = await service.chat(turn.text, state, new Date(FIXED_NOW), {
        context: { view: 'points', form: 'assistant' }, messages, draft, draftStatus: pendingStatus(draft)
      });
    } catch (_) {
      // The production service deliberately hides provider details. Keep only its
      // failure category and HTTP metadata, never the exception text or headers.
      observation.status = 'api_error'; observation.errorCode = 'ASSISTANT_UNAVAILABLE';
    }
    observation.durationMs = Math.round(performance.now() - started);
    observation.api = calls.slice(callOffset);
    const check = (name, passed, expected, actual) => observation.checks.push({ name, passed: !!passed, expected, actual });
    check('business_state_unchanged', JSON.stringify(state) === original, true, JSON.stringify(state) === original);
    if (observation.result) {
      const expectedSource = mode === 'model' ? 'model' : 'local';
      check('actual_response_source', observation.result.source === expectedSource, expectedSource, observation.result.source ?? null);
      check('actual_response_mode', observation.result.mode === (mode === 'model' ? 'connected' : 'local'), mode === 'model' ? 'connected' : 'local', observation.result.mode ?? null);
      turn.expect(observation.result, check);
      observation.status = observation.checks.every(row => row.passed) ? 'passed' : 'behavior_failure';
      messages.push({ role: 'user', text: turn.text }, { role: 'assistant', text: wordingOf(observation.result) });
      if (observation.result.cancelDraft) draft = null;
      else if (draftsOf(observation.result).length) draft = observation.result;
    }
    write(filename, record);
    if (observation.status !== 'passed') break;
  }
  record.status = record.turns.at(-1).status;
  if (record.review && record.status !== 'passed') record.review.status = 'blocked_by_automated_failure';
  record.skippedTurns = item.turns.length - record.turns.length;
  record.durationMs = record.turns.reduce((sum, row) => sum + row.durationMs, 0);
  record.finishedAt = new Date().toISOString(); write(filename, record);
  return { id: item.id, group: item.group, attempt, status: record.status, durationMs: record.durationMs, skippedTurns: record.skippedTurns,
    ...(record.review ? { reviewStatus: record.review.status } : {}), file: filename };
}

function validateOptions(options) {
  if (!['model', 'local'].includes(options.mode)) throw new Error('INVALID_MODE');
  if (!Number.isSafeInteger(options.repeat) || options.repeat < 1 || options.repeat > 20) throw new Error('INVALID_REPEAT');
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60000) throw new Error('INVALID_TIMEOUT');
}

async function runEvaluation(options = {}) {
  const mode = options.mode || 'model', repeat = options.repeat ?? 1, timeoutMs = options.timeoutMs ?? 12000;
  validateOptions({ mode, repeat, timeoutMs });
  const selected = selectCases(options.groups || (options.caseIds?.length ? [] : ['award']), options.caseIds || []);
  const base = path.resolve(options.outDir || path.join(ROOT, 'data', 'assistant-intent-' + Model.dateKey(new Date(), 'Asia/Shanghai').replace(/-/g, '')));
  const runDir = path.join(base, 'run-' + new Date().toISOString().replace(/[^0-9TZ]/g, '') + '-' + crypto.randomBytes(3).toString('hex'));
  fs.mkdirSync(runDir, { recursive: true });
  const provider = options.providerOptions || {}, apiKey = mode === 'local' ? '' : (provider.apiKey ?? process.env.AI_API_KEY ?? '');
  const evidenceType = mode === 'local' ? 'local_rule_baseline' : provider.fetch ? 'controlled_provider_runner_check' : 'configured_provider_intent_check';
  const write = outputWriter(runDir, apiKey), calls = [];
  const summary = { version: 2, status: 'running', requestedMode: mode, evidenceType, externalModelRun: mode === 'model' && !provider.fetch,
    transport: mode === 'local' ? 'local_no_network' : provider.fetch ? 'injected_fetch_not_a_real_model_verification' : 'normal_provider_fetch', fixedNow: FIXED_NOW,
    assessmentScope: 'Exit code and status report automatic assertions only. Open-ended content has a separate pending human review.',
    boundary: 'Synthetic in-memory family only; service.chat interpretation, no SaaS persistence, microphone, UI, or real parent authorization.',
    startedAt: new Date().toISOString(), runDir, sourceHashes: sourceHashes(), selectedCaseIds: selected.map(item => item.id),
    omittedCaseIds: CASES.filter(item => !selected.includes(item)).map(item => item.id), repeat, timeoutMs, plannedCaseRuns: selected.length * repeat, results: [] };
  const progress = current => write('progress.json', { status: summary.status, updatedAt: new Date().toISOString(), completedCaseRuns: summary.results.length, plannedCaseRuns: summary.plannedCaseRuns, current });
  write('summary.json', summary); progress(null);
  let service;
  try {
    service = createAssistantService({ ...provider, apiKey, chatEnabled: mode === 'model', formOnly: false, timeoutMs,
      fetch: observedFetch(provider.fetch || global.fetch, calls) });
    summary.chatStatus = service.chatStatus();
    if (mode === 'model' && summary.chatStatus.mode !== 'connected') throw new Error('AI_API_KEY_REQUIRED');
    summary.model = mode === 'model' ? (provider.model || process.env.AI_MODEL || 'gpt-4.1-mini') : null;
  } catch (_) {
    summary.status = 'configuration_error'; summary.errorCode = 'AI_CONFIGURATION_INVALID_OR_MISSING'; summary.exitCode = EXIT.api;
    summary.externalModelRun = false; summary.finishedAt = new Date().toISOString();
    write('summary.json', summary); progress(null); return summary;
  }
  for (let attempt = 1; attempt <= repeat; attempt++) {
    for (const item of selected) {
      const result = await runCase(item, attempt, { service, mode, evidenceType, calls, write, progress });
      summary.results.push(result); write('summary.json', summary); progress(null);
      if (options.onCase) options.onCase(result);
    }
  }
  summary.counts = { passed: 0, behavior_failure: 0, api_error: 0 };
  for (const result of summary.results) summary.counts[result.status]++;
  summary.exitCode = (summary.counts.behavior_failure ? EXIT.behavior : 0) | (summary.counts.api_error ? EXIT.api : 0);
  summary.status = summary.exitCode ? 'failed' : 'passed';
  summary.pendingHumanReviews = summary.results.filter(result => result.reviewStatus === 'pending').map(result => ({ id: result.id, attempt: result.attempt, file: result.file }));
  summary.finishedAt = new Date().toISOString(); summary.apiCalls = calls.length;
  write('summary.json', summary); progress(null);
  return summary;
}

function parseArgs(args) {
  const options = {}, groups = [], caseIds = [];
  const names = { '--group': 'groups', '--case': 'caseIds', '--mode': 'mode', '--repeat': 'repeat', '--timeout-ms': 'timeoutMs', '--out': 'outDir' };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '--list') { options[arg.slice(2)] = true; continue; }
    const name = names[arg], value = args[++index];
    if (!name || !value || value.startsWith('--')) throw new Error('INVALID_ARGUMENTS');
    if (name === 'groups') groups.push(...value.split(','));
    else if (name === 'caseIds') caseIds.push(...value.split(','));
    else options[name] = name === 'repeat' || name === 'timeoutMs' ? Number(value) : value;
  }
  if (groups.length) options.groups = groups;
  if (caseIds.length) options.caseIds = caseIds;
  return options;
}

function help() {
  return 'Usage: node [--env-file-if-exists=.env.saas.local] tools/eval-assistant-intent.cjs [options]\n' +
    '  --group award|date|dialogue|negative|time|open|all  (default: award; comma-separated allowed)\n' +
    '  --case ID[,ID]   Select individual cases; --list shows their inputs.\n' +
    '  --repeat 1..20   Independent repetitions, saved in a new run directory.\n' +
    '  --out DIRECTORY --timeout-ms 12000\n' +
    '  --mode model|local  Default model requires AI_API_KEY; local is explicitly not a model evaluation.\n' +
    '  --list --help\n' +
    'Exit: 0 automatic checks passed; 1 behavioral failure; 2 API/service/configuration error; 3 both.\n' +
    'Open-ended content needs the separate human review saved with its response; an automatic pass does not grade content quality.\n' +
    'Service exceptions (including rejected provider protocols) are API/service errors; returned results failing intent checks are behavioral failures.\n' +
    'Each turn/case and current progress are saved. Failed cases stop before later dependent turns.\n';
}

async function main(args) {
  let options;
  try { options = parseArgs(args); }
  catch (_) { console.error('INVALID_ARGUMENTS\n' + help()); return EXIT.api; }
  if (options.help) { console.log(help()); return EXIT.passed; }
  if (options.list) {
    console.log(JSON.stringify(CASES.map(({ id, group, turns, review }) => ({ id, group, inputs: turns.map(turn => turn.text), ...(review ? { requiresHumanReview: true } : {}) })), null, 2));
    return EXIT.passed;
  }
  try {
    const summary = await runEvaluation({ ...options, onCase: row => console.log(row.id + ' r' + row.attempt + ': ' + row.status + ' (' + row.durationMs + ' ms)') });
    console.log('Result: ' + summary.status + '; evidence: ' + summary.runDir);
    if (summary.pendingHumanReviews?.length) console.log('Human review pending: ' + summary.pendingHumanReviews.length + ' open-ended response(s).');
    return summary.exitCode;
  } catch (_) { console.error('EVALUATION_CONFIGURATION_OR_OUTPUT_ERROR; use --help.'); return EXIT.api; }
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; });
module.exports = { runEvaluation, selectCases, parseArgs, createFixture, FIXED_NOW, EXIT };
