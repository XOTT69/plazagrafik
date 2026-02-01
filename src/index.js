export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("OK", { status: 200 });
    }

    const msg = update.message || update.channel_post;
    if (!msg) return new Response("OK", { status: 200 });

    const text = msg.text || msg.caption || "";
    
    // Шукаємо 2.2 блок
    const match = text.match(/💡[\s\S]*?2\.2[\s\S]*?(?=3\.|✅|$)/i);
    if (!match) return new Response("OK", { status: 200 });

    const payload = match[0].trim();

    try {
      await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.CHANNEL_ID,
          text: payload,
          disable_web_page_preview: true
        })
      });
    } catch (e) {
      console.log("SEND ERROR:", e);
    }

    return new Response("OK", { status: 200 });
  }
};
