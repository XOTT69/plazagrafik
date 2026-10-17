import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolvedWebhookSecret,workerWebhookUrl,
  installOwnWebhook,renderBrowserSetupPage
} from '../src/webhook-setup.js';
import worker,{handleTelegramWebhook} from '../src/index.js';

const BASE='https://plazagrafik.example.workers.dev';
const request=()=>new Request(BASE+'/setup',{method:'POST'});
const env=()=>({
  BOT_TOKEN:'123456789:AbC_0123456789abcdef',
  CHANNEL_ID:'-1001234567890',
  ADMIN_TELEGRAM_ID:'10001000'
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
  assert.match(html,/Підключити Telegram webhook/);
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
