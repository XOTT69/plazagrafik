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
  return hours > 0 ? [`${text}\n⚫ Без світла: ${hours.toFixed(1)} год`, hours] : [text, 0];
}

function extract22Section(text) {
  console.log("🔥 TELEGRAM POST DETECTED");
  console.log("📄 FULL TEXT:", text.substring(0, 800));

  // ШАПКА: перші 2 унікальні рядки
  const lines = text.split('\n');
  const headerSet = new Set();
  const header = lines.slice(0, 4)
    .map(l => l.trim())
    .filter(l => l && !headerSet.has(l) && headerSet.size < 2)
    .slice(0, 2)
    .join('\n');

  // ТІЛЬКИ 2.2 + пов'язані часи
  const two2Block = text.match(/(?<=Підгрупа|Група|черга\s*)2\.2[\s\S]*?(?=Підгрупа\s*[13]|Група\s*[13]|✅|$)/i);
  const section22 = two2Block ? two2Block[0].trim() : null;

  console.log("📅 HEADER:", header);
  console.log("🎯 2.2 BLOCK:", section22?.substring(0, 200) || "MISSING");

  if (!section22) {
    console.log("💥 NO 2.2 BLOCK");
    return null;
  }

  return `${header}\n\n${section22}`.trim();
}

function build22Message(text) {
  const section = extract22Section(text);
  if (!section) return null;

  const [parsedText] = parseDarkHours(section);
  console.log("📤 READY:", parsedText.substring(0, 300));
  return parsedText;
}

export default {
  async fetch(request, env) {
    console.log(`${request.method} ${request.url}`);
    
    if (request.method !== "POST") return new Response("OK");

    let update;
    try {
      update = await request.json();
    } catch (e) {
      console.log("JSON ERROR:", e.message);
      return new Response("OK");
    }

    const msg = update.message || update.channel_post;
    if (!msg || (!msg.text && !msg.caption)) {
      console.log("NO MESSAGE");
      return new Response("OK");
    }

    const payload = build22Message(msg.text || msg.caption);
    if (!payload) {
      console.log("NO PAYLOAD");
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

    console.log("✅ STATUS:", res.status, await res.text().catch(() => "no text"));
    return new Response("OK");
  }
};
