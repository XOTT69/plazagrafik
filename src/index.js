// --- ДОПОМІЖНІ ФУНКЦІЇ ---

// Функція для підрахунку часу (з 10:00 до 14:00 -> 4 год)
function formatDuration(startStr, endStr) {
  try {
    const [sh, sm] = startStr.split(":").map(Number);
    const [eh, em] = endStr.split(":").map(Number);
    let diff = (eh * 60 + em) - (sh * 60 + sm);
    if (diff < 0) diff += 24 * 60; // обробка переходу через добу
    if (diff <= 0) return "";
    return `(${(diff / 60).toFixed(1)} год)`;
  } catch {
    return "";
  }
}

// Функція обробки тексту: додає тривалість і рахує суму
function processTextWithHours(text) {
  const patterns = [
    /з\s+(\d{2}:\d{2})\s+до\s+(\d{2}:\d{2})/gi,
    /(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2})/gi,
    /(\d{2}:\d{2})\s*до\s*(\d{2}:\d{2})/gi
  ];

  let totalMinutes = 0;
  let processedText = text;

  // Проходимо по всіх форматах часу
  for (const pattern of patterns) {
    const matches = [...processedText.matchAll(pattern)];
    // Йдемо з кінця, щоб не збити індекси при заміні
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      const [full, start, end] = match;
      
      const duration = formatDuration(start, end);
      if (!duration) continue;

      // Додаємо в текст (наприклад: "з 10 до 14 (4.0 год)")
      processedText = 
        processedText.slice(0, match.index) + 
        full + " " + duration + 
        processedText.slice(match.index + full.length);

      // Рахуємо суму
      const [sh, sm] = start.split(":").map(Number);
      const [eh, em] = end.split(":").map(Number);
      let diff = (eh * 60 + em) - (sh * 60 + sm);
      if (diff < 0) diff += 24 * 60;
      totalMinutes += diff;
    }
  }

  const totalHours = (totalMinutes / 60).toFixed(1);
  const footer = totalHours > 0 ? `\n\n⚫ Разом без світла: ${totalHours} год` : "";
  
  return processedText + footer;
}

// --- ОСНОВНА ЛОГІКА ---

export default {
  async fetch(request, env) {
    // 1. Відповідаємо 200 OK на все, щоб Telegram не спамив
    if (request.method !== "POST") return new Response("OK");

    let update;
    try {
      update = await request.json();
    } catch (e) {
      return new Response("OK");
    }

    const msg = update.message || update.channel_post;
    if (!msg) return new Response("OK");

    const text = msg.text || msg.caption || "";
    if (!text) return new Response("OK");

    // 2. Логуємо вхід (для дебагу в Cloudflare)
    console.log("📥 IN:", text.slice(0, 100).replace(/\n/g, " "));

    // --- ПАРСИНГ ---
    const lines = text.split('\n');
    
    // А. Шукаємо шапку (дата/заголовок)
    // Беремо перші 2-3 рядки, які не є описом груп
    const headerLines = [];
    for (let i = 0; i < Math.min(lines.length, 5); i++) {
      const line = lines[i].trim();
      if (!line) continue;
      // Якщо рядок схожий на дату або заголовок "Графік"
      if (line.includes("Графік") || line.match(/\d{2}\.\d{2}/) || line.match(/Понеділок|Вівторок|Середа|Четвер|П'ятниця|Субота|Неділя/i)) {
        headerLines.push(line);
      }
      // Якщо дійшли до опису груп - стоп шапка
      if (line.match(/група|черга/i)) break;
    }
    const header = headerLines.join('\n');

    // Б. Шукаємо блок 2.2
    let start22 = -1;
    let end22 = -1;

    // Патерн для пошуку нашої групи
    const myGroupPattern = /2\.2/; 
    // Патерн для пошуку БУДЬ-ЯКОЇ ІНШОЇ групи (щоб знати де зупинитись)
    // Шукає "1.1", "1.2", "2.1", "3.1" і т.д., або слова "Група 1", "Черга 3"
    const otherGroupPattern = /(?:^|\s)(1\.|2\.1|3\.|4\.|5\.|6\.|Група\s*[13456]|Черга\s*[13456])/i;
    
    // Знаходимо старт
    for (let i = 0; i < lines.length; i++) {
      if (myGroupPattern.test(lines[i])) {
        start22 = i;
        break;
      }
    }

    if (start22 === -1) {
      console.log("❌ 2.2 not found");
      return new Response("OK");
    }

    // Знаходимо кінець (початок наступної групи або кінець тексту)
    for (let i = start22 + 1; i < lines.length; i++) {
      const line = lines[i];
      // Якщо рядок містить іншу групу або ключові слова кінця
      if (otherGroupPattern.test(line) || line.includes("✅") || line.includes("єСвітло")) {
        end22 = i;
        break;
      }
    }
    if (end22 === -1) end22 = lines.length;

    // Вирізаємо шматок
    const rawBody = lines.slice(start22, end22).join('\n').trim();
    
    // В. Обробляємо часи
    const processedBody = processTextWithHours(rawBody);

    // Г. Збираємо фінальне повідомлення
    const finalMessage = `${header}\n\n${processedBody}`;

    console.log("📤 OUT:", finalMessage.slice(0, 100).replace(/\n/g, " "));

    // 3. Відправляємо в канал
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.CHANNEL_ID,
        text: finalMessage,
        disable_web_page_preview: true
      })
    });

    return new Response("OK");
  }
};
