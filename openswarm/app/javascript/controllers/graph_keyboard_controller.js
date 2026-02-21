import { Controller } from "@hotwired/stimulus"

// Handles keyboard navigation and node selection for the worktree graph.
export default class extends Controller {
  static targets = ["canvas", "node", "details"]
  static values = { selected: String, createUrl: String, openUrl: String, repo: String }

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
      window.dispatchEvent(new CustomEvent("worktree:toggle-terminal"))
      return
    }

    const selectedNode = this.nodeTargets.find(
      (node) => node.dataset.nodeId === this.selectedValue
    )

    if (!selectedNode) return
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
    event?.preventDefault?.()
    event?.stopPropagation?.()

    const button = event.currentTarget
    const parentId = button.dataset.parentId
    const parentBranch = button.dataset.parentBranch || "this branch"

    const name = window.prompt(`New worktree name from ${parentBranch}:`)
    if (name === null) return

    const trimmedName = name.trim()
    if (!trimmedName) return
    if (!this.createUrlValue || !this.repoValue || !parentId) {
      console.error("Missing create-worktree params", {
        createUrl: this.createUrlValue,
        repo: this.repoValue,
        parentId
      })
      window.alert("Worktree creation is not configured on this page")
      return
    }

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

      const payload = await this.parseJsonResponse(response)
      if (!response.ok) {
        const message = payload.error || payload.raw || `Failed to create worktree (${response.status})`
        console.error("Worktree create request failed", {
          status: response.status,
          statusText: response.statusText,
          payload
        })
        window.alert(message)
        return
      }

      if (!payload.redirect_url) {
        console.error("Worktree create missing redirect_url", payload)
        window.alert("Worktree created but response was incomplete")
        return
      }

      Turbo.visit(payload.redirect_url, { action: "replace" })
    } catch (error) {
      console.error("Worktree create request threw", error)
      window.alert(error?.message || "Failed to create worktree")
    } finally {
      button.disabled = false
    }
  }

  async parseJsonResponse(response) {
    const raw = await response.text()
    if (!raw) return {}

    try {
      return JSON.parse(raw)
    } catch (_error) {
      return { raw }
    }
  }

  async openTerminal(worktreeId) {
    if (!worktreeId) return

    // Desktop mode: resolve path from DOM and open PTY directly (skip Rails PTY)
    const isDesktop = typeof window.desktopShell?.terminal?.create === "function"
    if (isDesktop) {
      const node = this.nodeTargets.find((n) => n.dataset.nodeId === worktreeId)
      const path = node?.dataset.path
      if (!path) return

      window.dispatchEvent(
        new CustomEvent("worktree:open-terminal", {
          detail: { path }
        })
      )
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
        window.alert(payload.error || "Failed to open terminal")
        return
      }

      const payload = await response.json().catch(() => ({}))
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
