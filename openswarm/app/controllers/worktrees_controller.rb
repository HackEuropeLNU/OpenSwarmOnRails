# frozen_string_literal: true

class WorktreesController < ApplicationController
  # Default repo roots to scan. In production, this would come from a config/model.
  REPO_ROOTS = [
    "/Users/matar/fafo/OpenSwarmOnRails",
    "/Users/matar/fafo/OpenSwarm"
  ].freeze

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

  private

  def discover_repos
    REPO_ROOTS.filter_map do |root|
      next unless File.directory?(root)

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
  # Uses a layered top-down layout with centered children.
  def compute_layout(tree, worktrees)
    return { nodes: [], edges: [], width: 1000, height: 400 } if tree.empty? || worktrees.empty?

    nodes = []
    edges = []

    # Build levels: root is level 0, children are level 1
    root_wt = worktrees.find { |wt| wt.id == tree[:id] }
    children_ids = (tree[:children] || []).map { |c| c[:id] }
    children_wts = worktrees.select { |wt| children_ids.include?(wt.id) }

    # Layout params — generous spacing for premium look
    node_width = 200
    node_height = 62
    horizontal_gap = 48
    level_gap = 140
    canvas_padding_x = 80
    canvas_padding_y = 60

    # Calculate positions
    all_levels = [[root_wt].compact, children_wts]
    all_levels.reject!(&:empty?)

    max_count = all_levels.map(&:length).max || 1
    canvas_width = [max_count * (node_width + horizontal_gap) - horizontal_gap + canvas_padding_x * 2, 900].max
    canvas_height = all_levels.length * level_gap + node_height + canvas_padding_y * 2

    all_levels.each_with_index do |level_nodes, level_idx|
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

    # Build edges from root to each child
    root_node = nodes.find { |n| n[:id] == tree[:id] }
    if root_node
      children_ids.each do |child_id|
        child_node = nodes.find { |n| n[:id] == child_id }
        next unless child_node

        # Smooth cubic bezier from bottom-center of parent to top-center of child
        x1 = root_node[:center_x]
        y1 = root_node[:y] + root_node[:height]
        x2 = child_node[:center_x]
        y2 = child_node[:y]
        ctrl_offset = (y2 - y1) * 0.5

        edges << {
          path: "M#{x1} #{y1} C#{x1} #{y1 + ctrl_offset}, #{x2} #{y2 - ctrl_offset}, #{x2} #{y2}",
          from: root_node[:id],
          to: child_node[:id]
        }
      end
    end

    { nodes: nodes, edges: edges, width: canvas_width.to_i, height: canvas_height.to_i }
  end
end
