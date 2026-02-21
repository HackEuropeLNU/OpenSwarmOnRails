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
    "detailsState",
    "detailsBranch",
    "detailsPath",
    "detailsHead",
    "detailsDirtyDot",
    "detailsDirtyText",
    "detailsAhead",
    "detailsBehind",
    "listItem",
    "createModal",
    "createInput",
    "createParent",
    "replaceModal",
    "replaceBranch",
    "replaceCancel",
    "deleteModal",
    "deleteBranch",
    "deleteDirty",
    "deleteForce",
    "deleteCancel",
    "commitModal",
    "commitBranch",
    "commitInput",
    "mergeConflictModal",
    "mergeConflictSource",
    "mergeConflictTarget",
    "mergeConflictFiles",
    "mergeConflictManual"
  ]

  static values = {
    selected: String,
    openProjectUrl: String,
    createUrl: String,
    deleteUrl: String,
    openUrl: String,
    fetchPullUrl: String,
    rebaseUrl: String,
    commitUrl: String,
    pushUrl: String,
    mergeUrl: String,
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
    this.pendingCreateParentId = null
    this.pendingDeleteWorktreeId = null
    this.pendingDeleteForce = false
    this.pendingReplaceCreatePayload = null
    this.pendingCommitWorktreeId = null
    this.pendingMergeConflict = null
    this.openTerminalInFlight = false
    this.refreshTimeoutIds = []
    this.lastAutoRefreshAt = 0

    this.externalRefreshHandler = this.handleExternalRefresh.bind(this)
    window.addEventListener("worktree:refresh-request", this.externalRefreshHandler)
    this.periodicRefreshId = window.setInterval(() => {
      this.requestRefresh("periodic")
    }, 30000)

    const initialId = this.selectedValue || this.nodeTargets[0]?.dataset.nodeId
    if (initialId) {
      this.selectNodeById(initialId, { syncUrl: false })
    } else {
      this.renderSelectedState()
    }
  }

  disconnect() {
    document.removeEventListener("keydown", this.boundKeydown)
    window.removeEventListener("worktree:refresh-request", this.externalRefreshHandler)
    this.clearScheduledRefreshes()
    if (this.periodicRefreshId) {
      window.clearInterval(this.periodicRefreshId)
      this.periodicRefreshId = null
    }
  }

  handleKeydown(event) {
    if (this.isModalOpen()) {
      if (event.key === "Escape") {
        event.preventDefault()
        this.closeDialogs()
      }
      return
    }

    if (this.isTerminalSessionActive(event)) return

    // Skip if user is typing in an input
    const tag = event.target.tagName
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return

    switch (event.key) {
      case "j":
        event.preventDefault()
        this.moveSelectionByAxis("down")
        break
      case "k":
        event.preventDefault()
        this.moveSelectionByAxis("up")
        break
      case "h":
        event.preventDefault()
        this.moveSelectionByAxis("left")
        break
      case "l":
        event.preventDefault()
        this.moveSelectionByAxis("right")
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
      case "f":
        if (!event.ctrlKey && !event.metaKey) {
          event.preventDefault()
          this.fetchPullSelected()
        }
        break
      case "F":
        if (!event.ctrlKey && !event.metaKey) {
          event.preventDefault()
          this.rebaseSelectedOntoParent()
        }
        break
      case "c":
        event.preventDefault()
        this.commitSelected()
        break
      case "p":
        event.preventDefault()
        this.pushSelected()
        break
      case "m":
        event.preventDefault()
        this.mergeSelectedToParent()
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
      this.selectNodeById(newId)
    }
  }

  moveSelectionByAxis(direction) {
    const nodes = this.nodeTargets
    if (nodes.length === 0) return

    const currentNode = nodes.find((node) => node.dataset.nodeId === this.selectedValue) || nodes[0]
    if (!currentNode) return

    const currentCenter = this.nodeCenter(currentNode)
    let bestNode = null
    let bestScore = Number.POSITIVE_INFINITY

    nodes.forEach((candidate) => {
      if (candidate === currentNode) return

      const candidateCenter = this.nodeCenter(candidate)
      const dx = candidateCenter.x - currentCenter.x
      const dy = candidateCenter.y - currentCenter.y

      if (direction === "up" && dy >= 0) return
      if (direction === "down" && dy <= 0) return
      if (direction === "left" && dx >= 0) return
      if (direction === "right" && dx <= 0) return

      const primary = direction === "left" || direction === "right" ? Math.abs(dx) : Math.abs(dy)
      const secondary = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx)
      const score = primary + secondary * 2

      if (score < bestScore) {
        bestScore = score
        bestNode = candidate
      }
    })

    if (bestNode) {
      this.selectNodeById(bestNode.dataset.nodeId)
      return
    }

    if (direction === "up" || direction === "left") {
      this.moveSelection(-1)
    } else {
      this.moveSelection(1)
    }
  }

  nodeCenter(node) {
    const rect = node.getBoundingClientRect()
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    }
  }

  async selectNode(event) {
    this.traceAction("select-node")
    const button = event.currentTarget
    const nodeId = button.dataset.nodeId
    if (!nodeId) return

    this.selectNodeById(nodeId)
  }

  selectFromList(event) {
    event?.preventDefault?.()
    const nodeId = event.currentTarget?.dataset.nodeId
    if (!nodeId) return
    this.selectNodeById(nodeId)
  }

  async openNodeTerminal(event) {
    this.traceAction("open-terminal")
    const button = event.currentTarget
    const nodeId = button.dataset.nodeId
    if (!nodeId) return

    await this.openTerminal(nodeId)
  }

  selectNodeById(nodeId, { syncUrl = true } = {}) {
    if (!nodeId) return
    this.selectedValue = nodeId
    this.renderSelectedState()
    if (syncUrl) {
      this.syncSelectedToUrl(nodeId)
    }
  }

  syncSelectedToUrl(nodeId) {
    const url = new URL(window.location)
    url.searchParams.set("selected", nodeId)
    window.history.replaceState({}, "", url.toString())
  }

  renderSelectedState() {
    this.nodeTargets.forEach((node) => {
      const inner = node.querySelector("div")
      if (!inner) return

      const isSelected = node.dataset.nodeId === this.selectedValue
      inner.classList.toggle("node-glow-selected", isSelected)
      inner.classList.toggle("ring-1", isSelected)
      inner.classList.toggle("ring-blue-300/40", isSelected)
      inner.classList.toggle("border-blue-300", isSelected)
      inner.classList.toggle("bg-blue-50/70", isSelected)
    })

    this.listItemTargets.forEach((item) => {
      const isSelected = item.dataset.nodeId === this.selectedValue
      const label = item.querySelector("[data-node-branch-label]")

      item.classList.toggle("bg-blue-50", isSelected)
      item.classList.toggle("border-blue-200", isSelected)
      item.classList.toggle("hover:bg-gray-100", !isSelected)
      if (label) {
        label.classList.toggle("text-gray-800", isSelected)
        label.classList.toggle("text-gray-500", !isSelected)
      }
    })

    const selectedNode = this.nodeTargets.find((node) => node.dataset.nodeId === this.selectedValue)
    this.renderDetails(selectedNode)
  }

  renderDetails(node) {
    if (!node) return

    this.detailsBranchTarget.textContent = node.dataset.branch || ""
    this.detailsPathTarget.textContent = node.dataset.formattedPath || node.dataset.path || ""
    this.detailsHeadTarget.textContent = node.dataset.headShort || ""
    this.detailsAheadTarget.textContent = node.dataset.ahead || "0"
    this.detailsBehindTarget.textContent = node.dataset.behind || "0"

    const isDirty = node.dataset.dirty === "true"
    this.detailsDirtyTextTarget.textContent = isDirty ? "yes" : "no"
    this.detailsDirtyTextTarget.classList.toggle("text-red-600", isDirty)
    this.detailsDirtyTextTarget.classList.toggle("text-emerald-600", !isDirty)
    this.detailsDirtyDotTarget.classList.toggle("bg-red-500", isDirty)
    this.detailsDirtyDotTarget.classList.toggle("bg-emerald-500", !isDirty)

    const state = node.dataset.state || "committed"
    const badgeClass = (node.dataset.badgeClass || "bg-gray-50 text-gray-600 border-gray-200").split(" ")
    this.detailsStateTarget.className = "text-[10px] px-1.5 py-0.5 rounded-md border font-mono"
    this.detailsStateTarget.classList.add(...badgeClass)
    this.detailsStateTarget.textContent = state
  }

  refresh() {
    this.traceAction("refresh")
    this.requestRefresh("manual", { force: true })
  }

  requestRefresh(reason, { force = false } = {}) {
    if (!force) {
      if (document.visibilityState !== "visible") return
      if (this.isModalOpen()) return
      if (reason === "periodic" && this.isTerminalPanelVisible()) return

      const now = Date.now()
      if (now - this.lastAutoRefreshAt < 1500) return
      this.lastAutoRefreshAt = now
    }

    Turbo.visit(window.location.href, { action: "replace" })
  }

  handleExternalRefresh(event) {
    const detail = event?.detail || {}
    const delays = Array.isArray(detail.delaysMs) ? detail.delaysMs : [900, 2200]
    this.clearScheduledRefreshes()

    delays.forEach((delayMs) => {
      const timeoutId = window.setTimeout(() => {
        this.requestRefresh("terminal")
      }, Math.max(0, Number(delayMs) || 0))
      this.refreshTimeoutIds.push(timeoutId)
    })
  }

  clearScheduledRefreshes() {
    this.refreshTimeoutIds.forEach((timeoutId) => window.clearTimeout(timeoutId))
    this.refreshTimeoutIds = []
  }

  isTerminalPanelVisible() {
    const panel = document.querySelector(".terminal-panel")
    return panel?.dataset?.visible === "true"
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
    const selectedNode = this.selectedNodeTarget()

    if (!selectedNode) return
    debug("openSelectedTerminal -> opening selected node", { nodeId: selectedNode.dataset.nodeId })
    this.openTerminal(selectedNode.dataset.nodeId)
  }

  createFromSelected() {
    this.traceAction("open-create-dialog")
    const selectedNode = this.selectedNodeTarget()

    if (!selectedNode) return
    this.openCreateDialog(selectedNode.dataset.nodeId, selectedNode.dataset.branch)
  }

  async fetchPullSelected() {
    this.traceAction("fetch-pull")
    const selectedNode = this.selectedNodeTarget()
    if (!selectedNode) return

    await this.performNodeAction(
      this.fetchPullUrlValue,
      selectedNode.dataset.nodeId,
      "Fetch/pull is not configured on this page"
    )
  }

  async rebaseSelectedOntoParent() {
    this.traceAction("rebase-onto-parent")
    const selectedNode = this.selectedNodeTarget()
    if (!selectedNode) return

    const parentBranch = selectedNode.dataset.parentBranch
    if (!parentBranch) {
      window.alert("Selected worktree has no parent branch")
      return
    }

    await this.performNodeAction(
      this.rebaseUrlValue,
      selectedNode.dataset.nodeId,
      "Rebase is not configured on this page"
    )
  }

  commitSelected() {
    this.traceAction("open-commit-dialog")
    const selectedNode = this.selectedNodeTarget()
    if (!selectedNode) return

    this.openCommitDialog(selectedNode)
  }

  openCommitDialog(node) {
    const worktreeId = node.dataset.nodeId
    if (!worktreeId || !this.hasCommitModalTarget) return

    const branch = node.dataset.branch || "this worktree"

    this.pendingCommitWorktreeId = worktreeId
    this.commitBranchTarget.textContent = branch
    this.commitInputTarget.value = ""
    this.commitModalTarget.classList.remove("hidden")
    this.commitInputTarget.focus()
  }

  cancelCommit(event) {
    event?.preventDefault?.()
    this.closeDialogs()
  }

  async submitCommit(event) {
    event.preventDefault()
    this.traceAction("submit-commit")

    const worktreeId = this.pendingCommitWorktreeId
    const trimmed = this.commitInputTarget.value.trim()

    if (!worktreeId || !trimmed) {
      window.alert("Commit message is required")
      return
    }

    const payload = await this.performNodeAction(
      this.commitUrlValue,
      worktreeId,
      "Commit is not configured on this page",
      { message: trimmed }
    )

    if (payload) {
      this.closeDialogs()
    }
  }

  async pushSelected() {
    this.traceAction("push-selected")
    const selectedNode = this.selectedNodeTarget()
    if (!selectedNode) return

    await this.performNodeAction(
      this.pushUrlValue,
      selectedNode.dataset.nodeId,
      "Push is not configured on this page"
    )
  }

  async mergeSelectedToParent() {
    this.traceAction("merge-to-parent")
    const selectedNode = this.selectedNodeTarget()
    if (!selectedNode) return

    const parentBranch = selectedNode.dataset.parentBranch
    if (!parentBranch) {
      window.alert("Selected worktree has no parent branch")
      return
    }

    const result = await this.requestMergeToParent(selectedNode.dataset.nodeId)
    if (!result) return

    if (result.conflict) {
      this.openMergeConflictDialog(result)
      return
    }

    if (result.redirect_url) {
      Turbo.visit(result.redirect_url, { action: "replace" })
    } else {
      this.refresh()
    }
  }

  async requestMergeToParent(worktreeId) {
    if (!this.mergeUrlValue || !this.repoValue) {
      window.alert("Merge is not configured on this page")
      return null
    }
    if (!worktreeId) return null

    const csrfToken = document
      .querySelector("meta[name='csrf-token']")
      ?.getAttribute("content")

    try {
      const response = await fetch(this.mergeUrlValue, {
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

      const payload = await this.parseJsonResponse(response)
      if (response.ok) return payload

      if (payload.conflict) {
        return payload
      }

      window.alert(payload.error || payload.raw || "Merge failed")
      return null
    } catch (error) {
      window.alert(error?.message || "Merge failed")
      return null
    }
  }

  openMergeConflictDialog(payload) {
    if (!this.hasMergeConflictModalTarget) return

    const context = payload.conflict_context || {}
    const files = Array.isArray(context.conflicted_files) ? context.conflicted_files : []

    this.pendingMergeConflict = {
      parentId: context.parent_id,
      prompt: payload.prompt,
      sourceBranch: context.source_branch || "(unknown)",
      targetBranch: context.target_branch || "(unknown)",
      conflictedFiles: files
    }

    this.mergeConflictSourceTarget.textContent = this.pendingMergeConflict.sourceBranch
    this.mergeConflictTargetTarget.textContent = this.pendingMergeConflict.targetBranch
    this.mergeConflictFilesTarget.textContent = files.length > 0 ? files.join("\n") : "(none reported)"
    this.mergeConflictModalTarget.classList.remove("hidden")
    this.focusDefaultChoice(this.mergeConflictManualTarget)
  }

  cancelMergeConflictResolution(event) {
    event?.preventDefault?.()
    this.closeDialogs()
  }

  async resolveMergeConflictWithAgent(event) {
    event?.preventDefault?.()

    const conflict = this.pendingMergeConflict
    if (!conflict) return
    if (!conflict.parentId) {
      window.alert("Unable to open parent worktree terminal")
      return
    }
    if (!conflict.prompt) {
      window.alert("Conflict prompt was not provided")
      return
    }

    const command = `opencode --prompt ${this.shellQuote(conflict.prompt)}`
    this.closeDialogs()
    await this.openTerminal(conflict.parentId, { initialCommand: command })
  }

  shellQuote(text) {
    return `'${String(text).replace(/'/g, `'"'"'`)}'`
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

    try {
      const result = await this.requestCreateWorktree({
        parentId,
        branchName: trimmedName,
        replaceExisting: false,
        forceReplace: false
      })

      if (!result.ok) {
        if (result.conflict) {
          this.openReplaceCreateDialog(parentId, trimmedName)
          return
        }

        console.error("Worktree create request failed", {
          message: result.message,
          payload: result.payload
        })
        window.alert(result.message)
        return
      }

      if (!result.payload.redirect_url) {
        console.error("Worktree create missing redirect_url", result.payload)
        window.alert("Worktree created but response was incomplete")
        return
      }

      this.closeDialogs()
      Turbo.visit(result.payload.redirect_url, { action: "replace" })
    } catch (error) {
      console.error("Worktree create request threw", error)
      window.alert(error?.message || "Failed to create worktree")
    }
  }

  openReplaceCreateDialog(parentId, branchName) {
    this.pendingReplaceCreatePayload = { parentId, branchName }
    this.replaceBranchTarget.textContent = branchName
    this.createModalTarget.classList.add("hidden")
    this.replaceModalTarget.classList.remove("hidden")
    this.focusDefaultChoice(this.replaceCancelTarget)
  }

  cancelReplaceCreate(event) {
    event?.preventDefault?.()
    this.replaceModalTarget.classList.add("hidden")
    this.pendingReplaceCreatePayload = null
    this.createModalTarget.classList.remove("hidden")
    this.createInputTarget.focus()
    this.createInputTarget.select()
  }

  async submitReplaceCreate(event) {
    event.preventDefault()
    this.traceAction("submit-replace-create")

    const payload = this.pendingReplaceCreatePayload
    if (!payload) return

    try {
      const result = await this.requestCreateWorktree({
        parentId: payload.parentId,
        branchName: payload.branchName,
        replaceExisting: true,
        forceReplace: true
      })

      if (!result.ok) {
        window.alert(result.message)
        return
      }

      if (!result.payload.redirect_url) {
        window.alert("Worktree created but response was incomplete")
        return
      }

      this.closeDialogs()
      Turbo.visit(result.payload.redirect_url, { action: "replace" })
    } catch (error) {
      window.alert(error?.message || "Failed to create worktree")
    }
  }

  deleteSelected() {
    this.traceAction("open-delete-dialog")
    const selectedNode = this.selectedNodeTarget()

    if (!selectedNode) return
    this.openDeleteDialog(selectedNode)
  }

  selectedNodeTarget() {
    return this.nodeTargets.find(
      (node) => node.dataset.nodeId === this.selectedValue
    )
  }

  async performNodeAction(url, worktreeId, missingConfigMessage, extraPayload = {}) {
    if (!url || !this.repoValue) {
      window.alert(missingConfigMessage)
      return null
    }
    if (!worktreeId) return null

    const csrfToken = document
      .querySelector("meta[name='csrf-token']")
      ?.getAttribute("content")

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({
          repo: this.repoValue,
          worktree_id: worktreeId,
          ...extraPayload
        })
      })

      const payload = await this.parseJsonResponse(response)
      if (!response.ok) {
        window.alert(payload.error || payload.raw || "Action failed")
        return null
      }

      if (payload.redirect_url) {
        Turbo.visit(payload.redirect_url, { action: "replace" })
      } else {
        this.refresh()
      }
      return payload
    } catch (error) {
      window.alert(error?.message || "Action failed")
      return null
    }
  }

  openDeleteDialog(node) {
    const worktreeId = node.dataset.nodeId
    if (!worktreeId) return

    const branch = node.dataset.branch || "this worktree"
    const dirty = node.dataset.dirty === "true"

    this.pendingDeleteWorktreeId = worktreeId
    this.pendingDeleteForce = dirty
    this.deleteBranchTarget.textContent = branch
    this.deleteDirtyTarget.textContent = dirty ? "yes" : "no"
    this.deleteModalTarget.classList.remove("hidden")
    this.focusDefaultChoice(this.deleteCancelTarget)
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
          force: this.pendingDeleteForce
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
    this.replaceModalTarget.classList.add("hidden")
    this.deleteModalTarget.classList.add("hidden")
    if (this.hasMergeConflictModalTarget) {
      this.mergeConflictModalTarget.classList.add("hidden")
    }
    if (this.hasCommitModalTarget) {
      this.commitModalTarget.classList.add("hidden")
    }
    this.pendingCreateParentId = null
    this.pendingReplaceCreatePayload = null
    this.pendingDeleteWorktreeId = null
    this.pendingDeleteForce = false
    this.pendingCommitWorktreeId = null
    this.pendingMergeConflict = null
  }

  closeDialogBackdrop(event) {
    if (event.target === event.currentTarget) {
      this.closeDialogs()
    }
  }

  isModalOpen() {
    return !this.createModalTarget.classList.contains("hidden") ||
      !this.replaceModalTarget.classList.contains("hidden") ||
      !this.deleteModalTarget.classList.contains("hidden") ||
      (this.hasMergeConflictModalTarget && !this.mergeConflictModalTarget.classList.contains("hidden")) ||
      (this.hasCommitModalTarget && !this.commitModalTarget.classList.contains("hidden"))
  }

  async requestCreateWorktree({ parentId, branchName, replaceExisting, forceReplace }) {
    const csrfToken = document
      .querySelector("meta[name='csrf-token']")
      ?.getAttribute("content")

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
        name: branchName,
        replace_existing: replaceExisting,
        force_replace: forceReplace
      })
    })

    const payload = await this.parseJsonResponse(response)
    if (response.ok) {
      return { ok: true, payload }
    }

    const message = payload.error || payload.raw || `Failed to create worktree (${response.status})`
    const conflict = /already exists/i.test(message)
    return { ok: false, payload, message, conflict }
  }

  isTerminalSessionActive(event) {
    const panel = document.querySelector(".terminal-panel[data-visible='true']")
    if (!panel) return false

    const target = event.target
    if (target instanceof Element && target.closest(".terminal-panel")) {
      return true
    }

    const active = document.activeElement
    if (active instanceof Element && active.closest(".terminal-panel")) {
      return true
    }

    return false
  }

  traceAction(action) {
    if (!DEBUG) return
    debug(`click (${action})`)
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

  async openTerminal(worktreeId, options = {}) {
    if (!worktreeId) return

    const node = this.nodeTargets.find((targetNode) => targetNode.dataset.nodeId === worktreeId)
    const nodePath = node?.dataset.path || ""
    const nodeBranch = node?.dataset.branch || ""

    // Desktop mode: resolve path from DOM and open PTY directly (skip Rails PTY)
    const isDesktop = typeof window.desktopShell?.terminal?.create === "function"
    debug("openTerminal called", { worktreeId, isDesktop })
    if (isDesktop) {
      const path = nodePath
      debug("desktop path lookup", { foundNode: !!node, path })
      if (!path) {
        console.error(TAG, "desktop path missing for node", { worktreeId })
        return
      }

      window.dispatchEvent(
        new CustomEvent("worktree:open-terminal", {
          detail: {
            path,
            worktree_id: worktreeId,
            worktreeId,
            branch: nodeBranch,
            initialCommand: options.initialCommand || null
          }
        })
      )
      debug("dispatched worktree:open-terminal", { path })
      return
    }

    // Browser mode: hit Rails endpoint to spawn PTY via WebTerminalService
    if (!this.openUrlValue || !this.repoValue) return
    if (this.openTerminalInFlight) return

    const csrfToken = document
      .querySelector("meta[name='csrf-token']")
      ?.getAttribute("content")

    this.openTerminalInFlight = true
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
          detail: {
            ...payload,
            worktreeId,
            path: payload.path || nodePath,
            branch: nodeBranch,
            initialCommand: options.initialCommand || null
          }
        })
      )
    } catch (_error) {
      window.alert("Failed to open terminal")
    } finally {
      this.openTerminalInFlight = false
    }
  }

  focusDefaultChoice(element) {
    if (!(element instanceof HTMLElement)) return
    requestAnimationFrame(() => element.focus())
  }

}
