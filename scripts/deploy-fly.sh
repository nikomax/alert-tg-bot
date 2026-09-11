#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if command -v flyctl >/dev/null 2>&1; then
  FLY=(flyctl)
elif [[ -x "$HOME/.fly/bin/flyctl" ]]; then
  FLY=("$HOME/.fly/bin/flyctl")
else
  echo "flyctl не знайдено. Установіть: https://fly.io/docs/flyctl/install/" >&2
  exit 1
fi

APP="$(awk -F'"' '/^app = / { print $2; exit }' fly.toml)"
REGION="$(awk -F'"' '/^primary_region = / { print $2; exit }' fly.toml)"
VOLUME="alert_data"

if [[ -z "$APP" || -z "$REGION" ]]; then
  echo "Не вдалося прочитати app/region з fly.toml" >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "Немає .env — скопіюйте .env.example і заповніть." >&2
  exit 1
fi

if [[ ! -d data/session || ! -f data/bot.db ]]; then
  echo "Немає data/session або data/bot.db. Спочатку запустіть бота локально (npm start), щоб з’явилась сесія." >&2
  exit 1
fi

echo "==> Перевірка логіну Fly"
"${FLY[@]}" auth whoami >/dev/null

echo "==> Апка $APP"
if "${FLY[@]}" status --app "$APP" >/dev/null 2>&1; then
  echo "    уже існує"
else
  "${FLY[@]}" apps create "$APP" --org personal
fi

echo "==> Том $VOLUME у $REGION"
if "${FLY[@]}" volumes list --app "$APP" 2>/dev/null | grep -q "$VOLUME"; then
  echo "    уже існує"
else
  "${FLY[@]}" volumes create "$VOLUME" --app "$APP" --region "$REGION" --size 1 --yes
fi

echo "==> Секрети з .env"
"${FLY[@]}" secrets import --app "$APP" --stage < .env

echo "==> Deploy"
"${FLY[@]}" deploy --app "$APP" --ha=false

echo "==> Копіювання сесії і SQLite на том"
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 data/bot.db "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 || true
fi
TAR="$(mktemp -t alert-data.XXXXXX).tgz"
COPY_ARGS=(session bot.db)
[[ -f data/bot.db-wal ]] && COPY_ARGS+=(bot.db-wal)
[[ -f data/bot.db-shm ]] && COPY_ARGS+=(bot.db-shm)
tar czf "$TAR" -C data "${COPY_ARGS[@]}"
trap 'rm -f "$TAR"' EXIT

"${FLY[@]}" ssh console --app "$APP" -C "mkdir -p /app/data"
"${FLY[@]}" ssh console --app "$APP" -C "rm -f /tmp/alert-data.tgz"
"${FLY[@]}" ssh sftp put "$TAR" /tmp/alert-data.tgz --app "$APP"
"${FLY[@]}" ssh console --app "$APP" -C "sh -c 'tar xzf /tmp/alert-data.tgz -C /app/data && rm -f /tmp/alert-data.tgz'"

echo "==> Рестарт"
MACHINE_ID="$("${FLY[@]}" machines list --app "$APP" --json | python3 -c 'import json,sys; rows=json.load(sys.stdin); print(rows[0]["id"] if rows else "")')"
if [[ -z "$MACHINE_ID" ]]; then
  echo "Немає машини для рестарту" >&2
  exit 1
fi
"${FLY[@]}" machines restart "$MACHINE_ID" --app "$APP"

echo "==> Готово. Логи: ${FLY[*]} logs --app $APP"
echo "    Перевірте /status у Telegram."
