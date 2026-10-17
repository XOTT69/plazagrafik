import test from 'node:test';
import assert from 'node:assert/strict';
import {personalAction,keyboard,normalizedProfile,confirmedPersonalPeriods} from '../src/personal-bot.js';
import {Group22Publisher,handleTelegramWebhook} from '../src/index.js';
import {workerWebhookUrl,renderDtekSetupPage} from '../src/webhook-setup.js';

const groups=Array.from({length:6},(_,i)=>[String(i+1)+'.1',String(i+1)+'.2']).flat();
const time=new Date('2026-10-17T11:30:00Z'); // 14:30 in Kyiv
const source={confirmedSchedules:{
  '2026-10-17':Object.fromEntries(groups.map(group=>[
    group,group==='2.2'?[[0,60],[900,1140]]:group==='1.2'?[[420,540]]:[]
  ])),
  '2026-10-18':Object.fromEntries(groups.map(group=>[
    group,group==='2.2'?[[450,660]]:[]
  ]))
}};
const mem=()=>{
  const data=new Map();
  return {get:async k=>data.get(k),put:async(k,v)=>{data.set(k,v);},delete:async k=>data.delete(k),data};
};
const mockTelegram=async (_url,request)=>{
  const sent=JSON.parse(request.body);
  assert.ok(sent.chat_id);
  return Response.json({ok:true,result:{message_id:33}});
};
test('Plaza starts with 2.2 and has usable reply keyboard without changing channels',()=>{
  const home=personalAction({scope:'plaza',text:'/start',now:time});
  assert.equal(home.handled,true);
  assert.match(home.text,/Плаза/);
  assert.equal(home.profile.group,'2.2');
  assert.ok(home.replyMarkup.keyboard.some(row=>row.some(b=>b.text==='💡 Сьогодні')));
  assert.equal(home.replyMarkup.keyboard.some(row=>row.some(b=>b.text==='🏠 Моя підгрупа')),false);
  assert.equal(personalAction({scope:'plaza',text:'random'}).handled,false);
});
test('DTEK group choice is remembered and options restricted to 12 known groups',()=>{
  const select=personalAction({scope:'dtek',text:'🏠 Моя підгрупа'});
  assert.equal(select.selecting,true);
  assert.equal(select.replyMarkup.keyboard.length,7);
  const changed=personalAction({scope:'dtek',text:'🏘 4.1'});
  assert.equal(changed.changed,true);
  assert.equal(changed.profile.group,'4.1');
  const next=personalAction({scope:'dtek',text:'💡 Сьогодні',profile:changed.profile,
    now:time,state:source});
  assert.match(next.text,/підгрупа|Графік 4\.1/i);
  assert.equal(next.profile.group,'4.1');
  assert.equal(normalizedProfile({group:'9.9'},'dtek').group,'2.2');
});
test('real clock-based status and next outage only express scheduled, not actual state',()=>{
  const now=personalAction({scope:'plaza',text:'/now',now:time,state:source});
  assert.match(now.text,/Планового відключення зараз немає/);
  assert.match(now.text,/15:00/);
  assert.match(now.text,/фактичну наявність світла не підтверджено/i);
  const next=personalAction({scope:'plaza',text:'⏳ Наступне',now:time,state:source});
  assert.match(next.text,/15:00/);
  assert.match(next.text,/30 хв/);
});
test('today/tomorrow and statistics use only verified DTEK facts',()=>{
  const today=personalAction({scope:'plaza',text:'💡 Сьогодні',now:time,state:source});
  assert.match(today.text,/00:00–01:00/);
  assert.match(today.text,/15:00–19:00/);
  assert.match(today.text,/Без світла: 5 год/);
  const tomorrow=personalAction({scope:'plaza',text:'📅 Завтра',now:time,state:source});
  assert.match(tomorrow.text,/18\.10\.2026/);
  const stats=personalAction({scope:'plaza',text:'📊 Статистика',now:time,state:source});
  assert.match(stats.text,/Найдовше відключення: 4 год/);
  assert.match(stats.text,/Найдовше зі світлом: 14 год/);
  const invalid={confirmedSchedules:{'2026-10-17':{'2.2':[[0,60]]}}};
  assert.equal(confirmedPersonalPeriods(invalid,'2026-10-17','2.2'),null);
  assert.match(personalAction({scope:'dtek',text:'💡 Сьогодні',now:time,state:invalid}).text,
    /Немає повного підтвердженого графіка/);
});
test('Plaza latest owner-forwarded version overrides cached confirmed feed in personal card',()=>{
  const result=personalAction({
    scope:'plaza',text:'💡 Сьогодні',now:time,state:source,
    override:{date:'2026-10-17',periods:[[0,60],[900,1200]]}
  });
  assert.match(result.text,/15:00–20:00/);
  assert.doesNotMatch(result.text,/15:00–19:00/);
});
test('DTEK setup maps to a distinct endpoint and keeps the Plaza webhook',async()=>{
  const base='https://plazagrafik.example.workers.dev';
  assert.equal(workerWebhookUrl(new Request(base+'/setup')),base+'/telegram');
  assert.equal(workerWebhookUrl(new Request(base+'/setup-dtek')),base+'/telegram/dtek');
  const page=await renderDtekSetupPage();
  const html=await page.text();
  assert.match(html,/fetch\('\/setup-dtek'/);
  assert.match(html,/DTEK_BOT_TOKEN/);
});
test('publisher stores DTEK private preference separately from existing dates',async()=>{
  const store=mem(),object=new Group22Publisher({storage:store},{});
  const call=async payload=>object.fetch(new Request('https://state.internal/profile',{
    method:'POST',body:JSON.stringify(payload)
  }));
  assert.equal((await (await call({scope:'dtek',userId:'1234',profile:{group:'5.2'}})).json()).profile.group,'5.2');
  assert.equal((await (await call({scope:'dtek',userId:'1234'})).json()).profile.group,'5.2');
  assert.equal((await (await call({scope:'plaza',userId:'1234'})).json()).profile,null);
  assert.equal(store.data.has('date:2026-10-17'),false);
  assert.equal((await call({scope:'dtek',userId:'-1'})).status,400);
});
test('unauthenticated DTEK private messages cannot trigger personal commands',async()=>{
  const req=new Request('https://test.invalid/telegram/dtek',{
    method:'POST',body:JSON.stringify({message:{
      from:{id:1234},chat:{id:1234,type:'private'},text:'/start'
    }})
  });
  const env={DTEK_BOT_TOKEN:'12345:FAKETOKEN',DTEK_WEBHOOK_SECRET:'dtek-secret'};
  assert.equal((await handleTelegramWebhook(req,env,{scope:'dtek'})).status,403);
});
test('a signed Plaza /start gets the private menu, no channel publication',async()=>{
  const storage=mem(),sent=[];
  const stub=new Group22Publisher({storage},{
    BOT_TOKEN:'123:abc',CHANNEL_ID:'@plazakvartal_svitlo'
  });
  const env={
    BOT_TOKEN:'123:abc',WEBHOOK_SECRET:'plaza-secret',
    CHANNEL_ID:'@plazakvartal_svitlo',ADMIN_TELEGRAM_ID:'999',
    SCHEDULE_STATE:{idFromName:()=>1,get:()=>({fetch:(url,opts)=>stub.fetch(new Request(url,opts))})},
    TEST_FETCH:async(_url,opts)=>{
      sent.push(JSON.parse(opts.body));
      return Response.json({ok:true,result:{message_id:4}});
    }
  };
  const req=new Request('https://plazagrafik.example.workers.dev/telegram',{
    method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'plaza-secret'},
    body:JSON.stringify({message:{
      from:{id:1234},chat:{id:1234,type:'private'},text:'/start'
    }})
  });
  assert.equal((await handleTelegramWebhook(req,env,{now:time})).status,200);
  assert.equal(sent.length,1);
  assert.equal(sent[0].chat_id,'1234');
  assert.match(sent[0].text,/Плаза/);
  assert.ok(sent[0].reply_markup?.keyboard?.length);
  assert.equal(storage.data.has('date:2026-10-17'),false);
});
test('DTEK private /start sends via independent token without using Plaza channel',async()=>{
  const storage=mem(),sent=[];
  const stub=new Group22Publisher({storage},{});
  const env={
    BOT_TOKEN:'plaza:unused',CHANNEL_ID:'@plazakvartal_svitlo',
    DTEK_BOT_TOKEN:'9876:other',DTEK_WEBHOOK_SECRET:'my-dtek-secret',
    SCHEDULE_STATE:{idFromName:()=>1,get:()=>({fetch:(url,opts)=>stub.fetch(new Request(url,opts))})},
    TEST_FETCH:async(url,opts)=>{
      sent.push([String(url),JSON.parse(opts.body)]);
      return Response.json({ok:true,result:{message_id:7}});
    }
  };
  const request=new Request('https://plazagrafik.example.workers.dev/telegram/dtek',{
    method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'my-dtek-secret'},
    body:JSON.stringify({message:{
      from:{id:456},chat:{id:456,type:'private'},text:'/start'
    }})
  });
  assert.equal((await handleTelegramWebhook(request,env,{scope:'dtek',now:time})).status,200);
  assert.equal(sent.length,1);
  assert.match(sent[0][0],/bot9876:other\/sendMessage/);
  assert.equal(sent[0][1].chat_id,'456');
  assert.doesNotMatch(sent[0][1].text,/Плаза/);
});
