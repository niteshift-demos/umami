#!/usr/bin/env bash
# Brings the task-local Postgres up, applies migrations, and seeds demo
# analytics data on an empty database. Shared by setup and resume.
set -euo pipefail

cd "$(dirname "$0")/../.."

COMPOSE="docker compose -f docker-compose.yml -f .niteshift/files/docker-compose.niteshift.yml"

ns services start postgres
timeout 180 bash -c "until $COMPOSE exec -T db pg_isready -U umami -d umami >/dev/null 2>&1; do sleep 2; done"

# Creates the schema and the default admin/umami login on a fresh database.
pnpm check-db

websites=$($COMPOSE exec -T db psql -U umami -d umami -tAc 'select count(*) from website' | tr -d '[:space:]')
if [ "$websites" = "0" ]; then
  pnpm seed-data
fi
