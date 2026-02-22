const os = require("os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const pty = require("node-pty");
const { randomUUID } = require("crypto");

const TAG = "[DEBUG:TerminalManager]";
const DEBUG = process.env.OPENSWARM_DEBUG_TERMINAL === "1";
const debug = (...args) => {
  if (DEBUG) console.log(TAG, ...args);
};

// Flow control constants.
const HIGH_WATERMARK = 100000;
const LOW_WATERMARK = 5000;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_BUFFER_CHARS = 200000;
const DEFAULT_SNAPSHOT_CHARS = 100000;
const TOKEN_RATE_LOG_MIN_INTERVAL_MS = 1000;
const TOKEN_RATE_PATTERNS = [
  /(\d+(?:\.\d+)?)\s*(?:tok|token|tokens)\s*\/\s*s\b/gi,
  /\b(?:tok|token|tokens)\s*\/\s*s\s*[:=]\s*(\d+(?:\.\d+)?)/gi,
  /\btps\s*[:=]\s*(\d+(?:\.\d+)?)/gi
];

const SHELL_LOGIN_ARG_BY_BASENAME = {
  bash: ["-il"],
  zsh: ["-il"],
  sh: ["-il"],
  fish: ["-il"],
  pwsh: ["-NoLogo"],
  powershell: ["-NoLogo"],
  "powershell.exe": ["-NoLogo"]
};

class TerminalManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map(); // sessionId -> SessionState
    this.sessionIdByCwd = new Map(); // normalized cwd -> sessionId
    debug("constructed, node-pty version:", require("node-pty/package.json").version);
  }

  create({ cwd, cols = DEFAULT_COLS, rows = DEFAULT_ROWS, shellPath, shellArgs, env = {}, reuse = true }) {
    const normalizedCwd = this._normalizeCwd(cwd);

    if (!normalizedCwd) {
      throw new Error("Invalid terminal cwd");
    }

    const existingSessionId = this.sessionIdByCwd.get(normalizedCwd);
    if (reuse && existingSessionId) {
      const existing = this.sessions.get(existingSessionId);
      if (existing && existing.state !== "exited") {
        return this._serializeSession(existing);
      }
      this.sessionIdByCwd.delete(normalizedCwd);
    }

    const profile = this._resolveShellProfile({ shellPath, shellArgs, env });
    const sessionId = randomUUID();

    debug("create() called - cwd:", normalizedCwd, "cols:", cols, "rows:", rows, "shell:", profile.shellPath);

    let ptyProcess;
    try {
      ptyProcess = pty.spawn(profile.shellPath, profile.shellArgs, {
        name: "xterm-256color",
        cols: this._clampCols(cols),
        rows: this._clampRows(rows),
        cwd: normalizedCwd,
        env: profile.env
      });
      debug("pty.spawn() succeeded - pid:", ptyProcess.pid, "sessionId:", sessionId);
    } catch (err) {
      console.error(TAG, "pty.spawn() FAILED:", err.message, err.stack);
      throw err;
    }

    const session = {
      id: sessionId,
      pty: ptyProcess,
      shell: profile.shellPath,
      cwd: normalizedCwd,
      state: "ready",
      unackedChars: 0,
      paused: false,
      buffer: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dataDisposable: null,
      exitDisposable: null,
      parseCarry: "",
      inputChars: 0,
      outputChars: 0,
      lastTokenRate: null,
      lastTokenRateLogAt: 0
    };

    let dataChunks = 0;
    session.dataDisposable = ptyProcess.onData((data) => {
      dataChunks++;
      if (dataChunks <= 3) {
        debug(`onData chunk #${dataChunks} sessionId:${sessionId} len:${data.length} preview:${JSON.stringify(data.slice(0, 80))}`);
      } else if (dataChunks === 4) {
        debug(`onData - suppressing further data logs for sessionId:${sessionId}`);
      }

      session.buffer = `${session.buffer}${data}`.slice(-MAX_BUFFER_CHARS);
      session.updatedAt = Date.now();
      session.unackedChars += data.length;
      session.outputChars += data.length;

      const tokenRate = this._extractTokenRate(session, data);
      if (tokenRate !== null) {
        const now = Date.now();
        const enoughTimeElapsed = now - session.lastTokenRateLogAt >= TOKEN_RATE_LOG_MIN_INTERVAL_MS;
        const changedRate = session.lastTokenRate !== tokenRate;
        session.lastTokenRate = tokenRate;

        if (changedRate || enoughTimeElapsed) {
          session.lastTokenRateLogAt = now;
          console.log(
            `[METRIC:tokens] session=${sessionId} token_per_sec=${tokenRate.toFixed(2)} input_chars=${session.inputChars} output_chars=${session.outputChars} cwd=${session.cwd}`
          );
          this.emit("metrics", {
            sessionId,
            cwd: session.cwd,
            tokenPerSec: tokenRate,
            inputChars: session.inputChars,
            outputChars: session.outputChars,
            timestamp: now
          });
        }
      }

      if (!session.paused && session.unackedChars > HIGH_WATERMARK) {
        debug("PAUSING pty - unackedChars:", session.unackedChars, "sessionId:", sessionId);
        ptyProcess.pause();
        session.paused = true;
      }

      this.emit("data", { sessionId, data });
    });

    session.exitDisposable = ptyProcess.onExit(({ exitCode }) => {
      debug("onExit - sessionId:", sessionId, "exitCode:", exitCode);
      session.state = "exited";
      session.updatedAt = Date.now();
      this.emit("exit", { sessionId, exitCode });
      this._cleanup(sessionId, { keepMapEntry: false });
    });

    this.sessions.set(sessionId, session);
    this.sessionIdByCwd.set(normalizedCwd, sessionId);

    const result = this._serializeSession(session);
    debug("create() returning:", JSON.stringify(result));
    return result;
  }

  write(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session || session.state === "exited") {
      debug("write() - session not found or exited, sessionId:", sessionId);
      return false;
    }
    session.inputChars += (data || "").length;
    session.pty.write(data);
    return true;
  }

  resize(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    if (!session || session.state === "exited") {
      debug("resize() - session not found or exited, sessionId:", sessionId);
      return false;
    }
    cols = this._clampCols(cols);
    rows = this._clampRows(rows);
    debug("resize() - sessionId:", sessionId, "cols:", cols, "rows:", rows);
    try {
      session.pty.resize(cols, rows);
    } catch (_e) {
      console.error(TAG, "resize() threw:", _e.message);
    }
    return true;
  }

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
    this._cleanup(sessionId, { keepMapEntry: false });
    return true;
  }

  list() {
    const result = [];
    for (const [id, session] of this.sessions) {
      result.push(this._serializeSession(session, id));
    }
    return result;
  }

  snapshot(sessionId, maxChars = DEFAULT_SNAPSHOT_CHARS) {
    const session = this.sessions.get(sessionId);
    if (!session || session.state === "exited") return "";

    const limit = Math.max(0, Math.min(Number(maxChars) || DEFAULT_SNAPSHOT_CHARS, MAX_BUFFER_CHARS));
    if (limit === 0) return "";
    return session.buffer.slice(-limit);
  }

  destroyAll() {
    for (const sessionId of this.sessions.keys()) {
      this.kill(sessionId);
    }
  }

  _cleanup(sessionId, { keepMapEntry = false } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      session.dataDisposable?.dispose?.();
      session.exitDisposable?.dispose?.();
    } catch (_error) {
      // Ignore cleanup errors.
    }

    if (this.sessionIdByCwd.get(session.cwd) === sessionId) {
      this.sessionIdByCwd.delete(session.cwd);
    }

    if (!keepMapEntry) {
      this.sessions.delete(sessionId);
    }
  }

  _serializeSession(session, fallbackId = null) {
    return {
      sessionId: session.id || fallbackId,
      shell: session.shell,
      cwd: session.cwd,
      state: session.state,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt
    };
  }

  _normalizeCwd(value) {
    if (!value || typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;

    try {
      return path.resolve(trimmed);
    } catch (_error) {
      return null;
    }
  }

  _resolveShellProfile({ shellPath, shellArgs, env }) {
    const platform = os.platform();
    const resolvedShellPath =
      (typeof shellPath === "string" && shellPath.trim()) ||
      process.env.OPENSWARM_TERMINAL_SHELL ||
      process.env.SHELL ||
      (platform === "win32" ? "powershell.exe" : "/bin/zsh");

    const basename = path.basename(resolvedShellPath).toLowerCase();
    const resolvedShellArgs =
      Array.isArray(shellArgs) && shellArgs.length > 0
        ? shellArgs.map((arg) => String(arg))
        : (SHELL_LOGIN_ARG_BY_BASENAME[basename] || []);

    return {
      shellPath: resolvedShellPath,
      shellArgs: resolvedShellArgs,
      env: {
        ...process.env,
        ...env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor"
      }
    };
  }

  _clampCols(cols) {
    return Math.max(20, Math.min(Number(cols) || DEFAULT_COLS, 1000));
  }

  _clampRows(rows) {
    return Math.max(4, Math.min(Number(rows) || DEFAULT_ROWS, 500));
  }

  _extractTokenRate(session, chunk) {
    if (!chunk) return null;

    const normalized = this._stripAnsi(chunk).replace(/\r(?!\n)/g, "\n");
    session.parseCarry = `${session.parseCarry}${normalized}`.slice(-3000);

    const matches = [];
    for (const pattern of TOKEN_RATE_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(session.parseCarry)) !== null) {
        const parsed = Number(match[1]);
        if (Number.isFinite(parsed) && parsed >= 0) matches.push(parsed);
      }
    }

    if (matches.length === 0) return null;
    return matches[matches.length - 1];
  }

  _stripAnsi(text) {
    return text.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><])/g, "");
  }
}

module.exports = { TerminalManager };
