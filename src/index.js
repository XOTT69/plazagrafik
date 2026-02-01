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
  const lines = text.split('\n');
  
  // ✅ ШАПКА: перші 2-3 непорожні рядки БЕЗ дублів 📆
  let headerLines = [];
  let dateSeen = false;
  for (let i = 0; i < lines.length && headerLines.length < 3; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    // Додаємо дати тільки ОДИН раз
    if ((line.match(/📆|📅/) || line.match(/\d{2}\.\d{2}\.\d{4}/)) && dateSeen) continue;
    if (line.match(/📆|📅|\d{2}\.\d{2}\.\d{4}/)) dateSeen = true;
    
    headerLines.push(line);
  }
  const fullHeader = headerLines.join('\n').trim() || '💡Графік відключень';

  // 🎯 Тільки 2.2 секція
  const patterns = [/Підгрупа\s*2\.2/i, /Група\s*2\.2/i, /черга\s*2\.2/i, /2\.2\b/i];
  let startLine = -1;

  for (let i = 0; i < lines.length; i++) {
    for (const pat of patterns) {
      if (lines[i].match(pat)) {
        startLine = i;
        break;
      }
    }
    if (startLine !== -1) break;
  }

  if (startLine === -1) {
    console.log("❌ No 2.2");
    return null;
  }

  // СТРОГО до наступної групи (НЕ включаємо 1.1 чи інші)
  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    if (lines[i].match(/Підгрупа\s*(?!2\.)[3-9\.]|Група\s*[3-9]|черга\s*[3-9]|✅|Для всіх інших/i)) {
      endLine = i;
      break;
    }
  }

  const my22Lines = lines.slice(startLine, endLine).filter(l => l.trim() && !l.match(/1\.1|Група 1|Підгрупа 1/i));
  const my22Section = my22Lines.join('\n');

  console.log("📅 Header (no dups):", fullHeader);
  console.log("🎯 2.2 only:", my22Section || "EMPTY");

  return `${fullHeader}\n\n${my22Section}`.trim();
}

function build22Message(text) {
  const section = extract22Section(text);
  if (!section) return null;

  const [parsedText, darkInfo] = parseDarkHours(section);
  const fullMsg = darkInfo ? `${parsedText}\n\n${darkInfo}` : parsedText;
  console.log("📤 Final:", fullMsg.substring(0, 400));
  return fullMsg;
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");

    const update = await request.json().catch(() => null);
    if (!update) return new Response("OK");

    const msg = update.message || update.channel_post;
    if (!msg) return new Response("OK");

    const text = msg.text || msg.caption || "";
    if (!text) return new Response("OK");

    console.log("📥 Input preview:", text.substring(0, 300));

    const payload = build22Message(text);
    if (!payload) {
      console.log("⏭️ Skip no 2.2");
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

    console.log("✅ Done:", res.status);
    return new Response("OK");
  }
};
