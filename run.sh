#!/usr/bin/env bash
# Запуск игры: туннель (ngrok или cloudflared) + сервер с ботом.
#   TUNNEL=ngrok       — постоянный домен NGROK_DOMAIN, игра открывается прямо из группы
#   TUNNEL=cloudflared — бесплатный туннель без регистрации, адрес меняется при каждом запуске,
#                        поэтому кнопка в группе ведёт в личку с ботом, а он даёт кнопку «Играть»
#   TUNNEL=none        — без туннеля (PUBLIC_URL задан вручную)
set -e
cd "$(dirname "$0")"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
PORT="${PORT:-8080}"
export PATH="$HOME/.local/bin:$PATH"
mkdir -p data

if [ -z "$TUNNEL" ]; then
  if [ -n "$NGROK_DOMAIN" ]; then TUNNEL=ngrok; else TUNNEL=cloudflared; fi
fi

if [ ! -x .venv/bin/python ]; then
  echo "Создаю виртуальное окружение…"
  if command -v uv >/dev/null; then
    uv venv -q .venv && uv pip install -q --python .venv/bin/python -r requirements.txt
  else
    python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt
  fi
fi

TUNNEL_PID=""
trap '[ -n "$TUNNEL_PID" ] && kill $TUNNEL_PID 2>/dev/null' EXIT

case "$TUNNEL" in
  ngrok)
    command -v ngrok >/dev/null || { echo "ngrok не найден (см. README)"; exit 1; }
    ngrok http "$PORT" --url="https://${NGROK_DOMAIN#https://}" --log=stdout > data/ngrok.log 2>&1 &
    TUNNEL_PID=$!
    echo "ngrok: https://${NGROK_DOMAIN#https://} → localhost:$PORT (лог: data/ngrok.log)"
    ;;
  cloudflared)
    command -v cloudflared >/dev/null || { echo "cloudflared не найден (см. README)"; exit 1; }
    # http2 вместо quic: QUIC (UDP) почти не проходит через VPN в режиме TUN и мобильный интернет
    cloudflared tunnel --no-autoupdate --protocol http2 --url "http://localhost:$PORT" > data/cloudflared.log 2>&1 &
    TUNNEL_PID=$!
    echo "Жду адрес туннеля Cloudflare…"
    URL=""
    for _ in $(seq 60); do
      URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' data/cloudflared.log | head -1 || true)
      [ -n "$URL" ] && break
      kill -0 $TUNNEL_PID 2>/dev/null || break
      sleep 1
    done
    [ -n "$URL" ] || { echo "Туннель не поднялся, см. data/cloudflared.log"; exit 1; }
    export PUBLIC_URL="$URL" ENTRY_MODE=private
    echo "cloudflared: $URL → localhost:$PORT"
    ;;
esac

.venv/bin/python run.py
