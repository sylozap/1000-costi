#!/usr/bin/env bash
# Установка/обновление на сервере (Ubuntu). Запускать от root:
#   bash /opt/1000-costi/deploy/setup.sh
set -e
APP=/opt/1000-costi
cd "$APP"

if [ ! -f .env ]; then
  echo "Нет файла $APP/.env — скопируй его с компьютера (см. README, раздел «Свой сервер»)"; exit 1
fi

apt-get update -q
apt-get install -y -q python3 python3-venv

id costi >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin costi
[ -x .venv/bin/python ] || python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt
# код принадлежит root (так работает git pull), служба пишет только в data/
mkdir -p data
chown -R costi:costi data
chown root:costi .env
chmod 640 .env

cp deploy/1000-costi.service /etc/systemd/system/1000-costi.service
systemctl daemon-reload
systemctl enable 1000-costi >/dev/null
systemctl restart 1000-costi
sleep 3
systemctl --no-pager --lines=8 status 1000-costi || true
echo
echo "Проверка: curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/  (должно быть 200)"
