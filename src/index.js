export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    
    if (pathname === '/webhook') {
      return handleWebhook(request, env);
    }
    
    return new Response('DTEK 2.2 Bot OK', { status: 200 });
  }
};

async function handleWebhook(request, env) {
  const update = await request.json();
  const payload = processTelegramUpdate(update);
  
  if (payload) {
    await sendToChannel(env.BOT_TOKEN, env.CHANNEL_ID, payload);
  }
  
  return new Response('OK', { status: 200 });
}

function processTelegramUpdate(update) {
  const message = update.message;
  if (!message) return null;
  
  const text = message.text || message.caption || '';
  if (!text) return null;
  
  return build22Message(text);
}

function formatDuration(startStr, endStr) {
  try {
    const [startH, startM] = startStr.split(':').map(Number);
    const [endH, endM] = endStr.split(':').map(Number);
    const duration = (endH * 60 + endM) - (startH * 60 + startM);
    if (duration <= 0) return '';
    return `(${ (duration / 60).toFixed(1) } год)`;
  } catch { return ''; }
}

function parseDarkHours(text) {
  const patterns = [ /(\d{2}:\d{2})[\s–-](\d{2}:\d{2})/gi, /від\s+(\d{2}:\d{2})\s+до\s+(\d{2}:\d{2})/gi, /з\s+(\d{2}:\d{2})\s+до\s+(\d{2}:\d{2})/gi ];
  let totalMinutes = 0;
  let modified = text;
  
  for (const pattern of patterns) {
    let match;
    while (match = pattern.exec(modified)) {
      const [, start, end] = match;
      const duration = formatDuration(start, end);
      if (duration) {
        const replacement = `${start}–${end}${duration}`;
        modified = modified.slice(0, match.index) + replacement + modified.slice(match.index + match[0].length);
        totalMinutes += ((end.split(':').map(Number).reduce((a,b)=>a*60+b)) - (start.split(':').map(Number).reduce((a,b)=>a*60+b)));
      }
    }
  }
  
  const hours = totalMinutes / 60;
  const summary = hours > 0 ? `\n\n⚫ Без світла: ${hours.toFixed(1)} годин` : '';
  return { text: modified, summary };
}

function build22Message(text) {
  const lines = text.split('\n');
  const header = lines.find(l => l.trim()) || '';
  
  // Підгрупа 2.2
  const idx22 = lines.findIndex(l => l.includes('Підгрупа') && l.includes('2.2'));
  if (idx22 > -1) {
    const block = lines.slice(idx22, lines.findIndex((l,i)=>i>idx22 && !l.trim()));
    const full = header + '\n\n' + block.join('\n');
    const result = parseDarkHours(full);
    return result.summary ? result.text + result.summary : null;
  }
  
  // Вмикаємо 2.2 підгрупу
  const line22 = lines.find(l => l.includes('2.2') && l.includes('підгрупу'));
  if (line22) {
    const full = header + '\n' + line22;
    const result = parseDarkHours(full);
    return result.summary ? result.text + result.summary : null;
  }
  
  return null;
}

async function sendToChannel(token, channelId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: channelId,
      text,
      parse_mode: 'HTML'
    })
  }).then(r => r.ok);
}
