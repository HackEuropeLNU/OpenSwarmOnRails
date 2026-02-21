.PHONY: dev dev-backend dev-frontend

BACKEND_PORT ?= 3000
FRONTEND_PORT ?= 4173

dev:
	@echo "Starting backend on http://localhost:$(BACKEND_PORT)"
	@echo "Starting UI scaffold on http://localhost:$(FRONTEND_PORT)/ui_scaffold/"
	@trap 'kill 0' INT TERM EXIT; \
	PORT=$(BACKEND_PORT) ./openswarm/bin/dev & \
	python3 -m http.server $(FRONTEND_PORT) --directory ui_scaffold & \
	wait

dev-backend:
	@PORT=$(BACKEND_PORT) ./openswarm/bin/dev

dev-frontend:
	@python3 -m http.server $(FRONTEND_PORT) --directory ui_scaffold
