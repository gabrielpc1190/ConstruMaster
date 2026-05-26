# ConstruMaster

Webapp interna para supervisar obras de construcción de ADITA para el cliente Nicholas Rowley.

Ver `docs/superpowers/specs/` para diseño y `docs/superpowers/plans/` para implementación.

## Setup

```bash
cp .env.example .env  # llenar con secretos reales
docker compose up -d
docker compose exec web python manage.py migrate
docker compose exec web python manage.py createsuperuser
```

## Stack

Python 3.13, Django 5.2, Postgres 16, Redis 7, Cloudflare Tunnel.
