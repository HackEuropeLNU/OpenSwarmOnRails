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
const OPENCODE_SPINNER_REGEX = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/
const OPENCODE_IDLE_TIMEOUT_MS = 1500
const SHELL_PROMPT_REGEX = /(?:\r?\n|^)[^\r\n]*[%$#] $/

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
    this.activityTimeoutId = null
    this.isBackgroundBusy = false
    this.trackingOpencode = false
    this.inputBuffer = ""
    this.outputTail = ""
    this.textDecoder = new TextDecoder()

    this.openHandler = this.openFromEvent.bind(this)
    this.resizeHandler = this.resizeTerminal.bind(this)
    this.escapeHandler = this.handleEscape.bind(this)
    this.toggleHandler = this.togglePanel.bind(this)

    window.addEventListener("worktree:open-terminal", this.openHandler)
    window.addEventListener("worktree:toggle-terminal", this.toggleHandler)
    window.addEventListener("resize", this.resizeHandler)
    document.addEventListener("keydown", this.escapeHandler)

    // Desktop: subscribe to PTY events globally
    if (isDesktop) {
      debug("desktop mode: subscribing to IPC events")
      const offData = desktopTerminal.onData((sessionId, data) => {
        if (!this.term) return

        const activeSessionMatch = Boolean(this.sessionId) && sessionId === this.sessionId
        const pendingSessionMatch = !this.sessionId && this.acceptDesktopDataBeforeSessionId &&
          (!this.pendingDesktopSessionId || this.pendingDesktopSessionId === sessionId)

        if (!activeSessionMatch && !pendingSessionMatch) return

        if (!this.sessionId && pendingSessionMatch && !this.pendingDesktopSessionId) {
          this.pendingDesktopSessionId = sessionId
        }

        if (this.unackedChars === 0) {
          debug("first terminal:data chunk", { sessionId, len: data.length, preview: data.slice(0, 80) })
        }
        this.recordOutputActivity(data)
        this.term.write(data)

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

        if (sessionId !== this.sessionId) return
        debug("received terminal:exit", { sessionId })
        this.statusTarget.textContent = "exited"
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

    this.ipcCleanups.forEach((fn) => fn())
    this.ipcCleanups = []

    this.destroyTerminal({ killRemote: false, closeRemoteBrowser: false })
    this.clearBackgroundActivity()
    this.updateBackgroundIndicator()
    document.documentElement.classList.remove("overflow-hidden")
  }

  // ── Show / hide without destroying the PTY ──

  showPanel() {
    debug("showPanel")
    this.panelTarget.classList.remove("hidden")
    this.panelVisible = true
    document.documentElement.classList.add("overflow-hidden")
    this.updateBackgroundIndicator()

    requestAnimationFrame(() => {
      this.resizeTerminal()
      if (this.term) this.term.focus()
    })

    // Layout can settle a frame later after un-hiding; refit once more.
    window.setTimeout(() => this.resizeTerminal(), 40)
  }

  hidePanel() {
    debug("hidePanel")
    this.panelTarget.classList.add("hidden")
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
      this.showPanel()
      this.setupTerminal()
      this.attachDesktopTerminalHandlers()
      this.term.focus()
      this.resizeTerminal()
      this.updateBackgroundIndicator()
      return
    }

    this.destroyTerminal({ killRemote: false, closeRemoteBrowser: false })
    this.acceptDesktopDataBeforeSessionId = true
    this.pendingDesktopSessionId = null

    this.pathTarget.textContent = path
    this.statusTarget.textContent = "creating"

    this.showPanel()
    this.setupTerminal()

    const cols = this.term?.cols || 80
    const rows = this.term?.rows || 24
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
      this.shellTarget.textContent = result.shell
      this.statusTarget.textContent = "connected"
      this.desktopSessionsByPath.set(path, { sessionId: result.sessionId, shell: result.shell })
      this.desktopPathBySessionId.set(result.sessionId, path)

      this.attachDesktopTerminalHandlers()

      this.term.focus()
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
      this.trackInputForOpencode(data)
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

    this.showPanel()
    this.setupTerminal()
    this.connectSubscription(payload.session_id)
    this.updateBackgroundIndicator()
  }

  handleEscape(event) {
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
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      convertEol: false,
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
          if (!this.term) return

          if (message.type === "output") {
            if (message.encoding === "base64") {
              const bytes = this.decodeBase64(message.data || "")
              const text = this.textDecoder.decode(bytes)
              this.recordOutputActivity(text)
              this.term.write(bytes)
            } else {
              const text = message.data || ""
              this.recordOutputActivity(text)
              this.term.write(text)
            }
          } else if (message.type === "closed") {
            this.statusTarget.textContent = "closed"
            this.sessionId = null
            this.resetOpencodeTracking()
            this.updateBackgroundIndicator()
          }
        }
      }
    )

    // Wire input for browser mode
    this.term.onData((data) => {
      if (!this.subscription) return
      this.trackInputForOpencode(data)
      this.subscription.perform("input", { data })
    })

    this.term.onResize(({ cols, rows }) => {
      if (!this.subscription) return
      this.subscription.perform("resize", { cols, rows })
    })
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
    const previousSessionId = this.sessionId
    const previousPath = this.activePath

    // Desktop: kill PTY via IPC
    if (killRemote && isDesktop && previousSessionId) {
      desktopTerminal.kill(previousSessionId)
      const mappedPath = this.desktopPathBySessionId.get(previousSessionId) || previousPath
      if (mappedPath) this.desktopSessionsByPath.delete(mappedPath)
      this.desktopPathBySessionId.delete(previousSessionId)
    }

    this.disconnectSubscription({ closeRemote: closeRemoteBrowser })
    this.sessionId = null
    this.activePath = null
    this.unackedChars = 0
    this.acceptDesktopDataBeforeSessionId = false
    this.pendingDesktopSessionId = null
    if (!this.panelVisible) {
      document.documentElement.classList.remove("overflow-hidden")
    }
    this.resetOpencodeTracking()
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

  traceActionClick(event) {
    const message = event?.detail?.message || "click (unknown-action)"
    console.log(TAG, message)
    if (!this.term) return
    this.term.writeln(`\r\n${message}`)
  }

  trackInputForOpencode(data) {
    if (!data) return

    for (const char of data) {
      if (char === "\u0003") {
        this.resetOpencodeTracking()
        continue
      }

      if (char === "\r" || char === "\n") {
        const command = this.inputBuffer.trim()
        if (command.startsWith("opencode")) {
          this.trackingOpencode = true
          this.outputTail = ""
          this.clearBackgroundActivity()
          this.updateBackgroundIndicator()
        }
        this.inputBuffer = ""
        continue
      }

      if (char === "\u007f" || char === "\b") {
        this.inputBuffer = this.inputBuffer.slice(0, -1)
        continue
      }

      if (char >= " " && char <= "~") {
        this.inputBuffer += char
      }
    }
  }

  recordOutputActivity(text) {
    if (!this.trackingOpencode || !text) return

    this.outputTail += text
    if (this.outputTail.length > 2048) {
      this.outputTail = this.outputTail.slice(-2048)
    }

    if (SHELL_PROMPT_REGEX.test(this.outputTail)) {
      this.clearBackgroundActivity()
      this.trackingOpencode = false
      this.outputTail = ""
      this.updateBackgroundIndicator()
      return
    }

    if (!OPENCODE_SPINNER_REGEX.test(text)) return

    this.isBackgroundBusy = true
    this.startSpinner()
    this.updateBackgroundIndicator()

    if (this.activityTimeoutId) {
      clearTimeout(this.activityTimeoutId)
    }

    this.activityTimeoutId = setTimeout(() => {
      this.isBackgroundBusy = false
      this.stopSpinner()
      this.trackingOpencode = false
      this.outputTail = ""
      this.updateBackgroundIndicator()
    }, OPENCODE_IDLE_TIMEOUT_MS)
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

  clearBackgroundActivity() {
    this.isBackgroundBusy = false
    this.stopSpinner()
    if (this.activityTimeoutId) {
      clearTimeout(this.activityTimeoutId)
      this.activityTimeoutId = null
    }
  }

  resetOpencodeTracking() {
    this.trackingOpencode = false
    this.inputBuffer = ""
    this.outputTail = ""
    this.clearBackgroundActivity()
  }

  updateBackgroundIndicator() {
    if (!this.hasBackgroundIndicatorTarget) return

    const shouldShow = Boolean(this.sessionId) && !this.panelVisible
    this.backgroundIndicatorTarget.classList.toggle("hidden", !shouldShow)

    if (!this.hasBackgroundLabelTarget) return
    this.backgroundLabelTarget.textContent = this.isBackgroundBusy ? "opencode running" : "terminal idle"
  }

  normalizePath(path) {
    if (!path) return ""
    return String(path).trim().replace(/\/+$/, "") || "/"
  }
}
