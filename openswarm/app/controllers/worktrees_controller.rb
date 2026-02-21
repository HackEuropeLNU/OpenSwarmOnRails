# frozen_string_literal: true

class WorktreesController < ApplicationController
  def index
    @repos = discover_repos
    @selected_repo = if params[:repo]
      @repos.find { |r| r[:name] == params[:repo] } || @repos.first
    else
      @repos.first
    end

    @worktrees = []
    @tree = {}
    @repo_root = nil

    if @selected_repo
      result = GitWorktreeService.discover(@selected_repo[:root])
      if result.success
        @worktrees = result.data[:worktrees]
        @tree = result.data[:tree]
        @repo_root = result.data[:repo_root]
      else
        @error = result.error
      end
    end

    @selected_id = params[:selected] || @worktrees.first&.id
    @selected_node = @worktrees.find { |wt| wt.id == @selected_id } || @worktrees.first
    @layout = compute_layout(@tree, @worktrees)
  end

  def create_worktree
    repo_name = params[:repo].to_s
    parent_id = params[:parent_id].to_s
    worktree_name = params[:name].to_s

    repos = discover_repos
    selected_repo = repos.find { |r| r[:name] == repo_name }
    return render json: { error: "Repository not found" }, status: :not_found unless selected_repo

    discovery = GitWorktreeService.discover(selected_repo[:root])
    unless discovery.success
      return render json: { error: discovery.error }, status: :unprocessable_entity
    end

    parent = discovery.data[:worktrees].find { |wt| wt.id == parent_id }
    return render json: { error: "Parent worktree not found" }, status: :unprocessable_entity unless parent
    return render json: { error: "Cannot create from detached HEAD" }, status: :unprocessable_entity if parent.detached

    result = GitWorktreeService.create_worktree(
      repo_root: selected_repo[:root],
      parent_branch: parent.branch,
      branch_name: worktree_name
    )

    unless result.success
      return render json: { error: result.error }, status: :unprocessable_entity
    end

    render json: {
      id: result.data[:id],
      branch: result.data[:branch],
      redirect_url: worktrees_path(repo: repo_name, selected: result.data[:id])
    }
  end

  def open_terminal
    repo_name = params[:repo].to_s
    worktree_id = params[:worktree_id].to_s

    repos = discover_repos
    selected_repo = repos.find { |r| r[:name] == repo_name }
    return render json: { error: "Repository not found" }, status: :not_found unless selected_repo

    discovery = GitWorktreeService.discover(selected_repo[:root])
    unless discovery.success
      return render json: { error: discovery.error }, status: :unprocessable_entity
    end

    worktree = discovery.data[:worktrees].find { |wt| wt.id == worktree_id }
    return render json: { error: "Worktree not found" }, status: :unprocessable_entity unless worktree

    result = LocalTerminalService.open(worktree.path)
    unless result.success
      return render json: { error: result.error }, status: :unprocessable_entity
    end

    render json: {
      ok: true,
      path: worktree.path,
      app: result.data[:app]
    }
  end

  private

  def repo_roots
    configured_roots = ENV.fetch("OPENSWARM_REPO_ROOTS", "")
      .split(File::PATH_SEPARATOR)
      .map(&:strip)
      .reject(&:empty?)

    return configured_roots if configured_roots.any?

    [Rails.root.join("..").expand_path.to_s]
  end

  def discover_repos
    repo_roots.filter_map do |root|
      next unless File.directory?(root)

      in_git_repo = `git -C "#{root}" rev-parse --is-inside-work-tree 2>/dev/null`.strip == "true" rescue false
      next unless in_git_repo

      # Get basic info about the repo
      branch_count = `git -C "#{root}" branch --list 2>/dev/null`.lines.count rescue 0
      worktree_count = `git -C "#{root}" worktree list 2>/dev/null`.lines.count rescue 0

      {
        root: root,
        name: File.basename(root),
        branch_count: branch_count,
        worktree_count: worktree_count
      }
    end
  end

  # Compute x,y positions and SVG edges for a tree of worktrees.
  # Uses a layered top-down layout with centered siblings.
  def compute_layout(tree, worktrees)
    return { nodes: [], edges: [], width: 1000, height: 400 } if tree.empty? || worktrees.empty?

    worktree_by_id = worktrees.index_by(&:id)
    levels = Hash.new { |h, k| h[k] = [] }
    edge_pairs = []
    visited = {}

    walk = nil
    walk = lambda do |node, depth|
      return unless node.is_a?(Hash)

      node_id = node[:id]
      return if node_id.nil? || visited[node_id]

      visited[node_id] = true
      levels[depth] << node_id

      (node[:children] || []).each do |child|
        child_id = child[:id]
        edge_pairs << [node_id, child_id] if child_id
        walk.call(child, depth + 1)
      end
    end

    walk.call(tree, 0)

    missing_ids = worktree_by_id.keys - visited.keys
    missing_ids.each do |id|
      levels[1] << id
      edge_pairs << [tree[:id], id]
    end

    all_levels = levels.keys.sort.map { |depth| levels[depth].uniq }

    nodes = []

    # Layout params — generous spacing for premium look
    node_width = 200
    node_height = 62
    horizontal_gap = 48
    level_gap = 140
    canvas_padding_x = 80
    canvas_padding_y = 60

    # Calculate positions
    max_count = [all_levels.map(&:length).max || 1, 1].max
    canvas_width = [max_count * (node_width + horizontal_gap) - horizontal_gap + canvas_padding_x * 2, 900].max
    canvas_height = all_levels.length * level_gap + node_height + canvas_padding_y * 2

    all_levels.each_with_index do |level_ids, level_idx|
      level_nodes = level_ids.filter_map { |id| worktree_by_id[id] }
      next if level_nodes.empty?

      total_width = level_nodes.length * node_width + (level_nodes.length - 1) * horizontal_gap
      start_x = (canvas_width - total_width) / 2.0

      level_nodes.each_with_index do |wt, node_idx|
        x = start_x + node_idx * (node_width + horizontal_gap)
        y = canvas_padding_y + level_idx * level_gap

        nodes << {
          id: wt.id,
          x: x.round(1),
          y: y.round(1),
          width: node_width,
          height: node_height,
          center_x: (x + node_width / 2.0).round(1),
          center_y: (y + node_height / 2.0).round(1),
          worktree: wt
        }
      end
    end

    node_by_id = nodes.index_by { |n| n[:id] }
    edges = edge_pairs.filter_map do |from_id, to_id|
      from_node = node_by_id[from_id]
      to_node = node_by_id[to_id]
      next unless from_node && to_node

      x1 = from_node[:center_x]
      y1 = from_node[:y] + from_node[:height]
      x2 = to_node[:center_x]
      y2 = to_node[:y]
      ctrl_offset = (y2 - y1) * 0.5

      {
        path: "M#{x1} #{y1} C#{x1} #{y1 + ctrl_offset}, #{x2} #{y2 - ctrl_offset}, #{x2} #{y2}",
        from: from_id,
        to: to_id
      }
    end

    { nodes: nodes, edges: edges, width: canvas_width.to_i, height: canvas_height.to_i }
  end
end
