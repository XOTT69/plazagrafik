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
  const lines = text.split("\n");
  let start = -1, end = lines.length;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("2.2")) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  for (let i = start + 1; i < lines.length; i++) {
    if (
      lines[i].includes("Підгрупа") ||
      lines[i].includes("✅") ||
      lines[i].includes("Для всіх інших") ||
      lines[i].includes("єСвітло")
    ) {
      end = i;
      break;
    }
  }

  const headerLines = [];
  for (let i = 0; i < lines.length && headerLines.length < 2; i++) {
    if (lines[i].trim()) headerLines.push(lines[i]);
  }

  return [...headerLines, "", lines.slice(start, end).join("\n")].join("\n").trim();
}

function build22Message(text) {
  const section = extract22Section(text);
  if (!section) {
    console.log("No 2.2 section");
    return null;
  }

  const [parsedText, darkInfo] = parseDarkHours(section);
  return darkInfo ? `${parsedText}\n\n${darkInfo}` : parsedText;
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

    console.log("Text preview:", text.substring(0, 100));

    const payload = build22Message(text);
    if (!payload) {
      console.log("No 2.2 payload");
      return new Response("OK");
    }

    console.log("Sending payload:", payload.substring(0, 100));

    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.CHANNEL_ID,
        text: payload,
        disable_web_page_preview: true
      })
    });

    const resText = await res.text();
    console.log("Send result:", res.status, resText.substring(0, 200));

    return new Response("OK");
  }
};
