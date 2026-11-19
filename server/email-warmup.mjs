import { z } from 'zod';
import { AppError } from './model.mjs';

const dayMs=24*60*60*1000;
export const warmupSchema=z.object({
 startDaily:z.number().int().min(1).max(10000),
 dailyIncrease:z.number().int().min(1).max(1000),
 targetDaily:z.number().int().min(1).max(10000),
 restart:z.boolean().default(false)
}).superRefine((value,ctx)=>{
 if(value.targetDaily<value.startDaily)ctx.addIssue({code:'custom',message:'The target must be at least the starting daily allowance.'});
});

export function warmupState(connection,now=Date.now()){
 const plan=connection.channel==='email'?connection.config?.warmup:null;
 if(!plan||plan.status==='disabled')return {status:'disabled',dailyLimit:connection.daily_limit,hourlyLimit:connection.hourly_limit,plan:plan||null};
 const elapsed=Math.max(0,plan.elapsedMs+(plan.status==='active'?now-Date.parse(plan.resumedAt):0));
 const days=Math.floor(elapsed/dayMs),allowance=Math.min(plan.targetDaily,plan.startDaily+days*plan.dailyIncrease);
 const dailyLimit=Math.min(connection.daily_limit,allowance);
 return {
  status:plan.status==='paused'?'paused':allowance>=plan.targetDaily?'completed':'active',
  day:days+1,dailyLimit,hourlyLimit:Math.min(connection.hourly_limit,dailyLimit),
  nextIncreaseAt:plan.status==='active'&&allowance<plan.targetDaily?new Date(now+dayMs-elapsed%dayMs).toISOString():null,
  plan
 };
}

export function configureWarmup(connection,input,now=Date.now()){
 const settings=warmupSchema.parse(input);
 if(connection.channel!=='email')throw new AppError(400,'Email warmup requires an email connection.');
 if(!connection.enabled||!connection.verified_at)throw new AppError(400,'Verify and enable the email connection before starting warmup.');
 if(settings.targetDaily>connection.daily_limit)throw new AppError(400,'The warmup target cannot exceed the connection daily limit.');
 const previous=connection.config?.warmup;
 const fresh=settings.restart||!previous||previous.status==='disabled';
 return {startDaily:settings.startDaily,dailyIncrease:settings.dailyIncrease,targetDaily:settings.targetDaily,
  status:fresh?'active':previous.status,elapsedMs:fresh?0:previous.elapsedMs,
  startedAt:fresh?new Date(now).toISOString():previous.startedAt,
  resumedAt:fresh?new Date(now).toISOString():previous.resumedAt};
}

export function changeWarmupStatus(connection,status,now=Date.now()){
 const previous=connection.config?.warmup;
 if(connection.channel!=='email'||!previous||previous.status==='disabled')throw new AppError(409,'Start an email warmup plan first.');
 if(status==='active'&&(!connection.enabled||!connection.verified_at))throw new AppError(400,'Verify and enable the email connection before resuming warmup.');
 if(previous.status===status)return previous;
 return {...previous,status,
  elapsedMs:previous.elapsedMs+(previous.status==='active'?Math.max(0,now-Date.parse(previous.resumedAt)):0),
  resumedAt:new Date(now).toISOString()};
}

export async function warmupOverview(client,connection){
 const state=warmupState(connection);
 const usage=(await client.query(`SELECT count(*) FILTER(WHERE created_at>now()-interval '24 hours')::int AS daily,
  count(*) FILTER(WHERE created_at>now()-interval '1 hour')::int AS hourly,
  count(*) FILTER(WHERE status IN ('accepted','delivered','read','replied') AND created_at>now()-interval '24 hours')::int AS accepted
  FROM outreach_deliveries WHERE connection_id=$1 AND status<>'skipped'`,[connection.id])).rows[0];
 return {...state,connectionDailyLimit:connection.daily_limit,connectionHourlyLimit:connection.hourly_limit,
  sendingEnabled:!!(connection.enabled&&connection.verified_at),usage,
  remainingDaily:Math.max(0,state.dailyLimit-usage.daily),remainingHourly:Math.max(0,state.hourlyLimit-usage.hourly)};
}
