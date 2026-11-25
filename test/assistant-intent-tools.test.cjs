'use strict';
process.env.TZ = 'UTC';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../model.js');
const T = require('../assistant-tools.cjs');

const now = new Date('2026-11-25T08:30:00Z');

function ledgerState() {
  const state = M.createSeed(now);
  state.points = [
    {id:'before',name:'范围外',points:1000,at:'2026-11-22T15:59:59.999Z'},
    {id:'first',name:'阅读',points:3,at:'2026-11-22T16:00:00Z'},
    {id:'second',name:'收拾玩具',points:7,at:'2026-11-24T15:59:59.999Z'},
    {id:'third',name:'自己洗澡',points:11,at:'2026-11-24T16:00:00Z'},
    {id:'after',name:'明天',points:1000,at:'2026-11-25T16:00:00Z'}
  ];
  state.redemptions = [{id:'gift',rewardId:'gift-reward',name:'礼品',points:6,category:'daily',at:'2026-11-23T08:00:00Z'}];
  state.petPurchases = [{id:'partner',itemId:'snack',name:'伙伴道具',quantity:1,unitPoints:3,points:3,at:'2026-11-24T08:00:00Z'}];
  return state;
}

test('recent three-day totals use Shanghai calendar days and remain complete in a summary', () => {
  const state = ledgerState(), before = JSON.stringify(state);
  const result = T.executeTool('read_ledger',{days:3,limit:1,summaryOnly:true},state,now);
  assert.equal(result.kind,'answer');
  assert.equal(result.data.from,'2026-11-23');
  assert.equal(result.data.to,'2026-11-25');
  assert.equal(result.data.total,5);
  assert.equal(result.data.earned,21);
  assert.equal(result.data.spent,9);
  assert.match(result.answer,/获得 21 分/);
  assert.match(result.answer,/消费 9 分/);
  assert.doesNotMatch(result.answer,/自己洗澡|仅显示/);
  assert.equal(JSON.stringify(state),before);
});

test('limiting ledger details does not hide or reduce the full earned and spent totals', () => {
  const state = ledgerState(), before = JSON.stringify(state);
  const result = T.executeTool('read_ledger',{days:3,limit:1},state,now);
  assert.equal(result.kind,'answer');
  assert.equal(result.data.rows.length,1);
  assert.equal(result.data.total,5);
  assert.equal(result.data.hasMore,true);
  assert.equal(result.data.earned,21);
  assert.equal(result.data.spent,9);
  assert.match(result.answer,/获得 21 分/);
  assert.match(result.answer,/消费 9 分/);
  assert.match(result.answer,/仅显示前 1 条/);
  assert.equal(JSON.stringify(state),before);
});

test('behavior totals include every matching award even when result fitting removes details', () => {
  const state = ledgerState();
  state.pointItems = [{id:'read',name:'自主阅读',points:3,enabled:true}];
  state.points = Array.from({length:50},(_,index) => ({
    id:'read-'+index,itemId:'read',name:'自主阅读'+'片段'.repeat(55),points:index%5+1,
    at:'2026-11-'+(23+index%3)+'T08:00:00+08:00'
  }));
  state.points.push({id:'other',name:'收拾玩具',points:999,at:'2026-11-24T08:00:00+08:00'});
  const before = JSON.stringify(state);
  const complete = T.executeTool('read_ledger',{days:3,behavior:'阅读',limit:50},state,now);
  const result = T.fitResult(complete,state,now);
  assert.equal(result.kind,'answer');
  assert.ok(result.data.rows.length<50,'details should shrink to fit the response budget');
  assert.equal(result.data.total,50);
  assert.equal(result.data.earned,150);
  assert.ok(result.data.spent===0);
  assert.match(result.answer,/获得 150 分/);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<=18000);
  assert.equal(JSON.stringify(state),before);
});

test('empty summaries state zero and replay the same scope against current records', () => {
  const state = ledgerState();
  state.points = []; state.redemptions = []; state.petPurchases = [];
  const empty = T.executeTool('read_ledger',{days:3,summaryOnly:true},state,now);
  assert.equal(empty.kind,'answer');
  assert.equal(empty.data.total,0);
  assert.equal(empty.data.earned,0);
  assert.match(empty.answer,/获得 0 分/);
  state.points.push({id:'new',name:'阅读',points:6,at:'2026-11-24T08:00:00+08:00'});
  const before = JSON.stringify(state), refreshed = T.queryResult(empty.query,state,now);
  assert.equal(refreshed.data.from,'2026-11-23');
  assert.equal(refreshed.data.earned,6);
  assert.match(refreshed.answer,/获得 6 分/);
  assert.doesNotMatch(refreshed.answer,/\+6 分/);
  assert.equal(JSON.stringify(state),before);
});
