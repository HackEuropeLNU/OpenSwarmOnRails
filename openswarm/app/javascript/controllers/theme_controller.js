import { Controller } from "@hotwired/stimulus"

// Controls dark/light theme toggle.
// For the Codex-inspired premium look, dark is the default and primary mode.
export default class extends Controller {
  static targets = ["root"]

  connect() {
    this.theme = localStorage.getItem("openswarm-theme") || "dark"
    this.apply()
  }

  toggle() {
    this.theme = this.theme === "dark" ? "light" : "dark"
    localStorage.setItem("openswarm-theme", this.theme)
    this.apply()
  }

  apply() {
    // For now, dark mode is the only fully styled mode.
    // Theme switching would require server-side re-render or extensive CSS custom properties.
    document.documentElement.classList.toggle("dark", this.theme === "dark")
  }
}
