import test from 'node:test';
import assert from 'node:assert/strict';
import { configureWarmup,changeWarmupStatus,warmupState,warmupSchema } from '../server/email-warmup.mjs';

const day=86400000,started=Date.parse('2026-10-01T10:00:00Z');
const mailbox=()=>({channel:'email',enabled:true,verified_at:new Date(started),daily_limit:100,hourly_limit:20,config:{}});
const attach=(connection,plan)=>({...connection,config:{...connection.config,warmup:plan}});

test('warmup increases only after full active days and retains its target cap after completion',()=>{
 let connection=mailbox();connection=attach(connection,configureWarmup(connection,{startDaily:5,dailyIncrease:5,targetDaily:30},started));
 assert.equal(warmupState(connection,started).dailyLimit,5);
 assert.equal(warmupState(connection,started+day-1).dailyLimit,5);
 assert.equal(warmupState(connection,started+day).dailyLimit,10);
 assert.equal(warmupState(connection,started+day).day,2);
 assert.equal(warmupState(connection,started).hourlyLimit,5);
 assert.equal(warmupState(connection,started+10*day).dailyLimit,30);
 assert.equal(warmupState(connection,started+10*day).status,'completed');
 assert.equal(warmupState(connection,started+10*day).nextIncreaseAt,null);
 assert.equal(warmupState({...connection,daily_limit:3},started+10*day).dailyLimit,3);
 assert.equal(warmupState({...connection,channel:'sms'},started).dailyLimit,100);
});

test('pause freezes the allowance and resume preserves partial progress without counting paused days',()=>{
 let connection=mailbox();connection=attach(connection,configureWarmup(connection,{startDaily:5,dailyIncrease:5,targetDaily:100},started));
 connection=attach(connection,changeWarmupStatus(connection,'paused',started+day/2));
 assert.equal(warmupState(connection,started+10*day).dailyLimit,5);
 assert.equal(warmupState(connection,started+10*day).nextIncreaseAt,null);
 assert.deepEqual(changeWarmupStatus(connection,'paused',started+10*day),connection.config.warmup);
 connection=attach(connection,changeWarmupStatus(connection,'active',started+10*day));
 assert.equal(warmupState(connection,started+10*day+day/2-1).dailyLimit,5);
 assert.equal(warmupState(connection,started+10*day+day/2).dailyLimit,10);
 assert.equal(warmupState(connection,started+10*day).nextIncreaseAt,new Date(started+10*day+day/2).toISOString());
});

test('editing preserves the clock, restart resets it, and turning off restores connection limits',()=>{
 let connection=mailbox();connection=attach(connection,configureWarmup(connection,{startDaily:5,dailyIncrease:5,targetDaily:100},started));
 connection=attach(connection,configureWarmup(connection,{startDaily:5,dailyIncrease:10,targetDaily:100},started+2*day));
 assert.equal(warmupState(connection,started+2*day).dailyLimit,25);
 connection=attach(connection,configureWarmup(connection,{startDaily:5,dailyIncrease:10,targetDaily:100,restart:true},started+2*day));
 assert.equal(warmupState(connection,started+2*day).dailyLimit,5);
 connection=attach(connection,changeWarmupStatus(connection,'disabled',started+2*day));
 assert.equal(warmupState(connection,started+2*day).dailyLimit,100);
 connection=attach(connection,configureWarmup(connection,{startDaily:2,dailyIncrease:2,targetDaily:10},started+3*day));
 assert.equal(warmupState(connection,started+3*day).day,1);
 assert.equal(warmupState(connection,started+3*day).dailyLimit,2);
});

test('warmup rejects invalid allowances, non-email accounts and unverified or disabled mailboxes',()=>{
 const settings={startDaily:5,dailyIncrease:5,targetDaily:100};
 for(const bad of [{startDaily:0},{dailyIncrease:0},{dailyIncrease:1.5},{targetDaily:4}])assert.equal(warmupSchema.safeParse({...settings,...bad}).success,false);
 for(const override of [{channel:'sms'},{enabled:false},{verified_at:null},{daily_limit:50}])assert.throws(()=>configureWarmup({...mailbox(),...override},settings,started),e=>e.status===400);
 assert.throws(()=>changeWarmupStatus(mailbox(),'active',started),e=>e.status===409);
 let connection=attach(mailbox(),configureWarmup(mailbox(),settings,started));
 connection=attach(connection,changeWarmupStatus(connection,'paused',started));
 assert.throws(()=>changeWarmupStatus({...connection,enabled:false},'active',started),e=>e.status===400);
 assert.equal(changeWarmupStatus({...connection,enabled:false},'disabled',started).status,'disabled');
});
