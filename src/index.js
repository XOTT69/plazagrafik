export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Перевірка, що бот живий (для браузера)
    if (request.method === 'GET') {
      return new Response('DTEK 2.2 Bot is Active ✅');
    }

    // Обробка Webhook від Telegram
    if (url.pathname === '/webhook' && request.method === 'POST') {
      try {
        const update = await request.json();
        
        // Логіка обробки повідомлення
        if (update.message && (update.message.text || update.message.caption)) {
          const rawText = update.message.text || update.message.caption;
          
          // 1. Аналізуємо текст (чи є там про 2.2)
          const processedMessage = build22Message(rawText);

          // 2. Якщо є результат — відправляємо в канал
          if (processedMessage) {
            await sendMessage(env.BOT_TOKEN, env.CHANNEL_ID, processedMessage);
          }
        }
        
        return new Response('OK');
      } catch (e) {
        return new Response('Error: ' + e.message, { status: 200 }); // 200 щоб Telegram не спамив повторами
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};

// --- ОСНОВНА ЛОГІКА (Аналог Python build_22_message) ---

function build22Message(text) {
  const lines = text.split('\n');
  
  // Знаходимо заголовок (перший непорожній рядок)
  let header = '';
  for (const line of lines) {
    if (line.trim()) {
      header = line;
      break;
    }
  }
  if (!header) return null;

  // Варіант 1: "Підгрупа 2.2 відключення" (Блок)
  const start22Index = lines.findIndex(line => line.includes('Підгрупа') && line.includes('2.2'));
  
  if (start22Index !== -1) {
    // Збираємо блок до порожнього рядка
    const block = [];
    for (let i = start22Index; i < lines.length; i++) {
      if (lines[i].trim() === '' && block.length > 0) break;
      block.push(lines[i]);
    }
    const blockText = block.filter(l => l.trim()).join('\n');
    
    // Формуємо повний текст
    // (Python брав header + перші 2 рядки, тут спростимо: Header + блок)
    let fullText = header + '\n\n' + blockText;
    
    // Парсимо години
    return parseDarkHours(fullText);
  }

  // Варіант 2: "О 18:30 / Вмикаємо 2.2 підгрупу" (Рядок)
  const line22 = lines.find(line => line.includes('2.2') && line.includes('підгрупу'));
  
  if (line22) {
    let fullText = (line22 === header) ? line22 : `${header}\n${line22}`;
    return parseDarkHours(fullText);
  }

  return null;
}

// --- ПАРСИНГ ГОДИН (Аналог Python parse_dark_hours) ---

function parseDarkHours(text) {
  // Регулярки з Python скрипта
  const patterns = [
    /(\d{1,2}:\d{2})[\s–-](\d{1,2}:\d{2})/gi,           // 18:00-22:00
    /від\s+(\d{1,2}:\d{2})\s+до\s+(\d{1,2}:\d{2})/gi,   // від 18:00 до 22:00
    /з\s+(\d{1,2}:\d{2})\s+до\s+(\d{1,2}:\d{2})/gi      // з 18:00 до 22:00
  ];

  let totalMinutes = 0;
  let modifiedText = text;

  // Проходимо по всіх патернах
  for (const pattern of patterns) {
    // Знаходимо всі збіги і замінюємо (аналог re.sub з логікою)
    modifiedText = modifiedText.replace(pattern, (match, startStr, endStr) => {
      const durationStr = formatDuration(startStr, endStr);
      if (!durationStr) return match;

      // Рахуємо загальний час
      const minutes = getMinutesDiff(startStr, endStr);
      if (minutes > 0) totalMinutes += minutes;

      // Формуємо рядок заміни (зберігаємо оригінальний розділювач, або ставимо дефіс)
      const separator = match.includes('–') ? '–' : '-';
      
      // Повертаємо формат: 18:00-22:00(4.0 год)
      // Спрощено: беремо чистий час + дужки, ігноруючи складні слова "від/до" в заміні, 
      // щоб було компактно, як у вашому прикладі
      return `${startStr}${separator}${endStr}${durationStr}`;
    });
  }

  const hours = totalMinutes / 60;
  const summary = hours > 0 ? `\n\n⚫ Без світла: ${hours.toFixed(1)} годин` : '';
  
  return modifiedText + summary;
}

// --- ДОПОМІЖНІ ФУНКЦІЇ ---

function getMinutesDiff(startStr, endStr) {
  const [h1, m1] = startStr.split(':').map(Number);
  const [h2, m2] = endStr.split(':').map(Number);
  
  const startMins = h1 * 60 + m1;
  const endMins = h2 * 60 + m2;
  
  let diff = endMins - startMins;
  if (diff < 0) diff += 24 * 60; // Перехід через північ
  return diff;
}

function formatDuration(startStr, endStr) {
  const minutes = getMinutesDiff(startStr, endStr);
  if (minutes <= 0) return "";
  const hours = minutes / 60;
  return `(${hours.toFixed(1)} год)`;
}

// --- ВІДПРАВКА В TELEGRAM ---

async function sendMessage(token, chat_id, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chat_id,
      text: text,
      // parse_mode: 'HTML' // Можна увімкнути, якщо треба жирний текст
    })
  });
  return response.json();
}
