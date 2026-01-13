export default {
  async fetch(request, env) {
    console.log("REQUEST RECEIVED");

    if (request.method !== "POST") {
      console.log("Not POST");
      return new Response("OK");
    }

    const update = await request.json();
    console.log("UPDATE:", JSON.stringify(update));

    const msg = update.message || update.channel_post;
    if (!msg) {
      console.log("No message in update");
      return new Response("OK");
    }

    const text = msg.text || msg.caption || "";
    console.log("TEXT:", text);

    // ТЕСТОВЕ повідомлення
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.CHANNEL_ID,
        text: "ТЕСТ: " + text
      })
    });

    console.log("Message sent to channel");

    return new Response("OK");
  }
};
