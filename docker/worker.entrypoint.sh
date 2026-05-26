#!/bin/bash
set -e

# Wait for DB ready (web container handles migrations)
sleep 5

exec python manage.py qcluster
