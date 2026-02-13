#!/bin/sh
# Runs on every backend container start (after postgres is healthy, per
# docker-compose.yml's depends_on condition). Applies pending Alembic
# migrations before the API starts serving traffic, so a fresh `docker
# compose up` never hits "relation ... does not exist". `set -e` makes a
# failed migration abort the container instead of starting an API that
# can't talk to its own schema.
set -e

echo "[entrypoint] Applying database migrations (alembic upgrade head)..."
alembic upgrade head
echo "[entrypoint] Migrations up to date. Starting API server..."

exec uvicorn app.main:app --host 0.0.0.0 --port 8000
