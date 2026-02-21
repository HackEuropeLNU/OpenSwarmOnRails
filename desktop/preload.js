const { contextBridge, ipcRenderer } = require("electron");

const TAG = "[DEBUG:preload]";
const DEBUG = process.env.OPENSWARM_DEBUG_TERMINAL === "1";
const debug = (...args) => {
  if (DEBUG) console.log(TAG, ...args);
};

debug("preload script initialized");

contextBridge.exposeInMainWorld("desktopShell", {
  platform: process.platform,

  // ── Terminal API (node-pty via Electron main process) ──
  terminal: {
    /**
     * Create a new PTY session.
     * @param {{ cwd: string, cols?: number, rows?: number }} opts
     * @returns {Promise<{ sessionId: string, shell: string, cwd: string }>}
     */
    create: (opts) => {
      debug("terminal.create", opts);
      return ipcRenderer.invoke("terminal:create", opts);
    },

    /** Write input to a PTY session. */
    write: (sessionId, data) => ipcRenderer.invoke("terminal:write", { sessionId, data }),

    /** Resize a PTY session. */
    resize: (sessionId, cols, rows) => ipcRenderer.invoke("terminal:resize", { sessionId, cols, rows }),

    /** Acknowledge processed characters (flow control). */
    ack: (sessionId, charCount) => ipcRenderer.invoke("terminal:ack", { sessionId, charCount }),

    /** Kill a PTY session. */
    kill: (sessionId) => {
      debug("terminal.kill", { sessionId });
      return ipcRenderer.invoke("terminal:kill", { sessionId });
    },

    /** List all active sessions. */
    list: () => {
      debug("terminal.list");
      return ipcRenderer.invoke("terminal:list");
    },

    /** Subscribe to PTY output data. Callback receives (sessionId, data). */
    onData: (callback) => {
      const handler = (_event, { sessionId, data }) => callback(sessionId, data);
      debug("terminal.onData subscribed");
      ipcRenderer.on("terminal:data", handler);
      return () => {
        debug("terminal.onData unsubscribed");
        ipcRenderer.removeListener("terminal:data", handler);
      };
    },

    /** Subscribe to PTY exit events. Callback receives (sessionId, exitCode). */
    onExit: (callback) => {
      const handler = (_event, { sessionId, exitCode }) => callback(sessionId, exitCode);
      debug("terminal.onExit subscribed");
      ipcRenderer.on("terminal:exit", handler);
      return () => {
        debug("terminal.onExit unsubscribed");
        ipcRenderer.removeListener("terminal:exit", handler);
      };
    }
  }
});
