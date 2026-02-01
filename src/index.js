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
  
  // ✅ ШАПКА: перші непорожні рядки + ВСІ 📆 дати
  let headerLines = [];
  for (let i = 0; i < lines.length && headerLines.length < 4; i++) {
    if (lines[i].trim()) {
      headerLines.push(lines[i]);
      // Збираємо ВСІ дати 📆/📅
      if (lines[i].match(/📆|📅/)) headerLines.push(lines[i]);
    }
  }
  const fullHeader = headerLines.join('\n').trim() || '💡Графік відключень';

  // Знаходимо мою 2.2
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
    console.log("❌ No 2.2 found");
    return null;
  }

  // Тільки моя секція 2.2
  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    if (lines[i].match(/Підгрупа\s*[3-9]|Група\s*[3-9]|черга\s*[3-9]|✅|Для всіх інших/i)) {
      endLine = i;
      break;
    }
  }

  const my22Lines = lines.slice(startLine, endLine).filter(l => l.trim());
  const my22Section = my22Lines.join('\n');

  console.log("📅 Full header:", fullHeader);
  console.log("🎯 My 2.2:", my22Section.substring(0, 150));

  return `${fullHeader}\n\n${my22Section}`.trim();
}

function build22Message(text) {
  const section = extract22Section(text);
  if (!section) return null;

  const [parsedText, darkInfo] = parseDarkHours(section);
  const fullMsg = darkInfo ? `${parsedText}\n\n${darkInfo}` : parsedText;
  console.log("📤 Payload:", fullMsg.substring(0, 350));
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

    console.log("📥 Input:", text.substring(0, 250));

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

    console.log("✅ Status:", res.status);
    return new Response("OK");
  }
};
