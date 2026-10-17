import {SOURCE_URL,choosePosts} from './schedule22.js';

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
 * Records the Telegram message ID per *calendar date*. Later revisions and
 * the tomorrow->today transition edit that exact message in place.
 *
 * The old webhook no longer republishes a channel message. Only the cron
 * trigger calls this object with confirmed daily DTEK source content.
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
      if(!DAY.test(payload?.date||'')||
        typeof payload.text!=='string'||!payload.text||
        payload.text.length>POST_MAX_LENGTH ||
        !payload.text.includes('Підгрупа 2.2 відключення:')) {
        return Response.json({status:'invalid'}, {status:400});
      }
      const key='date:'+payload.date;
      const previous=await this.ctx.storage.get(key);
      if(previous?.text===payload.text && previous?.messageId)
        return Response.json({status:'unchanged'});
      if(previous?.status==='pending' && !previous?.messageId) {
        // The original send may have succeeded, but the response was lost.
        // Never risk a duplicate send; operator can reconcile the message ID.
        return Response.json({status:'pending',reason:'delivery outcome unknown'});
      }
      if(previous?.messageId) {
        // If the post was deleted, fail safely: don't publish a replacement.
        await telegramCall(this.env,'editMessageText',{
          message_id:previous.messageId,text:payload.text
        },this.env.TEST_FETCH||fetch);
        await this.ctx.storage.put(key,{
          ...previous,text:payload.text,status:'published',
          editedAt:new Date().toISOString()
        });
        return Response.json({status:'edited',messageId:previous.messageId});
      }
      // Persist BEFORE sending. If the Telegram call times out after a
      // successful send, later crons must not generate a second message.
      await this.ctx.storage.put(key,{
        status:'pending',text:payload.text,startedAt:new Date().toISOString()
      });
      let sent;
      try {
        sent=await telegramCall(this.env,'sendMessage',{
          text:payload.text,disable_notification:false
        },this.env.TEST_FETCH||fetch);
      }catch(err) {
        // A definitive 4xx response means Telegram did not accept this send;
        // retry on a later cron once permissions or rate limit recover.
        if(err.status>=400 && err.status<500)await this.ctx.storage.delete(key);
        throw err;
      }
      if(!Number.isSafeInteger(sent?.message_id) || sent.message_id<1)
        throw new Error('Telegram delivery uncertain: no message_id returned');
      await this.ctx.storage.put(key,{
        status:'published',text:payload.text,messageId:sent.message_id,
        publishedAt:new Date().toISOString()
      });
      return Response.json({status:'published',messageId:sent.message_id});
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

export default {
  // Telegram can keep its webhook pointed here; incoming channel messages
  // are intentionally ignored. No copies of manual publications are sent.
  async fetch() {
    return new Response('OK');
  },
  async scheduled(_event,env,ctx) {
    ctx.waitUntil(checkDtekAndPublish(env).then(results=>{
      console.log('Confirmed DTEK 2.2 cron:',JSON.stringify(results));
    }).catch(error=>console.error('Group 2.2 cron failed:',error.message)));
  }
};
