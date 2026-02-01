function formatDuration(startStr, endStr) {
  try {
    const [sh, sm] = startStr.split(":").map(Number);
    const [eh, em] = endStr.split(":").map(Number);
    const diff = (eh * 60 + em) - (sh * 60 + sm);
    if (diff <= 0) return "";
    return `(${(diff / 60).toFixed(1)} год)`;
  } catch {
    return "";
  }
}

function parseDarkHours(text) {
  const patterns = [
    /з\s+(\d{2}:\d{2})\s+до\s+(\d{2}:\d{2})/gi,
    /від\s+(\d{2}:\d{2})\s+до\s+(\d{2}:\d{2})/gi,
    /(\d{2}:\d{2})[\s–-](\d{2}:\d{2})/gi
  ];

  let totalMinutes = 0;
  let modifiedText = text;

  for (const pattern of patterns) {
    const matches = [...modifiedText.matchAll(pattern)];

    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      const [full, startStr, endStr] = match;

      const durationStr = formatDuration(startStr, endStr);
      if (!durationStr) continue;

      const replacement = full + durationStr;

      modifiedText =
        modifiedText.slice(0, match.index) +
        replacement +
        modifiedText.slice(match.index + full.length);

      const [sh, sm] = startStr.split(":").map(Number);
      const [eh, em] = endStr.split(":").map(Number);
      totalMinutes += (eh * 60 + em) - (sh * 60 + sm);
    }
  }

  const hours = totalMinutes / 60;
  const summary = hours > 0 ? `⚫ Без світла: ${hours.toFixed(1)} годин` : "";
  return [modifiedText, summary];
}

function extract22Section(text) {
  console.log("=== RAW INPUT ===", text.substring(0, 800));

  const lines = text.split('\n');
  
  // 🛡️ ШАПКА: перші 2 непорожні рядки (БЕЗ дублів)
  let headerLines = [];
  for (let i = 0; i < Math.min(lines.length, 3); i++) {
    const line = lines[i].trim();
    if (line && !headerLines.some(h => h.includes(line))) {
      headerLines.push(line);
    }
  }
  const header = headerLines.join('\n') || '💡Графік';

  // 🎯 ТІЛЬКИ 2.2 блок
  const patterns = [/Підгрупа 2\.2/i, /Група 2\.2/i, /черга 2\.2/i, /2\.2\b/i];
  let startIdx = -1;
  
  for (let i = 0; i < lines.length; i++) {
    for (const pat of patterns) {
      if (lines[i].match(pat)) {
        startIdx = i;
        break;
      }
    }
    if (startIdx !== -1) break;
  }

  if (startIdx === -1) {
    console.log("❌ ZERO 2.2 MATCHES");
    return null;
  }

  // СТРОГО до наступної групи
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].match(/(Підгрупа|Група|черга)\s*(?!2\.)[1-9]/i) || lines[i].match(/✅|Для всіх/i)) {
      endIdx = i;
      break;
    }
  }

  // ФІЛЬТР: ТІЛЬКИ 2.2 рядки
  const sectionLines = lines.slice(startIdx, endIdx)
    .filter(l => l.trim() && (l.match(/2\.2/) || l.match(/\d{2}:\d{2}/)));
    
  const section = sectionLines.join('\n');

  console.log("📅 HEADER:", header);
  console.log("🎯 SECTION (lines", sectionLines.length, "):", section || "EMPTY");

  return `${header}\n\n${section}`.trim();
}

function build22Message(text) {
  const section = extract22Section(text);
  if (!section) {
    console.log("💥 FAILED TO BUILD");
    return null;
  }

  const [parsed, summary] = parseDarkHours(section);
  const msg = summary ? `${parsed}\n\n${summary}` : parsed;
  
  console.log("📤 FINAL MSG:", msg);
  return msg;
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");

    const update = await request.json().catch(() => ({}));
    const msg = update.message || update.channel_post;
    
    if (!msg?.text && !msg?.caption) {
      console.log("⚠️ No text");
      return new Response("OK");
    }

    const text = msg.text || msg.caption;
    console.log("🚀 Processing...");

    const payload = build22Message(text);
    if (!payload) {
      console.log("⏭️ Skip");
      return new Response("OK");
    }

    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.CHANNEL_ID,
        text: payload,
        disable_web_page_preview: true
      })
    });

    console.log("✅ Telegram:", res.status);
    return new Response("OK");
  }
};
