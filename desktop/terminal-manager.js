const os = require("os");
const pty = require("node-pty");
const { randomUUID } = require("crypto");

const TAG = "[DEBUG:TerminalManager]";
const DEBUG = process.env.OPENSWARM_DEBUG_TERMINAL === "1";
const debug = (...args) => {
  if (DEBUG) console.log(TAG, ...args);
};

// ── Flow control constants (matches VS Code approach) ──
const HIGH_WATERMARK = 100000; // pause pty after this many unacked chars
const LOW_WATERMARK = 5000;    // resume pty after acked below this

class TerminalManager {
  constructor() {
    this.sessions = new Map(); // sessionId -> SessionState
    debug("constructed, node-pty version:", require("node-pty/package.json").version);
  }

  /**
   * Create a new PTY session.
   * @param {string} cwd - Working directory
   * @param {number} cols - Initial columns
   * @param {number} rows - Initial rows
   * @param {Function} onData - Called with (sessionId, data:string)
   * @param {Function} onExit - Called with (sessionId, exitCode:number)
   * @returns {{ sessionId, shell, cwd }}
   */
  create({ cwd, cols = 80, rows = 24, onData, onExit }) {
    const shell = process.env.SHELL || (os.platform() === "win32" ? "powershell.exe" : "/bin/zsh");
    const sessionId = randomUUID();

    debug("create() called - cwd:", cwd, "cols:", cols, "rows:", rows, "shell:", shell);

    let ptyProcess;
    try {
      ptyProcess = pty.spawn(shell, ["-il"], {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor"
        }
      });
      debug("pty.spawn() succeeded - pid:", ptyProcess.pid, "sessionId:", sessionId);
    } catch (err) {
      console.error(TAG, "pty.spawn() FAILED:", err.message, err.stack);
      throw err;
    }

    const session = {
      id: sessionId,
      pty: ptyProcess,
      shell,
      cwd,
      state: "ready",       // ready | exited
      unackedChars: 0,
      paused: false,
      dataDisposable: null,
      exitDisposable: null
    };

    let dataChunks = 0;
    // Wire PTY output -> renderer via callback
    session.dataDisposable = ptyProcess.onData((data) => {
      dataChunks++;
      if (dataChunks <= 3) {
        debug(`onData chunk #${dataChunks} sessionId:${sessionId} len:${data.length} preview:${JSON.stringify(data.slice(0, 80))}`);
      } else if (dataChunks === 4) {
        debug(`onData - suppressing further data logs for sessionId:${sessionId}`);
      }

      session.unackedChars += data.length;

      // Flow control: pause if renderer is behind
      if (!session.paused && session.unackedChars > HIGH_WATERMARK) {
        debug("PAUSING pty - unackedChars:", session.unackedChars, "sessionId:", sessionId);
        ptyProcess.pause();
        session.paused = true;
      }

      onData(sessionId, data);
    });

    session.exitDisposable = ptyProcess.onExit(({ exitCode }) => {
      debug("onExit - sessionId:", sessionId, "exitCode:", exitCode);
      session.state = "exited";
      onExit(sessionId, exitCode);
      this._cleanup(sessionId);
    });

    this.sessions.set(sessionId, session);

    const result = { sessionId, shell, cwd };
    debug("create() returning:", JSON.stringify(result));
    return result;
  }

  /**
   * Write input data to a PTY session.
   */
  write(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session || session.state === "exited") {
      debug("write() - session not found or exited, sessionId:", sessionId);
      return false;
    }
    session.pty.write(data);
    return true;
  }

  /**
   * Resize a PTY session.
   */
  resize(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    if (!session || session.state === "exited") {
      debug("resize() - session not found or exited, sessionId:", sessionId);
      return false;
    }
    cols = Math.max(1, Math.min(cols, 1000));
    rows = Math.max(1, Math.min(rows, 500));
    debug("resize() - sessionId:", sessionId, "cols:", cols, "rows:", rows);
    try {
      session.pty.resize(cols, rows);
    } catch (_e) {
      console.error(TAG, "resize() threw:", _e.message);
    }
    return true;
  }

  /**
   * Acknowledge processed characters (flow control).
   * Renderer calls this after writing data to xterm.
   */
  ack(sessionId, charCount) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.unackedChars = Math.max(0, session.unackedChars - charCount);
    if (session.paused && session.unackedChars < LOW_WATERMARK) {
      debug("RESUMING pty - unackedChars:", session.unackedChars, "sessionId:", sessionId);
      session.pty.resume();
      session.paused = false;
    }
  }

  /**
   * Kill a PTY session.
   */
  kill(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      debug("kill() - session not found, sessionId:", sessionId);
      return false;
    }
    debug("kill() - sessionId:", sessionId);
    try {
      session.pty.kill();
    } catch (_e) {
      console.error(TAG, "kill() threw:", _e.message);
    }
    this._cleanup(sessionId);
    return true;
  }

  /**
   * List all active sessions.
   */
  list() {
    const result = [];
    for (const [id, session] of this.sessions) {
      result.push({
        sessionId: id,
        shell: session.shell,
        cwd: session.cwd,
        state: session.state
      });
    }
    return result;
  }

  /**
   * Kill all sessions (app shutdown).
   */
  destroyAll() {
    for (const sessionId of this.sessions.keys()) {
      this.kill(sessionId);
    }
  }

  _cleanup(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
  }
}

module.exports = { TerminalManager };
