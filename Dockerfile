FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# System deps for psycopg, lxml, pyheif, weasyprint
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    libxml2-dev libxslt-dev \
    libheif-dev \
    libpango-1.0-0 libpangoft2-1.0-0 \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps
COPY pyproject.toml ./
RUN pip install --no-cache-dir -e .[dev]

# Copy app
COPY . .

# Entrypoints
RUN chmod +x docker/web.entrypoint.sh docker/worker.entrypoint.sh

EXPOSE 8000
