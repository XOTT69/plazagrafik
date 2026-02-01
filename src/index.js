// Функція форматування часу (безпечна)
function formatDuration(startStr, endStr) {
  try {
    const [sh, sm] = startStr.split(":").map(Number);
    const [eh, em] = endStr.split(":").map(Number);
    let diff = (eh * 60 + em) - (sh * 60 + sm);
    if (diff < 0) diff += 24 * 60;
    if (diff <= 0) return "";
    return `(${(diff / 60).toFixed(1)} год)`;
  } catch (e) { return ""; }
}

// Головний парсер (безпечний)
function safeParse(text) {
  try {
    const lines = text.split('\n');
    
    // 1. Шапка (дата)
    const header = lines.slice(0, 3)
      .filter(l => l.match(/\d{2}\.\d{2}|Графік|Понеділок|Вівторок|Середа|Четвер|П'ятниця|Субота|Неділя/i))
      .slice(0, 2).join('\n') || "💡 Графік";

    // 2. Пошук 2.2
    // Шукаємо рядок з "2.2"
    const startIdx = lines.findIndex(l => l.match(/2\.2/));
    if (startIdx === -1) return null;

    // 3. Пошук кінця (інша група або кінець)
    // Шукаємо "Група X", "Черга X", "1.", "3." і т.д.
    let endIdx = lines.findIndex((l, i) => i > startIdx && l.match(/(?:^|\s)(1\.|3\.|4\.|5\.|6\.|Група\s*[13456]|Черга\s*[13456]|✅)/i));
    if (endIdx === -1) endIdx = lines.length;

    // Вирізаємо текст групи
    let groupText = lines.slice(startIdx, endIdx).join('\n').trim();

    // 4. Додаємо години
    let totalMinutes = 0;
    const timePattern = /(\d{2}:\d{2})\s*(?:-|–|до)\s*(\d{2}:\d{2})/gi;
    
    groupText = groupText.replace(timePattern, (match, start, end) => {
      const dur = formatDuration(start, end);
      if (dur) {
        const [sh, sm] = start.split(":").map(Number);
        const [eh, em] = end.split(":").map(Number);
        let diff = (eh * 60 + em) - (sh * 60 + sm);
        if (diff < 0) diff += 24 * 60;
        totalMinutes += diff;
        return `${match} ${dur}`;
      }
      return match;
    });

    const totalHours = (totalMinutes / 60).toFixed(1);
    const footer = totalHours > 0 ? `\n\n⚫ Разом: ${totalHours} год` : "";

    return `${header}\n\n${groupText}${footer}`;

  } catch (err) {
    console.error("PARSING ERROR:", err);
    return null;
  }
}

export default {
  async fetch(request, env) {
    // ГЛОБАЛЬНИЙ ЗАХИСТ: Завжди повертаємо 200 OK, навіть якщо все впало
    try {
      if (request.method !== "POST") return new Response("OK");

      // ПЕРЕВІРКА ЗМІННИХ (це часта причина 500 помилки)
      if (!env.BOT_TOKEN) {
        console.error("❌ ПОМИЛКА: Не задано BOT_TOKEN у Settings -> Variables");
        return new Response("OK");
      }
      if (!env.CHANNEL_ID) {
        console.error("❌ ПОМИЛКА: Не задано CHANNEL_ID у Settings -> Variables");
        return new Response("OK");
      }

      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("OK");
      }

      const msg = update.message || update.channel_post;
      if (!msg || !msg.text) return new Response("OK");

      console.log("📥 Отримано текст:", msg.text.substring(0, 50).replace(/\n/g, " "));

      // Виконуємо парсинг
      const payload = safeParse(msg.text);

      if (!payload) {
        console.log("⚠️ Групу 2.2 не знайдено або помилка парсингу.");
        return new Response("OK");
      }

      console.log("📤 Відправляю:", payload.substring(0, 50).replace(/\n/g, " "));

      // Відправка
      const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.CHANNEL_ID,
          text: payload,
          disable_web_page_preview: true
        })
      });

      if (!res.ok) {
        console.error("❌ Помилка Telegram API:", await res.text());
      } else {
        console.log("✅ Успішно відправлено!");
      }

    } catch (criticalError) {
      console.error("🔥 КРИТИЧНА ПОМИЛКА (500):", criticalError.stack);
    }

    // ЗАВЖДИ відповідаємо OK, щоб зняти зависання Telegram
    return new Response("OK", { status: 200 });
  }
};
