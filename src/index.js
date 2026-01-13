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
    let matches = [...modifiedText.matchAll(pattern)];
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      const [full, startStr, endStr] = match;
      const durationStr = formatDuration(startStr, endStr);
      if (!durationStr) continue;
      const prefix = full.includes("–") ? "–" : "-";
      const replacement = `${startStr}${prefix}${endStr}${durationStr}`;
      modifiedText = modifiedText.slice(0, match.index) + replacement + modifiedText.slice(match.index + full.length);
      totalMinutes += (parseInt(endStr.split(":")[0]) * 60 + parseInt(endStr.split(":")[1])) - (parseInt(startStr.split(":")[0]) * 60 + parseInt(startStr.split(":")[1]));
    }
  }
  const hours = totalMinutes / 60;
  const summary = hours > 0 ? `⚫ Без світла: ${hours.toFixed(1)} годин` : "";
  return [modifiedText, summary];
}

function extract22Section(text) {
  // Витягуємо блок Підгрупа 2.2 (весь до наступної підгрупи)
  const lines = text.split('\n');
  let start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('Підгрупа 2.2')) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  
  // Кінець — наступна Підгрупа X.X або ✅/кінець
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].includes('Підгрупа') || lines[i].includes('✅') || lines[i].includes('Для всіх інших')) {
      end = i;
      break;
    }
  }
  
  const block = lines.slice(start, end).join('\n');
  return block;
}

function build22Message(text) {
  const headerMatch = text.match(/\[💡\].*?(Вівторок|Середа|Четверг|Пʼятниця|Субота|Неділя)/);
  const header = headerMatch ? headerMatch[0] : text.split('\n')[0];
  
  const block = extract22Section(text);
  if (!block) {
    console.log("No 2.2 section found");
    return null;
  }
  
  let fullText = `${header}\n\n${block}`.trim();
  const [parsedText, darkInfo] = parseDarkHours(fullText);
  
  return darkInfo ? `${parsedText}\n\n${darkInfo}` : parsedText;
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");
    const update = await request.json();
    const msg = update.message || update.channel_post;
    if (!msg) return new Response("OK");
    
    const text = msg.text || msg.caption || "";
    console.log("Received text preview:", text.substring(0, 200));
    
    const payload = build22Message(text);
    if (!payload) {
      console.log("No 2.2 payload generated");
      return new Response("OK");
    }
    
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.CHANNEL_ID,
        text: payload,
        disable_web_page_preview: true,
        parse_mode: "HTML"
      })
    });
    
    const resText = await res.text();
    console.log("Send result:", res.status, resText);
    
    return new Response("OK");
  }
};
