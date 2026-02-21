import { Controller } from "@hotwired/stimulus"
import { Terminal } from "xterm"
import { FitAddon } from "@xterm/addon-fit"
import consumer from "cable_consumer"

const TAG = "[DEBUG:web_terminal]"
const DEBUG = false
const debug = (...args) => {
  if (DEBUG) console.log(TAG, ...args)
}

// ── Detect desktop mode (Electron with node-pty IPC) ──
const desktopTerminal = window.desktopShell?.terminal
const isDesktop = typeof desktopTerminal?.create === "function"

// ── Flow control: batch ack every N chars ──
const ACK_BATCH_SIZE = 5000
const DEFERRED_OUTPUT_LIMIT = 200000
const OPENCODE_SPINNER_REGEX = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/
const OPENCODE_IDLE_TIMEOUT_MS = 1500
const SHELL_PROMPT_REGEX = /(?:\r?\n|^)[^\r\n]*[%$#] $/
const TOKEN_RATE_REGEXES = [
  /(\d+(?:\.\d+)?)\s*(?:tok|token|tokens)\s*\/\s*s\b/i,
  /(\d+(?:\.\d+)?)\s*(?:tok|token|tokens)\s*per\s*sec(?:ond)?\b/i,
  /\b(?:tok|token|tokens)\s*\/\s*s\s*[:=]\s*(\d+(?:\.\d+)?)/i,
  /\btps\s*[:=]\s*(\d+(?:\.\d+)?)/i
]
const TOKEN_DEBUG_SAMPLE_LIMIT = 120
const TOKEN_RATE_PATTERNS = [
  /(\d+(?:\.\d+)?)\s*(?:tokens?|tok)\s*\/\s*s\b/gi,
  /\b(?:tokens?|tok)\s*\/\s*s\s*[:=]\s*(\d+(?:\.\d+)?)/gi,
  /\btps\s*[:=]\s*(\d+(?:\.\d+)?)/gi
]

export default class extends Controller {
  static targets = [
    "panel",
    "terminal",
    "path",
    "shell",
    "status",
    "backgroundIndicator",
    "backgroundSpinner",
    "backgroundLabel"
  ]

  connect() {
    debug("connect", { isDesktop })
    this.subscription = null  // ActionCable subscription (browser mode)
    this.term = null
    this.fitAddon = null
    this.sessionId = null
    this.activePath = null
    this.panelVisible = false
    this.unackedChars = 0     // renderer-side flow control counter
    this.ipcCleanups = []     // IPC listener cleanup functions
    this.acceptDesktopDataBeforeSessionId = false
    this.pendingDesktopSessionId = null
    this.desktopSessionsByPath = new Map()
    this.desktopPathBySessionId = new Map()
    this.spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    this.spinnerFrameIndex = 0
    this.spinnerIntervalId = null
    this.sessionStateById = new Map()
    this.runningSessionIds = new Set()
    this.sessionTimeoutIds = new Map()
    this.textDecoder = new TextDecoder()
    this.outputParseCarry = ""
    this.sessionMetaById = new Map()
    this.pendingSessionMeta = null
    this.resizeObserver = null
    this.deferredOutput = ""

    this.openHandler = this.openFromEvent.bind(this)
    this.resizeHandler = this.resizeTerminal.bind(this)
    this.escapeHandler = this.handleEscape.bind(this)
    this.toggleHandler = this.togglePanel.bind(this)

    window.addEventListener("worktree:open-terminal", this.openHandler)
    window.addEventListener("worktree:toggle-terminal", this.toggleHandler)
    window.addEventListener("resize", this.resizeHandler)
    document.addEventListener("keydown", this.escapeHandler)

    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(() => this.resizeTerminal())
      if (this.hasPanelTarget) this.resizeObserver.observe(this.panelTarget)
      if (this.hasTerminalTarget) this.resizeObserver.observe(this.terminalTarget)
    }

    // Desktop: subscribe to PTY events globally
    if (isDesktop) {
      debug("desktop mode: subscribing to IPC events")
      const offData = desktopTerminal.onData((sessionId, data) => {
        this.recordOutputActivity(data, sessionId)

        const activeSessionMatch = Boolean(this.sessionId) && sessionId === this.sessionId
        const pendingSessionMatch = !this.sessionId && this.acceptDesktopDataBeforeSessionId &&
          (!this.pendingDesktopSessionId || this.pendingDesktopSessionId === sessionId)

        if (!activeSessionMatch && !pendingSessionMatch) {
          desktopTerminal.ack(sessionId, data.length)
          return
        }

        if (!this.term) {
          this.queueDeferredOutput(data)
          this.processTerminalOutput(data, sessionId)
          desktopTerminal.ack(sessionId, data.length)
          return
        }

        if (!this.sessionId && pendingSessionMatch && !this.pendingDesktopSessionId) {
          this.pendingDesktopSessionId = sessionId
        }

        if (this.unackedChars === 0) {
          debug("first terminal:data chunk", { sessionId, len: data.length, preview: data.slice(0, 80) })
        }
        this.recordOutputActivity(data)
        this.term.write(data)
        this.processTerminalOutput(data, sessionId)

        // Flow control ACK
        this.unackedChars += data.length
        if (this.unackedChars >= ACK_BATCH_SIZE) {
          debug("sending ACK", { sessionId, charCount: this.unackedChars })
          desktopTerminal.ack(sessionId, this.unackedChars)
          this.unackedChars = 0
        }
      })

      const offExit = desktopTerminal.onExit((sessionId, _exitCode) => {
        const mappedPath = this.desktopPathBySessionId.get(sessionId)
        if (mappedPath) {
          this.desktopSessionsByPath.delete(mappedPath)
          this.desktopPathBySessionId.delete(sessionId)
        }

        this.resetOpencodeTracking(sessionId)
        this.sessionStateById.delete(sessionId)
        this.runningSessionIds.delete(sessionId)
        const timeoutId = this.sessionTimeoutIds.get(sessionId)
        if (timeoutId) {
          clearTimeout(timeoutId)
          this.sessionTimeoutIds.delete(sessionId)
        }

        if (sessionId !== this.sessionId) return
        debug("received terminal:exit", { sessionId })
        this.statusTarget.textContent = "exited"
        this.sessionMetaById.delete(sessionId)
        this.sessionId = null
        this.activePath = null
        this.resetOpencodeTracking()
        this.updateBackgroundIndicator()
      })

      this.ipcCleanups.push(offData, offExit)
    }
  }

  disconnect() {
    debug("disconnect")
    window.removeEventListener("worktree:open-terminal", this.openHandler)
    window.removeEventListener("worktree:toggle-terminal", this.toggleHandler)
    window.removeEventListener("resize", this.resizeHandler)
    document.removeEventListener("keydown", this.escapeHandler)

    if (this.resizeObserver) {
      this.resizeObserver.disconnect()
      this.resizeObserver = null
    }

    this.ipcCleanups.forEach((fn) => fn())
    this.ipcCleanups = []

    this.destroyTerminal({ killRemote: false, closeRemoteBrowser: false })
    this.clearBackgroundActivity()
    this.updateBackgroundIndicator()
    document.documentElement.classList.remove("overflow-hidden")
  }

  // ── Show / hide using slide transform (never dispose xterm, always keep mounted) ──

  showPanel() {
    debug("showPanel")
    this.panelTarget.dataset.visible = "true"
    this.panelVisible = true
    document.documentElement.classList.add("overflow-hidden")
    this.updateBackgroundIndicator()

    // Force reflow and refresh terminal after slide animation completes
    setTimeout(() => {
      if (this.term) {
        this.term.focus()
        this.term.refresh(0, this.term.rows - 1)
      }
      this.resizeTerminal()
    }, 200)
  }

  hidePanel() {
    debug("hidePanel")
    this.panelTarget.dataset.visible = "false"
    this.panelVisible = false
    document.documentElement.classList.remove("overflow-hidden")
    this.updateBackgroundIndicator()
  }

  togglePanel() {
    if (this.panelVisible) {
      this.hidePanel()
    } else if (this.sessionId) {
      this.showPanel()
    }
  }

  closePanel() {
    this.hidePanel()
  }

  reopenFromIndicator(event) {
    event?.preventDefault?.()
    if (!this.sessionId) return
    this.showPanel()
  }

  backdropClose(event) {
    if (event.target === this.panelTarget) {
      this.hidePanel()
    }
  }

  // ── Open a new terminal session (or re-show existing) ──

  openFromEvent(event) {
    const payload = event.detail || {}
    debug("openFromEvent", payload)
    this.pendingSessionMeta = this.buildSessionMeta(payload)

    // Desktop mode: payload has `path` from the worktree, we create PTY directly
    if (isDesktop) {
      this._openDesktopTerminal(payload)
      return
    }

    // Browser mode: payload has `session_id` from Rails backend
    if (!payload.session_id) return
    this._openBrowserTerminal(payload)
  }

  async _openDesktopTerminal(payload) {
    const rawPath = payload.path
    const path = this.normalizePath(rawPath)
    if (!path) {
      console.error(TAG, "_openDesktopTerminal missing path", payload)
      return
    }

    debug("_openDesktopTerminal", { path, existingSessionId: this.sessionId })

    let existingSession = this.desktopSessionsByPath.get(path)
    if (!existingSession) {
      existingSession = await this.findExistingDesktopSession(path)
    }

    if (existingSession) {
      this.destroyTerminal({ killRemote: false, closeRemoteBrowser: false })
      this.sessionId = existingSession.sessionId
      this.activePath = path
      this.pathTarget.textContent = path
      this.shellTarget.textContent = existingSession.shell || ""
      this.statusTarget.textContent = "connected"
      this.setupTerminal()
      this.attachDesktopTerminalHandlers()
      this.showPanel()
      return
    }

    this.destroyTerminal({ killRemote: false, closeRemoteBrowser: false })
    this.acceptDesktopDataBeforeSessionId = true
    this.pendingDesktopSessionId = null

    this.pathTarget.textContent = path
    this.statusTarget.textContent = "creating"
    this.setupTerminal()
    this.showPanel()

    const cols = 80
    const rows = 24
    debug("creating desktop terminal", { path, cols, rows })

    try {
      const result = await desktopTerminal.create({ cwd: path, cols, rows })
      debug("desktopTerminal.create result", result)

      if (this.pendingDesktopSessionId && this.pendingDesktopSessionId !== result.sessionId) {
        this.term?.reset()
      }

      this.sessionId = result.sessionId
      this.activePath = path
      this.acceptDesktopDataBeforeSessionId = false
      this.pendingDesktopSessionId = null
      if (this.pendingSessionMeta) {
        this.sessionMetaById.set(result.sessionId, this.pendingSessionMeta)
      }
      this.shellTarget.textContent = result.shell
      this.statusTarget.textContent = "connected"
      this.desktopSessionsByPath.set(path, { sessionId: result.sessionId, shell: result.shell })
      this.desktopPathBySessionId.set(result.sessionId, path)
      this.attachDesktopTerminalHandlers()
      this.resizeTerminal()
      this.updateBackgroundIndicator()
    } catch (err) {
      this.acceptDesktopDataBeforeSessionId = false
      this.pendingDesktopSessionId = null
      this.statusTarget.textContent = "error"
      this.activePath = null
      console.error("Failed to create desktop terminal:", err)
    }
  }

  async findExistingDesktopSession(path) {
    if (!isDesktop || typeof desktopTerminal.list !== "function") return null

    try {
      const sessions = await desktopTerminal.list()
      if (!Array.isArray(sessions)) return null

      const match = sessions.find((session) => {
        if (!session || session.state === "exited") return false
        return this.normalizePath(session.cwd) === path
      })

      if (!match?.sessionId) return null

      const result = {
        sessionId: match.sessionId,
        shell: match.shell || ""
      }

      this.desktopSessionsByPath.set(path, result)
      this.desktopPathBySessionId.set(match.sessionId, path)
      return result
    } catch (error) {
      debug("findExistingDesktopSession failed", { path, error })
      return null
    }
  }

  attachDesktopTerminalHandlers() {
    if (!this.term) return

    this.term.onData((data) => {
      if (!this.sessionId) return
      this.trackInputForOpencode(data, this.sessionId)
      if (data && data.trim()) {
        debug("term.onData (user input)", { len: data.length, preview: data.slice(0, 60) })
      }
      desktopTerminal.write(this.sessionId, data)
    })

    this.term.onResize(({ cols, rows }) => {
      if (!this.sessionId) return
      debug("term.onResize", { sessionId: this.sessionId, cols, rows })
      desktopTerminal.resize(this.sessionId, cols, rows)
    })
  }

  _openBrowserTerminal(payload) {
    if (!payload.session_id) return

    // If we already have this session, just re-show
    if (this.sessionId === payload.session_id) {
      this.showPanel()
      return
    }

    this.destroyTerminal()

    this.pathTarget.textContent = payload.path || ""
    this.shellTarget.textContent = payload.shell || ""
    this.statusTarget.textContent = "connecting"
    this.pendingSessionMeta = this.buildSessionMeta(payload)
    this.sessionMetaById.set(payload.session_id, this.pendingSessionMeta)

    this.setupTerminal()
    this.showPanel()
    this.connectSubscription(payload.session_id)
    this.updateBackgroundIndicator()
  }

  handleEscape(event) {
    const minimizeShortcut = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "g"
    if (minimizeShortcut && this.panelVisible) {
      event.preventDefault()
      this.hidePanel()
      return
    }

    if (event.key === "Escape" && this.panelVisible) {
      this.hidePanel()
    }
  }

  // ── Terminal setup (shared between desktop and browser) ──

  setupTerminal() {
    debug("setupTerminal")
    if (this.term) {
      this.term.dispose()
      this.term = null
      this.fitAddon = null
      this.terminalTarget.innerHTML = ""
    }

    this.term = new Terminal({
      cursorBlink: true,
      fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 14,
      lineHeight: 1.32,
      letterSpacing: 0,
      convertEol: false,
      scrollback: 5000,
      theme: {
        background: "#0b1220",
        foreground: "#dbe5f5",
        cursor: "#93c5fd",
        selectionBackground: "rgba(59, 130, 246, 0.28)",
        black: "#0f172a",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#f59e0b",
        blue: "#3b82f6",
        magenta: "#ec4899",
        cyan: "#14b8a6",
        white: "#e2e8f0",
        brightBlack: "#334155",
        brightRed: "#f87171",
        brightGreen: "#4ade80",
        brightYellow: "#fbbf24",
        brightBlue: "#60a5fa",
        brightMagenta: "#f472b6",
        brightCyan: "#2dd4bf",
        brightWhite: "#f8fafc"
      }
    })

    this.fitAddon = new FitAddon()
    this.term.loadAddon(this.fitAddon)
    this.term.open(this.terminalTarget)
    this.fitAddon.fit()
  }

  // ── ActionCable connection (browser mode only) ──

  connectSubscription(sessionId) {
    this.disconnectSubscription()
    this.sessionId = sessionId

    this.subscription = consumer.subscriptions.create(
      { channel: "TerminalChannel", session_id: sessionId },
      {
        connected: () => {
          this.statusTarget.textContent = "connected"
          this.resizeTerminal()
          if (this.term) this.term.focus()
        },
        disconnected: () => {
          this.statusTarget.textContent = "disconnected"
        },
        rejected: () => {
          this.statusTarget.textContent = "rejected"
        },
        received: (message) => {
          if (message.type === "output") {
            if (message.encoding === "base64") {
              const bytes = this.decodeBase64(message.data || "")
              const text = this.textDecoder.decode(bytes)
              this.recordOutputActivity(text, this.sessionId)
              if (this.term) {
                this.term.write(bytes)
              } else {
                this.queueDeferredOutput(text)
              }
              this.processTerminalOutput(text, this.sessionId)
            } else {
              const text = message.data || ""
              this.recordOutputActivity(text, this.sessionId)
              if (this.term) {
                this.term.write(text)
              } else {
                this.queueDeferredOutput(text)
              }
              this.processTerminalOutput(text, this.sessionId)
            }
          } else if (message.type === "closed") {
            this.statusTarget.textContent = "closed"
            if (this.sessionId) this.sessionMetaById.delete(this.sessionId)
            this.sessionId = null
            this.resetOpencodeTracking()
            this.updateBackgroundIndicator()
          }
        }
      }
    )

    this.attachBrowserTerminalHandlers()
  }

  attachBrowserTerminalHandlers() {
    if (!this.term) return

    this.term.onData((data) => {
      if (!this.subscription) return
      this.trackInputForOpencode(data, this.sessionId)
      this.subscription.perform("input", { data })
    })

    this.term.onResize(({ cols, rows }) => {
      if (!this.subscription) return
      this.subscription.perform("resize", { cols, rows })
    })
  }

  queueDeferredOutput(chunk) {
    if (!chunk) return
    this.deferredOutput = `${this.deferredOutput}${chunk}`.slice(-DEFERRED_OUTPUT_LIMIT)
  }

  flushDeferredOutput() {
    if (!this.term || !this.deferredOutput) return
    this.term.write(this.deferredOutput)
    this.deferredOutput = ""
  }

  resizeTerminal() {
    if (!this.term || !this.fitAddon || !this.panelVisible) return

    this.fitAddon.fit()
    this.term.refresh(0, this.term.rows - 1)

    if (isDesktop && this.sessionId) {
      debug("resizeTerminal -> desktop resize", { sessionId: this.sessionId, cols: this.term.cols, rows: this.term.rows })
      desktopTerminal.resize(this.sessionId, this.term.cols, this.term.rows)
    } else if (this.subscription) {
      this.subscription.perform("resize", { cols: this.term.cols, rows: this.term.rows })
    }
  }

  // ── Cleanup ──

  disconnectSubscription({ closeRemote = false } = {}) {
    if (!this.subscription) return

    if (closeRemote) {
      this.subscription.perform("close")
    }
    this.subscription.unsubscribe()
    this.subscription = null
    this.sessionId = null
  }

  destroyTerminal({ killRemote = true, closeRemoteBrowser = false } = {}) {
    debug("destroyTerminal", { isDesktop, sessionId: this.sessionId })
    const closingSessionId = this.sessionId
    // Desktop: kill PTY via IPC
    if (killRemote && isDesktop && closingSessionId) {
      desktopTerminal.kill(closingSessionId)
      const mappedPath = this.desktopPathBySessionId.get(closingSessionId) || this.activePath
      if (mappedPath) this.desktopSessionsByPath.delete(mappedPath)
      this.desktopPathBySessionId.delete(closingSessionId)
    }

    this.disconnectSubscription({ closeRemote: closeRemoteBrowser })
    if (closingSessionId) this.sessionMetaById.delete(closingSessionId)
    this.sessionId = null
    this.activePath = null
    this.unackedChars = 0
    this.acceptDesktopDataBeforeSessionId = false
    this.pendingDesktopSessionId = null
    this.pendingSessionMeta = null
    this.outputParseCarry = ""
    this.deferredOutput = ""
    if (!this.panelVisible) {
      document.documentElement.classList.remove("overflow-hidden")
    }
    if (killRemote && closingSessionId) {
      this.resetOpencodeTracking(closingSessionId)
      this.sessionStateById.delete(closingSessionId)
      this.runningSessionIds.delete(closingSessionId)
      const timeoutId = this.sessionTimeoutIds.get(closingSessionId)
      if (timeoutId) {
        clearTimeout(timeoutId)
        this.sessionTimeoutIds.delete(closingSessionId)
      }
    }
    this.updateBackgroundIndicator()

    if (this.term) {
      this.term.dispose()
      this.term = null
      this.fitAddon = null
      this.terminalTarget.innerHTML = ""
    }
  }

  killTerminal() {
    this.hidePanel()
    this.destroyTerminal({ killRemote: true, closeRemoteBrowser: true })
    this.statusTarget.textContent = "idle"
    this.pathTarget.textContent = ""
    this.shellTarget.textContent = ""
  }

  decodeBase64(data) {
    const binary = window.atob(data)
    const bytes = new Uint8Array(binary.length)

    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i)
    }

    return bytes
  }

  bytesToString(bytes) {
    if (!bytes || bytes.length === 0) return ""
    return new TextDecoder("utf-8").decode(bytes)
  }

  buildSessionMeta(payload) {
    return {
      worktreeId: payload.worktreeId || null,
      branch: payload.branch || null,
      path: payload.path || null
    }
  }

  processTerminalOutput(output, sessionId) {
    if (!output) return

    const normalized = this.normalizeOutputForParsing(output)
    this.outputParseCarry = `${this.outputParseCarry}${normalized}`.slice(-3000)

    const matchedRates = []
    TOKEN_RATE_PATTERNS.forEach((pattern) => {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(this.outputParseCarry)) !== null) {
        const rate = Number(match[1])
        if (Number.isFinite(rate) && rate >= 0) {
          matchedRates.push(rate)
        }
      }
    })

    if (matchedRates.length === 0) return

    const latestRate = matchedRates[matchedRates.length - 1]
    const sessionMeta = this.resolveSessionMeta(sessionId)
    window.dispatchEvent(
      new CustomEvent("worktree:token-rate", {
        detail: {
          ...sessionMeta,
          sessionId,
          tokensPerSecond: latestRate,
          timestamp: Date.now()
        }
      })
    )
  }

  resolveSessionMeta(sessionId) {
    if (sessionId && this.sessionMetaById.has(sessionId)) {
      return this.sessionMetaById.get(sessionId)
    }

    if (this.pendingSessionMeta) {
      return this.pendingSessionMeta
    }

    return {
      worktreeId: null,
      branch: null,
      path: this.pathTarget.textContent || null
    }
  }

  normalizeOutputForParsing(output) {
    return output
      .replace(/[\u001b\u009b][[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "")
      .replace(/\r(?!\n)/g, "\n")
  }

  traceActionClick(event) {
    const message = event?.detail?.message || "click (unknown-action)"
    console.log(TAG, message)
    if (!this.term) return
    this.term.writeln(`\r\n${message}`)
  }

  trackInputForOpencode(data, sessionId = this.sessionId) {
    if (!data || !sessionId) return

    const state = this.getSessionState(sessionId)
    for (const char of data) {
      if (char === "\u0003") {
        this.resetOpencodeTracking(sessionId)
        continue
      }

      if (char === "\r" || char === "\n") {
        const command = state.inputBuffer.trim()
        if (command.startsWith("opencode")) {
          state.trackingOpencode = true
          state.outputTail = ""
          state.lastTokenRate = null
          state.noTokenChunkCount = 0
          this.runningSessionIds.delete(sessionId)
          this.updateBackgroundIndicator()
          console.log(TAG, "opencode start detected", { sessionId, path: this.desktopPathBySessionId.get(sessionId) || this.activePath })
        }
        state.inputBuffer = ""
        continue
      }

      if (char === "\u007f" || char === "\b") {
        state.inputBuffer = state.inputBuffer.slice(0, -1)
        continue
      }

      if (char >= " " && char <= "~") {
        state.inputBuffer += char
      }
    }
  }

  recordOutputActivity(text, sessionId = this.sessionId) {
    if (!text || !sessionId) return

    const state = this.getSessionState(sessionId)
    if (!state.trackingOpencode) return

    state.outputTail += text
    if (state.outputTail.length > 2048) {
      state.outputTail = state.outputTail.slice(-2048)
    }

    const normalizedText = this.stripAnsi(text)
    const tokenRate = this.extractTokenRate(normalizedText)

    if (tokenRate !== null) {
      state.lastTokenRate = tokenRate
      state.noTokenChunkCount = 0
      console.log(TAG, "token/s detected", {
        sessionId,
        path: this.desktopPathBySessionId.get(sessionId) || this.activePath,
        tokenRate,
        sample: normalizedText.slice(0, TOKEN_DEBUG_SAMPLE_LIMIT)
      })
    } else {
      state.noTokenChunkCount += 1
      if (state.noTokenChunkCount % 20 === 0) {
        console.log(TAG, "token/s not detected in recent output", {
          sessionId,
          path: this.desktopPathBySessionId.get(sessionId) || this.activePath,
          chunkCount: state.noTokenChunkCount,
          sample: normalizedText.slice(0, TOKEN_DEBUG_SAMPLE_LIMIT)
        })
      }
    }

    if (SHELL_PROMPT_REGEX.test(state.outputTail)) {
      this.resetOpencodeTracking(sessionId)
      console.log(TAG, "opencode prompt detected, marking idle", {
        sessionId,
        path: this.desktopPathBySessionId.get(sessionId) || this.activePath
      })
      return
    }

    if (!OPENCODE_SPINNER_REGEX.test(text)) return

    this.runningSessionIds.add(sessionId)
    this.startSpinner()
    this.updateBackgroundIndicator()

    const existingTimeout = this.sessionTimeoutIds.get(sessionId)
    if (existingTimeout) {
      clearTimeout(existingTimeout)
    }

    const timeoutId = setTimeout(() => {
      this.runningSessionIds.delete(sessionId)
      if (state) {
        state.trackingOpencode = false
        state.outputTail = ""
      }
      this.sessionTimeoutIds.delete(sessionId)
      this.updateBackgroundIndicator()
      console.log(TAG, "opencode idle timeout", {
        sessionId,
        path: this.desktopPathBySessionId.get(sessionId) || this.activePath
      })
    }, OPENCODE_IDLE_TIMEOUT_MS)

    this.sessionTimeoutIds.set(sessionId, timeoutId)
  }

  startSpinner() {
    if (this.spinnerIntervalId || !this.hasBackgroundSpinnerTarget) return

    this.backgroundSpinnerTarget.textContent = this.spinnerFrames[this.spinnerFrameIndex]
    this.spinnerIntervalId = setInterval(() => {
      this.spinnerFrameIndex = (this.spinnerFrameIndex + 1) % this.spinnerFrames.length
      this.backgroundSpinnerTarget.textContent = this.spinnerFrames[this.spinnerFrameIndex]
    }, 80)
  }

  stopSpinner() {
    if (this.spinnerIntervalId) {
      clearInterval(this.spinnerIntervalId)
      this.spinnerIntervalId = null
    }

    if (this.hasBackgroundSpinnerTarget) {
      this.backgroundSpinnerTarget.textContent = "⠿"
    }
  }

  clearBackgroundActivity(sessionId = null) {
    if (sessionId) {
      this.runningSessionIds.delete(sessionId)
      const timeoutId = this.sessionTimeoutIds.get(sessionId)
      if (timeoutId) {
        clearTimeout(timeoutId)
        this.sessionTimeoutIds.delete(sessionId)
      }
    } else {
      this.runningSessionIds.clear()
      for (const timeoutId of this.sessionTimeoutIds.values()) {
        clearTimeout(timeoutId)
      }
      this.sessionTimeoutIds.clear()
    }

    if (this.runningSessionIds.size === 0) {
      this.stopSpinner()
    }
  }

  resetOpencodeTracking(sessionId = this.sessionId) {
    if (sessionId) {
      const state = this.sessionStateById.get(sessionId)
      if (state) {
        state.trackingOpencode = false
        state.inputBuffer = ""
        state.outputTail = ""
        state.lastTokenRate = null
        state.noTokenChunkCount = 0
      }
      this.clearBackgroundActivity(sessionId)
      this.updateBackgroundIndicator()
      return
    }

    for (const state of this.sessionStateById.values()) {
      state.trackingOpencode = false
      state.inputBuffer = ""
      state.outputTail = ""
      state.lastTokenRate = null
      state.noTokenChunkCount = 0
    }
    this.clearBackgroundActivity()
    this.updateBackgroundIndicator()
  }

  updateBackgroundIndicator() {
    if (!this.hasBackgroundIndicatorTarget) return

    if (!isDesktop) {
      const shouldShow = Boolean(this.sessionId) && !this.panelVisible
      this.backgroundIndicatorTarget.classList.toggle("hidden", !shouldShow)
      if (!this.hasBackgroundLabelTarget) return
      this.backgroundLabelTarget.textContent = shouldShow ? "running (1)" : "idle (0)"
      return
    }

    const totalDesktopSessions = this.desktopSessionsByPath.size
    const visibleSessionCount = this.panelVisible && this.sessionId ? 1 : 0
    const backgroundSessionCount = Math.max(totalDesktopSessions - visibleSessionCount, 0)
    const runningBackgroundCount = this.countRunningBackgroundSessions()
    const idleBackgroundCount = Math.max(backgroundSessionCount - runningBackgroundCount, 0)
    const shouldShow = backgroundSessionCount > 0

    this.backgroundIndicatorTarget.classList.toggle("hidden", !shouldShow)

    if (runningBackgroundCount > 0) {
      this.startSpinner()
    } else {
      this.stopSpinner()
    }

    if (!this.hasBackgroundLabelTarget) return
    if (runningBackgroundCount > 0 && idleBackgroundCount > 0) {
      this.backgroundLabelTarget.textContent = `running (${runningBackgroundCount}) · idle (${idleBackgroundCount})`
      return
    }

    if (runningBackgroundCount > 0) {
      this.backgroundLabelTarget.textContent = `running (${runningBackgroundCount})`
      return
    }

    this.backgroundLabelTarget.textContent = `idle (${idleBackgroundCount})`
  }

  countRunningBackgroundSessions() {
    const runningPaths = new Set()
    for (const sessionId of this.runningSessionIds) {
      const path = this.desktopPathBySessionId.get(sessionId)
      if (!path) continue
      if (this.panelVisible && this.activePath === path) continue
      runningPaths.add(path)
    }
    return runningPaths.size
  }

  getSessionState(sessionId) {
    const key = sessionId || "browser"
    if (!this.sessionStateById.has(key)) {
      this.sessionStateById.set(key, {
        trackingOpencode: false,
        inputBuffer: "",
        outputTail: "",
        lastTokenRate: null,
        noTokenChunkCount: 0
      })
    }
    return this.sessionStateById.get(key)
  }

  extractTokenRate(text) {
    if (!text) return null
    for (const regex of TOKEN_RATE_REGEXES) {
      const match = text.match(regex)
      if (!match) continue
      const parsed = Number.parseFloat(match[1])
      if (Number.isFinite(parsed)) return parsed
    }
    return null
  }

  stripAnsi(text) {
    return text.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><])/g, "")
  }

  normalizePath(path) {
    if (!path) return ""
    return String(path).trim().replace(/\/+$/, "") || "/"
  }
}
