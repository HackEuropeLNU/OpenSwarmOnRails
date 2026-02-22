import { Controller } from "@hotwired/stimulus"
import consumer from "cable_consumer"

const HEARTBEAT_MS = 10_000

export default class extends Controller {
  static targets = ["roster", "nodeBadge", "status", "inviteInput"]

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

    this.selectionHandler = this.onSelectionChanged.bind(this)
    this.shareHandler = this.onShareRequest.bind(this)
    window.addEventListener("worktree:selected", this.selectionHandler)
    window.addEventListener("zed:share-request", this.shareHandler)

    if (this.hasInviteInputTarget) {
      this.inviteInputTarget.value = this.inviteUrl()
    }

    this.subscribe()
    this.render()
  }

  disconnect() {
    window.removeEventListener("worktree:selected", this.selectionHandler)
    window.removeEventListener("zed:share-request", this.shareHandler)

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
        name: this.identityNameValue,
        github_login: this.githubLoginValue,
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
    this.currentMode = "local"
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
      name: this.identityNameValue,
      github_login: this.githubLoginValue,
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
        name: this.identityNameValue,
        github_login: this.githubLoginValue,
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

  membersByBranch() {
    return this.members.reduce((memo, member) => {
      const branch = member?.branch
      if (!branch) return memo
      if (!memo[branch]) memo[branch] = []
      memo[branch].push(member)
      return memo
    }, {})
  }

  render() {
    this.renderNodeBadges()
    this.renderRoster()
  }

  renderNodeBadges() {
    const branchMap = this.membersByBranch()
    this.nodeBadgeTargets.forEach((target) => {
      const members = branchMap[target.dataset.branch] || []
      target.innerHTML = members.map((member) => this.memberPill(member)).join("")
    })
  }

  renderRoster() {
    if (!this.hasRosterTarget) return

    if (this.members.length === 0) {
      this.rosterTarget.innerHTML = "<div class='text-[10px] text-gray-400 font-mono'>no one online</div>"
      return
    }

    this.rosterTarget.innerHTML = this.members
      .map((member) => {
        const mine = member.identity_id === this.identityIdValue
        const mode = member.mode === "zed-shared" ? "zed live" : "local"
        const modeClass = member.mode === "zed-shared" ? "text-indigo-600" : "text-emerald-600"
        const handle = member.github_login ? `@${member.github_login}` : "git profile"

        return `
          <div class="flex items-center gap-2 rounded-md border ${mine ? "border-blue-200 bg-blue-50/50" : "border-gray-200 bg-white"} px-2 py-1.5">
            <span class="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-gray-300 bg-gray-50 px-1 text-[9px] text-gray-600 font-mono">${this.initials(member.name)}</span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center justify-between gap-2">
                <span class="truncate text-[11px] ${mine ? "text-blue-700" : "text-gray-700"} font-mono">${this.escapeHtml(member.name)}${mine ? " (you)" : ""}</span>
                <span class="text-[10px] font-mono ${modeClass}">${mode}</span>
              </div>
              <div class="truncate text-[10px] text-gray-400 font-mono">${this.escapeHtml(handle)} · ${this.escapeHtml(member.branch || "no branch selected")}</div>
            </div>
          </div>
        `
      })
      .join("")
  }

  memberPill(member) {
    const mine = member.identity_id === this.identityIdValue
    const modeClass = member.mode === "zed-shared"
      ? "border-indigo-300 bg-indigo-50 text-indigo-700"
      : "border-emerald-300 bg-emerald-50 text-emerald-700"
    const label = member.github_login ? `@${member.github_login}` : member.name

    return `<span class="inline-flex items-center rounded-md border px-1.5 py-0.5 text-[9px] font-mono ${modeClass}">${this.escapeHtml(label)}${mine ? "*" : ""}</span>`
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
    const identityLabel = this.githubLoginValue ? `@${this.githubLoginValue}` : this.identityNameValue
    this.statusTarget.textContent = `room: ${this.roomValue || "default"} · ${identityLabel} · ${label}`
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
