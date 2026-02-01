// --- ДОПОМІЖНІ ФУНКЦІЇ ---

function calculateDuration(start, end) {
  try {
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    let diff = (eh * 60 + em) - (sh * 60 + sm);
    if (diff < 0) diff += 24 * 60; // перехід через добу
    return diff;
  } catch {
    return 0;
  }
}

function processLinesWithHours(lines) {
  let totalMinutes = 0;
  const processedLines = lines.map(line => {
    // Шукаємо час у форматі 00:00-00:00 або з 00:00 до 00:00
    return line.replace(/(\d{2}:\d{2})\s*(?:-|–|до)\s*(\d{2}:\d{2})/gi, (match, start, end) => {
      const minutes = calculateDuration(start, end);
      if (minutes > 0) {
        totalMinutes += minutes;
        return `${match} (${(minutes / 60).toFixed(1)} год)`;
      }
      return match;
    });
  });

  const totalHours = (totalMinutes / 60).toFixed(1);
  if (totalHours > 0) {
    processedLines.push(`\n⚫ Разом без світла: ${totalHours} год`);
  }
  return processedLines.join('\n');
}

// --- ГОЛОВНИЙ ПАРСЕР ---

function parseSchedule(text) {
  const lines = text.split('\n');
  const header = [];
  const body = [];
  
  let found22 = false;

  // 1. Витягуємо шапку (перші 2-3 рядки, де є текст або дати)
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // Якщо це опис групи - шапка закінчилась
    if (line.match(/група|черга|підгрупа/i)) break;
    header.push(line);
  }

  // 2. Шукаємо 2.2 і читаємо до наступної групи
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // ПЕРЕВІРКА НА СТАРТ: чи є тут 2.2?
    if (line.match(/2\.2/)) {
      found22 = true;
      body.push(line); // Додаємо заголовок групи
      continue;
    }

    if (found22) {
      // ПЕРЕВІРКА НА СТОП: чи це початок іншої групи?
      // Шукаємо 1.x, 3.x, 4.x, 5.x, 6.x або слова "Група/Черга/Всі інші"
      if (line.match(/(?:^|\s)(1\.|3\.|4\.|5\.|6\.|✅|єСвітло|Для всіх)/)) {
        break; // Зупиняємось, далі чужий графік
      }
      // Якщо це не нова група - додаємо рядок собі
      body.push(line);
    }
  }

  if (!found22) return null; // Не знайшли 2.2

  // 3. Формуємо результат
  const headerText = header.join('\n');
  const bodyText = processLinesWithHours(body);

  return `${headerText}\n\n${bodyText}`;
}

// --- ОБРОБНИК ЗАПИТІВ ---

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");

    try {
      const update = await request.json();
      const msg = update.message || update.channel_post;
      
      if (!msg || (!msg.text && !msg.caption)) return new Response("OK");

      const text = msg.text || msg.caption;
      const responseText = parseSchedule(text);

      if (responseText) {
        await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: env.CHANNEL_ID,
            text: responseText,
            disable_web_page_preview: true
          })
        });
      }

    } catch (e) {
      console.error("Error:", e);
    }

    return new Response("OK");
  }
};
