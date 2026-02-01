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
  // Заголовок з датами
  const dateMatches = text.match(/(📆|📅).*?(?=\n\n|\n✅|$)/gi) || [];
  const header = dateMatches.slice(0, 2).join('\n') || '💡Графік відключень на сьогодні';

  // Тільки рядки з 2.2 (універсально)
  const patterns = [
    /Підгрупа\s*2\.2[^\n]*?(?=\n|$)/i,
    /Група\s*2\.2[^\n]*?(?=\n|$)/i,
    /черга\s*2\.2[^\n]*?(?=\n|$)/i,
    /(?:^|\n)2\.2\s*[^\n]*?(?=\n|$)/i
  ];

  let my22Lines = [];

  for (const pat of patterns) {
    const matches = [...text.matchAll(pat)];
    my22Lines.push(...matches.map(m => m[0].trim()));
    if (my22Lines.length > 0) break;
  }

  if (!my22Lines.length) {
    console.log("❌ No 2.2 lines found");
    return null;
  }

  const my22Section = my22Lines.join('\n');
  console.log(`✅ My 2.2 only (${my22Lines.length} lines):`, my22Section);

  return `${header}\n\n${my22Section}`.trim();
}

function build22Message(text) {
  const section = extract22Section(text);
  if (!section) return null;

  const [parsedText, darkInfo] = parseDarkHours(section);
  const fullMsg = darkInfo ? `${parsedText}\n\n${darkInfo}` : parsedText;
  console.log("📤 Sending full 2.2:", fullMsg.substring(0, 200));
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

    console.log("📥 Text preview:", text.substring(0, 100));

    const payload = build22Message(text);
    if (!payload) {
      console.log("⏭️ Skipping: no 2.2");
      return new Response("OK");
    }

    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.CHANNEL_ID,
        text: payload,
        disable_web_page_preview: true,
        parse_mode: "Markdown"
      })
    });

    const resText = await res.text();
    console.log("✅ Send result:", res.status, resText.substring(0, 100));

    return new Response("OK");
  }
};
