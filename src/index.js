import {
  SOURCE_URL,choosePosts,validatedPeriods,format22,kyivDate,nextDate,
  scheduleFingerprint,scheduleFingerprintFromText
} from './schedule22.js';
import {parseForwardedGroup22} from './manual-forward.js';
import {personalAction,normalizedProfile} from './personal-bot.js';
import {resolvedWebhookSecret,installOwnWebhook,inspectOwnWebhook,validateSetupKey,renderBrowserSetupPage,renderDtekSetupPage} from './webhook-setup.js';

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
  constructor(ctx,env,clock=()=>new Date()) {
    this.ctx=ctx;
    this.env=env;
    this.clock=clock;
    this.queue=Promise.resolve();
  }
  async fetch(request) {
    const route=new URL(request.url).pathname;
    // Internal-only DO diagnostics: Worker never exposes these paths publicly.
    if(route==='/diagnostics' && request.method==='POST') {
      let payload;
      try{payload=await request.json();}catch{return Response.json({status:'invalid'},{status:400});}
      if(!Array.isArray(payload?.dates)||payload.dates.length>3||
        payload.dates.some(date=>!DAY.test(date)))
        return Response.json({status:'invalid'},{status:400});
      const days={};
      for(const date of payload.dates) {
        const item=await this.ctx.storage.get('date:'+date);
        days[date]={
          status:item?.pending||item?.status==='pending'?'pending':
            item?.messageId?'published':'not-published',
          messageId:Number.isSafeInteger(item?.messageId)?item.messageId:null,
          publishedAt:item?.publishedAt||null,
          manualHold:!!item?.manualHold,
          // Do not leak raw Telegram token, credentials, or source text.
          pendingSince:item?.pending?.startedAt||null
        };
      }
      return Response.json({lastCron:await this.ctx.storage.get('lastCron')||null,days});
    }
    if(route==='/cron-result' && request.method==='POST') {
      let payload;
      try{payload=await request.json();}catch{return Response.json({status:'invalid'},{status:400});}
      if(typeof payload?.checkedAt!=='string'||!Array.isArray(payload?.results)||
        payload.results.length>3)return Response.json({status:'invalid'},{status:400});
      const summary={checkedAt:payload.checkedAt,
        status:payload.status==='error'?'error':'ok',
        results:payload.results.map(v=>({
          date:DAY.test(v?.date||'')?v.date:null,
          status:String(v?.status||'unknown').slice(0,60)
        })),
        error:payload.status==='error'?String(payload.error||'Unknown error').slice(0,180):null
      };
      await this.ctx.storage.put('lastCron',summary);
      return Response.json({status:'saved'});
    }
    if(route==='/profile' && request.method==='POST') {
      let payload;
      try{payload=await request.json();}catch{return Response.json({status:'invalid'},{status:400});}
      const scope=payload?.scope, id=String(payload?.userId||'');
      if(!['plaza','dtek'].includes(scope)||!/^[1-9][0-9]{0,17}$/.test(id))
        return Response.json({status:'invalid'},{status:400});
      const key='profile:'+scope+':'+id;
      if(payload.profile){
        const profile=normalizedProfile(payload.profile,scope);
        await this.ctx.storage.put(key,profile);
      }
      return Response.json({profile:await this.ctx.storage.get(key)||null});
    }
    if(route==='/status' && request.method==='POST') {
      let input;
      try{input=await request.json()}catch{return Response.json({status:'invalid'},{status:400})}
      if(!DAY.test(input?.date||''))return Response.json({status:'invalid'},{status:400});
      const item=await this.ctx.storage.get('date:'+input.date);
      const pending=Boolean(item?.pending || item?.status==='pending');
      const manualHold=Boolean(item?.manualHold);
      const status=pending?'pending':
        manualHold?'awaiting-source-sync':
        item?.messageId?'published':'not-published';
      let periods=null;
      try{
        const parsed=JSON.parse(item?.fingerprint||'null');
        if(parsed?.date===input.date)periods=validatedPeriods(parsed.periods);
      }catch{}
      return Response.json({
        status, date:input.date, messageId:item?.messageId||null,
        publishedAt:item?.publishedAt||null,
        startedAt:item?.pending?.startedAt||null,
        periods,revision:item?.revision||0,
        manualHold,hasSavedFingerprint:Boolean(item?.fingerprint)
      });
    }
    if(route==='/current' && request.method==='POST') {
      let input;try{input=await request.json();}catch{return Response.json({status:'invalid'},{status:400});}
      if(!DAY.test(input?.date||''))return Response.json({status:'invalid'},{status:400});
      const item=await this.ctx.storage.get('date:'+input.date);
      let periods=null;
      if(item?.fingerprint) {
        try {
          const parsed=JSON.parse(item.fingerprint);
          if(parsed.date===input.date)periods=validatedPeriods(parsed.periods);
        } catch {}
      }
      return Response.json({periods});
    }
    if(route!=='/publish'||request.method!=='POST')
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
      // Only the signed owner command can acknowledge a missing Telegram post.
      // Match the exact pending attempt and verified schedule before one retry.
      // Cron and /sync22 never carry this recovery acknowledgment.
      const recovery=payload.recovery;
      const recovering=recovery?.confirmedMissing===true;
      if(recovery!==undefined) {
        const startedAt=String(recovery?.pendingSince||'');
        const startedMs=Date.parse(startedAt);
        if(!recovering || !previous?.pending ||
          previous.pending.startedAt!==startedAt ||
          previous.pending.fingerprint!==fingerprint ||
          !Number.isFinite(startedMs) ||
          Date.now()-startedMs<60_000) {
          return Response.json({status:'recovery-refused',
            reason:'Pending attempt changed, is too recent, or schedule differs'});
        }
      }
      if((previous?.pending || previous?.status==='pending')&&!recovering) {
        // Delivery was uncertain. Only a date-specific, owner-confirmed
        // recovery can bypass this protection; no automated duplicates.
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
      // Render only after deduplication: prior successful publication decides
      // whether this is a new or updated schedule, and current Kyiv date
      // decides whether it is for tomorrow. Neither changes the fingerprint.
      const postText=format22(payload.date,periods,{
        today:kyivDate(this.clock()),updated:Boolean(previous?.messageId)
      });
      if(postText.length>POST_MAX_LENGTH)
        return Response.json({status:'invalid'}, {status:400});
      // Keep the last confirmed version while marking this proposed revision
      // pending. If Telegram definitively rejects, restore it for retry.
      await this.ctx.storage.put(key,{
        ...previous,
        pending:{fingerprint,startedAt:new Date().toISOString()}
      });
      let sent;
      try {
        sent=await telegramCall(this.env,'sendMessage',{
          text:postText,disable_notification:false
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
        text:postText,
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

async function saveCronDiagnostics(stub,summary) {
  // Logging must never prevent a successful Telegram post or turn a
  // completed run into an ambiguous failure requiring a duplicate retry.
  try {
    await stub.fetch('https://state.internal/cron-result',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(summary)
    });
  } catch(error) {
    console.warn('2.2 diagnostic heartbeat unavailable: '+String(error?.message||error));
  }
}

export async function checkDtekAndPublish(env,{fetchFn=fetch,now=new Date()}={}) {
  if(!env.SCHEDULE_STATE)throw new Error('Missing SCHEDULE_STATE durable object binding');
  const stub=env.SCHEDULE_STATE.get(env.SCHEDULE_STATE.idFromName('confirmed-2.2'));
  const today=kyivDate(now),dates=[today,nextDate(today)];
  const checkedAt=now.toISOString();
  let results=[];
  try {
    // A fresh URL on every poll prevents a stale GitHub raw CDN response
    // from hiding tomorrow's new confirmed DTEK schedule.
    const url=SOURCE_URL+'?v='+encodeURIComponent(String(now.getTime()));
    const response=await fetchFn(url,{
      headers:{Accept:'application/json','Cache-Control':'no-cache'},
      cache:'no-store',
      signal:AbortSignal.timeout(12000)
    });
    if(!response.ok)throw new Error('DTEK confirmed feed HTTP '+response.status);
    const data=await response.json();
    const posts=choosePosts(data,now);
    const seen=new Set();
    for(const post of posts) {
      seen.add(post.date);
      post.source='auto';
      const res=await stub.fetch('https://state.internal/publish',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(post)
      });
      const outcome=await res.json();
      if(!res.ok)console.error('Group 2.2 post failed for '+post.date+': '+outcome.error);
      results.push({date:post.date,...outcome});
    }
    // Track missing dates explicitly. No claim that a missing fact is a
    // successful Telegram publication.
    const summary=dates.map(date=>{
      const found=results.find(r=>r.date===date);
      return found?{date,status:found.status}:{date,status:'no-confirmed-fact'};
    });
    await saveCronDiagnostics(stub,{
      checkedAt,status:'ok',results:summary
    });
    return results;
  } catch(error) {
    await saveCronDiagnostics(stub,{
      checkedAt,status:'error',
      results:dates.map(date=>({date,status:'check-failed'})),
      error:String(error?.message||error)
    });
    throw error;
  }
}

function dtekEnv(env) {
  // Separate token and signing key: the public DTEK bot cannot impersonate Plaza.
  return {
    ...env,
    BOT_TOKEN:env.DTEK_BOT_TOKEN,
    WEBHOOK_SECRET:env.DTEK_WEBHOOK_SECRET||'',
    CHANNEL_ID:'@svitlo_kyivshchyna'
  };
}
function publisherStub(env) {
  return env.SCHEDULE_STATE.get(env.SCHEDULE_STATE.idFromName('confirmed-2.2'));
}
const DATA_COMMANDS=new Set([
  '💡 Сьогодні','📅 Завтра','🕒 Зараз','⏳ Наступне',
  '📊 Статистика','📚 Календар','📤 Поділитися',
  '/today','/graph','/tomorrow','/now','/next','/stats','/history'
]);
async function privateMenu(env,scope,userId,chatId,text,now){
  const value=text.trim();
  const isChoice=value==='/start'||value==='/menu'||value==='/help'||
    value==='↩️ Меню'||value==='🏠 Моя підгрупа'||
    value==='⚙️ Налаштування'||value==='❓ Допомога'||
    (scope==='dtek' && (value.startsWith('🏘 ') ||
      value.startsWith('/group ')));
  if(!isChoice && !DATA_COMMANDS.has(value))return false;
  if(!env.SCHEDULE_STATE)throw new Error('SCHEDULE_STATE binding unavailable');
  const stub=publisherStub(env);
  const saved=await stub.fetch('https://state.internal/profile',{
    method:'POST',body:JSON.stringify({scope,userId})
  });
  if(!saved.ok)throw new Error('Cannot load personal preferences');
  const profile=(await saved.json()).profile;
  let data={};
  let override=null;
  if(DATA_COMMANDS.has(text.trim())) {
    const fetchFn=env.TEST_SOURCE_FETCH||fetch;
    try{
      const response=await fetchFn(SOURCE_URL,{
        headers:{Accept:'application/json','Cache-Control':'no-cache'},
        signal:AbortSignal.timeout(10000)
      });
      if(!response.ok)throw new Error('DTEK feed HTTP '+response.status);
      data=await response.json();
    }catch(error){
      console.warn('Personal DTEK feed unavailable:',String(error?.message||error));
      return await tellOwner(scope==='dtek'?dtekEnv(env):env,chatId,
        '⚠️ Тимчасово не можу отримати підтверджені графіки. Спробуй трохи пізніше.');
    }
    if(scope==='plaza') {
      const date=kyivDate(now), tomorrow=nextDate(date);
      const dates=[date,tomorrow];
      const results=await Promise.all(dates.map(async d=>{
        const response=await stub.fetch('https://state.internal/current',{
          method:'POST',body:JSON.stringify({date:d})
        });
        return response.ok?await response.json():{periods:null};
      }));
      // Only override the date currently requested; histories use public feed.
      const selected=text.trim()==='📅 Завтра'||text.trim()==='/tomorrow'?1:0;
      if(results[selected]?.periods)override={date:dates[selected],periods:results[selected].periods};
    }
  }
  const result=personalAction({scope,text,profile,now,state:data,override});
  if(!result.handled)return false;
  if(result.changed) {
    const response=await stub.fetch('https://state.internal/profile',{
      method:'POST',body:JSON.stringify({scope,userId,profile:result.profile})
    });
    if(!response.ok)throw new Error('Cannot save personal preferences');
  }
  await tellOwner(scope==='dtek'?dtekEnv(env):env,chatId,result.text,
    result.replyMarkup);
  return true;
}

async function tellOwner(env,chatId,text,replyMarkup=null) {
  return telegramCall(env,'sendMessage',{
    chat_id:chatId,text,reply_markup:replyMarkup||undefined,
    disable_notification:true,parse_mode:'HTML'
  },env.TEST_FETCH||fetch);
}

/** Only secret-signed private messages can operate the bots. */
export async function handleTelegramWebhook(request,env,{now=new Date(),scope='plaza'}={}) {
  if(scope==='dtek'&&!env.DTEK_BOT_TOKEN)
    return new Response('DTEK bot is not configured',{status:503});
  const botEnv=scope==='dtek'?dtekEnv(env):env;
  const expectedSecret=await resolvedWebhookSecret(botEnv).catch(()=>null);
  if(!expectedSecret || request.headers.get('X-Telegram-Bot-Api-Secret-Token')!==expectedSecret)
    return new Response('Forbidden',{status:403});
  let update;
  try{update=await request.json();}catch{return new Response('OK');}
  // Never process channel_post or group updates; no feedback loops.
  const message=update?.message;
  if(!message||message.chat?.type!=='private'||!message.from?.id)
    return new Response('OK');
  const userId=String(message.from.id), chatId=String(message.chat.id);
  const text=String(message.text||message.caption||'');
  if(text.trim()==='/id' || text.trim().startsWith('/id@')) {
    await tellOwner(botEnv,chatId,'🆔 Ваш Telegram ID: <code>'+userId+'</code>');
    return new Response('OK');
  }
  const isAdmin=!!env.ADMIN_TELEGRAM_ID&&userId===String(env.ADMIN_TELEGRAM_ID);
  if(scope==='plaza' && isAdmin && /^\/(?:status22|sync22)(?:@\w+)?$/i.test(text.trim())) {
    if(!env.SCHEDULE_STATE) {
      await tellOwner(env,chatId,'⚠️ У Cloudflare відсутня прив’язка SCHEDULE_STATE.');
      return new Response('OK');
    }
    const nowDate=kyivDate(now),tomorrow=nextDate(nowDate);
    const isSync=/^\/sync22/i.test(text.trim());
    const stub=publisherStub(env);
    let posts=[],feedError='';
    try {
      const fetchFn=env.TEST_SOURCE_FETCH||fetch;
      const response=await fetchFn(SOURCE_URL,{
        headers:{Accept:'application/json','Cache-Control':'no-cache'},
        signal:AbortSignal.timeout(12000)
      });
      if(!response.ok)throw Error('GitHub HTTP '+response.status);
      posts=choosePosts(await response.json(),now);
    }catch(e){feedError=String(e?.message||e)}
    const rows=['🩺 <b>Автографік 2.2 — Плаза</b>',''];
    rows.push('📡 Джерело ДТЕК: '+(feedError?'❌ '+feedError:'✅ доступне'));
    rows.push('📍 Куди надсилаємо: <code>'+
      String(env.CHANNEL_ID||'не налаштовано').replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</code>');
    const blockedDates=[];
    for(const day of [nowDate,tomorrow]) {
      const post=posts.find(p=>p.date===day);
      const result=await stub.fetch('https://state.internal/status',{
        method:'POST',body:JSON.stringify({date:day})
      });
      if(!result.ok)throw Error('Cannot read schedule publisher state');
      const state=await result.json();
      if(state.status==='pending')blockedDates.push(day);
      rows.push('');
      rows.push((day===nowDate?'📆 Сьогодні: ':'🌅 Завтра: ')+day);
      rows.push('Графік 2.2: '+(post?
        '✅ '+post.periods.map(([a,b])=>
          String(Math.floor(a/60)).padStart(2,'0')+':'+
          String(a%60).padStart(2,'0')+'–'+
          String(Math.floor(b/60)).padStart(2,'0')+':'+
          String(b%60).padStart(2,'0')).join(', ') || '✅ Без відключень':
        '⏳ немає підтверджених даних'));
      rows.push('Публікація: '+({
        pending:'⚠️ Невідомий результат відправки, автоматичний повтор заблоковано',
        'awaiting-source-sync':'⏳ Очікування синхронізації після ручного графіка',
        published:'✅ збережено ID повідомлення '+state.messageId,
        'not-published':'❌ ще не опубліковано'
      }[state.status]||state.status));
      if(state.publishedAt)rows.push('Остання відправка: '+state.publishedAt);
      if(state.startedAt)rows.push('Початок незавершеної: '+state.startedAt);
    }
    if(isSync) {
      const post=posts.find(p=>p.date===tomorrow);
      if(!post)rows.push('\n⚠️ Повтор не виконано: підтвердженого графіка на завтра немає.');
      else {
        const response=await stub.fetch('https://state.internal/publish',{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({...post,source:'auto'})
        });
        const outcome=await response.json();
        rows.push('\n🔄 Перевірка відправки завтра: <b>'+
          String(outcome.status||'error')+'</b>');
        if(outcome.status==='published')rows.push('✅ Надіслано допис №'+outcome.messageId);
        if(outcome.status==='pending')rows.push('⚠️ Можливо вже надіслано. Потрібна перевірка у групі — не повторюємо наосліп.');
        if(outcome.error)rows.push('Помилка: '+String(outcome.error).replace(/&/g,'&amp;').replace(/</g,'&lt;'));
      }
    }
    rows.push('\n🔄 /sync22 — звичайна перевірка на завтра без дублів.');
    for(const blocked of blockedDates) {
      rows.push('\n⚠️ Якщо графіка '+blocked+' НЕМАЄ в каналі, після перевірки використай:');
      rows.push('<code>/recover22 '+blocked+'</code>');
      rows.push('Це ручне відновлення; /sync22 не знімає pending.');
    }
    await tellOwner(env,chatId,rows.join('\n'));
    return new Response('OK');
  }

  // Recover a blocked pending send ONLY after the owner has checked
  // the destination channel and explicitly confirmed the post is absent.
  const recoveryCommand=/^\/recover22(?:@\w+)?(?:\s+(\d{4}-\d{2}-\d{2})(?:\s+(CONFIRM))?)?$/i.exec(text.trim());
  if(scope==='plaza'&&isAdmin&&recoveryCommand) {
    const date=recoveryCommand[1],confirmed=Boolean(recoveryCommand[2]);
    const allowed=[kyivDate(now),nextDate(kyivDate(now))];
    if(!date||!allowed.includes(date)) {
      await tellOwner(env,chatId,
        '⚠️ Формат: <code>/recover22 РРРР-ММ-ДД</code>. Доступні лише сьогодні та завтра.');
      return new Response('OK');
    }
    if(!env.SCHEDULE_STATE) {
      await tellOwner(env,chatId,'❌ Немає SCHEDULE_STATE у Cloudflare.');
      return new Response('OK');
    }
    const stub=publisherStub(env);
    const response=await stub.fetch('https://state.internal/status',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({date})
    });
    if(!response.ok)throw Error('Cannot read pending publication');
    const state=await response.json();
    if(state.status!=='pending'||!state.startedAt) {
      await tellOwner(env,chatId,
        'ℹ️ Для '+date+' немає незавершеної публікації. Стан: <b>'+
        String(state.status||'unknown')+'</b>. Перевір /status22.');
      return new Response('OK');
    }
    if(!confirmed) {
      await tellOwner(env,chatId,
        '⚠️ <b>Відновлення графіка 2.2 за '+date+'</b>\n\n'+
        'Спершу перевір канал <b>'+
        String(env.CHANNEL_ID||'Плаза').replace(/&/g,'&amp;').replace(/</g,'&lt;')+
        '</b>: повідомлення за цю дату справді НЕМАЄ.\n\n'+
        'Тільки після перевірки надішли:\n'+
        '<code>/recover22 '+date+' CONFIRM</code>\n\n'+
        'Можливий дубль, якщо Telegram фактично прийняв старе повідомлення.');
      return new Response('OK');
    }
    const fetchFn=env.TEST_SOURCE_FETCH||fetch;
    const feedResponse=await fetchFn(SOURCE_URL+'?recovery='+encodeURIComponent(String(now.getTime())),{
      headers:{Accept:'application/json','Cache-Control':'no-cache'},
      cache:'no-store',signal:AbortSignal.timeout(12000)
    });
    if(!feedResponse.ok) {
      await tellOwner(env,chatId,'❌ Джерело ДТЕК недоступне. Відновлення не виконано.');
      return new Response('OK');
    }
    const post=choosePosts(await feedResponse.json(),now).find(p=>p.date===date);
    if(!post) {
      await tellOwner(env,chatId,'❌ Немає повного підтвердженого графіка на '+date+'.');
      return new Response('OK');
    }
    const sent=await stub.fetch('https://state.internal/publish',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...post,source:'auto',recovery:{
        confirmedMissing:true,pendingSince:state.startedAt
      }})
    });
    const outcome=await sent.json();
    if(outcome.status==='published') {
      await tellOwner(env,chatId,'✅ Відновлено публікацію 2.2 на '+date+
        ' у '+String(env.CHANNEL_ID||'канал')+
        '. Telegram підтвердив повідомлення №'+outcome.messageId+'.');
    } else {
      const explanations={
        'recovery-refused':'Стан або години змінилися, повтор заблоковано.',
        pending:'Telegram знову не підтвердив відправку; автоматичний повтор заблоковано.',
        unchanged:'Цей графік уже збережений як опублікований.',
        error:'Не вдалося підтвердити доставку. Перевір логи та канал.'
      };
      await tellOwner(env,chatId,'⚠️ Відновлення '+date+': <b>'+
        String(outcome.status||'error')+'</b>\n'+
        (explanations[outcome.status]||'Перевір /status22 та канал.'));
    }
    return new Response('OK');
  }

  if(scope==='plaza'&&isAdmin&&/^\/syncstatus(?:@plazakvartalbot)?$/i.test(text.trim())) {
    if(!env.SCHEDULE_STATE) {
      await tellOwner(env,chatId,'⚠️ Не налаштовано SCHEDULE_STATE у Cloudflare.');
      return new Response('OK');
    }
    const today=kyivDate(now),tomorrow=nextDate(today);
    const response=await publisherStub(env).fetch('https://state.internal/diagnostics',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({dates:[today,tomorrow]})
    });
    if(!response.ok)throw new Error('Cannot read 2.2 sync diagnostics');
    const info=await response.json();
    const statuses={
      published:'✅ Опубліковано',pending:'⚠️ Невизначена відправка',
      'not-published':'⏳ Ще не опубліковано'
    };
    const lines=['🩺 <b>Автопублікація ДТЕК — підгрупа 2.2</b>',''];
    if(info.lastCron?.checkedAt) {
      const dt=new Date(info.lastCron.checkedAt);
      const local=Number.isNaN(dt.getTime())?'невідомо':
        new Intl.DateTimeFormat('uk-UA',{timeZone:'Europe/Kyiv',
          day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(dt);
      const age=Math.round((now.getTime()-dt.getTime())/60000);
      const fresh=age>=0&&age<=15;
      lines.push((fresh?'✅':'⚠️')+' Останній Cron: '+local+
        (Number.isFinite(age)?' ('+Math.max(0,age)+' хв тому)':''));
      if(info.lastCron.status==='error')
        lines.push('❌ Помилка перевірки: '+String(info.lastCron.error||'невідома').slice(0,150));
    } else {
      lines.push('⚠️ Запису про роботу Cron ще немає.');
    }
    const outcome=Object.fromEntries((info.lastCron?.results||[])
      .filter(x=>DAY.test(x?.date||'')).map(x=>[x.date,x.status]));
    for(const date of [today,tomorrow]) {
      const day=info.days?.[date]||{};
      lines.push('',(date===today?'📅 Сьогодні: ':'🌅 Завтра: ')+date,
        statuses[day.status]||'⏳ Не відомо');
      if(day.messageId)lines.push('📨 Допис №'+day.messageId);
      if(day.pendingSince)lines.push('⚠️ Потрібно перевірити, чи Telegram прийняв повідомлення.');
      if(day.manualHold)lines.push('⏸ Очікування джерела після ручного графіка.');
      if(outcome[date])lines.push('🔄 Результат Cron: '+outcome[date]);
    }
    lines.push('','🔒 Діагностика доступна тільки власнику бота.');
    await tellOwner(env,chatId,lines.join('\n'));
    return new Response('OK');
  }
  // Preserve owner-forwarded 2.2 schedules before personal menu handling.
  if(scope==='plaza'&&isAdmin){
    const schedule=parseForwardedGroup22(text,now);
    if(schedule){
      if(!env.SCHEDULE_STATE)throw new Error('SCHEDULE_STATE binding unavailable');
      const response=await publisherStub(env).fetch('https://state.internal/publish',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(schedule)
      });
      const result=await response.json();
      if(result.status==='published')
        await tellOwner(env,chatId,'✅ Опублікував підгрупу 2.2 за '+schedule.date+
          ' у канал. Це новий допис №'+result.messageId+'.');
      else if(result.status==='unchanged')
        await tellOwner(env,chatId,
          'ℹ️ Графік 2.2 за '+schedule.date+' не змінився. Повторно не публікую.');
      else if(result.status==='awaiting-source-sync')
        await tellOwner(env,chatId,'ℹ️ Очікую оновлення автоматичного джерела.');
      else await tellOwner(env,chatId,
        '⚠️ Не вдалося підтвердити публікацію ('+
          String(result.status||'error')+'). Перевір канал і логи.');
      return new Response('OK');
    }
  }
  if(await privateMenu(env,scope,userId,chatId,text,now))
    return new Response('OK');
  // Never publish arbitrary private messages; only owner can forward valid schedules.
  if(scope==='plaza'&&isAdmin&&text&&!text.startsWith('/'))
    await tellOwner(env,chatId,
      '⚠️ Не знайшов підтверджений графік 2.2 на сьогодні або завтра. '+
      'Перешли текст із датою, заголовком «Підгрупа 2.2 відключення:» і точними інтервалами.');
  return new Response('OK');
}

export default {
  // POST from Telegram; the only posting path is an authenticated
  // private admin chat, never a channel_post or a public group message.
  async fetch(request,env) {
    const pathname=new URL(request.url).pathname;
    if(pathname==='/setup' && request.method==='GET')
      return renderBrowserSetupPage();
    if(pathname==='/setup-dtek' && request.method==='GET')
      return renderDtekSetupPage();
    if(['/setup','/setup-dtek'].includes(pathname) && request.method==='POST') {
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
      const setupEnv=pathname==='/setup-dtek'?dtekEnv(env):env;
      let result;
      if(payload?.mode==='inspect') {
        result=await inspectOwnWebhook(request,setupEnv);
      } else if(payload?.mode==='connect' && payload?.acceptTransfer===true) {
        result=await installOwnWebhook(request,setupEnv,{
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
    if(request.method!=='POST' || !['/','/telegram','/telegram/dtek'].includes(pathname))
      return new Response('OK');
    try{return await handleTelegramWebhook(request,env,{
      scope:pathname==='/telegram/dtek'?'dtek':'plaza'
    });}
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
