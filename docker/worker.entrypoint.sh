#!/bin/bash
set -e

bash /app/docker/check-env.sh

# Wait for web container to finish initial Django migrations.
# Polls for the django_q_task table — once it exists, all migrations
# (including django-q2) have been applied.
echo "worker: waiting for Django migrations to complete..."
until python -c "
import os, django
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'construmaster.settings')
django.setup()
from django.db import connection
with connection.cursor() as c:
    c.execute('SELECT 1 FROM django_q_task LIMIT 0')
" 2>/dev/null; do
    sleep 2
done

echo "worker: migrations ready, starting qcluster"
exec python manage.py qcluster
