#!/bin/bash
# Abort container startup if .env still contains placeholder/insecure values.
# Sourced by web.entrypoint.sh and worker.entrypoint.sh.

set -e

INSECURE_PATTERNS=(
    "__GENERATE_ME__"
    "dev-insecure-change-me"
    "CHANGEME"
    "your-bccr-token"
    "your-email@example.com"
    "AIza...your-key-here"
)

FAIL=0

check_var() {
    local name="$1"
    local value="${!name}"
    if [ -z "$value" ]; then
        echo "FATAL: $name is empty" >&2
        FAIL=1
        return
    fi
    for pat in "${INSECURE_PATTERNS[@]}"; do
        if [[ "$value" == *"$pat"* ]]; then
            echo "FATAL: $name contains insecure placeholder '$pat' — generate a real value" >&2
            FAIL=1
            return
        fi
    done
}

# Required for any environment (dev or prod).
check_var DJANGO_SECRET_KEY
check_var POSTGRES_PASSWORD
check_var DATABASE_URL
check_var GEMINI_API_KEY
check_var BCCR_TOKEN

if [ "$FAIL" -ne 0 ]; then
    echo "" >&2
    echo "Refusing to start. Edit .env and replace placeholder values." >&2
    echo "See .env.example for generation commands." >&2
    exit 1
fi
