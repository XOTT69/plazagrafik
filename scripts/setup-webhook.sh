#!/usr/bin/env bash
set -euo pipefail

echo "Telegram webhook — резервне пересилання групи 2.2"
echo "Потрібен Telegram BOT_TOKEN саме цього Worker."
echo

read -r -p "Workers URL (https://plazagrafik.example.workers.dev): " BASE
BASE="$(printf '%s' "$BASE" | sed 's#/$##')"
if [[ ! "$BASE" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]]; then
  echo "Помилка: введіть повну HTTPS адресу Worker без /telegram." >&2
  exit 1
fi
WEBHOOK_URL="$BASE/telegram"

read -r -s -p "Telegram BOT_TOKEN (не показується): " TOKEN
echo
read -r -s -p "WEBHOOK_SECRET з Cloudflare (не показується): " SECRET
echo

if [[ -z "$TOKEN" || ! "$SECRET" =~ ^[A-Za-z0-9_-]{1,256}$ ]]; then
  echo "Неправильний токен чи формат WEBHOOK_SECRET." >&2
  exit 1
fi
echo
echo "Поточний webhook для вказаного токена:"
curl -f -sS "https://api.telegram.org/bot$TOKEN/getWebhookInfo"
echo
echo
echo "УВАГА: Telegram дозволяє лише один webhook на один токен."
echo "Новий webhook: $WEBHOOK_URL"
read -r -p "Замінити поточний webhook? Введіть yes: " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
  echo "Скасовано. Нічого не змінено."
  exit 0
fi

curl -f -sS -X POST "https://api.telegram.org/bot$TOKEN/setWebhook" \
  --data-urlencode "url=$WEBHOOK_URL" \
  --data-urlencode "secret_token=$SECRET" \
  --data-urlencode 'allowed_updates=["message"]'
echo
echo "Webhook налаштований. Перешліть боту в приватний чат датований графік 2.2."
unset TOKEN SECRET
