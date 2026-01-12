export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");

    const update = await request.json();
    const msg = update.message || update.channel_post;
    if (!msg) return new Response("OK");

    const text = msg.text || msg.caption || "";
    if (!text) return new Response("OK");

    const payload = build22Message(text);
    if (!payload) return new Response("OK");

    await sendToTelegram(env.BOT_TOKEN, env.CHANNEL_ID, payload);
    return new Response("OK");
  }
};

async function sendToTelegram(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    })
  });
}

function build22Message(text) {
  const lines = text.split("\n");
  const header = lines.find(l => l.trim());
  const line22 = lines.find(l => l.includes("2.2") && l.includes("підгруп"));
  if (!header || !line22) return null;
  return header === line22 ? line22 : `${header}\n${line22}`;
}
