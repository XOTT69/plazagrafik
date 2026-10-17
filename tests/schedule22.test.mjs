import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmed22,choosePosts,format22,kyivDate,validatedPeriods,emergencyWarning,SOURCE_URL} from '../src/schedule22.js';
import {Group22Publisher,checkDtekAndPublish} from '../src/index.js';

const DATE='2026-10-17';
const GROUPS=Array.from({length:6},(_,i)=>[String(i+1)+'.1',String(i+1)+'.2']).flat();
const feed=(intervals=[[0,60],[900,1140]])=>({
  confirmedSchedules:{[DATE]:Object.fromEntries(GROUPS.map(g=>[g,g==='2.2'?intervals:[]]))},
  emergency:{status:{active:true,kind:'екстрені',scope:'districts',districts:['Бучанський']}}
});
const storage=()=>{
  const data=new Map();
  return {get:k=>Promise.resolve(data.get(k)),put:(k,v)=>{data.set(k,v);return Promise.resolve();},
    delete:k=>{data.delete(k);return Promise.resolve();},data};
};
function reply(body,status=200) {
  return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
}

test('uses confirmed subgroup 2.2 and never parses incomplete/preset posts',()=>{
  const data=feed();
  assert.deepEqual(confirmed22(data,DATE),[[0,60],[900,1140]]);
  delete data.confirmedSchedules[DATE]['3.1'];
  assert.equal(confirmed22(data,DATE),null);
  assert.equal(confirmed22({preset:{data:{}}},DATE),null);
});
test('validates half-hour endpoints and refuses overlaps',()=>{
  assert.deepEqual(validatedPeriods([[570,690],[900,1440]]),[[570,690],[900,1440]]);
  assert.equal(validatedPeriods([[11,690]]),null);
  assert.equal(validatedPeriods([[900,800]]),null);
  assert.equal(validatedPeriods([[0,60],[30,90]]),null);
});
test('formats Telegram-compatible 2.2 schedule and emergency caveat',()=>{
  const text=format22(DATE,[[0,60],[900,1140]],{
    today:DATE,emergency:feed().emergency.status
  });
  assert.match(text,/Підгрупа 2\.2 відключення:/);
  assert.match(text,/❌з 00:00 до 01:00 \(1\.0 год\)/);
  assert.match(text,/❌з 15:00 до 19:00 \(4\.0 год\)/);
  assert.match(text,/Разом без світла: 5\.0 год/);
  assert.match(text,/Бучанський район/);
  assert.doesNotMatch(text,/Підгрупа 1\.2/);
  assert.match(emergencyWarning({active:true,kind:'аварійні',districts:[]}),/поза графіком/);
});
test('timezone selects today and tomorrow only for confirmed days',()=>{
  const now=new Date('2026-10-16T22:20:00Z');
  assert.equal(kyivDate(now),'2026-10-17');
  const posts=choosePosts(feed(),now);
  assert.equal(posts.length,1);
  assert.equal(posts[0].date,DATE);
  assert.match(posts[0].text,/на сьогодні/);
  assert.match(SOURCE_URL,/XOTT69\/dtek/);
});
test('ignores any manual Telegram webhook post',async()=>{
  const {default:worker}=await import('../src/index.js');
  const response=await worker.fetch(new Request('https://example.workers.dev/telegram',{
    method:'POST',body:JSON.stringify({channel_post:{text:'💡 Графік 2.2'}})
  }),{BOT_TOKEN:'x',CHANNEL_ID:'y'});
  assert.equal(response.status,200);
  assert.equal(await response.text(),'OK');
});
test('one post per date, same ID edited on a real schedule change',async()=>{
  const calls=[];
  const testFetch=async(url,request)=>{
    const path=String(url).split('/').pop();
    const payload=JSON.parse(request.body);
    calls.push([path,payload]);
    if(path==='sendMessage')return reply({ok:true,result:{message_id:85}});
    if(path==='editMessageText')return reply({ok:true,result:{message_id:85}});
    throw Error(path);
  };
  const state={storage:storage()};
  const object=new Group22Publisher(state,{
    BOT_TOKEN:'fake',CHANNEL_ID:'-100123',TEST_FETCH:testFetch
  });
  const post=async text=>{
    const response=await object.fetch(new Request('https://state.internal/publish',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({date:DATE,text})
    }));
    return response.json();
  };
  const a=format22(DATE,[[0,60]],{today:DATE});
  const b=format22(DATE,[[0,120]],{today:DATE});
  assert.equal((await post(a)).status,'published');
  assert.equal((await post(a)).status,'unchanged');
  assert.equal((await post(b)).status,'edited');
  assert.deepEqual(calls.map(x=>x[0]),['sendMessage','editMessageText']);
  assert.equal(calls[1][1].message_id,85);
});
test('parallel cron calls do not send duplicates',async()=>{
  let sends=0;
  const object=new Group22Publisher({storage:storage()},{
    BOT_TOKEN:'fake',CHANNEL_ID:'-100123',
    TEST_FETCH:async()=>{sends++;return reply({ok:true,result:{message_id:4}});}
  });
  const message=format22(DATE,[[0,60]],{today:DATE});
  const send=()=>object.fetch(new Request('https://state.internal/publish',{
    method:'POST',body:JSON.stringify({date:DATE,text:message})
  }));
  const results=await Promise.all([send(),send(),send()]);
  assert.equal(sends,1);
  assert.deepEqual((await Promise.all(results.map(r=>r.json()))).map(r=>r.status),
    ['published','unchanged','unchanged']);
});
test('network failure leaves pending state rather than risking a duplicate',async()=>{
  let called=0;
  const object=new Group22Publisher({storage:storage()},{
    BOT_TOKEN:'fake',CHANNEL_ID:'-100123',
    TEST_FETCH:async()=>{called++;throw new Error('timeout');}
  });
  const text=format22(DATE,[[0,60]],{today:DATE});
  const send=()=>object.fetch(new Request('https://state.internal/publish',{
    method:'POST',body:JSON.stringify({date:DATE,text})
  }));
  assert.equal((await (await send()).json()).status,'error');
  assert.equal((await (await send()).json()).status,'pending');
  assert.equal(called,1);
});
test('definite Telegram 403 is retried on a later run after permissions fixed',async()=>{
  let called=0;
  const object=new Group22Publisher({storage:storage()},{
    BOT_TOKEN:'fake',CHANNEL_ID:'-100123',
    TEST_FETCH:async()=>++called===1?
      reply({ok:false,description:'Forbidden'},403):reply({ok:true,result:{message_id:23}})
  });
  const text=format22(DATE,[[0,60]],{today:DATE});
  const send=()=>object.fetch(new Request('https://state.internal/publish',{
    method:'POST',body:JSON.stringify({date:DATE,text})
  }));
  assert.equal((await (await send()).json()).status,'error');
  assert.equal((await (await send()).json()).status,'published');
  assert.equal(called,2);
});
test('cron reads confirmed feed and passes it to persistent publisher',async()=>{
  const posted=[];
  const env={SCHEDULE_STATE:{
    idFromName:()=>1,get:()=>({
      fetch:async(_url,opts)=>{posted.push(JSON.parse(opts.body));return reply({status:'published'});}
    })
  }};
  const result=await checkDtekAndPublish(env,{
    now:new Date('2026-10-16T22:20:00Z'),
    fetchFn:async()=>reply(feed())
  });
  assert.equal(posted.length,1);
  assert.equal(result[0].status,'published');
  assert.equal(posted[0].date,DATE);
});
