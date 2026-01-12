export default {
  async fetch(request, env, ctx) {
    const router = Router();
    
    // Webhook endpoint для Telegram
    router.post('/webhook', async (request) => {
      const update = await request.json();
      const payload = await processTelegramUpdate(update);
      
      if (payload) {
        await sendToChannel(env.BOT_TOKEN, env.CHANNEL_ID, payload);
      }
      
      return new Response('OK', { status: 200 });
    });

    return router.handle(request);
  }
};

async function processTelegramUpdate(update) {
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
    
    const start = startH * 60 + startM;
    const end = endH * 60 + endM;
    const duration = end - start;
    
    if (duration <= 0) return '';
    
    const hours = duration / 60;
    return `(${hours.toFixed(1)} год)`;
  } catch {
    return '';
  }
}

function parseDarkHours(text) {
  const patterns = [
    /(\d{2}:\d{2})[\s–-](\d{2}:\d{2})/gi,
    /від\s+(\d{2}:\d{2})\s+до\s+(\d{2}:\d{2})/gi,
    /з\s+(\d{2}:\d{2})\s+до\s+(\d{2}:\d{2})/gi
  ];
  
  let totalMinutes = 0;
  let modifiedText = text;
  
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(modifiedText)) !== null) {
      const startStr = match[1];
      const endStr = match[2];
      
      const durationStr = formatDuration(startStr, endStr);
      if (durationStr) {
        const prefix = '–' in match[0] ? '–' : '-';
        const replacement = `${startStr}${prefix}${endStr}${durationStr}`;
        
        modifiedText = modifiedText.slice(0, match.index) + 
                      replacement + 
                      modifiedText.slice(match.index + match[0].length);
        
        const [startH, startM] = startStr.split(':').map(Number);
        const [endH, endM] = endStr.split(':').map(Number);
        totalMinutes += (endH - startH) * 60 + (endM - startM);
      }
    }
  }
  
  const hours = totalMinutes / 60;
  const summary = hours > 0 ? `⚫ Без світла: ${hours.toFixed(1)} годин` : '';
  return { modifiedText, summary };
}

function build22Message(text) {
  const lines = text.split('\n');
  
  // Знаходимо шапку
  let header = lines.find(line => line.trim()) || '';
  
  // Формат "Підгрупа 2.2 відключення"
  const start22Index = lines.findIndex(line => 
    line.includes('Підгрупа') && line.includes('2.2')
  );
  
  if (start22Index !== -1) {
    const block = [];
    for (let i = start22Index; i < lines.length; i++) {
      if (lines[i].trim() === '' && block.length > 0) break;
      block.push(lines[i]);
    }
    
    const blockText = block.filter(l => l.trim()).join('\n');
    let fullText = header + '\n\n' + blockText;
    
    const { modifiedText, summary } = parseDarkHours(fullText);
    return summary ? modifiedText + '\n\n' + summary : null;
  }
  
  // Формат "О 18:30 / Вмикаємо 2.2 підгрупу"
  const line22 = lines.find(line => 
    line.includes('2.2') && line.includes('підгрупу')
  );
  
  if (line22) {
    const fullText = line22 === header ? line22 : `${header}\n${line22}`;
    const { modifiedText, summary } = parseDarkHours(fullText);
    return summary ? modifiedText + '\n\n' + summary : null;
  }
  
  return null;
}

async function sendToChannel(token, channelId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: channelId,
      text: text,
      parse_mode: 'HTML'
    })
  });
  
  return response.ok;
}
