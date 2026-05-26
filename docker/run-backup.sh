#!/bin/bash
set -e

MODE="${1:-db}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DEST="/dest"

case "$MODE" in
  db)
    echo "[$(date)] DB backup starting..."
    mkdir -p "$DEST/db"
    PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
        --host="$POSTGRES_HOST" --port=5432 \
        --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
        --format=custom --compress=9 \
        --file="$DEST/db/construmaster_${TIMESTAMP}.dump"
    echo "[$(date)] DB backup done: $DEST/db/construmaster_${TIMESTAMP}.dump"
    # Retención 30 días
    find "$DEST/db" -name "construmaster_*.dump" -mtime +30 -delete
    ;;
  files)
    echo "[$(date)] Files backup starting..."
    mkdir -p "$DEST/files"
    if [ -d /source ] && [ "$(ls -A /source 2>/dev/null)" ]; then
        tar -czf "$DEST/files/media_${TIMESTAMP}.tar.gz" -C /source . 2>&1 | tail -5 || true
        echo "[$(date)] Files backup done: $DEST/files/media_${TIMESTAMP}.tar.gz"
        # Retención 90 días
        find "$DEST/files" -name "media_*.tar.gz" -mtime +90 -delete
    else
        echo "[$(date)] Files backup skipped: no content"
    fi
    ;;
  *)
    echo "Usage: $0 {db|files}"
    exit 1
    ;;
esac
