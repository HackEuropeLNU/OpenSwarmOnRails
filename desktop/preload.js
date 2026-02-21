const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopShell", {
  platform: process.platform,

  // ── Terminal API (node-pty via Electron main process) ──
  terminal: {
    /**
     * Create a new PTY session.
     * @param {{ cwd: string, cols?: number, rows?: number }} opts
     * @returns {Promise<{ sessionId: string, shell: string, cwd: string }>}
     */
    create: (opts) => ipcRenderer.invoke("terminal:create", opts),

    /** Write input to a PTY session. */
    write: (sessionId, data) => ipcRenderer.invoke("terminal:write", { sessionId, data }),

    /** Resize a PTY session. */
    resize: (sessionId, cols, rows) => ipcRenderer.invoke("terminal:resize", { sessionId, cols, rows }),

    /** Acknowledge processed characters (flow control). */
    ack: (sessionId, charCount) => ipcRenderer.invoke("terminal:ack", { sessionId, charCount }),

    /** Kill a PTY session. */
    kill: (sessionId) => ipcRenderer.invoke("terminal:kill", { sessionId }),

    /** List all active sessions. */
    list: () => ipcRenderer.invoke("terminal:list"),

    /** Subscribe to PTY output data. Callback receives (sessionId, data). */
    onData: (callback) => {
      const handler = (_event, { sessionId, data }) => callback(sessionId, data);
      ipcRenderer.on("terminal:data", handler);
      return () => ipcRenderer.removeListener("terminal:data", handler);
    },

    /** Subscribe to PTY exit events. Callback receives (sessionId, exitCode). */
    onExit: (callback) => {
      const handler = (_event, { sessionId, exitCode }) => callback(sessionId, exitCode);
      ipcRenderer.on("terminal:exit", handler);
      return () => ipcRenderer.removeListener("terminal:exit", handler);
    }
  }
});
