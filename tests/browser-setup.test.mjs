import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolvedWebhookSecret,workerWebhookUrl,
  installOwnWebhook,inspectOwnWebhook,validateSetupKey,renderBrowserSetupPage
} from '../src/webhook-setup.js';
import worker,{handleTelegramWebhook} from '../src/index.js';

const BASE='https://plazagrafik.example.workers.dev';
const request=()=>new Request(BASE+'/setup',{method:'POST'});
const env=()=>({
  BOT_TOKEN:'123456789:AbC_0123456789abcdef',
  CHANNEL_ID:'-1001234567890',
  ADMIN_TELEGRAM_ID:'10001000',
  SETUP_KEY:'myVeryStrongSetupKeyOnlyForTests_0123456789'
});
function telegramMock({initial='',afterSet=null}={}) {
  const calls=[];
  let configured=initial;
  return {
    calls,
    fetchFn:async(url,opts)=>{
      const method=String(url).split('/').pop(),payload=JSON.parse(opts.body);
      calls.push({method,payload});
      let result={};
      if(method==='getWebhookInfo')result={url:configured,allowed_updates:['channel_post']};
      else if(method==='getMe')result={id:123456789,is_bot:true,username:'PlazaScheduleBot'};
      else if(method==='setWebhook') {
        configured=afterSet ?? payload.url;
        result=true;
      } else throw Error('Unexpected method '+method);
      return new Response(JSON.stringify({ok:true,result}),{
        status:200,headers:{'Content-Type':'application/json'}
      });
    }
  };
}

test('browser page has one setup button and does not expose tokens',async()=>{
  const page=renderBrowserSetupPage();
  const html=await page.text();
  assert.equal(page.status,200);
  assert.match(html,/Перенести резервне пересилання/);
  assert.match(html,/fetch\('\/setup'/);
  assert.doesNotMatch(html,/123456789:AbC_/);
  assert.match(page.headers.get('Content-Security-Policy'),/connect-src 'self'/);
});

test('derived secret stays stable and contains valid Telegram characters',async()=>{
  const a=await resolvedWebhookSecret(env());
  const b=await resolvedWebhookSecret(env());
  assert.equal(a,b);
  assert.match(a,/^[a-f0-9]{64}$/);
  assert.notEqual(a,await resolvedWebhookSecret({...env(),BOT_TOKEN:'9:different'}));
  assert.equal(await resolvedWebhookSecret({...env(),WEBHOOK_SECRET:'Manual_Secret-1'}),'Manual_Secret-1');
});

test('only same workers.dev origin is a valid installer destination',()=>{
  assert.equal(workerWebhookUrl(request()),BASE+'/telegram');
  assert.throws(()=>workerWebhookUrl(new Request('https://evil.invalid/setup')),/workers.dev/);
  assert.throws(()=>workerWebhookUrl(new Request('https://notplazagrafik.example.workers.dev/setup')),/workers.dev/);
});

test('first-time browser setup registers only this worker with a signed webhook',async()=>{
  const telegram=telegramMock();
  const res=await installOwnWebhook(request(),env(),telegram);
  assert.equal(res.status,'connected');
  assert.deepEqual(telegram.calls.map(x=>x.method),
    ['getWebhookInfo','setWebhook','getWebhookInfo']);
  const payload=telegram.calls[1].payload;
  assert.equal(payload.url,BASE+'/telegram');
  assert.deepEqual(payload.allowed_updates,['message']);
  assert.match(payload.secret_token,/^[a-f0-9]{64}$/);
  assert.equal(payload.drop_pending_updates,false);
});

test('cannot hijack another Telegram webhook, and does not touch it',async()=>{
  const telegram=telegramMock({initial:'https://another-bot.example.dev/telegram'});
  const result=await installOwnWebhook(request(),env(),telegram);
  assert.equal(result.status,'conflict');
  assert.deepEqual(telegram.calls.map(x=>x.method),['getWebhookInfo']);
  assert.doesNotMatch(JSON.stringify(result),/another-bot/);
});

test('configuration must have valid admin ID and channel before setup',async()=>{
  const mock=telegramMock();
  assert.equal((await installOwnWebhook(request(),{...env(),ADMIN_TELEGRAM_ID:''},mock)).status,'configuration-required');
  assert.equal((await installOwnWebhook(request(),{...env(),CHANNEL_ID:''},mock)).status,'configuration-required');
  assert.equal(mock.calls.length,0);
});

test('explicit configured webhook secret continues to work for private owner',async()=>{
  const e={...env(),WEBHOOK_SECRET:'test_secret_123'};
  const res=await handleTelegramWebhook(
    new Request(BASE+'/telegram',{
      method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'test_secret_123'},
      body:JSON.stringify({channel_post:{text:'2.2'}})
    }),e
  );
  assert.equal(res.status,200);
});

test('browser setup POST returns configuration error without secrets',async()=>{
  const res=await worker.fetch(request(),{});
  assert.equal(res.status,400);
  const json=await res.json();
  assert.equal(json.status,'configuration-required');
});


function setupRequest(payload,extraHeaders={}) {
  return new Request(BASE+'/setup',{
    method:'POST',
    headers:{'Content-Type':'application/json',...extraHeaders},
    body:JSON.stringify(payload)
  });
}

test('webhook transfer page requires a Cloudflare-held secret for every API call',async()=>{
  const noKey=await worker.fetch(setupRequest({mode:'inspect'}),env());
  assert.equal(noKey.status,403);
  assert.equal((await noKey.json()).status,'unauthorized');
  const badKey=await worker.fetch(setupRequest({
    mode:'connect',setupKey:'notTheRealKey',acceptTransfer:true,
    botUsername:'@PlazaScheduleBot',webhookFingerprint:'bad'
  }),env());
  assert.equal(badKey.status,403);
  assert.equal((await badKey.json()).status,'unauthorized');
  assert.equal(await validateSetupKey(env(),env().SETUP_KEY),true);
  assert.equal(await validateSetupKey(env(),'different'),false);
});

test('inspection reveals bot username and old host but never Telegram credentials',async()=>{
  const oldUrl='https://old-schedule.workers.dev/telegram?secret=DO_NOT_REVEAL';
  const mock=telegramMock({initial:oldUrl});
  const data=await inspectOwnWebhook(request(),env(),mock);
  assert.equal(data.status,'ready');
  assert.equal(data.botUsername,'@PlazaScheduleBot');
  assert.equal(data.currentWebhookHost,'old-schedule.workers.dev');
  assert.equal(data.alreadyConnected,false);
  assert.match(data.webhookFingerprint,/^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(data),/DO_NOT_REVEAL|123456789:AbC_/);
  assert.deepEqual(mock.calls.map(x=>x.method),['getMe','getWebhookInfo']);
});

test('a wrong username prevents taking over another existing webhook',async()=>{
  const mock=telegramMock({initial:'https://old-schedule.workers.dev/telegram'});
  const snapshot=await inspectOwnWebhook(request(),env(),mock);
  const data=await installOwnWebhook(request(),env(),{
    fetchFn:mock.fetchFn,
    allowTransfer:true,
    expectedBotUsername:'@PowerMonitorBot',
    expectedWebhookFingerprint:snapshot.webhookFingerprint
  });
  assert.equal(data.status,'confirmation-required');
  assert.equal(mock.calls.filter(x=>x.method==='setWebhook').length,0);
});

test('stale old webhook snapshot prevents webhook migration',async()=>{
  const original=telegramMock({initial:'https://old-a.workers.dev/telegram'});
  const snapshot=await inspectOwnWebhook(request(),env(),original);
  const changed=telegramMock({initial:'https://old-b.workers.dev/telegram'});
  const data=await installOwnWebhook(request(),env(),{
    fetchFn:changed.fetchFn,allowTransfer:true,
    expectedBotUsername:'@PlazaScheduleBot',
    expectedWebhookFingerprint:snapshot.webhookFingerprint
  });
  assert.equal(data.status,'conflict');
  assert.equal(changed.calls.filter(x=>x.method==='setWebhook').length,0);
});

test('owner confirmed same-bot migration preserves pending updates and signs incoming webhook',async()=>{
  const mock=telegramMock({initial:'https://old-schedule.workers.dev/telegram'});
  const inspected=await inspectOwnWebhook(request(),env(),mock);
  const data=await installOwnWebhook(request(),env(),{
    fetchFn:mock.fetchFn,allowTransfer:true,
    expectedBotUsername:inspected.botUsername,
    expectedWebhookFingerprint:inspected.webhookFingerprint
  });
  assert.equal(data.status,'connected');
  const set=mock.calls.find(x=>x.method==='setWebhook');
  assert.ok(set);
  assert.equal(set.payload.url,BASE+'/telegram');
  assert.deepEqual(set.payload.allowed_updates,['message']);
  assert.equal(set.payload.drop_pending_updates,false);
  assert.match(set.payload.secret_token,/^[a-f0-9]{64}$/);
});

test('setup page creates browser-only random key and confirms identity',async()=>{
  const text=await renderBrowserSetupPage().text();
  assert.match(text,/crypto.getRandomValues/);
  assert.match(text,/SETUP_KEY/);
  assert.match(text,/Перевірити Telegram-бота/);
  assert.match(text,/username/);
  assert.match(text,/acceptTransfer:true/);
  assert.doesNotMatch(text,/bot\d+:/);
});

test('setup handler rejects cross-origin requests before acting',async()=>{
  const response=await worker.fetch(setupRequest({
    mode:'inspect',setupKey:env().SETUP_KEY
  },{'Origin':'https://evil.example.com'}),env());
  assert.equal(response.status,403);
});
