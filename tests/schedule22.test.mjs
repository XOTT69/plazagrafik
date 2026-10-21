import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmed22,choosePosts,format22,kyivDate,validatedPeriods,emergencyWarning,SOURCE_URL,scheduleFingerprint,scheduleFingerprintFromText} from '../src/schedule22.js';
import {Group22Publisher,checkDtekAndPublish,handleTelegramWebhook} from '../src/index.js';
import {parseForwardedGroup22} from '../src/manual-forward.js';

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
  assert.match(text,/Під час екстрених відключень/);
  assert.doesNotMatch(text,/Бучанський район/);
  assert.doesNotMatch(text,/Підгрупа 1\.2/);
  assert.match(emergencyWarning({active:true,kind:'аварійні',districts:[]}),/поза графіком/);
});
test('timezone selects today and tomorrow only for confirmed days',()=>{
  const now=new Date('2026-10-16T22:20:00Z');
  assert.equal(kyivDate(now),'2026-10-17');
  const posts=choosePosts(feed(),now);
  assert.equal(posts.length,1);
  assert.equal(posts[0].date,DATE);
  assert.match(posts[0].text,/Графік відключення світла/);
  assert.deepEqual(posts[0].periods,[[0,60],[900,1140]]);
  assert.match(SOURCE_URL,/XOTT69\/dtek/);
});
test('private webhook without Telegram shared secret is rejected',async()=>{
  const {default:worker}=await import('../src/index.js');
  const request=new Request('https://example.workers.dev/telegram',{
    method:'POST',body:JSON.stringify({message:{chat:{type:'private',id:1},from:{id:1},text:'bad'}})
  });
  assert.equal((await worker.fetch(request,{BOT_TOKEN:'x',CHANNEL_ID:'y'})).status,403);
});
test('signed channel posts never trigger re-publication loops',async()=>{
  const {default:worker}=await import('../src/index.js');
  const request=new Request('https://example.workers.dev/telegram',{
    method:'POST',
    headers:{'X-Telegram-Bot-Api-Secret-Token':'secret'},
    body:JSON.stringify({channel_post:{text:'💡 Графік 2.2'}})
  });
  assert.equal((await worker.fetch(request,{WEBHOOK_SECRET:'secret',BOT_TOKEN:'x',CHANNEL_ID:'y'})).status,200);
});
test('new post on a real 2.2 change; identical data or text-only changes do nothing',async()=>{
  const calls=[];
  let index=85;
  const testFetch=async(url,request)=>{
    const method=String(url).split('/').pop(),payload=JSON.parse(request.body);
    calls.push([method,payload]);
    assert.equal(method,'sendMessage');
    return reply({ok:true,result:{message_id:index++}});
  };
  const state={storage:storage()};
  const object=new Group22Publisher(state,{
    BOT_TOKEN:'fake',CHANNEL_ID:'-100123',TEST_FETCH:testFetch
  });
  const post=async (periods,text)=>{
    const response=await object.fetch(new Request('https://state.internal/publish',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({date:DATE,periods,text})
    }));
    return response.json();
  };
  const a=[[0,60]], b=[[0,120]];
  const original=format22(DATE,a,{today:DATE});
  const revised=format22(DATE,b,{today:DATE});
  assert.equal((await post(a,original)).messageId,85);
  assert.equal((await post(a,original+'  ')).status,'unchanged');
  assert.equal((await post(b,revised)).messageId,86);
  assert.equal((await post(b,revised)).status,'unchanged');
  assert.deepEqual(calls.map(x=>x[0]),['sendMessage','sendMessage']);
  assert.equal(state.storage.data.get('date:'+DATE).revision,2);
});

test('existing edited-day record migrates without sending duplicate on deployment',async()=>{
  let calls=0;
  const data=storage(), periods=[[0,60]];
  await data.put('date:'+DATE,{
    status:'published',messageId:99,text:format22(DATE,periods,{today:DATE})
  });
  const object=new Group22Publisher({storage:data},{
    BOT_TOKEN:'fake',CHANNEL_ID:'-100123',
    TEST_FETCH:async()=>{calls++;return reply({ok:true,result:{message_id:15}});}
  });
  const response=await object.fetch(new Request('https://state.internal/publish',{
    method:'POST',body:JSON.stringify({
      date:DATE,periods,text:format22(DATE,periods,{today:DATE})
    })
  }));
  assert.equal((await response.json()).status,'unchanged');
  assert.equal(calls,0);
  assert.equal(data.data.get('date:'+DATE).fingerprint,scheduleFingerprint(DATE,periods));
  assert.equal(scheduleFingerprintFromText(DATE,format22(DATE,periods,{today:DATE})),
    scheduleFingerprint(DATE,periods));
});

test('parallel cron calls do not send duplicates',async()=>{
  let sends=0;
  const object=new Group22Publisher({storage:storage()},{
    BOT_TOKEN:'fake',CHANNEL_ID:'-100123',
    TEST_FETCH:async()=>{sends++;return reply({ok:true,result:{message_id:4}});}
  });
  const message=format22(DATE,[[0,60]],{today:DATE});
  const send=()=>object.fetch(new Request('https://state.internal/publish',{
    method:'POST',body:JSON.stringify({date:DATE,periods:[[0,60]],text:message})
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
    method:'POST',body:JSON.stringify({date:DATE,periods:[[0,60]],text})
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
    method:'POST',body:JSON.stringify({date:DATE,periods:[[0,60]],text})
  }));
  assert.equal((await (await send()).json()).status,'error');
  assert.equal((await (await send()).json()).status,'published');
  assert.equal(called,2);
});
test('cron reads confirmed feed and passes it to persistent publisher',async()=>{
  const posted=[],diagnostics=[];
  const env={SCHEDULE_STATE:{
    idFromName:()=>1,get:()=>({
      fetch:async(url,opts)=>{
        const value=JSON.parse(opts.body);
        if(url.endsWith('/cron-record')){
          diagnostics.push(value);
          return reply({status:'recorded'});
        }
        posted.push(value);
        return reply({status:'published'});
      }
    })
  }};
  const result=await checkDtekAndPublish(env,{
    now:new Date('2026-10-16T22:20:00Z'),
    fetchFn:async()=>reply(feed())
  });
  assert.equal(posted.length,2,'one publication and one diagnostics heartbeat');
  assert.equal(result[0].status,'published');
  assert.equal(posted[0].date,DATE);
  assert.deepEqual(posted[1].results,[
    {date:DATE,status:'published'},
    {date:'2026-10-18',status:'no-confirmed-fact'}
  ]);
  assert.equal(diagnostics.length,1);
  assert.equal(diagnostics[0].status,'ok');
});


test('admin can forward a real dated 12-group message; parses only 2.2',()=>{
  const text=[
    '💡Оновлений графік відключення світла на сьогодні.',
    '📆Субота, 17.10.2026',
    '💡Підгрупа 1.2 відключення:',
    '❌з 06:00 до 08:30 (2.5 год)',
    '⚫ Разом без світла: 2.5 год',
    '💡Підгрупа 2.2 відключення:',
    '❌з 00:00 до 01:00 (1.0 год)',
    '❌з 15:00 до 19:00 (4.0 год)',
    '⚫ Разом без світла: 5.0 год',
    '💡Підгрупа 3.1 відключення:',
    '❌з 05:00 до 07:00'
  ].join('\n');
  const post=parseForwardedGroup22(text,new Date('2026-10-17T07:00:00Z'));
  assert.equal(post.date,DATE);
  assert.deepEqual(post.periods,[[0,60],[900,1140]]);
  assert.match(post.text,/Підгрупа 2.2 відключення/);
  assert.doesNotMatch(post.text,/06:00 до 08:30/);
  assert.equal(post.source,'manual');
});
test('manual forward parser ignores stale, undated, overlapping or irrelevant messages',()=>{
  const now=new Date('2026-10-17T08:00:00Z');
  const message=(date,body)=>[
    '📆'+date, '💡Підгрупа 2.2 відключення:',...body
  ].join('\n');
  assert.equal(parseForwardedGroup22(message('16.10.2026',['❌з 03:00 до 05:00']),now),null);
  assert.equal(parseForwardedGroup22(message('31.02.2026',['❌з 03:00 до 05:00']),now),null);
  assert.equal(parseForwardedGroup22('Підгрупа 2.2 відключення:\n❌з 03:00 до 05:00',now),null);
  assert.equal(parseForwardedGroup22(message('17.10.2026',[
    '❌з 03:00 до 05:00','❌з 04:30 до 06:30'
  ]),now),null);
  assert.equal(parseForwardedGroup22('📆17.10.2026\nЗмінено підгрупи: 2.2',now),null);
  const empty=parseForwardedGroup22(
    message('17.10.2026',['✅ Відключень за графіком немає.']),now);
  assert.deepEqual(empty.periods,[]);
});
test('only signed private messages from admin can submit manual schedule',async()=>{
  const posts=[],replies=[];
  const env={
    BOT_TOKEN:'fake',CHANNEL_ID:'-100123',WEBHOOK_SECRET:'safe-telegram',
    ADMIN_TELEGRAM_ID:'100',
    SCHEDULE_STATE:{idFromName:()=>1,get:()=>({
      fetch:async(_url,options)=>{
        posts.push(JSON.parse(options.body));
        return reply({status:'published',messageId:55});
      }
    })},
    TEST_FETCH:async(_url,options)=>{
      replies.push(JSON.parse(options.body));
      return reply({ok:true,result:{message_id:999}});
    }
  };
  const payload=id=>new Request('https://plazagrafik.workers.dev/telegram',{
    method:'POST',
    headers:{'X-Telegram-Bot-Api-Secret-Token':'safe-telegram'},
    body:JSON.stringify({message:{
      chat:{id,type:'private'},from:{id},
      text:'📆Субота, 17.10.2026\nПідгрупа 2.2 відключення:\n❌з 15:00 до 19:00'
    }})
  });
  const now=new Date('2026-10-17T07:00:00Z');
  assert.equal((await handleTelegramWebhook(payload(101),env,{now})).status,200);
  assert.equal(posts.length,0);
  assert.equal((await handleTelegramWebhook(payload(100),env,{now})).status,200);
  assert.equal(posts.length,1);
  assert.deepEqual(posts[0].periods,[[900,1140]]);
  assert.equal(replies[0].chat_id,'100');
  assert.match(replies[0].text,/Опублікував/);
  const unsigned=new Request('https://plazagrafik.workers.dev/telegram',{
    method:'POST',body:JSON.stringify({message:{chat:{type:'private',id:100},from:{id:100}}})
  });
  assert.equal((await handleTelegramWebhook(unsigned,env,{now})).status,403);
});

test('manual early update does not bounce back to cached older automatic schedule',async()=>{
  const calls=[],store=storage();
  let messageId=51;
  const botFetch=async(_url,opts)=>{
    calls.push(JSON.parse(opts.body));
    return reply({ok:true,result:{message_id:messageId++}});
  };
  const object=new Group22Publisher({storage:store},{
    BOT_TOKEN:'fake',CHANNEL_ID:'-100123',TEST_FETCH:botFetch
  });
  const publish=async(periods,source)=>{
    const res=await object.fetch(new Request('https://state.internal/publish',{
      method:'POST',body:JSON.stringify({
        date:DATE,periods,source,text:format22(DATE,periods,{today:DATE})
      })
    }));
    return (await res.json()).status;
  };
  const old=[[0,60]],forwarded=[[0,90]],newer=[[0,120]];
  assert.equal(await publish(old,'auto'),'published');
  assert.equal(await publish(forwarded,'manual'),'published');
  assert.equal(await publish(old,'auto'),'awaiting-source-sync');
  assert.equal(calls.length,2);
  assert.equal(await publish(forwarded,'auto'),'unchanged');
  assert.equal(await publish(newer,'auto'),'published');
  assert.equal(calls.length,3);
});

test('manual first, unknown old auto snapshot never triggers a wrong duplicate',async()=>{
  const store=storage();
  const object=new Group22Publisher({storage:store},{
    BOT_TOKEN:'fake',CHANNEL_ID:'-100123',
    TEST_FETCH:async()=>reply({ok:true,result:{message_id:51}})
  });
  const p=async(periods,source)=>{
    const res=await object.fetch(new Request('https://state.internal/publish',{
      method:'POST',body:JSON.stringify({date:DATE,periods,source,
        text:format22(DATE,periods,{today:DATE})})
    }));
    return (await res.json()).status;
  };
  assert.equal(await p([[0,120]],'manual'),'published');
  assert.equal(await p([[0,60]],'auto'),'awaiting-source-sync');
  assert.equal(await p([[0,60]],'auto'),'awaiting-source-sync');
  assert.equal(await p([[0,120]],'auto'),'unchanged');
});

test('formats distinct initial/updated headlines for today and tomorrow',()=>{
  const today='2026-10-17',tomorrow='2026-10-18';
  const periods=[[900,1140]];
  const header=(date,updated)=>format22(date,periods,{today,updated}).split('\n')[0];
  assert.equal(header(today,false),'💡 <b>Графік відключення світла</b>');
  assert.equal(header(today,true),'🔄 <b>Оновлений графік відключення світла</b>');
  assert.equal(header(tomorrow,false),'📅 <b>Графік відключення світла на завтра</b>');
  assert.equal(header(tomorrow,true),'🔄 <b>Оновлений графік відключення світла на завтра</b>');
  assert.match(format22(tomorrow,periods,{today}),/Неділя, 18\.10\.2026/);
});

test('today: first schedule, later change and unchanged hours get the correct title with no duplicates',async()=>{
  const calls=[],store=storage(),today='2026-10-17';
  let id=100;
  const object=new Group22Publisher({storage:store},{
    BOT_TOKEN:'fake',CHANNEL_ID:'@plazakvartal_svitlo',
    TEST_FETCH:async(_url,opts)=>{
      calls.push(JSON.parse(opts.body));
      return reply({ok:true,result:{message_id:id++}});
    }
  },()=>new Date('2026-10-17T08:00:00Z'));
  const post=async (periods,source='auto')=>{
    const resp=await object.fetch(new Request('https://state.internal/publish',{
      method:'POST',body:JSON.stringify({
        date:today,periods,source,
        text:format22(today,periods,{today})
      })
    }));
    return (await resp.json()).status;
  };
  const a=[[0,60],[900,1140]],b=[[0,60],[900,1200]];
  assert.equal(await post(a),'published');
  assert.match(calls[0].text,/^💡 <b>Графік відключення світла<\/b>/);
  assert.equal(await post(a),'unchanged');
  assert.equal(await post(b),'published');
  assert.match(calls[1].text,/^🔄 <b>Оновлений графік відключення світла<\/b>/);
  assert.equal(await post(b),'unchanged');
  assert.equal(await post(b,'manual'),'unchanged');
  assert.equal(calls.length,2);
  assert.equal(store.data.get('date:'+today).revision,2);
});

test('tomorrow: revisions say tomorrow; day rollover alone never reposts',async()=>{
  const date='2026-10-18',calls=[],store=storage();
  let now=new Date('2026-10-17T18:00:00Z'),id=200;
  const object=new Group22Publisher({storage:store},{
    BOT_TOKEN:'fake',CHANNEL_ID:'@plazakvartal_svitlo',
    TEST_FETCH:async(_url,opts)=>{
      calls.push(JSON.parse(opts.body));
      return reply({ok:true,result:{message_id:id++}});
    }
  },()=>now);
  const post=async (periods,source='auto')=>{
    const resp=await object.fetch(new Request('https://state.internal/publish',{
      method:'POST',body:JSON.stringify({
        date,periods,source,text:format22(date,periods,{today:'2026-10-17'})
      })
    }));
    return (await resp.json()).status;
  };
  const a=[[360,510]],b=[[360,540]],c=[[390,540]];
  assert.equal(await post(a),'published');
  assert.match(calls[0].text,/^📅 <b>Графік відключення світла на завтра<\/b>/);
  assert.equal(await post(a),'unchanged');
  assert.equal(await post(b),'published');
  assert.match(calls[1].text,/^🔄 <b>Оновлений графік відключення світла на завтра<\/b>/);
  assert.equal(await post(b,'manual'),'unchanged');
  // 22:30 UTC is 01:30 the next day in Kyiv.
  now=new Date('2026-10-17T22:30:00Z');
  assert.equal(await post(b),'unchanged');
  assert.equal(calls.length,2);
  assert.equal(await post(c),'published');
  assert.match(calls[2].text,/^🔄 <b>Оновлений графік відключення світла<\/b>/);
  assert.doesNotMatch(calls[2].text,/на завтра/);
  assert.equal(await post(c),'unchanged');
  assert.equal(calls.length,3);
});

test('a pre-existing published message counts as a revision and does not repost unchanged',async()=>{
  const store=storage(),texts=[];
  const old=[[0,60]],revised=[[0,90]];
  await store.put('date:'+DATE,{
    status:'published',messageId:80,revision:1,
    fingerprint:scheduleFingerprint(DATE,old),
    text:format22(DATE,old,{today:DATE})
  });
  const object=new Group22Publisher({storage:store},{
    BOT_TOKEN:'fake',CHANNEL_ID:'-100123',
    TEST_FETCH:async(_url,opts)=>{
      texts.push(JSON.parse(opts.body).text);
      return reply({ok:true,result:{message_id:81}});
    }
  },()=>new Date('2026-10-17T08:00:00Z'));
  const post=async(periods)=>{
    const res=await object.fetch(new Request('https://state.internal/publish',{
      method:'POST',body:JSON.stringify({
        date:DATE,periods,text:format22(DATE,periods,{today:DATE})
      })
    }));
    return (await res.json()).status;
  };
  assert.equal(await post(old),'unchanged');
  assert.equal(await post(revised),'published');
  assert.match(texts[0],/^🔄 <b>Оновлений графік відключення світла<\/b>/);
  assert.equal(texts.length,1);
});


test('private admin /status22 diagnoses tomorrow without posting duplicate Telegram messages',async()=>{
  const date='2026-10-22';
  const groups=Object.fromEntries(GROUPS.map(g=>[g,g==='2.2'?[[630,870],[1260,1320]]:[]]));
  const feedData={confirmedSchedules:{[date]:groups}};
  const t=new Date('2026-10-21T17:55:00Z');
  const botMessages=[],published=[];
  const env={
    BOT_TOKEN:'fake',CHANNEL_ID:'-100123',WEBHOOK_SECRET:'signed-only',
    ADMIN_TELEGRAM_ID:'100',
    SCHEDULE_STATE:{idFromName:()=>1,get:()=>({
      fetch:async(url,opts)=>{
        const input=JSON.parse(opts.body);
        if(url.endsWith('/status'))return reply({
          status:'not-published',date:input.date,
          messageId:null,publishedAt:null
        });
        published.push(input);return reply({status:'published',messageId:71});
      }
    })},
    TEST_SOURCE_FETCH:async()=>reply(feedData),
    TEST_FETCH:async(_url,opts)=>{
      botMessages.push(JSON.parse(opts.body));
      return reply({ok:true,result:{message_id:90}});
    }
  };
  const msg=(value,id=100)=>new Request('https://example.workers.dev/telegram',{
    method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'signed-only'},
    body:JSON.stringify({message:{
      chat:{type:'private',id},from:{id},text:value
    }})
  });
  assert.equal((await handleTelegramWebhook(msg('/status22'),env,{now:t})).status,200);
  assert.equal(published.length,0);
  assert.equal(botMessages.length,1);
  assert.match(botMessages[0].text,/Автографік 2\.2/);
  assert.match(botMessages[0].text,/10:30–14:30/);
  assert.match(botMessages[0].text,/21:00–22:00/);
  assert.match(botMessages[0].text,/ще не опубліковано/);
  assert.equal((await handleTelegramWebhook(msg('/status22',101),env,{now:t})).status,200);
  assert.equal(botMessages.length,1,'not an admin: no diagnostic access');
  assert.equal((await handleTelegramWebhook(msg('/sync22'),env,{now:t})).status,200);
  assert.equal(published.length,1,'sync submits tomorrow only once to the dedup publisher');
  assert.equal(published[0].date,date);
  assert.equal(published[0].source,'auto');
  assert.match(botMessages[1].text,/Надіслано допис №71/);
});

test('admin /sync22 respects already pending Telegram sends and never retries blindly',async()=>{
  const date='2026-10-22',now=new Date('2026-10-21T17:55:00Z');
  const full=Object.fromEntries(GROUPS.map(g=>[g,g==='2.2'?[[630,870]]:[]]));
  const calls=[],botMessages=[];
  const env={
    BOT_TOKEN:'fake',CHANNEL_ID:'-100123',WEBHOOK_SECRET:'signed-only',
    ADMIN_TELEGRAM_ID:'100',
    SCHEDULE_STATE:{idFromName:()=>1,get:()=>({
      fetch:async(url,opts)=>{
        calls.push(url);
        if(url.endsWith('/status'))return reply({status:'pending',startedAt:'2026-10-21T17:00:00Z'});
        return reply({status:'pending',reason:'delivery outcome unknown'});
      }
    })},
    TEST_SOURCE_FETCH:async()=>reply({confirmedSchedules:{[date]:full}}),
    TEST_FETCH:async(_url,opts)=>{
      botMessages.push(JSON.parse(opts.body));
      return reply({ok:true,result:{message_id:13}});
    }
  };
  const req=new Request('https://example.workers.dev/telegram',{
    method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'signed-only'},
    body:JSON.stringify({message:{chat:{type:'private',id:100},
      from:{id:100},text:'/sync22'}})
  });
  assert.equal((await handleTelegramWebhook(req,env,{now})).status,200);
  assert.equal(calls.filter(x=>x.endsWith('/publish')).length,1);
  assert.match(botMessages[0].text,/Потрібна перевірка у групі/);
  assert.match(botMessages[0].text,/автоматичний повтор заблоковано/);
});
