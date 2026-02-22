import { Controller } from "@hotwired/stimulus"

const TAG = "[DEBUG:terminal_settings]"
const DEBUG = false
const debug = (...args) => {
  if (DEBUG) console.log(TAG, ...args)
}

function checkIsDesktop() {
  return typeof window.desktopShell?.settings?.get === "function"
}

export default class extends Controller {
  static targets = [
    "modal",
    "terminalSelect",
    "currentLabel",
    "statusMessage"
  ]

  connect() {
    debug("connect", { isDesktop: checkIsDesktop() })
    this.installedTerminals = []
    this.currentMode = "system-default"

    if (checkIsDesktop()) {
      this.loadCurrentSettings()
    }
  }

  async loadCurrentSettings() {
    try {
      const [mode, installed] = await Promise.all([
        window.desktopShell.settings.get("terminalMode"),
        window.desktopShell.externalTerminal.detectInstalled()
      ])

      this.currentMode = mode || "system-default"
      this.installedTerminals = installed || []

      debug("loaded settings", { mode: this.currentMode, installed: this.installedTerminals })

      this.updateCurrentLabel()
      this.populateSelect()
    } catch (err) {
      debug("loadCurrentSettings failed", err)
    }
  }

  updateCurrentLabel() {
    if (!this.hasCurrentLabelTarget) return

    if (this.currentMode === "built-in") {
      this.currentLabelTarget.textContent = "Built-in"
    } else if (this.currentMode === "system-default") {
      this.currentLabelTarget.textContent = "System Default"
    } else {
      const terminal = this.installedTerminals.find((t) => t.id === this.currentMode)
      this.currentLabelTarget.textContent = terminal ? terminal.name : this.currentMode
    }
  }

  populateSelect() {
    if (!this.hasTerminalSelectTarget) return

    const select = this.terminalSelectTarget
    select.innerHTML = ""

    // Built-in option
    const builtInOption = document.createElement("option")
    builtInOption.value = "built-in"
    builtInOption.textContent = "Built-in Terminal (xterm.js)"
    select.appendChild(builtInOption)

    // System default option
    const defaultOption = document.createElement("option")
    defaultOption.value = "system-default"
    defaultOption.textContent = "System Default Terminal"
    select.appendChild(defaultOption)

    // Separator
    if (this.installedTerminals.length > 0) {
      const separator = document.createElement("option")
      separator.disabled = true
      separator.textContent = "──── Installed ────"
      select.appendChild(separator)
    }

    // Installed terminals
    for (const terminal of this.installedTerminals) {
      const option = document.createElement("option")
      option.value = terminal.id
      option.textContent = terminal.name
      select.appendChild(option)
    }

    select.value = this.currentMode
  }

  async openModal() {
    if (!checkIsDesktop()) {
      window.alert("Terminal settings are only available in the desktop app.")
      return
    }

    // Refresh the list before showing
    await this.loadCurrentSettings()

    if (this.hasModalTarget) {
      this.modalTarget.classList.remove("hidden")
      this.modalTarget.classList.add("flex")
    }
  }

  closeModal() {
    if (this.hasModalTarget) {
      this.modalTarget.classList.add("hidden")
      this.modalTarget.classList.remove("flex")
    }
  }

  backdropClose(event) {
    if (event.target === this.modalTarget) {
      this.closeModal()
    }
  }

  async saveSettings() {
    if (!this.hasTerminalSelectTarget) return

    const newMode = this.terminalSelectTarget.value
    debug("saveSettings", { newMode })

    try {
      const saved = await window.desktopShell.settings.set("terminalMode", newMode)
      if (saved) {
        this.currentMode = newMode
        this.updateCurrentLabel()
        this.showStatus("Settings saved!", "success")
        setTimeout(() => this.closeModal(), 800)
      } else {
        this.showStatus("Failed to save settings.", "error")
      }
    } catch (err) {
      debug("saveSettings failed", err)
      this.showStatus(`Error: ${err.message}`, "error")
    }
  }

  showStatus(message, type) {
    if (!this.hasStatusMessageTarget) return

    this.statusMessageTarget.textContent = message
    this.statusMessageTarget.className = type === "success"
      ? "text-[11px] font-mono text-green-600 mt-2"
      : "text-[11px] font-mono text-red-600 mt-2"

    setTimeout(() => {
      if (this.hasStatusMessageTarget) {
        this.statusMessageTarget.textContent = ""
      }
    }, 3000)
  }

  handleKeydown(event) {
    if (event.key === "Escape") {
      this.closeModal()
    }
  }
}
