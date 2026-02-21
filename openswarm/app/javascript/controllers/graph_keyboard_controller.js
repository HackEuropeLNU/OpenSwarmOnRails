import { Controller } from "@hotwired/stimulus"

const TAG = "[DEBUG:graph_keyboard]"

// Handles keyboard navigation and node selection for the worktree graph.
export default class extends Controller {
  static targets = ["canvas", "node", "details"]
  static values = { selected: String, createUrl: String, openUrl: String, repo: String }

  connect() {
    console.log(TAG, "connect", {
      nodeCount: this.nodeTargets.length,
      selected: this.selectedValue,
      isDesktop: typeof window.desktopShell?.terminal?.create === "function"
    })
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
      case "a":
        event.preventDefault()
        this.createFromSelected()
        break
      case "o":
        event.preventDefault()
        this.openSelectedTerminal()
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

  async selectNode(event) {
    const button = event.currentTarget
    const nodeId = button.dataset.nodeId
    if (!nodeId) return

    await this.openTerminal(nodeId)
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

  openSelectedTerminal() {
    // If a terminal session is already alive (hidden in background), toggle it back
    const termPanel = document.querySelector("[data-web-terminal-target='panel']")
    const termStatus = document.querySelector("[data-web-terminal-target='status']")
    const isAlive = termStatus &&
      !["idle", "closed"].includes(termStatus.textContent.trim()) &&
      termPanel?.classList.contains("hidden")

    if (isAlive) {
      console.log(TAG, "openSelectedTerminal -> toggling alive hidden terminal")
      window.dispatchEvent(new CustomEvent("worktree:toggle-terminal"))
      return
    }

    const selectedNode = this.nodeTargets.find(
      (node) => node.dataset.nodeId === this.selectedValue
    )

    if (!selectedNode) return
    console.log(TAG, "openSelectedTerminal -> opening selected node", { nodeId: selectedNode.dataset.nodeId })
    this.openTerminal(selectedNode.dataset.nodeId)
  }

  createFromSelected() {
    const selectedNode = this.nodeTargets.find(
      (node) => node.dataset.nodeId === this.selectedValue
    )

    if (!selectedNode) return

    const createButton = selectedNode.parentElement?.querySelector(".node-create-btn")
    if (createButton) {
      this.createFromNode({ currentTarget: createButton })
    }
  }

  async createFromNode(event) {
    const button = event.currentTarget
    const parentId = button.dataset.parentId
    const parentBranch = button.dataset.parentBranch || "this branch"

    const name = window.prompt(`New worktree name from ${parentBranch}:`)
    if (name === null) return

    const trimmedName = name.trim()
    if (!trimmedName) return
    if (!this.createUrlValue || !this.repoValue || !parentId) return

    const csrfToken = document
      .querySelector("meta[name='csrf-token']")
      ?.getAttribute("content")

    button.disabled = true

    try {
      const response = await fetch(this.createUrlValue, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({
          repo: this.repoValue,
          parent_id: parentId,
          name: trimmedName
        })
      })

      const payload = await response.json()
      if (!response.ok) {
        window.alert(payload.error || "Failed to create worktree")
        return
      }

      Turbo.visit(payload.redirect_url, { action: "replace" })
    } catch (_error) {
      window.alert("Failed to create worktree")
    } finally {
      button.disabled = false
    }
  }

  async openTerminal(worktreeId) {
    if (!worktreeId) return

    // Desktop mode: resolve path from DOM and open PTY directly (skip Rails PTY)
    const isDesktop = typeof window.desktopShell?.terminal?.create === "function"
    console.log(TAG, "openTerminal called", { worktreeId, isDesktop })
    if (isDesktop) {
      const node = this.nodeTargets.find((n) => n.dataset.nodeId === worktreeId)
      const path = node?.dataset.path
      console.log(TAG, "desktop path lookup", { foundNode: !!node, path })
      if (!path) {
        console.error(TAG, "desktop path missing for node", { worktreeId })
        return
      }

      window.dispatchEvent(
        new CustomEvent("worktree:open-terminal", {
          detail: { path }
        })
      )
      console.log(TAG, "dispatched worktree:open-terminal", { path })
      return
    }

    // Browser mode: hit Rails endpoint to spawn PTY via WebTerminalService
    if (!this.openUrlValue || !this.repoValue) return

    const csrfToken = document
      .querySelector("meta[name='csrf-token']")
      ?.getAttribute("content")

    try {
      const response = await fetch(this.openUrlValue, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({
          repo: this.repoValue,
          worktree_id: worktreeId
        })
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        console.error(TAG, "browser open terminal failed", { status: response.status, payload })
        window.alert(payload.error || "Failed to open terminal")
        return
      }

      const payload = await response.json().catch(() => ({}))
      console.log(TAG, "browser open terminal success", payload)
      window.dispatchEvent(
        new CustomEvent("worktree:open-terminal", {
          detail: payload
        })
      )
    } catch (_error) {
      window.alert("Failed to open terminal")
    }
  }
}
