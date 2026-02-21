import { Controller } from "@hotwired/stimulus"
import { Terminal } from "xterm"
import { FitAddon } from "@xterm/addon-fit"
import consumer from "../cable_consumer"

export default class extends Controller {
  static targets = ["panel", "terminal", "path", "shell", "status"]

  connect() {
    this.subscription = null
    this.term = null
    this.fitAddon = null
    this.sessionId = null
    this.panelVisible = false

    this.openHandler = this.openFromEvent.bind(this)
    this.resizeHandler = this.resizeTerminal.bind(this)
    this.escapeHandler = this.handleEscape.bind(this)
    this.toggleHandler = this.togglePanel.bind(this)

    window.addEventListener("worktree:open-terminal", this.openHandler)
    window.addEventListener("worktree:toggle-terminal", this.toggleHandler)
    window.addEventListener("resize", this.resizeHandler)
    document.addEventListener("keydown", this.escapeHandler)
  }

  disconnect() {
    window.removeEventListener("worktree:open-terminal", this.openHandler)
    window.removeEventListener("worktree:toggle-terminal", this.toggleHandler)
    window.removeEventListener("resize", this.resizeHandler)
    document.removeEventListener("keydown", this.escapeHandler)
    this.destroyTerminal()
  }

  // ── Show / hide without destroying the PTY ──

  showPanel() {
    this.panelTarget.classList.remove("hidden")
    this.panelVisible = true

    // Re-fit after CSS transition reveals the element
    requestAnimationFrame(() => {
      if (this.fitAddon && this.term) {
        this.fitAddon.fit()
        this.term.focus()
      }
    })
  }

  hidePanel() {
    this.panelTarget.classList.add("hidden")
    this.panelVisible = false
  }

  togglePanel() {
    if (this.panelVisible) {
      this.hidePanel()
    } else if (this.sessionId) {
      // Only toggle back if there is a live session
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
    if (!payload.session_id) return

    // If we already have this session, just re-show
    if (this.sessionId === payload.session_id) {
      this.showPanel()
      return
    }

    // Tear down any previous session before opening a new one
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

  // ── Terminal setup ──

  setupTerminal() {
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

    this.term.onData((data) => {
      if (!this.subscription) return
      this.subscription.perform("input", { data })
    })

    this.term.onResize(({ cols, rows }) => {
      if (!this.subscription) return
      this.subscription.perform("resize", { cols, rows })
    })
  }

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
  }

  resizeTerminal() {
    if (!this.term || !this.fitAddon || !this.subscription) return

    this.fitAddon.fit()
    this.subscription.perform("resize", { cols: this.term.cols, rows: this.term.rows })
  }

  disconnectSubscription() {
    if (!this.subscription) return

    this.subscription.perform("close")
    this.subscription.unsubscribe()
    this.subscription = null
    this.sessionId = null
  }

  destroyTerminal() {
    this.disconnectSubscription()

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
