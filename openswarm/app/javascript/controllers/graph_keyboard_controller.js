import { Controller } from "@hotwired/stimulus"

const TAG = "[DEBUG:graph_keyboard]"
const DEBUG = false
const debug = (...args) => {
  if (DEBUG) console.log(TAG, ...args)
}

// Handles keyboard navigation and node selection for the worktree graph.
export default class extends Controller {
  static targets = [
    "canvas",
    "node",
    "details",
    "createModal",
    "createInput",
    "createParent",
    "createReplace",
    "deleteModal",
    "deleteBranch",
    "deleteDirty",
    "deleteForce"
  ]

  static values = {
    selected: String,
    openProjectUrl: String,
    createUrl: String,
    deleteUrl: String,
    openUrl: String,
    repo: String
  }

  connect() {
    debug("connect", {
      nodeCount: this.nodeTargets.length,
      selected: this.selectedValue,
      isDesktop: typeof window.desktopShell?.terminal?.create === "function"
    })
    this.boundKeydown = this.handleKeydown.bind(this)
    document.addEventListener("keydown", this.boundKeydown)
    this.pendingSelectTimeout = null
    this.pendingCreateParentId = null
    this.pendingDeleteWorktreeId = null
    this.highlightSelected()
  }

  disconnect() {
    document.removeEventListener("keydown", this.boundKeydown)
    this.clearPendingSelect()
  }

  handleKeydown(event) {
    if (this.isModalOpen()) {
      if (event.key === "Escape") {
        event.preventDefault()
        this.closeDialogs()
      }
      return
    }

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
      case "d":
        event.preventDefault()
        this.deleteSelected()
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
    this.traceAction("select-node")
    const button = event.currentTarget
    const nodeId = button.dataset.nodeId
    if (!nodeId) return

    this.clearPendingSelect()
    this.pendingSelectTimeout = window.setTimeout(() => {
      this.pendingSelectTimeout = null
      if (nodeId !== this.selectedValue) {
        this.navigateToNode(nodeId)
      }
    }, 220)
  }

  async openNodeTerminal(event) {
    this.traceAction("open-terminal")
    const button = event.currentTarget
    const nodeId = button.dataset.nodeId
    if (!nodeId) return

    this.clearPendingSelect()
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
    this.traceAction("refresh")
    Turbo.visit(window.location.href, { action: "replace" })
  }

  async openProjectPicker() {
    this.traceAction("open-project")

    if (!this.openProjectUrlValue) {
      window.alert("Open project is not configured on this page")
      return
    }

    const pickGitRepo = window.desktopShell?.pickGitRepo
    if (typeof pickGitRepo !== "function") {
      window.alert("Open project picker is available in the desktop app")
      return
    }

    const selection = await pickGitRepo()
    if (selection?.error) {
      window.alert(selection.error)
      return
    }
    if (!selection?.path) return

    const csrfToken = document
      .querySelector("meta[name='csrf-token']")
      ?.getAttribute("content")

    try {
      const response = await fetch(this.openProjectUrlValue, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({ repo_root: selection.path })
      })

      const payload = await this.parseJsonResponse(response)
      if (!response.ok) {
        window.alert(payload.error || payload.raw || "Failed to open project")
        return
      }

      if (payload.redirect_url) {
        Turbo.visit(payload.redirect_url, { action: "replace" })
      } else {
        this.refresh()
      }
    } catch (error) {
      window.alert(error?.message || "Failed to open project")
    }
  }

  openSelectedTerminal() {
    this.traceAction("open-terminal")
    // If a terminal session is already alive (hidden in background), toggle it back
    const termPanel = document.querySelector("[data-web-terminal-target='panel']")
    const termStatus = document.querySelector("[data-web-terminal-target='status']")
    const isAlive = termStatus &&
      !["idle", "closed"].includes(termStatus.textContent.trim()) &&
      termPanel?.classList.contains("hidden")

    if (isAlive) {
      debug("openSelectedTerminal -> toggling alive hidden terminal")
      window.dispatchEvent(new CustomEvent("worktree:toggle-terminal"))
      return
    }

    const selectedNode = this.nodeTargets.find(
      (node) => node.dataset.nodeId === this.selectedValue
    )

    if (!selectedNode) return
    debug("openSelectedTerminal -> opening selected node", { nodeId: selectedNode.dataset.nodeId })
    this.openTerminal(selectedNode.dataset.nodeId)
  }

  createFromSelected() {
    this.traceAction("open-create-dialog")
    const selectedNode = this.nodeTargets.find(
      (node) => node.dataset.nodeId === this.selectedValue
    )

    if (!selectedNode) return
    this.openCreateDialog(selectedNode.dataset.nodeId, selectedNode.dataset.branch)
  }

  createFromNode(event) {
    event?.preventDefault?.()
    event?.stopPropagation?.()
    this.traceAction("open-create-dialog")

    const button = event.currentTarget
    const parentId = button.dataset.parentId
    const parentBranch = button.dataset.parentBranch || "this branch"

    this.openCreateDialog(parentId, parentBranch)
  }

  openCreateDialog(parentId, parentBranch) {
    if (!parentId) return

    this.pendingCreateParentId = parentId
    this.createParentTarget.textContent = parentBranch || "this branch"
    this.createInputTarget.value = ""
    if (this.hasCreateReplaceTarget) {
      this.createReplaceTarget.checked = false
    }
    this.createModalTarget.classList.remove("hidden")
    this.createInputTarget.focus()
  }

  cancelCreate(event) {
    event?.preventDefault?.()
    this.closeDialogs()
  }

  async submitCreate(event) {
    event.preventDefault()
    this.traceAction("submit-create")

    const parentId = this.pendingCreateParentId
    const trimmedName = this.createInputTarget.value.trim()

    if (!parentId || !trimmedName) return
    
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
          name: trimmedName,
          replace_existing: this.hasCreateReplaceTarget ? this.createReplaceTarget.checked : false,
          force_replace: this.hasCreateReplaceTarget ? this.createReplaceTarget.checked : false
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

      this.closeDialogs()
      Turbo.visit(payload.redirect_url, { action: "replace" })
    } catch (error) {
      console.error("Worktree create request threw", error)
      window.alert(error?.message || "Failed to create worktree")
    }
  }

  deleteSelected() {
    this.traceAction("open-delete-dialog")
    const selectedNode = this.nodeTargets.find(
      (node) => node.dataset.nodeId === this.selectedValue
    )

    if (!selectedNode) return
    this.openDeleteDialog(selectedNode)
  }

  openDeleteDialog(node) {
    const worktreeId = node.dataset.nodeId
    if (!worktreeId) return

    const branch = node.dataset.branch || "this worktree"
    const dirty = node.dataset.dirty === "true"

    this.pendingDeleteWorktreeId = worktreeId
    this.deleteBranchTarget.textContent = branch
    this.deleteDirtyTarget.textContent = dirty ? "yes" : "no"
    this.deleteForceTarget.checked = false
    this.deleteModalTarget.classList.remove("hidden")
  }

  cancelDelete(event) {
    event?.preventDefault?.()
    this.closeDialogs()
  }

  async submitDelete(event) {
    event.preventDefault()
    this.traceAction("submit-delete")

    const worktreeId = this.pendingDeleteWorktreeId
    if (!worktreeId || !this.deleteUrlValue || !this.repoValue) return

    const csrfToken = document
      .querySelector("meta[name='csrf-token']")
      ?.getAttribute("content")

    try {
      const response = await fetch(this.deleteUrlValue, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({
          repo: this.repoValue,
          worktree_id: worktreeId,
          force: this.deleteForceTarget.checked
        })
      })

      const payload = await this.parseJsonResponse(response)
      if (!response.ok) {
        const message = payload.error || payload.raw || `Failed to delete worktree (${response.status})`
        console.error("Worktree delete request failed", {
          status: response.status,
          statusText: response.statusText,
          payload
        })
        window.alert(message)
        return
      }

      if (!payload.redirect_url) {
        console.error("Worktree delete missing redirect_url", payload)
        window.alert("Worktree deleted but response was incomplete")
        return
      }

      this.closeDialogs()
      Turbo.visit(payload.redirect_url, { action: "replace" })
    } catch (error) {
      console.error("Worktree delete request threw", error)
      window.alert(error?.message || "Failed to delete worktree")
    }
  }

  closeDialogs() {
    this.createModalTarget.classList.add("hidden")
    this.deleteModalTarget.classList.add("hidden")
    this.pendingCreateParentId = null
    this.pendingDeleteWorktreeId = null
  }

  closeDialogBackdrop(event) {
    if (event.target === event.currentTarget) {
      this.closeDialogs()
    }
  }

  isModalOpen() {
    return !this.createModalTarget.classList.contains("hidden") ||
      !this.deleteModalTarget.classList.contains("hidden")
  }

  traceAction(action) {
    if (!DEBUG) return
    debug(`click (${action})`)
  }

  clearPendingSelect() {
    if (!this.pendingSelectTimeout) return

    window.clearTimeout(this.pendingSelectTimeout)
    this.pendingSelectTimeout = null
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
    debug("openTerminal called", { worktreeId, isDesktop })
    if (isDesktop) {
      const node = this.nodeTargets.find((n) => n.dataset.nodeId === worktreeId)
      const path = node?.dataset.path
      debug("desktop path lookup", { foundNode: !!node, path })
      if (!path) {
        console.error(TAG, "desktop path missing for node", { worktreeId })
        return
      }

      window.dispatchEvent(
        new CustomEvent("worktree:open-terminal", {
          detail: { path }
        })
      )
      debug("dispatched worktree:open-terminal", { path })
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
      debug("browser open terminal success", payload)
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
