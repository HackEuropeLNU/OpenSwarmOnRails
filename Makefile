.PHONY: dev dev-backend dev-frontend electron-install electron-dev electron-dmg electron-clean

BACKEND_PORT ?= 3000
BACKEND_BIND ?= 0.0.0.0
FRONTEND_PORT ?= 4173
OPENSWARMONRAILS_DIR ?= openswarm
ELECTRON_DIR ?= desktop
BACKEND_URL ?= http://localhost:$(BACKEND_PORT)

dev:
	@echo "Starting OpenSwarmOnRails backend on http://localhost:$(BACKEND_PORT)"
	@echo "Starting Tailwind watcher for Rails UI"
	@echo "Starting UI scaffold on http://localhost:$(FRONTEND_PORT)/ui_scaffold/"
	@trap 'kill 0' INT TERM EXIT; \
	(cd ./$(OPENSWARMONRAILS_DIR) && PORT=$(BACKEND_PORT) bin/rails server) & \
	(cd ./$(OPENSWARMONRAILS_DIR) && bin/rails tailwindcss:watch) & \
	python3 -m http.server $(FRONTEND_PORT) & \
	wait

dev-backend:
	@echo "Starting OpenSwarmOnRails backend on http://localhost:$(BACKEND_PORT)"
	@echo "Starting Tailwind watcher for Rails UI"
	@trap 'kill 0' INT TERM EXIT; \
	(cd ./$(OPENSWARMONRAILS_DIR) && PORT=$(BACKEND_PORT) bin/rails server) & \
	(cd ./$(OPENSWARMONRAILS_DIR) && bin/rails tailwindcss:watch) & \
	wait

dev-frontend:
	@python3 -m http.server $(FRONTEND_PORT)

electron-install:
	@echo "Installing Electron desktop dependencies"
	@cd "./$(ELECTRON_DIR)" && npm install

electron-dev: electron-install
	@echo "Starting OpenSwarmOnRails backend on http://$(BACKEND_BIND):$(BACKEND_PORT)"
	@echo "Starting Tailwind watcher for Rails UI"
	@echo "Launching Electron shell against $(BACKEND_URL)"
	@trap 'kill 0' INT TERM EXIT; \
	(cd ./$(OPENSWARMONRAILS_DIR) && PORT=$(BACKEND_PORT) bin/rails server -b $(BACKEND_BIND)) & \
	(cd ./$(OPENSWARMONRAILS_DIR) && bin/rails tailwindcss:watch) & \
	(cd "./$(ELECTRON_DIR)" && BACKEND_URL="$(BACKEND_URL)" npm run dev)

electron-dmg: electron-install
	@echo "Building macOS DMG in ./$(ELECTRON_DIR)/dist"
	@cd "./$(ELECTRON_DIR)" && BACKEND_URL="$(BACKEND_URL)" npm run build:mac

electron-clean:
	@echo "Cleaning desktop build artifacts"
	@cd "./$(ELECTRON_DIR)" && npm run clean
	@rm -rf "./$(ELECTRON_DIR)/node_modules/.cache/electron" "./$(ELECTRON_DIR)/node_modules/.cache/electron-builder"
