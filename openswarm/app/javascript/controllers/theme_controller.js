import { Controller } from "@hotwired/stimulus"

export default class extends Controller {
  static targets = ["root", "toggleLabel"]

  connect() {
    this.storageKey = "openswarm-theme"
    this.applyTheme(this.resolveInitialTheme())
  }

  toggle() {
    const nextTheme = this.currentTheme() === "dark" ? "light" : "dark"
    this.applyTheme(nextTheme)
  }

  resolveInitialTheme() {
    const savedTheme = window.localStorage.getItem(this.storageKey)
    if (savedTheme === "dark" || savedTheme === "light") {
      return savedTheme
    }

    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  }

  currentTheme() {
    return document.documentElement.dataset.theme === "dark" ? "dark" : "light"
  }

  applyTheme(theme) {
    const isDark = theme === "dark"

    document.documentElement.classList.toggle("dark", isDark)
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem(this.storageKey, theme)

    if (this.hasRootTarget) {
      this.rootTarget.dataset.theme = theme
    }

    if (this.hasToggleLabelTarget) {
      this.toggleLabelTarget.textContent = isDark ? "light" : "dark"
    }
  }
}
