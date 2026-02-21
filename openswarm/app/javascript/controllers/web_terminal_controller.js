import { Controller } from "@hotwired/stimulus"
import { Terminal } from "xterm"
import { FitAddon } from "@xterm/addon-fit"
import consumer from "cable_consumer"

const TAG = "[DEBUG:web_terminal]"

// ── Detect desktop mode (Electron with node-pty IPC) ──
const desktopTerminal = window.desktopShell?.terminal
const isDesktop = typeof desktopTerminal?.create === "function"

// ── Flow control: batch ack every N chars ──
const ACK_BATCH_SIZE = 5000

export default class extends Controller {
  static targets = ["panel", "terminal", "path", "shell", "status"]

  connect() {
    console.log(TAG, "connect", { isDesktop })
    this.subscription = null  // ActionCable subscription (browser mode)
    this.term = null
    this.fitAddon = null
    this.sessionId = null
    this.panelVisible = false
    this.unackedChars = 0     // renderer-side flow control counter
    this.ipcCleanups = []     // IPC listener cleanup functions

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
      console.log(TAG, "desktop mode: subscribing to IPC events")
      const offData = desktopTerminal.onData((sessionId, data) => {
        if (sessionId !== this.sessionId || !this.term) return
        if (this.unackedChars === 0) {
          console.log(TAG, "first terminal:data chunk", { sessionId, len: data.length, preview: data.slice(0, 80) })
        }
        this.term.write(data)

        // Flow control ACK
        this.unackedChars += data.length
        if (this.unackedChars >= ACK_BATCH_SIZE) {
          console.log(TAG, "sending ACK", { sessionId, charCount: this.unackedChars })
          desktopTerminal.ack(sessionId, this.unackedChars)
          this.unackedChars = 0
        }
      })

      const offExit = desktopTerminal.onExit((sessionId, _exitCode) => {
        if (sessionId !== this.sessionId) return
        console.log(TAG, "received terminal:exit", { sessionId })
        this.statusTarget.textContent = "exited"
        this.sessionId = null
      })

      this.ipcCleanups.push(offData, offExit)
    }
  }

  disconnect() {
    console.log(TAG, "disconnect")
    window.removeEventListener("worktree:open-terminal", this.openHandler)
    window.removeEventListener("worktree:toggle-terminal", this.toggleHandler)
    window.removeEventListener("resize", this.resizeHandler)
    document.removeEventListener("keydown", this.escapeHandler)

    this.ipcCleanups.forEach((fn) => fn())
    this.ipcCleanups = []

    this.destroyTerminal()
  }

  // ── Show / hide without destroying the PTY ──

  showPanel() {
    console.log(TAG, "showPanel")
    this.panelTarget.classList.remove("hidden")
    this.panelVisible = true

    requestAnimationFrame(() => {
      if (this.fitAddon && this.term) {
        this.fitAddon.fit()
        this.term.focus()
      }
    })
  }

  hidePanel() {
    console.log(TAG, "hidePanel")
    this.panelTarget.classList.add("hidden")
    this.panelVisible = false
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

  backdropClose(event) {
    if (event.target === this.panelTarget) {
      this.hidePanel()
    }
  }

  // ── Open a new terminal session (or re-show existing) ──

  openFromEvent(event) {
    const payload = event.detail || {}
    console.log(TAG, "openFromEvent", payload)

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
    const path = payload.path
    if (!path) {
      console.error(TAG, "_openDesktopTerminal missing path", payload)
      return
    }

    console.log(TAG, "_openDesktopTerminal", { path, existingSessionId: this.sessionId })

    // If we already have a live session, just re-show
    if (this.sessionId) {
      console.log(TAG, "session already exists; re-show panel", { sessionId: this.sessionId })
      this.showPanel()
      return
    }

    this.destroyTerminal()

    this.pathTarget.textContent = path
    this.statusTarget.textContent = "creating"

    this.showPanel()
    this.setupTerminal()

    const cols = this.term?.cols || 80
    const rows = this.term?.rows || 24
    console.log(TAG, "creating desktop terminal", { path, cols, rows })

    try {
      const result = await desktopTerminal.create({ cwd: path, cols, rows })
      console.log(TAG, "desktopTerminal.create result", result)
      this.sessionId = result.sessionId
      this.shellTarget.textContent = result.shell
      this.statusTarget.textContent = "connected"

      // Wire input: keystrokes -> IPC -> PTY
      this.term.onData((data) => {
        if (!this.sessionId) return
        if (data && data.trim()) {
          console.log(TAG, "term.onData (user input)", { len: data.length, preview: data.slice(0, 60) })
        }
        desktopTerminal.write(this.sessionId, data)
      })

      // Wire resize: xterm resize -> IPC -> PTY
      this.term.onResize(({ cols, rows }) => {
        if (!this.sessionId) return
        console.log(TAG, "term.onResize", { sessionId: this.sessionId, cols, rows })
        desktopTerminal.resize(this.sessionId, cols, rows)
      })

      this.term.focus()
    } catch (err) {
      this.statusTarget.textContent = "error"
      console.error("Failed to create desktop terminal:", err)
    }
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
  }

  handleEscape(event) {
    if (event.key === "Escape" && this.panelVisible) {
      this.hidePanel()
    }
  }

  // ── Terminal setup (shared between desktop and browser) ──

  setupTerminal() {
    console.log(TAG, "setupTerminal")
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
              this.term.write(this.decodeBase64(message.data || ""))
            } else {
              this.term.write(message.data || "")
            }
          } else if (message.type === "closed") {
            this.statusTarget.textContent = "closed"
            this.sessionId = null
          }
        }
      }
    )

    // Wire input for browser mode
    this.term.onData((data) => {
      if (!this.subscription) return
      this.subscription.perform("input", { data })
    })

    this.term.onResize(({ cols, rows }) => {
      if (!this.subscription) return
      this.subscription.perform("resize", { cols, rows })
    })
  }

  resizeTerminal() {
    if (!this.term || !this.fitAddon) return

    this.fitAddon.fit()

    if (isDesktop && this.sessionId) {
      console.log(TAG, "resizeTerminal -> desktop resize", { sessionId: this.sessionId, cols: this.term.cols, rows: this.term.rows })
      desktopTerminal.resize(this.sessionId, this.term.cols, this.term.rows)
    } else if (this.subscription) {
      this.subscription.perform("resize", { cols: this.term.cols, rows: this.term.rows })
    }
  }

  // ── Cleanup ──

  disconnectSubscription() {
    if (!this.subscription) return

    this.subscription.perform("close")
    this.subscription.unsubscribe()
    this.subscription = null
    this.sessionId = null
  }

  destroyTerminal() {
    console.log(TAG, "destroyTerminal", { isDesktop, sessionId: this.sessionId })
    // Desktop: kill PTY via IPC
    if (isDesktop && this.sessionId) {
      desktopTerminal.kill(this.sessionId)
    }

    this.disconnectSubscription()
    this.sessionId = null
    this.unackedChars = 0

    if (this.term) {
      this.term.dispose()
      this.term = null
      this.fitAddon = null
      this.terminalTarget.innerHTML = ""
    }
  }

  killTerminal() {
    this.hidePanel()
    this.destroyTerminal()
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
}
