FROM postgres:16.4

RUN apt-get update && apt-get install -y --no-install-recommends \
    cron tar gzip \
    && rm -rf /var/lib/apt/lists/*

# Copia script + cron config
COPY docker/run-backup.sh /backup/run-backup.sh
COPY docker/backup-cron /etc/cron.d/backup-cron
RUN chmod +x /backup/run-backup.sh && \
    chmod 0644 /etc/cron.d/backup-cron && \
    crontab /etc/cron.d/backup-cron && \
    touch /var/log/backup.log

CMD ["cron", "-f"]
