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
    if(current){
      let previous;
      try{previous=new URL(current);}
      catch{return {status:'conflict',reason:'Existing Telegram webhook address is invalid'};}
      if(previous.origin!==new URL(target).origin){
        if(!allowTransfer)
          return {status:'conflict',reason:'This bot token already has a different webhook address'};
        // Verify Telegram bot identity and that the existing webhook has not
        // changed between inspection and owner's explicit confirmation.
        const bot=await telegram(env,'getMe',{},fetchFn);
        const confirmed=String(expectedBotUsername).replace(/^@/,'').toLowerCase();
        if(!bot?.is_bot || !confirmed || confirmed!==String(bot.username??'').toLowerCase())
          return {status:'confirmation-required',reason:'Telegram bot username confirmation does not match'};
        if((await webhookFingerprint(current))!==expectedWebhookFingerprint)
          return {status:'conflict',reason:'Existing webhook changed; inspect again before transferring'};
      }
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
  return new Response("<!doctype html><html lang=\"uk\"><head><meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>Підключення Telegram • Графік 2.2</title>\n<style>body{background:#f5f7fb;font-family:system-ui,-apple-system,sans-serif;color:#132334;margin:0;padding:30px 12px}main{max-width:650px;margin:30px auto;background:white;padding:36px;border-radius:22px;box-shadow:0 10px 40px #16263813}h1{font-size:28px;margin:0 0 8px}p{line-height:1.6}ul{line-height:2;padding-left:24px}button{cursor:pointer;border:0;color:white;background:#145acc;border-radius:12px;font-weight:600;font-size:16px;padding:15px 22px}button:disabled{opacity:.5;cursor:wait}#result{white-space:pre-wrap;line-height:1.6;color:#15344d;margin-top:18px}small{color:#607080}</style></head><body><main>\n<h1>💡 Графік ДТЕК — підгрупа 2.2</h1>\n<p>Підключення резервного пересилання <b>без термінала</b>.</p>\n<ul><li>У Cloudflare уже задані BOT_TOKEN та CHANNEL_ID</li>\n<li>У Settings → Variables and Secrets додано ADMIN_TELEGRAM_ID — числовий ID власника Telegram</li>\n<li>Бот — адміністратор каналу/групи з правом публікації</li></ul>\n<p><small>Система перевірить, що бот не прив'язаний до іншого вебсайту. Ця дія налаштовує webhook виключно на поточний Worker.</small></p>\n<button id=\"connect\">Підключити Telegram webhook</button><div role=\"status\" id=\"result\"></div>\n<script>\ndocument.querySelector('#connect').addEventListener('click',async()=>{\nconst button=document.querySelector('#connect'),out=document.querySelector('#result');\nbutton.disabled=true;out.textContent='Перевіряю налаштування…';\ntry{\nconst resp=await fetch('/setup',{method:'POST',headers:{'Content-Type':'application/json'}});\nconst body=await resp.json();\nif(body.status==='connected')out.textContent='✅ Telegram webhook підключено. Перешли боту в особисті повідомлення графік із датою й підгрупою 2.2.';\nelse out.textContent='⚠️ '+(body.reason||body.status);\n}catch(e){out.textContent='Помилка з’єднання: '+e.message;}\nbutton.disabled=false;\n});\n</script></main></body></html>",{
    headers:{
      'Content-Type':'text/html; charset=utf-8',
      'Cache-Control':'no-store',
      'Referrer-Policy':'no-referrer',
      'X-Content-Type-Options':'nosniff',
      'Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    }
  });
}
