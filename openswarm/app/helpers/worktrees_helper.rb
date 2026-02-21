# frozen_string_literal: true

module WorktreesHelper
  def node_border_class(node_data, selected_id)
    wt = node_data[:worktree]
    classes = []

    if wt.id == selected_id
      classes << "ring-2 ring-blue-400/80 border-blue-400"
    elsif wt.dirty
      classes << "border-red-400/80"
    elsif wt.behind > 0
      classes << "border-amber-400/80"
    elsif wt.parent_branch.nil?
      classes << "border-amber-300/50"
    else
      classes << "border-slate-600/60"
    end

    classes.join(" ")
  end

  def node_state_badge_class(state)
    case state
    when "dirty"
      "bg-red-500/20 text-red-300 border-red-500/30"
    when "behind parent"
      "bg-amber-500/20 text-amber-300 border-amber-500/30"
    when "ahead"
      "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
    when "main"
      "bg-amber-500/15 text-amber-200 border-amber-400/20"
    else
      "bg-slate-500/20 text-slate-300 border-slate-500/30"
    end
  end

  def format_path(path)
    path.to_s.gsub(ENV["HOME"].to_s, "~")
  end

  def short_hash(hash)
    hash.to_s[0..6]
  end
end
