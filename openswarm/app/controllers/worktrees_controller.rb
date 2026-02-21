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

    result = WebTerminalService.open(worktree.path)
    unless result.success
      return render json: { error: result.error }, status: :unprocessable_entity
    end

    render json: {
      ok: true,
      path: worktree.path,
      session_id: result.data[:session_id],
      shell: result.data[:shell]
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
  # Uses a parent-aware layered layout so children stay under their parent.
  def compute_layout(tree, worktrees)
    return { nodes: [], edges: [], width: 1000, height: 400 } if tree.empty? || worktrees.empty?

    worktree_by_id = worktrees.index_by(&:id)
    children_by_id = Hash.new { |h, k| h[k] = [] }
    parent_by_id = {}
    visited = {}

    walk = nil
    walk = lambda do |node, parent_id = nil|
      return unless node.is_a?(Hash)

      node_id = node[:id]
      return if node_id.nil? || visited[node_id]

      visited[node_id] = true
      parent_by_id[node_id] = parent_id if parent_id

      raw_children = Array(node[:children]).select { |child| child.is_a?(Hash) && child[:id] }
      raw_children.each do |child|
        child_id = child[:id]
        children_by_id[node_id] << child_id
        walk.call(child, node_id)
      end
    end

    walk.call(tree) if tree.is_a?(Hash)

    root_id = if tree.is_a?(Hash)
      tree[:id]
    end
    unless root_id && worktree_by_id.key?(root_id)
      root_id = worktrees.find { |wt| wt.parent_branch.nil? }&.id || worktrees.first&.id
    end

    branch_to_id = {}
    worktrees.each do |wt|
      next if wt.detached || wt.branch == "(detached)"

      branch_to_id[wt.branch] ||= wt.id
    end

    worktrees.each do |wt|
      next if wt.id == root_id
      next if wt.detached
      next if parent_by_id.key?(wt.id)

      parent_id = wt.parent_branch && branch_to_id[wt.parent_branch]
      parent_id = root_id if parent_id.nil? || parent_id == wt.id
      next unless parent_id

      parent_by_id[wt.id] = parent_id
      children_by_id[parent_id] << wt.id
    end

    worktree_by_id.keys.each do |id|
      next if id == root_id
      next if parent_by_id.key?(id)
      next unless root_id

      parent_by_id[id] = root_id
      children_by_id[root_id] << id
    end

    children_by_id.each_value(&:uniq!)

    depth_by_id = {}
    if root_id
      depth_by_id[root_id] = 0
      queue = [root_id]
      until queue.empty?
        current_id = queue.shift
        children_by_id[current_id].each do |child_id|
          next if depth_by_id.key?(child_id)

          depth_by_id[child_id] = depth_by_id[current_id] + 1
          queue << child_id
        end
      end
    end

    worktree_by_id.keys.each do |id|
      depth_by_id[id] ||= (id == root_id ? 0 : 1)
    end

    x_units = {}
    placing = {}
    cursor = 0.0

    assign_x = nil
    assign_x = lambda do |id|
      return x_units[id] if x_units.key?(id)
      if placing[id]
        x_units[id] ||= cursor
        return x_units[id]
      end

      placing[id] = true
      child_ids = children_by_id[id]
        .select { |child_id| worktree_by_id.key?(child_id) }
        .sort_by { |child_id| worktree_by_id[child_id]&.branch.to_s }

      if child_ids.empty?
        x_units[id] = cursor
        cursor += 1.0
      else
        child_ids.each { |child_id| assign_x.call(child_id) }
        first_child = child_ids.first
        last_child = child_ids.last
        first_x = x_units[first_child] || assign_x.call(first_child)
        last_x = x_units[last_child] || assign_x.call(last_child)
        x_units[id] = (first_x + last_x) * 0.5
      end

      placing.delete(id)
      x_units[id]
    end

    roots = [root_id].compact
    worktree_by_id.each_key do |id|
      roots << id if parent_by_id[id].nil? && id != root_id
    end
    roots.uniq.each_with_index do |id, idx|
      assign_x.call(id)
      cursor += 0.8 if idx < roots.length - 1
    end

    worktree_by_id.each_key { |id| assign_x.call(id) unless x_units.key?(id) }

    # Layout params — generous spacing for premium look
    node_width = 200
    node_height = 62
    horizontal_gap = 48
    level_gap = 140
    canvas_padding_x = 80
    canvas_padding_y = 60

    unit_values = x_units.values
    min_unit = unit_values.min || 0.0
    max_unit = unit_values.max || 0.0
    unit_span = (max_unit - min_unit).abs
    unit_step = node_width + horizontal_gap
    canvas_width = [((unit_span + 1.0) * unit_step + canvas_padding_x * 2).round, 900].max
    max_depth = depth_by_id.values.max || 0
    canvas_height = (max_depth + 1) * level_gap + node_height + canvas_padding_y * 2

    nodes = worktree_by_id.values.map do |wt|
      x = canvas_padding_x + (x_units[wt.id] - min_unit) * unit_step
      y = canvas_padding_y + depth_by_id[wt.id] * level_gap

      {
        id: wt.id,
        x: x.round(1),
        y: y.round(1),
        width: node_width,
        height: node_height,
        center_x: (x + node_width / 2.0).round(1),
        center_y: (y + node_height / 2.0).round(1),
        worktree: wt
      }
    end.sort_by { |node| [node[:y], node[:x]] }

    node_by_id = nodes.index_by { |n| n[:id] }
    edge_pairs = parent_by_id.map { |child_id, parent_id| [parent_id, child_id] }.uniq

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
