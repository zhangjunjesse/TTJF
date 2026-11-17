'use strict';
const assert = require('node:assert/strict');
const M = require('../model.js');
const zone = 'Asia/Shanghai';

function verifyCalendar() {
  const now = '2026-11-20T16:05:00.000Z';
  assert.equal(M.dateKey(now, zone), '2026-11-21');
  assert.deepEqual(M.calendarParts(now, zone), {year:2026,month:11,day:21,weekday:6,hour:0,minute:5,second:0,millisecond:0,date:'2026-11-21',time:'00:05'});
  assert.equal(M.calendarTimestamp('2026-11-21','00:04',zone), '2026-11-20T16:04:00.000Z');
  assert.equal(M.calendarTimestamp('2026-11-20','23:59',zone), '2026-11-20T15:59:00.000Z');
  assert.equal(M.dateKey('2026-11-21',zone), '2026-11-21', 'civil dates never shift');
  assert.equal(M.addDays('2024-02-28',1,zone),'2024-02-29');
  assert.equal(M.addDays('2024-02-28',2,zone),'2024-03-01');
  assert.equal(M.addDays('2026-12-31',1,zone),'2027-01-01');
  assert.equal(M.addDays('2011-12-29',1,zone),'2011-12-30','Shanghai has this day even on an Apia device');
  assert.throws(() => M.calendarTimestamp('2026-02-29','12:00',zone), /日期不存在/);
  assert.throws(() => M.calendarTimestamp('2026-11-21','24:00',zone), /时间/);
  assert.throws(() => M.calendarTimestamp('2026-11-21','',zone), /时间/);
  assert.throws(() => M.dateKey(now,'America/New_York'), /时区/);

  let state = M.createEmptyFamily({childName:'时区测试'},now);
  const act = action => { state = M.apply(state,action,now,zone); return state; };
  act({id:'credit',type:'points.add',name:'加分',points:100,reason:'同一家庭日',at:M.calendarTimestamp('2026-11-21','00:04',zone)});
  assert.equal(state.points[0].at,'2026-11-20T16:04:00.000Z','canonical UTC instants are never shifted');
  assert.throws(() => act({id:'yesterday',type:'points.add',name:'昨天',points:1,reason:'拒绝',at:'2026-11-20T15:59:00.000Z'}), /只能为今天/);
  assert.throws(() => act({id:'future',type:'points.add',name:'未来',points:1,reason:'拒绝',at:'2026-11-20T16:06:00.000Z'}), /不能晚于/);
  act({id:'weekend',type:'reward.save',reward:{name:'周末礼品',points:1,category:'weekend'}});
  act({id:'month-end',type:'reward.save',reward:{name:'月底礼品',points:1,category:'outing'}});
  assert.equal(M.availability(state,'reward-weekend',now,zone).allowed,true);
  assert.equal(M.availability(state,'reward-weekend','2026-11-20T15:59:00.000Z',zone).allowed,false);
  assert.equal(M.availability(state,'reward-month-end','2026-11-27T16:05:00.000Z',zone).allowed,true);
  assert.equal(M.availability(state,'reward-month-end','2026-11-27T15:59:00.000Z',zone).allowed,false);
  act({id:'request-weekend',type:'redemption.request',rewardId:'reward-weekend'});
  assert.equal(state.requests[0].createdAt,now);
  act({id:'today-task',type:'task.save',task:{title:'今日日程',type:'task',date:'2026-11-21',time:'00:04'}});
  act({id:'last-task',type:'task.save',task:{title:'后日日程',type:'task',date:'2026-11-23'}});
  assert.throws(() => act({id:'far-task',type:'task.save',task:{title:'越界',type:'task',date:'2026-11-24'}}), /今天、明天或后天/);
  assert.throws(() => act({id:'old-task',type:'task.save',task:{title:'昨天',type:'task',date:'2026-11-20'}}), /过去日期/);
  act({id:'snooze-task',type:'task.snooze',taskId:'task-today-task',minutes:10});
  assert.equal(state.tasks[0].snoozeUntil,'2026-11-20T16:15:00.000Z','snooze remains elapsed UTC duration');
  act({id:'farm',type:'farm.start'});
  act({id:'care-today',type:'farm.animalCare',animalId:'chicken',care:'feed'});
  assert.equal(state.farm.animalCare[0].day,'2026-11-21');
  assert.equal(state.farm.animalCare[0].at,now);
  act({id:'plant',type:'farm.plant',cropId:'carrot',plotIds:['p2']});
  assert.equal(state.farm.plots[1].readyAt,'2026-11-21T00:05:00.000Z','crop still matures after exactly eight hours');
  act({id:'pet-care',type:'pet.care',care:'wash',source:'free'});
  assert.equal(M.petStatus(state,now,zone).familyDay,'2026-11-21');
  assert.equal(state.petCare[0].day,'2026-11-21');
  assert.equal(state.petCare[0].farmMode,true);
  assert.deepEqual(M.petStatus(state,now,zone).caredToday,[],'farm interactions preserve the archived exploration semantics');
  assert.equal(M.frequentPointItems(state,now).length,0);

  const local = new Date(now);
  const localKey = String(local.getFullYear()) + '-' + String(local.getMonth()+1).padStart(2,'0') + '-' + String(local.getDate()).padStart(2,'0');
  assert.equal(M.dateKey(now),localKey,'omitting zone keeps legacy device-local semantics');
  assert.equal(M.calendarTimestamp(localKey,'12:00'),new Date(localKey+'T12:00:00').toISOString());
  assert.equal(M.calendarParts(now).hour,local.getHours());
  console.log('Shanghai business calendar verified on ' + process.env.TZ);
}

if (process.env.TTJF_CALENDAR_CASE === '1') {
  verifyCalendar();
} else {
  const test = require('node:test');
  const {spawnSync} = require('node:child_process');
  for (const timezone of ['Asia/Shanghai','America/Los_Angeles','UTC','Pacific/Apia']) {
    test('family calendar, UI preflight and elapsed-time rules on ' + timezone, () => {
      const child = spawnSync(process.execPath,[__filename],{env:{...process.env,TZ:timezone,TTJF_CALENDAR_CASE:'1'},stdio:'inherit',timeout:30000});
      assert.ifError(child.error);
      assert.equal(child.status,0,'isolated timezone assertions must pass');
    });
  }
}
