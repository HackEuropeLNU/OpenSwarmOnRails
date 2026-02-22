import { Controller } from "@hotwired/stimulus"
import consumer from "cable_consumer"

const HEARTBEAT_MS = 10_000
const TOKEN_RATE_STALE_MS = 8_000

export default class extends Controller {
  static targets = ["roster", "nodeBadge", "nodeTokenRate", "status", "inviteInput", "nameInput"]

  static values = {
    repo: String,
    room: String,
    selectedBranch: String,
    selectedId: String,
    identityId: String,
    identityName: String,
    githubLogin: String
  }

  connect() {
    this.clientId = this.ensureClientId()
    this.currentMode = "local"
    this.selectedBranch = this.selectedBranchValue || null
    this.selectedId = this.selectedIdValue || null
    this.members = []
    this.publicIdentityName = this.loadCustomName() || this.presenceName()
    this.tokenRateByWorktreeId = new Map()

    this.selectionHandler = this.onSelectionChanged.bind(this)
    this.shareHandler = this.onShareRequest.bind(this)
    this.tokenRateHandler = this.onTokenRate.bind(this)
    window.addEventListener("worktree:selected", this.selectionHandler)
    window.addEventListener("zed:share-request", this.shareHandler)
    window.addEventListener("worktree:token-rate", this.tokenRateHandler)

    if (this.hasInviteInputTarget) {
      this.inviteInputTarget.value = this.inviteUrl()
    }

    if (this.hasNameInputTarget) {
      this.nameInputTarget.value = this.publicIdentityName
    }

    this.subscribe()
    this.render()
  }

  disconnect() {
    window.removeEventListener("worktree:selected", this.selectionHandler)
    window.removeEventListener("zed:share-request", this.shareHandler)
    window.removeEventListener("worktree:token-rate", this.tokenRateHandler)

    if (this.subscription) {
      this.subscription.perform("leave", {})
      this.subscription.unsubscribe()
      this.subscription = null
    }

    this.stopHeartbeat()
  }

  shareSelected() {
    if (!this.selectedBranch) return
    this.currentMode = "zed-shared"
    this.upsertPresence()
    this.render()
  }

  setLocalMode() {
    this.currentMode = "local"
    this.upsertPresence()
    this.render()
  }

  async copyInviteLink(event) {
    event?.preventDefault?.()
    const value = this.inviteUrl()

    try {
      await navigator.clipboard.writeText(value)
      this.renderStatus("invite copied")
    } catch (_error) {
      if (this.hasInviteInputTarget) {
        this.inviteInputTarget.focus()
        this.inviteInputTarget.select()
      }
      this.renderStatus("copy failed")
    }
  }

  submitName(event) {
    event?.preventDefault?.()

    const rawValue = this.hasNameInputTarget ? this.nameInputTarget.value : ""
    const customName = this.normalizeName(rawValue)

    if (customName) {
      this.publicIdentityName = customName
      this.storeCustomName(customName)
      this.renderStatus("name saved")
    } else {
      this.clearCustomName()
      this.publicIdentityName = this.presenceName()
      this.renderStatus("name reset")
    }

    if (this.hasNameInputTarget) {
      this.nameInputTarget.value = this.publicIdentityName
    }

    this.upsertPresence()
    this.render()
  }

  subscribe() {
    const repo = this.repoValue || "default"
    const room = this.roomValue || "default"

    this.subscription = consumer.subscriptions.create(
      {
        channel: "WorktreePresenceChannel",
        repo,
        room,
        client_id: this.clientId,
        identity_id: this.identityIdValue,
        name: this.publicIdentityName,
        github_login: null,
        branch: this.selectedBranch,
        selected_worktree_id: this.selectedId,
        mode: this.currentMode
      },
      {
        connected: () => {
          this.renderStatus("connected")
          this.upsertPresence()
          this.startHeartbeat()
        },
        disconnected: () => {
          this.stopHeartbeat()
          this.renderStatus("disconnected")
        },
        received: (payload) => {
          if (!payload || payload.type !== "roster") return
          this.members = Array.isArray(payload.roster) ? payload.roster : []
          this.render()
        }
      }
    )
  }

  onSelectionChanged(event) {
    const detail = event?.detail || {}
    this.selectedId = detail.nodeId || this.selectedId
    this.selectedBranch = detail.branch || this.selectedBranch
    this.upsertPresence()
    this.render()
  }

  onShareRequest(event) {
    const detail = event?.detail || {}
    this.selectedId = detail.nodeId || this.selectedId
    this.selectedBranch = detail.branch || this.selectedBranch
    this.currentMode = "zed-shared"
    this.upsertPresence()
    this.render()
  }

  upsertPresence() {
    if (!this.subscription) return

    this.subscription.perform("upsert", {
      name: this.publicIdentityName,
      github_login: null,
      branch: this.selectedBranch,
      selected_worktree_id: this.selectedId,
      mode: this.currentMode
    })
  }

  startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatId = window.setInterval(() => {
      if (!this.subscription) return
      this.subscription.perform("heartbeat", {
        name: this.publicIdentityName,
        github_login: null,
        branch: this.selectedBranch,
        selected_worktree_id: this.selectedId,
        mode: this.currentMode
      })
    }, HEARTBEAT_MS)
  }

  stopHeartbeat() {
    if (!this.heartbeatId) return
    window.clearInterval(this.heartbeatId)
    this.heartbeatId = null
  }

  ensureClientId() {
    const key = "openswarm.presenceClientId"
    const existing = window.sessionStorage.getItem(key)
    if (existing) return existing

    const generated = `client-${Math.random().toString(36).slice(2, 10)}`
    window.sessionStorage.setItem(key, generated)
    return generated
  }

  render() {
    this.renderNodeBadges()
    this.renderNodeTokenRates()
    this.renderRoster()
  }

  renderNodeBadges() {
    const labels = this.worktreeLabelMap()
    const now = Date.now()
    this.nodeBadgeTargets.forEach((target) => {
      const worktreeId = target.dataset.worktreeId
      const branch = target.dataset.branch
      const members = this.members.filter((member) => {
        if (member?.selected_worktree_id) {
          return member.selected_worktree_id === worktreeId
        }
        return member?.branch && member.branch === branch
      })

      target.innerHTML = members.map((member) => this.memberPill(member, labels)).join("")
    })
  }

  renderNodeTokenRates() {
    const now = Date.now()
    this.nodeTokenRateTargets.forEach((target) => {
      const worktreeId = target.dataset.worktreeId
      const tokenRate = this.tokenRateByWorktreeId.get(worktreeId)
      const isFresh = tokenRate && now - tokenRate.timestamp <= TOKEN_RATE_STALE_MS
      if (!isFresh) {
        target.classList.add("hidden")
        target.textContent = ""
        return
      }

      target.classList.remove("hidden")
      target.textContent = `${tokenRate.tokensPerSecond.toFixed(1)} tok/s`
    })
  }

  onTokenRate(event) {
    const detail = event?.detail || {}
    const tokensPerSecond = Number(detail.tokensPerSecond)
    if (!Number.isFinite(tokensPerSecond) || tokensPerSecond < 0) return

    const worktreeId = this.resolveWorktreeIdFromTokenDetail(detail)
    if (!worktreeId) return

    this.tokenRateByWorktreeId.set(worktreeId, {
      tokensPerSecond,
      timestamp: Number(detail.timestamp) || Date.now()
    })

    this.renderNodeBadges()
    this.renderNodeTokenRates()
  }

  resolveWorktreeIdFromTokenDetail(detail) {
    const direct = String(detail.worktreeId || "").trim()
    if (direct) return direct

    const byPath = this.findWorktreeIdByPath(detail.path)
    if (byPath) return byPath

    const byBranch = this.findWorktreeIdByBranch(detail.branch)
    if (byBranch) return byBranch

    return null
  }

  findWorktreeIdByPath(path) {
    const normalized = this.normalizePath(path)
    if (!normalized) return null

    const nodes = document.querySelectorAll("[data-graph-keyboard-target='node']")
    for (const node of nodes) {
      const nodePath = this.normalizePath(node?.dataset?.path)
      if (nodePath === normalized) {
        return node?.dataset?.nodeId || null
      }
    }

    return null
  }

  findWorktreeIdByBranch(branch) {
    const normalized = String(branch || "").trim()
    if (!normalized) return null

    const nodes = document.querySelectorAll("[data-graph-keyboard-target='node']")
    for (const node of nodes) {
      if (String(node?.dataset?.branch || "").trim() === normalized) {
        return node?.dataset?.nodeId || null
      }
    }

    return null
  }

  normalizePath(path) {
    if (!path) return ""
    return String(path).trim().replace(/\/+$/, "") || "/"
  }

  tokenRatePill(tokensPerSecond) {
    return `<span class="inline-flex items-center rounded-md border border-sky-300 bg-sky-50 px-1.5 py-0.5 text-[9px] font-mono text-sky-700">${tokensPerSecond.toFixed(1)} tok/s</span>`
  }

  renderRoster() {
    if (!this.hasRosterTarget) return

    if (this.members.length === 0) {
      this.rosterTarget.innerHTML = "<div class='text-[10px] text-gray-400 font-mono'>no one online</div>"
      return
    }

    const labels = this.worktreeLabelMap()

    this.rosterTarget.innerHTML = this.members
      .map((member) => {
        const mine = member.identity_id === this.identityIdValue
        const mode = member.mode === "zed-shared" ? "zed live" : "local"
        const modeClass = member.mode === "zed-shared" ? "text-red-700 dark:text-red-300" : "text-emerald-600"
        const label = this.memberDisplayName(member)
        const location = this.memberLocation(member, labels)

        return `
          <div class="flex items-center gap-2 rounded-md border ${mine ? "border-red-200 bg-red-50/50 dark:border-red-900/80 dark:bg-red-950/30" : "border-gray-200 bg-white dark:border-slate-700 dark:bg-slate-900"} px-2 py-1.5">
            <span class="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-gray-300 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 px-1 text-[9px] text-gray-600 dark:text-slate-300 font-mono">${this.initials(label)}</span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center justify-between gap-2">
                <span class="truncate text-[11px] ${mine ? "text-red-700 dark:text-red-300" : "text-gray-700 dark:text-slate-200"} font-mono">${this.escapeHtml(label)}${mine ? " (you)" : ""}</span>
                <span class="text-[10px] font-mono ${modeClass}">${mode}</span>
              </div>
              <div class="truncate text-[10px] text-gray-400 dark:text-slate-500 font-mono">${this.escapeHtml(location)}</div>
            </div>
          </div>
        `
      })
      .join("")
  }

  memberPill(member, labels) {
    const mine = member.identity_id === this.identityIdValue
    const modeClass = member.mode === "zed-shared"
      ? "border-red-300 bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900/80"
      : "border-emerald-300 bg-emerald-50 text-emerald-700"
    const label = this.memberDisplayName(member)
    const title = this.memberLocation(member, labels)

    return `<span title="${this.escapeHtml(title)}" class="inline-flex items-center rounded-md border px-1.5 py-0.5 text-[9px] font-mono ${modeClass}">${this.escapeHtml(label)}${mine ? "*" : ""}</span>`
  }

  inviteUrl() {
    const url = new URL(window.location.href)
    url.searchParams.set("room", this.roomValue || "default")
    if (this.repoValue) {
      url.searchParams.set("repo", this.repoValue)
    }
    url.searchParams.delete("selected")
    return url.toString()
  }

  renderStatus(state) {
    if (!this.hasStatusTarget) return

    const label = state || "connecting"
    const identityLabel = this.publicIdentityName
    this.statusTarget.textContent = `room: ${this.roomValue || "default"} · ${identityLabel} · ${label}`
  }

  presenceName() {
    return this.anonymousName(this.clientId)
  }

  anonymousName(source) {
    const compact = String(source || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(-6)

    return `dev-${compact || "anon"}`
  }

  memberDisplayName(member) {
    const name = this.normalizeName(member?.name)
    if (name) return name
    return this.anonymousName(member?.id || member?.identity_id)
  }

  customNameStorageKey() {
    const repo = this.repoValue || "default"
    const room = this.roomValue || "default"
    const identity = this.identityIdValue || "anonymous"
    return `openswarm.presenceName.${repo}.${room}.${identity}`
  }

  loadCustomName() {
    try {
      const value = window.localStorage.getItem(this.customNameStorageKey())
      return this.normalizeName(value)
    } catch (_error) {
      return null
    }
  }

  storeCustomName(value) {
    try {
      window.localStorage.setItem(this.customNameStorageKey(), value)
    } catch (_error) {
      // ignored
    }
  }

  clearCustomName() {
    try {
      window.localStorage.removeItem(this.customNameStorageKey())
    } catch (_error) {
      // ignored
    }
  }

  normalizeName(value) {
    const trimmed = String(value || "").replace(/\s+/g, " ").trim()
    if (!trimmed) return null
    return trimmed.slice(0, 40)
  }

  worktreeLabelMap() {
    const map = new Map()
    const nodes = document.querySelectorAll("[data-graph-keyboard-target='node']")
    nodes.forEach((node) => {
      const id = node?.dataset?.nodeId
      const branch = node?.dataset?.branch
      if (!id) return

      map.set(id, branch || id)
    })
    return map
  }

  memberLocation(member, labels) {
    const selectedId = String(member?.selected_worktree_id || "").trim()
    if (selectedId) {
      const label = labels.get(selectedId) || selectedId
      return `on ${label}`
    }

    if (member?.branch) return `branch ${member.branch}`
    return "no worktree selected"
  }

  initials(name) {
    const value = String(name || "").trim()
    return value.length > 0 ? value[0].toUpperCase() : "?"
  }

  escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;")
  }
}
