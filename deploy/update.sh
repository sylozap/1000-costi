#!/usr/bin/env bash
# Обновление на сервере до свежей версии с GitHub. Запускать от root:
#   bash /opt/1000-costi/deploy/update.sh
set -e
cd /opt/1000-costi
git pull --ff-only
bash deploy/setup.sh
