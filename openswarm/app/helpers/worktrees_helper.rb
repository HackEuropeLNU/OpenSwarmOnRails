# frozen_string_literal: true

module WorktreesHelper
  def node_border_class(node_data, selected_id)
    wt = node_data[:worktree]
    classes = []

    if wt.id == selected_id
      classes << "ring-2 ring-blue-300 border-blue-400"
    elsif wt.dirty
      classes << "border-red-300"
    elsif wt.behind > 0
      classes << "border-amber-300"
    elsif wt.parent_branch.nil?
      classes << "border-amber-300"
    else
      classes << "border-gray-200"
    end

    classes.join(" ")
  end

  def node_state_badge_class(state)
    case state
    when "detached"
      "bg-red-50 text-red-700 border-red-200"
    when "dirty"
      "bg-red-50 text-red-600 border-red-200"
    when "behind parent", "behind head"
      "bg-amber-50 text-amber-600 border-amber-200"
    when "committed", "local only", "ahead"
      "bg-orange-50 text-orange-700 border-orange-200"
    when "pushed", "main"
      "bg-emerald-50 text-emerald-700 border-emerald-200"
    else
      "bg-gray-50 text-gray-600 border-gray-200"
    end
  end

  def format_path(path)
    path.to_s.gsub(ENV["HOME"].to_s, "~")
  end

  def short_hash(hash)
    hash.to_s[0..6]
  end
end
