import { Controller } from "@hotwired/stimulus"

// Handles keyboard navigation and node selection for the worktree graph.
export default class extends Controller {
  static targets = ["canvas", "node", "details"]
  static values = { selected: String }

  connect() {
    this.boundKeydown = this.handleKeydown.bind(this)
    document.addEventListener("keydown", this.boundKeydown)
    this.highlightSelected()
  }

  disconnect() {
    document.removeEventListener("keydown", this.boundKeydown)
  }

  handleKeydown(event) {
    // Skip if user is typing in an input
    const tag = event.target.tagName
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return

    switch (event.key) {
      case "j":
        event.preventDefault()
        this.moveSelection(1)
        break
      case "k":
        event.preventDefault()
        this.moveSelection(-1)
        break
      case "r":
        if (!event.ctrlKey && !event.metaKey) {
          event.preventDefault()
          this.refresh()
        }
        break
    }
  }

  moveSelection(direction) {
    const nodes = this.nodeTargets
    if (nodes.length === 0) return

    const currentIndex = nodes.findIndex(
      (n) => n.dataset.nodeId === this.selectedValue
    )
    const nextIndex = Math.min(
      nodes.length - 1,
      Math.max(0, currentIndex + direction)
    )

    const newId = nodes[nextIndex].dataset.nodeId
    if (newId !== this.selectedValue) {
      this.navigateToNode(newId)
    }
  }

  selectNode(event) {
    const button = event.currentTarget
    const nodeId = button.dataset.nodeId
    if (nodeId && nodeId !== this.selectedValue) {
      this.navigateToNode(nodeId)
    }
  }

  navigateToNode(nodeId) {
    const url = new URL(window.location)
    url.searchParams.set("selected", nodeId)
    Turbo.visit(url.toString(), { action: "replace" })
  }

  highlightSelected() {
    this.nodeTargets.forEach((node) => {
      const inner = node.querySelector("div")
      if (!inner) return

      const isSelected = node.dataset.nodeId === this.selectedValue
      if (isSelected) {
        inner.classList.add("node-glow-selected", "ring-1", "ring-blue-200", "border-blue-400")
      }
    })
  }

  refresh() {
    Turbo.visit(window.location.href, { action: "replace" })
  }
}
