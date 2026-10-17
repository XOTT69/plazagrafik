import {
  SOURCE_URL,choosePosts,validatedPeriods,
  scheduleFingerprint,scheduleFingerprintFromText
} from './schedule22.js';
import {parseForwardedGroup22} from './manual-forward.js';
import {resolvedWebhookSecret,installOwnWebhook,inspectOwnWebhook,validateSetupKey,renderBrowserSetupPage} from './webhook-setup.js';

const TG_BASE='https://api.telegram.org/bot';
const DAY=/^\d{4}-\d{2}-\d{2}$/;
const POST_MAX_LENGTH=4000;

async function telegramCall(env,method,data,fetchFn=fetch) {
  if(!env.BOT_TOKEN||!env.CHANNEL_ID) {
    throw new Error('BOT_TOKEN and CHANNEL_ID must be configured in Cloudflare');
  }
  const response=await fetchFn(TG_BASE+env.BOT_TOKEN+'/'+method,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      chat_id:env.CHANNEL_ID,
      parse_mode:'HTML',
      disable_web_page_preview:true,
      ...data
    }),
    signal:AbortSignal.timeout(16000)
  });
  const json=await response.json();
  if(!response.ok||!json?.ok) {
    const err=new Error('Telegram '+method+': HTTP '+response.status+' '+String(json?.description||'unknown'));
    err.status=response.status;
    throw err;
  }
  return json.result;
}

/**
 * SQLite-backed Durable Object (Cloudflare Workers Free compatible).
 * Stores the most recently announced confirmed timetable per calendar date.
 * A new confirmed timetable sends a new unpinned message, never edits a post.
 * Repeated cron runs or status/formatting-only changes produce no duplicates.
 *
 * Owner-forwarded 2.2 timetables can use the same dedup state as cron.
 * A manual version temporarily protects against the old cached automatic
 * snapshot until the official feed catches up or genuinely changes.
 */
export class Group22Publisher {
  constructor(ctx,env) {
    this.ctx=ctx;
    this.env=env;
    this.queue=Promise.resolve();
  }
  async fetch(request) {
    if(new URL(request.url).pathname!=='/publish'||request.method!=='POST')
      return new Response('Not found',{status:404});
    const task=async()=>{
      let payload;
      try {payload=await request.json();} catch{return Response.json({status:'invalid'}, {status:400});}
      const periods=validatedPeriods(payload?.periods);
      if(!DAY.test(payload?.date||'')||
        periods===null ||
        typeof payload.text!=='string'||!payload.text||
        payload.text.length>POST_MAX_LENGTH ||
        !payload.text.includes('Підгрупа 2.2 відключення:')) {
        return Response.json({status:'invalid'}, {status:400});
      }
      const source=payload.source==='manual'?'manual':'auto';
      const key='date:'+payload.date;
      const fingerprint=scheduleFingerprint(payload.date,periods);
      const previous=await this.ctx.storage.get(key);
      // Timetable versions, NOT text changes, control the notification.
      // This also handles state left by the old edit-in-place publisher.
      const knownFingerprint=previous?.fingerprint ||
        scheduleFingerprintFromText(payload.date,previous?.text);
      if(previous?.pending || previous?.status==='pending') {
        // The new send may have reached Telegram even if its response
        // was lost. A human must reconcile before safely retrying.
        return Response.json({status:'pending',reason:'delivery outcome unknown'});
      }
      // When a manual forward outruns the cached public DTEK snapshot,
      // do not bounce between newer manual and older auto data every 5 min.
      // Allow auto publishing once its snapshot has actually changed from
      // the one observed when manual fallback was used.
      if(source==='auto' && previous?.manualHold) {
        const baseline=previous.manualHold.autoFingerprint;
        if(knownFingerprint===fingerprint && previous.messageId) {
          await this.ctx.storage.put(key,{
            ...previous,lastAutoFingerprint:fingerprint,manualHold:null
          });
          return Response.json({status:'unchanged',messageId:previous.messageId});
        }
        if(baseline===null || fingerprint===baseline) {
          await this.ctx.storage.put(key,{
            ...previous,lastAutoFingerprint:fingerprint,
            manualHold:{autoFingerprint:baseline ?? fingerprint}
          });
          return Response.json({status:'awaiting-source-sync'});
        }
      }
      if(knownFingerprint===fingerprint && previous?.messageId) {
        // Migrate an older per-day record without a canonical fingerprint.
        if(!previous.fingerprint)await this.ctx.storage.put(key,{
          ...previous,fingerprint,
          ...(source==='auto'?{lastAutoFingerprint:fingerprint}:{})
        });
        return Response.json({status:'unchanged',messageId:previous.messageId});
      }
      // Keep the last confirmed version while marking this proposed revision
      // pending. If Telegram definitively rejects, restore it for retry.
      await this.ctx.storage.put(key,{
        ...previous,
        pending:{fingerprint,startedAt:new Date().toISOString()}
      });
      let sent;
      try {
        sent=await telegramCall(this.env,'sendMessage',{
          text:payload.text,disable_notification:false
        },this.env.TEST_FETCH||fetch);
      } catch(err) {
        // Explicit 4xx means Telegram did not accept this particular send.
        // Preserve the previously successful revision, if one exists.
        if(err.status>=400 && err.status<500) {
          if(previous)await this.ctx.storage.put(key,previous);
          else await this.ctx.storage.delete(key);
        }
        throw err;
      }
      if(!Number.isSafeInteger(sent?.message_id) || sent.message_id<1)
        throw new Error('Telegram delivery uncertain: no message_id returned');
      const revision=(Number(previous?.revision)||0)+1;
      await this.ctx.storage.put(key,{
        fingerprint,
        text:payload.text,
        ...(source==='auto'?{
          lastAutoFingerprint:fingerprint,manualHold:null
        }:{
          lastAutoFingerprint:previous?.lastAutoFingerprint??null,
          manualHold:{autoFingerprint:previous?.lastAutoFingerprint??null}
        }),
        messageId:sent.message_id,
        status:'published',
        revision,
        publishedAt:new Date().toISOString()
      });
      return Response.json({
        status:'published',messageId:sent.message_id,revision
      });
    };
    // Explicit in-instance serialization plus persisted pending marker protect
    // against parallel cron runs and state races.
    const result=this.queue.then(task);
    this.queue=result.then(()=>{},()=>{});
    try {return await result;}
    catch(error){console.error('Group 2.2 Telegram error:',error.message);
      return Response.json({status:'error',error:String(error.message)}, {status:502});
    }
  }
}

export async function checkDtekAndPublish(env,{fetchFn=fetch,now=new Date()}={}) {
  if(!env.SCHEDULE_STATE)throw new Error('Missing SCHEDULE_STATE durable object binding');
  const response=await fetchFn(SOURCE_URL,{
    headers:{Accept:'application/json','Cache-Control':'no-cache'},
    signal:AbortSignal.timeout(12000)
  });
  if(!response.ok)throw new Error('DTEK confirmed feed HTTP '+response.status);
  const data=await response.json();
  const posts=choosePosts(data,now);
  const stub=env.SCHEDULE_STATE.get(env.SCHEDULE_STATE.idFromName('confirmed-2.2'));
  const results=[];
  for(const post of posts) {
    post.source='auto';
    const res=await stub.fetch('https://state.internal/publish',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(post)
    });
    const outcome=await res.json();
    if(!res.ok)console.error('Group 2.2 post failed for '+post.date+': '+outcome.error);
    results.push({date:post.date,...outcome});
  }
  return results;
}

async function tellOwner(env,chatId,text) {
  return telegramCall(env,'sendMessage',{
    chat_id:chatId,text,
    disable_notification:true,parse_mode:'HTML'
  },env.TEST_FETCH||fetch);
}

/** Telegram secret-header + sender-ID checks block forged and public posts. */
export async function handleTelegramWebhook(request,env,{now=new Date()}={}) {
  const expectedSecret=await resolvedWebhookSecret(env).catch(()=>null);
  if(!expectedSecret || request.headers.get('X-Telegram-Bot-Api-Secret-Token')!==expectedSecret) {
    return new Response('Forbidden',{status:403});
  }
  let update;
  try{update=await request.json();}catch{return new Response('OK');}
  // Never handle channel_post or group messages; this prevents feedback loops.
  const message=update?.message;
  if(!message || message.chat?.type!=='private' || !message.from?.id)
    return new Response('OK');

  const userId=String(message.from.id);
  const chatId=String(message.chat.id);
  const text=String(message.text||message.caption||'');
  if(/^\/id(?:@\w+)?$/iu.test(text.trim())) {
    await tellOwner(env,chatId,'🆔 Ваш Telegram ID: <code>'+userId+'</code>');
    return new Response('OK');
  }
  if(!env.ADMIN_TELEGRAM_ID || userId!==String(env.ADMIN_TELEGRAM_ID))
    return new Response('OK');

  const schedule=parseForwardedGroup22(text,now);
  if(!schedule) {
    if(text && !text.startsWith('/')) {
      await tellOwner(env,chatId,
        '⚠️ Не знайшов підтверджений графік 2.2 на сьогодні або завтра. '+
        'Перешли текст із датою, заголовком «Підгрупа 2.2 відключення:» '+
        'і точними інтервалами.');
    }
    return new Response('OK');
  }
  if(!env.SCHEDULE_STATE)throw new Error('SCHEDULE_STATE binding unavailable');
  const stub=env.SCHEDULE_STATE.get(env.SCHEDULE_STATE.idFromName('confirmed-2.2'));
  const response=await stub.fetch('https://state.internal/publish',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(schedule)
  });
  const result=await response.json();
  if(result.status==='published') {
    await tellOwner(env,chatId,
      '✅ Опублікував підгрупу 2.2 за '+schedule.date+
      ' у канал. Це новий допис №'+result.messageId+'.');
  } else if(result.status==='unchanged'){
    await tellOwner(env,chatId,
      'ℹ️ Графік 2.2 за '+schedule.date+' не змінився. Повторно не публікую.');
  } else if(result.status==='awaiting-source-sync') {
    await tellOwner(env,chatId,'ℹ️ Очікую оновлення автоматичного джерела.');
  } else {
    await tellOwner(env,chatId,
      '⚠️ Не вдалося надійно підтвердити публікацію ('+
      String(result.status||'error')+'). Перевір канал і логи перед повтором.');
  }
  return new Response('OK');
}

export default {
  // POST from Telegram; the only posting path is an authenticated
  // private admin chat, never a channel_post or a public group message.
  async fetch(request,env) {
    const pathname=new URL(request.url).pathname;
    if(pathname==='/setup' && request.method==='GET')
      return renderBrowserSetupPage();
    if(pathname==='/setup' && request.method==='POST') {
      // Require owner-defined Cloudflare SETUP_KEY before exposing bot details
      // or transferring an existing webhook. Never accept target URLs.
      let payload;
      try{payload=await request.json();}
      catch{return Response.json({status:'invalid'}, {status:400});}
      if(!env.SETUP_KEY || String(env.SETUP_KEY).length<24)
        return Response.json({
          status:'configuration-required',
          reason:'Create a Cloudflare Secret named SETUP_KEY (24+ characters) before continuing.'
        },{status:400,headers:{'Cache-Control':'no-store'}});
      if(!await validateSetupKey(env,payload?.setupKey))
        return Response.json({status:'unauthorized',reason:'Invalid setup key'},
          {status:403,headers:{'Cache-Control':'no-store'}});
      // Browser POSTs must originate from the same Worker domain.
      const origin=request.headers.get('Origin');
      if(origin && origin!==new URL(request.url).origin)
        return Response.json({status:'forbidden'}, {status:403});
      let result;
      if(payload?.mode==='inspect') {
        result=await inspectOwnWebhook(request,env);
      } else if(payload?.mode==='connect' && payload?.acceptTransfer===true) {
        result=await installOwnWebhook(request,env,{
          allowTransfer:true,
          expectedBotUsername:payload?.botUsername,
          expectedWebhookFingerprint:payload?.webhookFingerprint
        });
      } else return Response.json({status:'invalid'}, {status:400});
      return Response.json(result,{
        status:result.status==='connected'||result.status==='ready'?200:
          result.status==='conflict'?409:
          result.status==='configuration-required'?400:
          result.status==='confirmation-required'?422:502,
        headers:{'Cache-Control':'no-store'}
      });
    }
    if(request.method!=='POST' || !['/','/telegram'].includes(pathname))
      return new Response('OK');
    try{return await handleTelegramWebhook(request,env);}
    catch(error) {
      console.error('Telegram manual fallback error: '+String(error?.message||error));
      // Telegram retries if non-200; DO dedup still blocks repeats.
      return new Response('Temporary failure',{status:503});
    }
  },
  async scheduled(_event,env,ctx) {
    ctx.waitUntil(checkDtekAndPublish(env).then(results=>{
      console.log('Confirmed DTEK 2.2 cron:',JSON.stringify(results));
    }).catch(error=>console.error('Group 2.2 cron failed:',error.message)));
  }
};
