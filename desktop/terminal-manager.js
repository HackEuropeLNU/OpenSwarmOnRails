const os = require("os");
const pty = require("node-pty");
const { randomUUID } = require("crypto");

// ── Flow control constants (matches VS Code approach) ──
const HIGH_WATERMARK = 100000; // pause pty after this many unacked chars
const LOW_WATERMARK = 5000;    // resume pty after acked below this

class TerminalManager {
  constructor() {
    this.sessions = new Map(); // sessionId -> SessionState
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

    const ptyProcess = pty.spawn(shell, ["-il"], {
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

    // Wire PTY output -> renderer via callback
    session.dataDisposable = ptyProcess.onData((data) => {
      session.unackedChars += data.length;

      // Flow control: pause if renderer is behind
      if (!session.paused && session.unackedChars > HIGH_WATERMARK) {
        ptyProcess.pause();
        session.paused = true;
      }

      onData(sessionId, data);
    });

    session.exitDisposable = ptyProcess.onExit(({ exitCode }) => {
      session.state = "exited";
      onExit(sessionId, exitCode);
      this._cleanup(sessionId);
    });

    this.sessions.set(sessionId, session);

    return { sessionId, shell, cwd };
  }

  /**
   * Write input data to a PTY session.
   */
  write(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session || session.state === "exited") return false;
    session.pty.write(data);
    return true;
  }

  /**
   * Resize a PTY session.
   */
  resize(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    if (!session || session.state === "exited") return false;
    cols = Math.max(1, Math.min(cols, 1000));
    rows = Math.max(1, Math.min(rows, 500));
    try {
      session.pty.resize(cols, rows);
    } catch (_e) {
      // pty may have exited between check and resize
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
      session.pty.resume();
      session.paused = false;
    }
  }

  /**
   * Kill a PTY session.
   */
  kill(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    try {
      session.pty.kill();
    } catch (_e) {
      // already dead
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
