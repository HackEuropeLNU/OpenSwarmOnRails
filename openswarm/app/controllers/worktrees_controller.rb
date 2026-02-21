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
    replace_existing = ActiveModel::Type::Boolean.new.cast(params[:replace_existing])
    force_replace = ActiveModel::Type::Boolean.new.cast(params[:force_replace])

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
      branch_name: worktree_name,
      replace_existing: replace_existing,
      force_replace: force_replace
    )

    unless result.success
      return render json: { error: result.error }, status: :unprocessable_entity
    end

    render json: {
      id: result.data[:id],
      branch: result.data[:branch],
      redirect_url: worktrees_path(repo: repo_name, selected: result.data[:id])
    }
  rescue => e
    Rails.logger.error("[create_worktree] #{e.class}: #{e.message}\n#{Array(e.backtrace).join("\n")}")
    render json: { error: "Internal error creating worktree: #{e.message}" }, status: :internal_server_error
  end

  def open_project
    requested_root = params[:repo_root].to_s.strip
    return render json: { error: "Repository path is required" }, status: :unprocessable_entity if requested_root.empty?

    resolved_root = git_toplevel_for(requested_root)
    return render json: { error: "Selected folder is not a git repository" }, status: :unprocessable_entity unless resolved_root

    roots = session_repo_roots
    roots.delete(resolved_root)
    roots.unshift(resolved_root)
    session[:openswarm_repo_roots] = roots

    render json: {
      ok: true,
      repo_name: File.basename(resolved_root),
      redirect_url: worktrees_path(repo: File.basename(resolved_root))
    }
  rescue => e
    Rails.logger.error("[open_project] #{e.class}: #{e.message}\n#{Array(e.backtrace).join("\n")}")
    render json: { error: "Internal error opening project: #{e.message}" }, status: :internal_server_error
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

  def delete_worktree
    repo_name = params[:repo].to_s
    worktree_id = params[:worktree_id].to_s
    force = ActiveModel::Type::Boolean.new.cast(params[:force])

    repos = discover_repos
    selected_repo = repos.find { |r| r[:name] == repo_name }
    return render json: { error: "Repository not found" }, status: :not_found unless selected_repo

    discovery = GitWorktreeService.discover(selected_repo[:root])
    unless discovery.success
      return render json: { error: discovery.error }, status: :unprocessable_entity
    end

    worktree = discovery.data[:worktrees].find { |wt| wt.id == worktree_id }
    return render json: { error: "Worktree not found" }, status: :unprocessable_entity unless worktree
    return render json: { error: "Cannot delete main worktree" }, status: :unprocessable_entity if worktree.parent_branch.nil?
    if worktree.dirty && !force
      return render json: { error: "Worktree has uncommitted changes. Enable force delete to continue." }, status: :unprocessable_entity
    end

    result = GitWorktreeService.delete_worktree(
      repo_root: selected_repo[:root],
      worktree_path: worktree.path,
      force: force
    )

    unless result.success
      return render json: { error: result.error }, status: :unprocessable_entity
    end

    render json: {
      ok: true,
      redirect_url: worktrees_path(repo: repo_name)
    }
  rescue => e
    Rails.logger.error("[delete_worktree] #{e.class}: #{e.message}\n#{Array(e.backtrace).join("\n")}")
    render json: { error: "Internal error deleting worktree: #{e.message}" }, status: :internal_server_error
  end

  def fetch_pull_parent
    repo_name = params[:repo].to_s
    worktree_id = params[:worktree_id].to_s

    selected_repo, worktree, = resolve_repo_and_worktree(repo_name, worktree_id)
    return unless selected_repo && worktree

    result = GitWorktreeService.fetch_pull_parent(
      repo_root: selected_repo[:root],
      worktree_path: worktree.path
    )

    unless result.success
      return render json: { error: result.error }, status: :unprocessable_entity
    end

    render json: {
      ok: true,
      redirect_url: worktrees_path(repo: repo_name, selected: worktree.id),
      output: result.data[:output]
    }
  rescue => e
    Rails.logger.error("[fetch_pull_parent] #{e.class}: #{e.message}\n#{Array(e.backtrace).join("\n")}")
    render json: { error: "Internal error fetching/pulling worktree: #{e.message}" }, status: :internal_server_error
  end

  def rebase_onto_parent
    repo_name = params[:repo].to_s
    worktree_id = params[:worktree_id].to_s

    selected_repo, worktree, = resolve_repo_and_worktree(repo_name, worktree_id)
    return unless selected_repo && worktree

    if worktree.parent_branch.to_s.strip.empty?
      return render json: { error: "Selected worktree has no parent branch" }, status: :unprocessable_entity
    end

    result = GitWorktreeService.rebase_onto_parent(
      repo_root: selected_repo[:root],
      worktree_path: worktree.path,
      parent_branch: worktree.parent_branch
    )

    unless result.success
      return render json: { error: result.error }, status: :unprocessable_entity
    end

    render json: {
      ok: true,
      redirect_url: worktrees_path(repo: repo_name, selected: worktree.id),
      output: result.data[:output]
    }
  rescue => e
    Rails.logger.error("[rebase_onto_parent] #{e.class}: #{e.message}\n#{Array(e.backtrace).join("\n")}")
    render json: { error: "Internal error rebasing worktree: #{e.message}" }, status: :internal_server_error
  end

  def commit_selected
    repo_name = params[:repo].to_s
    worktree_id = params[:worktree_id].to_s
    message = params[:message].to_s.strip

    return render json: { error: "Commit message is required" }, status: :unprocessable_entity if message.empty?

    selected_repo, worktree, = resolve_repo_and_worktree(repo_name, worktree_id)
    return unless selected_repo && worktree

    result = GitWorktreeService.commit_selected(
      repo_root: selected_repo[:root],
      worktree_path: worktree.path,
      message: message
    )

    unless result.success
      return render json: { error: result.error }, status: :unprocessable_entity
    end

    render json: {
      ok: true,
      redirect_url: worktrees_path(repo: repo_name, selected: worktree.id),
      output: result.data[:output]
    }
  rescue => e
    Rails.logger.error("[commit_selected] #{e.class}: #{e.message}\n#{Array(e.backtrace).join("\n")}")
    render json: { error: "Internal error committing worktree: #{e.message}" }, status: :internal_server_error
  end

  def push_selected
    repo_name = params[:repo].to_s
    worktree_id = params[:worktree_id].to_s

    selected_repo, worktree, = resolve_repo_and_worktree(repo_name, worktree_id)
    return unless selected_repo && worktree

    result = GitWorktreeService.push_selected(
      repo_root: selected_repo[:root],
      worktree_path: worktree.path
    )

    unless result.success
      return render json: { error: result.error }, status: :unprocessable_entity
    end

    render json: {
      ok: true,
      redirect_url: worktrees_path(repo: repo_name, selected: worktree.id),
      output: result.data[:output]
    }
  rescue => e
    Rails.logger.error("[push_selected] #{e.class}: #{e.message}\n#{Array(e.backtrace).join("\n")}")
    render json: { error: "Internal error pushing worktree: #{e.message}" }, status: :internal_server_error
  end

  def merge_to_parent
    repo_name = params[:repo].to_s
    worktree_id = params[:worktree_id].to_s

    selected_repo, worktree, = resolve_repo_and_worktree(repo_name, worktree_id)
    return unless selected_repo && worktree

    if worktree.parent_branch.to_s.strip.empty?
      return render json: { error: "Selected worktree has no parent branch" }, status: :unprocessable_entity
    end

    result = GitWorktreeService.merge_to_parent(
      repo_root: selected_repo[:root],
      worktree_path: worktree.path,
      parent_branch: worktree.parent_branch
    )

    unless result.success
      return render json: { error: result.error }, status: :unprocessable_entity
    end

    selected_id = result.data[:parent_id] || worktree.id

    render json: {
      ok: true,
      redirect_url: worktrees_path(repo: repo_name, selected: selected_id),
      output: result.data[:output]
    }
  rescue => e
    Rails.logger.error("[merge_to_parent] #{e.class}: #{e.message}\n#{Array(e.backtrace).join("\n")}")
    render json: { error: "Internal error merging to parent: #{e.message}" }, status: :internal_server_error
  end

  private

  def resolve_repo_and_worktree(repo_name, worktree_id)
    repos = discover_repos
    selected_repo = repos.find { |r| r[:name] == repo_name }
    unless selected_repo
      render json: { error: "Repository not found" }, status: :not_found
      return [nil, nil, nil]
    end

    discovery = GitWorktreeService.discover(selected_repo[:root])
    unless discovery.success
      render json: { error: discovery.error }, status: :unprocessable_entity
      return [nil, nil, nil]
    end

    worktree = discovery.data[:worktrees].find { |wt| wt.id == worktree_id }
    unless worktree
      render json: { error: "Worktree not found" }, status: :unprocessable_entity
      return [nil, nil, nil]
    end

    [selected_repo, worktree, discovery]
  end

  def repo_roots
    roots = []
    roots.concat(session_repo_roots)

    configured_roots = ENV.fetch("OPENSWARM_REPO_ROOTS", "")
      .split(File::PATH_SEPARATOR)
      .map(&:strip)
      .reject(&:empty?)

    roots.concat(configured_roots)
    roots << Rails.root.join("..").expand_path.to_s if roots.empty?
    roots.uniq
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

  def session_repo_roots
    Array(session[:openswarm_repo_roots])
      .map(&:to_s)
      .map(&:strip)
      .reject(&:empty?)
      .select { |root| File.directory?(root) }
  end

  def git_toplevel_for(path)
    return nil unless File.directory?(path)

    require "open3"
    stdout, _stderr, status = Open3.capture3("git", "-C", path, "rev-parse", "--show-toplevel")
    return nil unless status.success?

    root = stdout.to_s.strip
    return nil if root.empty?

    root
  rescue
    nil
  end

  # Compute x,y positions and SVG edges for worktrees.
  # Uses the same layered approach as OpenSwarm TUI.
  def compute_layout(_tree, worktrees)
    return { nodes: [], edges: [], width: 1000, height: 400 } if worktrees.empty?

    worktree_by_id = worktrees.index_by(&:id)
    root = worktrees.find { |wt| wt.parent_branch.nil? && !wt.detached } || worktrees.first
    root_id = root&.id

    branch_to_id = {}
    worktrees.each do |wt|
      next if wt.detached || wt.branch == "(detached)"

      branch_to_id[wt.branch] ||= wt.id
    end

    parent_by_id = {}
    worktrees.each do |wt|
      next if wt.id == root_id
      next if wt.detached

      parent_id = nil
      if wt.parent_branch
        parent_id = branch_to_id[wt.parent_branch]
      end

      parent_id ||= find_branch_parent_id(wt.id, wt.branch, branch_to_id)
      parent_id = root_id if parent_id.nil? || parent_id == wt.id
      parent_by_id[wt.id] = parent_id if parent_id
    end

    children_by_id = Hash.new { |h, k| h[k] = [] }
    parent_by_id.each do |child_id, parent_id|
      children_by_id[parent_id] << child_id
    end
    children_by_id.each_value do |children|
      children.uniq!
      children.sort_by! { |child_id| worktree_by_id[child_id]&.branch.to_s }
    end

    depth_by_id = {}
    depth_for = nil
    depth_for = lambda do |id, visiting = {}|
      return depth_by_id[id] if depth_by_id.key?(id)
      return 0 if visiting[id]

      parent_id = parent_by_id[id]
      if parent_id.nil? || parent_id == id || !worktree_by_id.key?(parent_id)
        depth_by_id[id] = 0
      else
        visiting[id] = true
        depth_by_id[id] = depth_for.call(parent_id, visiting) + 1
        visiting.delete(id)
      end
      depth_by_id[id]
    end
    worktree_by_id.each_key { |id| depth_for.call(id) }

    x_units = {}
    placing = {}
    cursor = 0.0

    assign_x = nil
    assign_x = lambda do |id|
      return x_units[id] if x_units.key?(id)
      return cursor if placing[id]

      placing[id] = true
      child_ids = children_by_id[id].select { |child_id| worktree_by_id.key?(child_id) }

      if child_ids.empty?
        x_units[id] = cursor
        cursor += 1.0
      else
        child_ids.each { |child_id| assign_x.call(child_id) }
        placed = child_ids.filter_map { |cid| x_units[cid] }
        x_units[id] = placed.empty? ? cursor : (placed.first + placed.last) * 0.5
      end

      placing.delete(id)
      x_units[id]
    end

    roots = [root_id].compact
    worktree_by_id.each_key do |id|
      roots << id unless parent_by_id.key?(id)
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

  def find_branch_parent_id(current_id, branch, branch_to_id)
    parts = branch.to_s.split("/")
    while parts.length > 1
      parts.pop
      candidate = parts.join("/")
      parent_id = branch_to_id[candidate]
      return parent_id if parent_id && parent_id != current_id
    end
    nil
  end
end
