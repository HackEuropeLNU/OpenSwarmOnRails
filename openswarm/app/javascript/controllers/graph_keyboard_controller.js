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
    "tokenLegendRows",
    "tokenLegendEmpty",
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
    this.pendingCreateParentId = null
    this.pendingDeleteWorktreeId = null
    this.openTerminalInFlight = false
    this.worktreeMetaById = new Map()
    this.worktreeIdByPath = new Map()
    this.tokenRateByWorktree = this.loadTokenRates()
    this.boundTokenRateUpdate = this.handleTokenRateUpdate.bind(this)
    window.addEventListener("worktree:token-rate", this.boundTokenRateUpdate)
    this.indexWorktreeMetadata()

    const initialId = this.selectedValue || this.nodeTargets[0]?.dataset.nodeId
    if (initialId) {
      this.selectNodeById(initialId, { syncUrl: false })
    } else {
      this.renderSelectedState()
    }

    this.renderTokenLegend()
  }

  disconnect() {
    document.removeEventListener("keydown", this.boundKeydown)
    window.removeEventListener("worktree:token-rate", this.boundTokenRateUpdate)
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
      this.selectNodeById(newId)
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
            branch: nodeBranch
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
            branch: nodeBranch
          }
        })
      )
    } catch (_error) {
      window.alert("Failed to open terminal")
    } finally {
      this.openTerminalInFlight = false
    }
  }

  tokenStorageKey() {
    const repo = this.repoValue || "default"
    return `openswarm:token-rates:${repo}`
  }

  loadTokenRates() {
    try {
      const raw = window.sessionStorage.getItem(this.tokenStorageKey())
      if (!raw) return {}
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === "object" ? parsed : {}
    } catch (_error) {
      return {}
    }
  }

  persistTokenRates() {
    try {
      window.sessionStorage.setItem(this.tokenStorageKey(), JSON.stringify(this.tokenRateByWorktree))
    } catch (_error) {
      // ignore storage failures
    }
  }

  indexWorktreeMetadata() {
    this.worktreeMetaById.clear()
    this.worktreeIdByPath.clear()

    this.nodeTargets.forEach((node) => {
      const id = node.dataset.nodeId
      if (!id) return

      const meta = {
        id,
        branch: node.dataset.branch || id,
        path: node.dataset.path || ""
      }

      this.worktreeMetaById.set(id, meta)
      if (meta.path) this.worktreeIdByPath.set(meta.path, id)

      if (!this.tokenRateByWorktree[id]) {
        this.tokenRateByWorktree[id] = {
          tps: 0,
          updatedAt: null
        }
      }
    })

    Object.keys(this.tokenRateByWorktree).forEach((id) => {
      if (!this.worktreeMetaById.has(id)) {
        delete this.tokenRateByWorktree[id]
      }
    })

    this.persistTokenRates()
  }

  handleTokenRateUpdate(event) {
    const detail = event.detail || {}
    const worktreeId = this.resolveWorktreeId(detail)
    if (!worktreeId || !this.worktreeMetaById.has(worktreeId)) return

    const numericRate = Number(detail.tokensPerSecond)
    if (!Number.isFinite(numericRate) || numericRate < 0) return

    this.tokenRateByWorktree[worktreeId] = {
      tps: numericRate,
      updatedAt: detail.timestamp || Date.now()
    }

    this.persistTokenRates()
    this.renderTokenLegend()
  }

  resolveWorktreeId(detail) {
    if (detail.worktreeId && this.worktreeMetaById.has(detail.worktreeId)) {
      return detail.worktreeId
    }

    if (detail.path && this.worktreeIdByPath.has(detail.path)) {
      return this.worktreeIdByPath.get(detail.path)
    }

    return null
  }

  renderTokenLegend() {
    if (!this.hasTokenLegendRowsTarget || !this.hasTokenLegendEmptyTarget) return

    const rows = []
    this.worktreeMetaById.forEach((meta) => {
      const metric = this.tokenRateByWorktree[meta.id] || { tps: 0 }
      rows.push({
        id: meta.id,
        branch: meta.branch,
        tps: Number(metric.tps) || 0
      })
    })

    rows.sort((left, right) => right.tps - left.tps)
    const maxRate = rows.reduce((max, row) => Math.max(max, row.tps), 0)

    this.tokenLegendRowsTarget.innerHTML = ""
    this.hasTokenLegendEmptyTarget && this.tokenLegendEmptyTarget.classList.toggle("hidden", rows.length > 0)

    rows.forEach((row) => {
      const ratio = maxRate > 0 ? row.tps / maxRate : 0
      const rowElement = document.createElement("div")
      rowElement.className = "grid grid-cols-[minmax(0,1fr)_70px_34px] items-center gap-2"

      const nameElement = document.createElement("span")
      nameElement.className = "truncate text-[10px] text-slate-300 font-mono"
      nameElement.textContent = row.branch

      const trackElement = document.createElement("span")
      trackElement.className = "h-1.5 rounded-full bg-slate-800/90 overflow-hidden"

      const fillElement = document.createElement("span")
      fillElement.className = "block h-full rounded-full bg-cyan-400/90"
      fillElement.style.width = `${Math.max(4, Math.round(ratio * 100))}%`
      if (row.tps === 0) {
        fillElement.style.width = "0%"
      }

      const ratioElement = document.createElement("span")
      ratioElement.className = "text-right text-[10px] text-slate-400 font-mono"
      ratioElement.textContent = ratio.toFixed(2)

      trackElement.appendChild(fillElement)
      rowElement.appendChild(nameElement)
      rowElement.appendChild(trackElement)
      rowElement.appendChild(ratioElement)
      this.tokenLegendRowsTarget.appendChild(rowElement)
    })
  }
}
