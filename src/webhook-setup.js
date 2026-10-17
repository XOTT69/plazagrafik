/**
 * Browser-only Telegram webhook setup.
 * The setup endpoint only points the Telegram bot at the same deployed
 * plazagrafik workers.dev origin and never a user-provided destination.
 * Replacing a different webhook requires authenticated, explicit confirmation
 * of the existing bot username and current webhook snapshot.
 */
async function telegram(env,method,params={},fetchFn=fetch) {
  const token=String(env?.BOT_TOKEN??'');
  if(!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('BOT_TOKEN missing or invalid');
  const response=await fetchFn('https://api.telegram.org/bot'+token+'/'+method,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(params),signal:AbortSignal.timeout(13000)
  });
  const payload=await response.json();
  if(!response.ok||payload?.ok!==true)
    throw new Error('Telegram '+method+' rejected: HTTP '+response.status);
  return payload.result;
}
export async function resolvedWebhookSecret(env) {
  const explicit=String(env?.WEBHOOK_SECRET??'').trim();
  if(explicit){
    if(!/^[A-Za-z0-9_-]{1,256}$/.test(explicit))
      throw new Error('Invalid WEBHOOK_SECRET format');
    return explicit;
  }
  const token=String(env?.BOT_TOKEN??'');
  if(!/^\d+:[A-Za-z0-9_-]+$/.test(token))throw new Error('BOT_TOKEN missing or invalid');
  // Deterministic webhook secret derived from existing high-entropy bot
  // token; neither the token nor the secret is returned to the client.
  const input=new TextEncoder().encode('plazagrafik:telegram:webhook:v1:'+token);
  const bytes=await crypto.subtle.digest('SHA-256',input);
  return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export function workerWebhookUrl(request) {
  const url=new URL(request.url);
  if(url.protocol!=='https:'||!/^plazagrafik\.[a-z0-9.-]+\.workers\.dev$/i.test(url.hostname))
    throw new Error('Open /setup on the deployed plazagrafik workers.dev domain');
  return url.origin+'/telegram';
}

async function webhookFingerprint(url) {
  const data=new TextEncoder().encode(String(url??''));
  const hash=await crypto.subtle.digest('SHA-256',data);
  return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

/** A Cloudflare Secret, never a public Telegram user ID, gates setup actions. */
export async function validateSetupKey(env,provided) {
  const secret=String(env?.SETUP_KEY??'');
  const candidate=String(provided??'');
  if(secret.length<24||secret.length>256||candidate.length>256||!candidate)
    return false;
  const encode=new TextEncoder();
  const [a,b]=await Promise.all([
    crypto.subtle.digest('SHA-256',encode.encode(secret)),
    crypto.subtle.digest('SHA-256',encode.encode(candidate))
  ]);
  const x=new Uint8Array(a),y=new Uint8Array(b);
  let difference=0;
  for(let i=0;i<x.length;i++)difference|=x[i]^y[i];
  return difference===0;
}

/** Read-only inspection after setup-key authentication, token never exposed. */
export async function inspectOwnWebhook(request,env,{fetchFn=fetch}={}) {
  try {
    const target=workerWebhookUrl(request);
    if(!/^\d{4,16}$/.test(String(env?.ADMIN_TELEGRAM_ID??'')))
      return {status:'configuration-required',reason:'Set ADMIN_TELEGRAM_ID in Cloudflare'};
    if(!String(env?.CHANNEL_ID??'').trim())
      return {status:'configuration-required',reason:'Set CHANNEL_ID in Cloudflare'};
    await resolvedWebhookSecret(env);
    const bot=await telegram(env,'getMe',{},fetchFn);
    const info=await telegram(env,'getWebhookInfo',{},fetchFn);
    if(!bot?.is_bot || !/^[A-Za-z0-9_]{5,32}$/.test(String(bot.username??'')))
      return {status:'error',reason:'Telegram did not return a valid bot username'};
    const current=String(info?.url??'');
    let host='Не налаштовано';
    if(current){
      try {host=new URL(current).host;}
      catch {return {status:'error',reason:'Invalid existing Telegram webhook URL'};}
    }
    return {
      status:'ready',botUsername:'@'+bot.username,
      currentWebhookHost:host,
      alreadyConnected:current===target,
      webhookFingerprint:await webhookFingerprint(current)
    };
  } catch(error){
    return {status:'error',reason:String(error?.message||error)};
  }
}

export async function installOwnWebhook(request,env,{
  fetchFn=fetch,allowTransfer=false,expectedBotUsername='',
  expectedWebhookFingerprint=''
}={}) {
  try {
    if(!/^\d{4,16}$/.test(String(env?.ADMIN_TELEGRAM_ID??'')))
      return {status:'configuration-required',reason:'Set ADMIN_TELEGRAM_ID in Cloudflare → Worker → Settings → Variables and Secrets'};
    if(!String(env?.CHANNEL_ID??'').trim())
      return {status:'configuration-required',reason:'Set CHANNEL_ID in the Cloudflare Worker settings'};
    const target=workerWebhookUrl(request);
    const secret=await resolvedWebhookSecret(env);
    const info=await telegram(env,'getWebhookInfo',{},fetchFn);
    const current=String(info?.url??'');
    if(allowTransfer){
      // Always prove bot identity and old state before connecting a webhook,
      // including on a new bot with no current webhook or the same endpoint.
      const bot=await telegram(env,'getMe',{},fetchFn);
      const confirmed=String(expectedBotUsername).replace(/^@/,'').toLowerCase();
      if(!bot?.is_bot || !confirmed || confirmed!==String(bot.username??'').toLowerCase())
        return {status:'confirmation-required',reason:'Telegram bot username confirmation does not match'};
      if((await webhookFingerprint(current))!==expectedWebhookFingerprint)
        return {status:'conflict',reason:'Existing webhook changed; inspect again before transferring'};
    }
    if(current){
      let previous;
      try{previous=new URL(current);}
      catch{return {status:'conflict',reason:'Existing Telegram webhook address is invalid'};}
      if(previous.origin!==new URL(target).origin&&!allowTransfer)
        return {status:'conflict',reason:'This bot token already has a different webhook address'};
    }
    await telegram(env,'setWebhook',{
      url:target,secret_token:secret,allowed_updates:['message'],
      drop_pending_updates:false
    },fetchFn);
    const verify=await telegram(env,'getWebhookInfo',{},fetchFn);
    if(verify?.url!==target)throw new Error('Telegram did not confirm the webhook');
    return {status:'connected'};
  }catch(error){
    return {status:'error',reason:String(error?.message||error)};
  }
}

export function renderBrowserSetupPage() {
  return new Response("<!doctype html>\n<html lang=\"uk\"><head><meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>Резервне пересилання • Плаза 2.2</title>\n<style>\n*{box-sizing:border-box}body{background:#f5f7fa;color:#15273d;font:16px system-ui,-apple-system,sans-serif;margin:0;padding:24px 12px}\nmain{max-width:690px;margin:20px auto;background:#fff;padding:32px;border-radius:22px;box-shadow:0 12px 35px #17243414}\nh1{font-size:27px;margin:0 0 12px}h2{font-size:18px;margin:24px 0 12px}p{line-height:1.55}label{display:block;margin:12px 0 6px;font-weight:600}\ninput[type=text],input[type=password]{width:100%;min-height:44px;padding:10px;border:1px solid #bec8d8;border-radius:8px;font-size:15px}\nbutton{border:0;background:#135bc9;color:white;font-size:15px;font-weight:650;border-radius:10px;padding:13px 18px;cursor:pointer;margin-top:12px}\nbutton:disabled{opacity:.4;cursor:not-allowed}button.secondary{background:#e8f0ff;color:#135bc9}\n.row{display:flex;gap:10px;flex-wrap:wrap}small{color:#52657e;line-height:1.45}\n.status{margin-top:14px;white-space:pre-wrap;line-height:1.5}.panel{padding:16px;border:1px solid #dae3f0;border-radius:12px;margin-top:16px}\n.check{font-weight:400;display:flex;align-items:flex-start;gap:12px;line-height:1.5}\ncode{background:#f3f5f8;padding:2px 4px;border-radius:4px}\n</style></head><body><main>\n<h1>💡 Плаза — графік 2.2</h1>\n<p>Автоматична публікація працює незалежно від webhook. Тут можна перенести <b>резервне пересилання</b> зі старого обробника того самого бота, не зачіпаючи бота «Світло є / зникло».</p>\n<h2>1. Захист налаштування</h2>\n<p>У Cloudflare → <b>plazagrafik → Settings → Variables and Secrets</b> додайте <code>SETUP_KEY</code> як <b>Secret</b>. Згенеруйте ключ нижче, скопіюйте його до Cloudflare та збережіть.</p>\n<label for=\"key\">SETUP_KEY (тільки для цієї сторінки й Cloudflare)</label>\n<input id=\"key\" type=\"password\" autocomplete=\"off\" spellcheck=\"false\" placeholder=\"Мінімум 24 символи\">\n<div class=\"row\"><button class=\"secondary\" id=\"generate\">Згенерувати ключ</button><button class=\"secondary\" id=\"copy\">Копіювати ключ</button></div>\n<p><small>Ключ не записується у GitHub, не додається до адреси сторінки і не передається в ChatGPT. Після оновлення сторінки потрібно буде ввести його знову.</small></p>\n<h2>2. Перевірити старе підключення</h2>\n<button id=\"inspect\">Перевірити Telegram-бота</button>\n<div class=\"status\" id=\"inspection\" role=\"status\"></div>\n<section class=\"panel\" id=\"confirmArea\" hidden>\n<h2>3. Підтвердити перенесення</h2>\n<p><b>Переконайся, що вказаний нижче @username належить саме боту графіків, а не боту фактичної наявності світла.</b></p>\n<label for=\"username\">Введи @username показаного Telegram-бота</label>\n<input id=\"username\" type=\"text\" autocomplete=\"off\" autocapitalize=\"off\" spellcheck=\"false\" placeholder=\"@імʼя_бота\">\n<label class=\"check\"><input type=\"checkbox\" id=\"ack\">\nЯ підтверджую, що це бот графіків 2.2. Розумію, що старий webhook перестане отримувати вхідні повідомлення й резервне пересилання оброблятиме plazagrafik.\n</label>\n<button id=\"connect\" disabled>Перенести резервне пересилання</button>\n</section>\n<div class=\"status\" id=\"result\" role=\"status\"></div>\n<script>\nconst key=document.getElementById('key'),inspection=document.getElementById('inspection'),\nresult=document.getElementById('result'),panel=document.getElementById('confirmArea'),\nack=document.getElementById('ack'),name=document.getElementById('username'),\nconnect=document.getElementById('connect');\nlet observed=null;\ndocument.getElementById('generate').addEventListener('click',()=>{\nconst bytes=new Uint8Array(32);crypto.getRandomValues(bytes);\nkey.value=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');\nresult.textContent='Ключ згенеровано. Скопіюй його та додай як Secret SETUP_KEY у Cloudflare, потім повернись сюди.';\n});\ndocument.getElementById('copy').addEventListener('click',async()=>{\ntry{await navigator.clipboard.writeText(key.value);result.textContent='Ключ скопійовано.';}\ncatch{key.type='text';key.select();result.textContent='Скопіюй виділений ключ вручну.';}\n});\nfunction reset(){observed=null;panel.hidden=true;connect.disabled=true;ack.checked=false;}\nkey.addEventListener('input',reset);\nasync function call(body) {\nconst response=await fetch('/setup',{method:'POST',headers:{'Content-Type':'application/json'},\nbody:JSON.stringify({setupKey:key.value,...body})});\nreturn response.json();\n}\ndocument.getElementById('inspect').addEventListener('click',async()=>{\nreset();inspection.textContent='Перевіряю Telegram…';result.textContent='';\ntry{\nconst data=await call({mode:'inspect'});\nif(data.status!=='ready'){inspection.textContent='⚠️ '+(data.reason||data.status);return;}\nobserved=data;\ninspection.textContent='Telegram-бот: '+data.botUsername+\n'\\nПопередній webhook (домен): '+data.currentWebhookHost+\n'\\n'+(data.alreadyConnected?'Webhook уже спрямований на цей Worker.':'Вхідні повідомлення досі надходять на інший webhook.');\npanel.hidden=false;\n}catch(e){inspection.textContent='⚠️ '+e.message;}\n});\nfunction updateButton(){connect.disabled=!observed || !ack.checked || !name.value.trim();}\nname.addEventListener('input',updateButton);\nack.addEventListener('change',updateButton);\nconnect.addEventListener('click',async()=>{\nif(!observed||!ack.checked)return;\nconnect.disabled=true;result.textContent='Перевіряю підтвердження та підключаю…';\ntry{\nconst data=await call({mode:'connect',botUsername:name.value.trim(),\nwebhookFingerprint:observed.webhookFingerprint,acceptTransfer:true});\nif(data.status==='connected') {\nresult.textContent='✅ Резервне пересилання підключено до plazagrafik. Перешли графік у приватний чат боту для перевірки.';\nreset();\n} else {\nresult.textContent='⚠️ '+(data.reason||data.status)+'\\nЗа потреби повтори перевірку бота.';\n}\n}catch(e){result.textContent='⚠️ '+e.message;}\nconnect.disabled=false;\n});\n</script></main></body></html>",{
    headers:{
      'Content-Type':'text/html; charset=utf-8',
      'Cache-Control':'no-store',
      'Referrer-Policy':'no-referrer',
      'X-Content-Type-Options':'nosniff',
      'Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    }
  });
}
