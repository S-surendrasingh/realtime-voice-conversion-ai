.PHONY: install dev test test-frontend test-ai-worker lint format backend frontend docker-up docker-down

install:
	cd backend && python3.12 -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"
	cd frontend && npm install

dev:
	./dev.sh

test:
	cd backend && . .venv/bin/activate && pytest

# Phase 3 additions — not folded into `test` above so existing muscle-memory
# (`make test` = backend) keeps working. See docs/phase3-ai-conversion.md.
test-frontend:
	cd frontend && npm test

test-ai-worker:
	cd ai-worker && .venv/bin/pytest

lint:
	cd backend && . .venv/bin/activate && ruff check .
	cd frontend && npm run lint

format:
	cd backend && . .venv/bin/activate && ruff format .

backend:
	cd backend && . .venv/bin/activate && uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

frontend:
	cd frontend && npm run dev

docker-up:
	docker compose up --build

docker-down:
	docker compose down
