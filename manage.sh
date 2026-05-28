#!/bin/bash

APP_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
LOG_FILE="$APP_DIR/dev.log"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

cd "$APP_DIR" || exit 1

case "$1" in
  start)
    if lsof -i:8000 > /dev/null 2>&1 || lsof -i:3001 > /dev/null 2>&1; then
      echo -e "${YELLOW}Dev server already running. Use './manage.sh restart' to bounce it.${NC}"
      exit 0
    fi

    echo "Ensuring Postgres is up..."
    docker compose up -d postgres > /dev/null
    until docker compose ps postgres --format '{{.Health}}' 2>/dev/null | grep -q healthy; do
      sleep 1
    done

    echo "Starting ConstruMaster dev server..."
    nohup npm run dev > "$LOG_FILE" 2>&1 &
    echo -e "${GREEN}Started. Logs: $LOG_FILE${NC}"
    echo "Frontend: http://localhost:8000"
    echo "Backend:  http://localhost:3001"
    ;;

  stop)
    echo "Stopping ConstruMaster dev server..."
    lsof -t -i:8000 2>/dev/null | xargs -r kill -9 2>/dev/null
    lsof -t -i:3001 2>/dev/null | xargs -r kill -9 2>/dev/null
    pkill -f "npm run dev" 2>/dev/null
    pkill -f "vite" 2>/dev/null
    pkill -f "nodemon server/index.js" 2>/dev/null
    echo -e "${GREEN}Stopped.${NC}"
    ;;

  restart)
    "$0" stop
    sleep 2
    "$0" start
    ;;

  status)
    if lsof -i:3001 > /dev/null 2>&1; then
      echo -e "${GREEN}Backend running on :3001${NC}"
    else
      echo -e "${RED}Backend not running${NC}"
    fi
    if lsof -i:8000 > /dev/null 2>&1; then
      echo -e "${GREEN}Frontend running on :8000${NC}"
    else
      echo -e "${RED}Frontend not running${NC}"
    fi
    if docker compose ps postgres --format '{{.Status}}' 2>/dev/null | grep -q Up; then
      echo -e "${GREEN}Postgres container is up${NC}"
    else
      echo -e "${RED}Postgres container is not up${NC}"
    fi
    ;;

  logs)
    if [ -f "$LOG_FILE" ]; then
      tail -f "$LOG_FILE"
    else
      echo -e "${RED}No log file at $LOG_FILE${NC}"
      exit 1
    fi
    ;;

  reset-admin)
    if [ -z "$2" ]; then
      echo "Usage: ./manage.sh reset-admin <new_password>"
      exit 1
    fi
    NEW_PASSWORD="$2" node -e "
      import('@prisma/client').then(async ({ PrismaClient }) => {
        const bcrypt = (await import('bcryptjs')).default;
        const prisma = new PrismaClient();
        const hash = bcrypt.hashSync(process.env.NEW_PASSWORD, 10);
        const user = await prisma.user.upsert({
          where: { username: 'admin' },
          update: { passwordHash: hash, role: 'admin' },
          create: { username: 'admin', passwordHash: hash, role: 'admin', fullName: 'Administrador' },
        });
        console.log('Admin password reset for user id', user.id);
        await prisma.\$disconnect();
      }).catch(e => { console.error(e); process.exit(1); });
    "
    ;;

  *)
    echo "ConstruMaster Management Script"
    echo ""
    echo "Usage: $0 {command} [options]"
    echo ""
    echo "  start              Start Postgres + dev server (frontend + backend)"
    echo "  stop               Stop dev server"
    echo "  restart            Restart dev server"
    echo "  status             Show service status"
    echo "  logs               Tail dev.log"
    echo "  reset-admin <pwd>  Reset admin password"
    echo ""
    exit 1
    ;;
esac
