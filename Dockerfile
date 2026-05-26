FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    NODE_PATH=/usr/local/lib/node_modules

# System deps for psycopg, lxml, pyheif, weasyprint + Node.js (para Tailwind CLI via npm)
# Node.js se usa solo en build-time para compilar Tailwind CSS; sin runtime JS en la app
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    libxml2-dev libxslt-dev \
    libheif-dev \
    libpango-1.0-0 libpangoft2-1.0-0 \
    fonts-liberation \
    nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# Install Tailwind CSS CLI via npm (fallback cuando el binario standalone requiere AVX2)
# tailwindcss se instala global para que el CLI lo resuelva vía NODE_PATH o node_modules global
RUN npm install -g @tailwindcss/cli@4.3.0 tailwindcss@4.3.0 \
    && npm cache clean --force

WORKDIR /app

# Install Python deps
COPY pyproject.toml ./
RUN pip install --no-cache-dir -e .[dev]

# Copy app
COPY . .

# Entrypoints
RUN chmod +x docker/web.entrypoint.sh docker/worker.entrypoint.sh

EXPOSE 8000
