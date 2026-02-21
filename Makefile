.PHONY: dev dev-backend dev-frontend

BACKEND_PORT ?= 3000
FRONTEND_PORT ?= 4173
OPENSWARMONRAILS_DIR ?= openswarm

dev:
	@echo "Starting OpenSwarmOnRails backend on http://localhost:$(BACKEND_PORT)"
	@echo "Starting Tailwind watcher for Rails UI"
	@echo "Starting UI scaffold on http://localhost:$(FRONTEND_PORT)/ui_scaffold/"
	@trap 'kill 0' INT TERM EXIT; \
	PORT=$(BACKEND_PORT) ./$(OPENSWARMONRAILS_DIR)/bin/rails server & \
	./$(OPENSWARMONRAILS_DIR)/bin/rails tailwindcss:watch & \
	python3 -m http.server $(FRONTEND_PORT) & \
	wait

dev-backend:
	@echo "Starting OpenSwarmOnRails backend on http://localhost:$(BACKEND_PORT)"
	@echo "Starting Tailwind watcher for Rails UI"
	@trap 'kill 0' INT TERM EXIT; \
	PORT=$(BACKEND_PORT) ./$(OPENSWARMONRAILS_DIR)/bin/rails server & \
	./$(OPENSWARMONRAILS_DIR)/bin/rails tailwindcss:watch & \
	wait

dev-frontend:
	@python3 -m http.server $(FRONTEND_PORT)
