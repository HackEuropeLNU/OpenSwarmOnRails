const { app, BrowserWindow, shell, ipcMain } = require("electron");
const { TerminalManager } = require("./terminal-manager");

const DEFAULT_BACKEND_URL = "http://localhost:3000";
const BACKEND_URL = process.env.BACKEND_URL || DEFAULT_BACKEND_URL;
const BACKEND_WAIT_MS = Number(process.env.BACKEND_WAIT_MS || 20000);

const terminalManager = new TerminalManager();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForBackend(url, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(url, { method: "GET", signal: controller.signal });
      clearTimeout(timeoutId);

      if (response.ok || response.status >= 300) {
        return true;
      }
    } catch (_error) {
      // keep polling until timeout
    }

    await sleep(500);
  }

  return false;
}

function offlinePage(url) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>OpenSwarm Desktop</title>
    <style>
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #0f172a;
        color: #e2e8f0;
        min-height: 100vh;
        display: grid;
        place-items: center;
      }

      .card {
        width: min(560px, calc(100% - 48px));
        border: 1px solid #334155;
        border-radius: 12px;
        padding: 24px;
        background: #111827;
      }

      h1 {
        margin-top: 0;
        font-size: 20px;
      }

      code {
        background: #1f2937;
        border: 1px solid #334155;
        border-radius: 6px;
        padding: 2px 6px;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>OpenSwarm backend is not reachable</h1>
      <p>Desktop shell is running, but it could not reach:</p>
      <p><code>${url}</code></p>
      <p>Start the backend with <code>make dev-backend</code> and relaunch this app.</p>
    </main>
  </body>
</html>
`)}`;
}

// ── IPC handlers for terminal management ──

function setupTerminalIPC() {
  ipcMain.handle("terminal:create", (_event, { cwd, cols, rows }) => {
    const sender = _event.sender;

    const result = terminalManager.create({
      cwd,
      cols,
      rows,
      onData: (sessionId, data) => {
        if (!sender.isDestroyed()) {
          sender.send("terminal:data", { sessionId, data });
        }
      },
      onExit: (sessionId, exitCode) => {
        if (!sender.isDestroyed()) {
          sender.send("terminal:exit", { sessionId, exitCode });
        }
      }
    });

    return result;
  });

  ipcMain.handle("terminal:write", (_event, { sessionId, data }) => {
    return terminalManager.write(sessionId, data);
  });

  ipcMain.handle("terminal:resize", (_event, { sessionId, cols, rows }) => {
    return terminalManager.resize(sessionId, cols, rows);
  });

  ipcMain.handle("terminal:ack", (_event, { sessionId, charCount }) => {
    terminalManager.ack(sessionId, charCount);
  });

  ipcMain.handle("terminal:kill", (_event, { sessionId }) => {
    return terminalManager.kill(sessionId);
  });

  ipcMain.handle("terminal:list", () => {
    return terminalManager.list();
  });
}

// ── Window creation ──

async function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: "OpenSwarm",
    webPreferences: {
      preload: `${__dirname}/preload.js`,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  const backendReady = await waitForBackend(BACKEND_URL, BACKEND_WAIT_MS);

  if (backendReady) {
    await win.loadURL(BACKEND_URL);
  } else {
    await win.loadURL(offlinePage(BACKEND_URL));
  }
}

app.whenReady().then(() => {
  setupTerminalIPC();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  terminalManager.destroyAll();
});
