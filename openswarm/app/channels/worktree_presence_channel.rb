# frozen_string_literal: true

class WorktreePresenceChannel < ApplicationCable::Channel
  def subscribed
    @room_key = room_key_from(params)
    @member_id = params[:client_id].to_s.presence || SecureRandom.uuid
    @identity_id = params[:identity_id].to_s.presence || "anonymous"

    stream_from stream_name

    upsert_member!(
      name: params[:name],
      github_login: params[:github_login],
      branch: params[:branch],
      selected_worktree_id: params[:selected_worktree_id],
      mode: params[:mode]
    )
  end

  def unsubscribed
    return unless @room_key && @member_id

    roster = WorktreePresenceRegistry.remove(room_key: @room_key, member_id: @member_id)
    broadcast_roster!(roster)
  end

  def upsert(data)
    upsert_member!(
      name: data["name"],
      github_login: data["github_login"],
      branch: data["branch"],
      selected_worktree_id: data["selected_worktree_id"],
      mode: data["mode"]
    )
  end

  def heartbeat(data)
    upsert_member!(
      name: data["name"],
      github_login: data["github_login"],
      branch: data["branch"],
      selected_worktree_id: data["selected_worktree_id"],
      mode: data["mode"]
    )
  end

  def leave(_data)
    return unless @room_key && @member_id

    roster = WorktreePresenceRegistry.remove(room_key: @room_key, member_id: @member_id)
    broadcast_roster!(roster)
  end

  private

  def upsert_member!(name:, github_login:, branch:, selected_worktree_id:, mode:)
    roster = WorktreePresenceRegistry.upsert(
      room_key: @room_key,
      member: {
        id: @member_id,
        identity_id: @identity_id,
        name: name,
        github_login: github_login,
        branch: branch,
        selected_worktree_id: selected_worktree_id,
        mode: mode
      }
    )

    broadcast_roster!(roster)
  end

  def broadcast_roster!(roster)
    ActionCable.server.broadcast(stream_name, {
      type: "roster",
      room_key: @room_key,
      roster: roster
    })
  end

  def stream_name
    "worktree_presence:#{@room_key}"
  end

  def room_key_from(raw_params)
    repo = sanitize_segment(raw_params[:repo])
    room = sanitize_segment(raw_params[:room] || "default")
    "#{repo}:#{room}"
  end

  def sanitize_segment(value)
    cleaned = value.to_s.downcase.gsub(/[^a-z0-9_-]/, "-").gsub(/-+/, "-").gsub(/^-|-$/, "")
    cleaned.presence || "default"
  end
end
