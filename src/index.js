function formatDuration(startStr, endStr) {
  try {
    const [sh, sm] = startStr.split(":").map(Number);
    const [eh, em] = endStr.split(":").map(Number);

    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    const diff = end - start;

    if (diff <= 0) return "";

    const hours = diff / 60;
    return `(${hours.toFixed(1)} год)`;
  } catch {
    return "";
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
    const matches = [...modifiedText.matchAll(pattern)];

    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      const [full, startStr, endStr] = match;

      const durationStr = formatDuration(startStr, endStr);
      if (!durationStr) continue;

      const prefix = full.includes("–") ? "–" : "-";
      const replacement = `${startStr}${prefix}${endStr}${durationStr}`;

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

function build22Message(text) {
  const lines = text.split("\n");

  // Шапка
  let header = null;
  for (const line of lines) {
    if (line.trim()) {
      header = line;
      break;
    }
  }
  if (!header) return null;

  // ===== Формат 1: "Підгрупа 2.2 відключення" =====
  let start22 = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("Підгрупа") && lines[i].includes("2.2")) {
      start22 = i;
      break;
    }
  }

  if (start22 !== -1) {
    const block = [];
    for (let i = start22; i < lines.length; i++) {
      if (!lines[i].trim() && block.length) break;
      block.push(lines[i]);
    }

    const blockText = block.filter(l => l.trim()).join("\n");

    const headerLines = [];
    for (const line of lines) {
      if (line.trim()) headerLines.push(line);
      if (headerLines.length === 2) break;
    }

    let fullText = [...headerLines, "", blockText].join("\n").trim();

    const [parsedText, darkInfo] = parseDarkHours(fullText);
    if (darkInfo) return `${parsedText}\n\n${darkInfo}`;
    return parsedText;
  }

  // ===== Формат 2: "2.2 підгрупу" =====
  let line22 = null;
  for (const line of lines) {
    if (line.includes("2.2") && line.includes("підгруп")) {
      line22 = line;
      break;
    }
  }

  if (line22) {
    const fullText = header === line22 ? line22 : `${header}\n${line22}`;
    const [parsedText, darkInfo] = parseDarkHours(fullText);
    if (darkInfo) return `${parsedText}\n\n${darkInfo}`;
    return parsedText;
  }

  return null;
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");

    const update = await request.json();
    const msg = update.message || update.channel_post;
    if (!msg) return new Response("OK");

    const text = msg.text || msg.caption || "";
    if (!text) return new Response("OK");

    const payload = build22Message(text);
    if (!payload) {
      console.log("No payload generated");
      return new Response("OK");
    }

    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.CHANNEL_ID,
        text: payload,
        disable_web_page_preview: true
      })
    });

    console.log("Message sent to channel");
    return new Response("OK");
  }
};
