class MiroController < ApplicationController
  require 'net/http'
  require 'json'

  MIRO_API_BASE = "https://api.miro.com/v2"

  # Push diagram to Miro (replaces existing content)
  def push
    diagram = params[:diagram] || {}
    nodes = diagram[:nodes] || []
    edges = diagram[:edges] || []
    repo_name = diagram[:repo] || "OpenSwarm"

    miro_api_token = ENV['MIRO_API_TOKEN']
    board_id = ENV['MIRO_BOARD_ID'] || "uXjVG8mLG60="

    unless miro_api_token.present?
      return render json: {
        error: "MIRO_API_TOKEN not configured. Please add it to your .env file."
      }, status: :unprocessable_entity
    end

    # Clean up previous diagram items before creating new ones
    deleted_count = cleanup_board_items(board_id, miro_api_token)
    Rails.logger.info("[MiroController] Cleaned up #{deleted_count} existing items from board")

    created_items = []
    node_id_map = {} # Maps our node IDs to Miro item IDs

    # Build hierarchical layout for Miro
    miro_positions = calculate_miro_layout(nodes)

    # Create sticky notes for each node
    nodes.each_with_index do |node, index|
      pos = miro_positions[node[:id]] || { x: index * 400, y: 0 }

      # Determine color based on node state (Miro only accepts named colors)
      fill_color = case
                   when node[:dirty] then "red" # red for dirty
                   when node[:parentBranch].nil? then "yellow" # yellow for root
                   else "light_blue" # light blue for normal
                   end

      sticky_data = {
        data: {
          content: "<strong>#{node[:branch]}</strong><br/>State: #{node[:state]}",
          shape: "rectangle"
        },
        style: {
          fillColor: fill_color
        },
        position: {
          x: pos[:x],
          y: pos[:y]
        }
      }

      result = miro_api_request(
        method: :post,
        path: "/boards/#{board_id}/sticky_notes",
        token: miro_api_token,
        body: sticky_data
      )

      if result[:success]
        node_id_map[node[:id]] = result[:data]["id"]
        created_items << { type: "sticky_note", id: result[:data]["id"], branch: node[:branch] }
      else
        Rails.logger.warn("[MiroController] Failed to create sticky note for #{node[:branch]}: #{result[:error]}")
      end
    end

    # Create connectors for each edge
    edges.each do |edge|
      from_miro_id = node_id_map[edge[:from]]
      to_miro_id = node_id_map[edge[:to]]

      next unless from_miro_id && to_miro_id

      connector_data = {
        startItem: {
          id: from_miro_id
        },
        endItem: {
          id: to_miro_id
        },
        style: {
          strokeColor: "#ff0000",
          strokeWidth: "2.0"
        },
        shape: "curved"
      }

      result = miro_api_request(
        method: :post,
        path: "/boards/#{board_id}/connectors",
        token: miro_api_token,
        body: connector_data
      )

      if result[:success]
        created_items << { type: "connector", id: result[:data]["id"] }
      else
        Rails.logger.warn("[MiroController] Failed to create connector: #{result[:error]}")
      end
    end

    board_url = "https://miro.com/app/board/#{board_id}/"

    render json: {
      message: "Pushed #{created_items.count { |i| i[:type] == 'sticky_note' }} nodes and #{created_items.count { |i| i[:type] == 'connector' }} connectors to Miro",
      board_id: board_id,
      board_name: repo_name,
      board_url: board_url,
      items_created: created_items.length
    }, status: :ok

  rescue => e
    Rails.logger.error("[MiroController] Push error: #{e.class}: #{e.message}\n#{e.backtrace.first(5).join("\n")}")
    render json: { error: "Push failed: #{e.message}" }, status: :internal_server_error
  end

  # Pull branches from Miro and create worktrees
  def pull
    repo_name = params[:repo].to_s
    preview_only = params[:preview] != false && params[:preview] != "false"
    branches_to_create = params[:branches_to_create] || []

    miro_api_token = ENV['MIRO_API_TOKEN']
    board_id = ENV['MIRO_BOARD_ID'] || "uXjVG8mLG60="

    unless miro_api_token.present?
      return render json: {
        error: "MIRO_API_TOKEN not configured. Please add it to your .env file."
      }, status: :unprocessable_entity
    end

    # Discover existing worktrees
    repos = discover_repos
    selected_repo = repos.find { |r| r[:name] == repo_name }
    
    unless selected_repo
      return render json: { error: "Repository '#{repo_name}' not found" }, status: :not_found
    end

    discovery = GitWorktreeService.discover(selected_repo[:root])
    unless discovery.success
      return render json: { error: discovery.error }, status: :unprocessable_entity
    end

    existing_branches = discovery.data[:worktrees].map(&:branch)

    if preview_only
      # Fetch sticky notes from Miro and compare
      miro_branches = fetch_miro_branches(board_id, miro_api_token)
      
      # Find branches in Miro that don't exist as worktrees
      new_branches = miro_branches.reject { |mb| existing_branches.include?(mb[:branch]) }

      render json: {
        existing_branches: existing_branches,
        miro_branches: miro_branches.map { |b| b[:branch] },
        new_branches: new_branches,
        board_id: board_id
      }, status: :ok
    else
      # Create worktrees for specified branches
      created = []
      errors = []

      branches_to_create.each do |branch_info|
        branch_name = branch_info[:branch] || branch_info["branch"]
        parent_branch = branch_info[:parent] || branch_info["parent"]

        # Default to first existing branch if no parent specified
        parent_branch = existing_branches.first if parent_branch.blank? || parent_branch == "root"

        next if existing_branches.include?(branch_name)

        result = GitWorktreeService.create_worktree(
          repo_root: selected_repo[:root],
          parent_branch: parent_branch,
          branch_name: branch_name,
          replace_existing: false,
          force_replace: false
        )

        if result.success
          created << branch_name
          existing_branches << branch_name
        else
          errors << { branch: branch_name, error: result.error }
        end
      end

      render json: {
        message: "Created #{created.length} worktree(s) from Miro",
        created: created,
        errors: errors
      }, status: :ok
    end

  rescue => e
    Rails.logger.error("[MiroController] Pull error: #{e.class}: #{e.message}\n#{e.backtrace.first(5).join("\n")}")
    render json: { error: "Pull failed: #{e.message}" }, status: :internal_server_error
  end

  private

  # Fetch branch names from Miro sticky notes
  def fetch_miro_branches(board_id, token)
    branches = []

    # Get all sticky notes
    result = miro_api_request(
      method: :get,
      path: "/boards/#{board_id}/sticky_notes?limit=50",
      token: token
    )

    return branches unless result[:success] && result[:data]["data"]

    # Get all connectors to determine parent relationships
    connectors_result = miro_api_request(
      method: :get,
      path: "/boards/#{board_id}/connectors?limit=50",
      token: token
    )

    connector_map = {}
    if connectors_result[:success] && connectors_result[:data]["data"]
      connectors_result[:data]["data"].each do |connector|
        end_id = connector.dig("endItem", "id")
        start_id = connector.dig("startItem", "id")
        connector_map[end_id] = start_id if end_id && start_id
      end
    end

    # Build sticky note ID to branch map
    sticky_id_to_branch = {}
    result[:data]["data"].each do |sticky_note|
      content = sticky_note.dig("data", "content") || ""
      # Extract branch name from content (format: <strong>branch-name</strong>...)
      branch_match = content.match(/<strong>([^<]+)<\/strong>/)
      branch_name = branch_match ? branch_match[1].strip : nil
      
      if branch_name.present?
        sticky_id_to_branch[sticky_note["id"]] = branch_name
      end
    end

    # Build branches array with parent info
    sticky_id_to_branch.each do |sticky_id, branch_name|
      parent_sticky_id = connector_map[sticky_id]
      parent_branch = parent_sticky_id ? sticky_id_to_branch[parent_sticky_id] : nil

      branches << {
        branch: branch_name,
        parent: parent_branch,
        miro_id: sticky_id
      }
    end

    branches
  end

  # Discover repos (copied from WorktreesController)
  def discover_repos
    roots = session_repo_roots
    repos = []

    roots.each do |root|
      next unless File.directory?(root)
      result = GitWorktreeService.discover(root)
      if result.success
        repos << {
          name: File.basename(root),
          root: root,
          worktree_count: result.data[:worktrees].length
        }
      end
    end

    repos
  end

  def session_repo_roots
    Array(session[:openswarm_repo_roots]).presence || default_repo_roots
  end

  def default_repo_roots
    workspace = ENV.fetch("OPENSWARM_WORKSPACE", File.expand_path("~/Workspace"))
    return [] unless File.directory?(workspace)

    Dir.children(workspace)
       .map { |name| File.join(workspace, name) }
       .select { |path| File.directory?(path) && File.exist?(File.join(path, ".git")) }
       .first(10)
  end

  # Calculate hierarchical layout positions for Miro
  # Root node at top center, children spread horizontally below
  def calculate_miro_layout(nodes)
    return {} if nodes.empty?

    positions = {}
    node_width = 300  # Approximate sticky note width in Miro
    node_height = 150 # Approximate sticky note height in Miro
    horizontal_gap = 100
    vertical_gap = 200

    # Find root node (no parent branch)
    root = nodes.find { |n| n[:parentBranch].nil? }
    return {} unless root

    # Build children map
    children_map = {}
    nodes.each do |node|
      parent_branch = node[:parentBranch]
      if parent_branch
        children_map[parent_branch] ||= []
        children_map[parent_branch] << node
      end
    end

    # Calculate positions level by level using BFS
    queue = [[root, 0]] # [node, level]
    levels = {}

    while queue.any?
      node, level = queue.shift
      levels[level] ||= []
      levels[level] << node

      children = children_map[node[:branch]] || []
      children.each { |child| queue << [child, level + 1] }
    end

    # Position each level
    levels.each do |level, level_nodes|
      total_width = level_nodes.length * node_width + (level_nodes.length - 1) * horizontal_gap
      start_x = -total_width / 2

      level_nodes.each_with_index do |node, index|
        x = start_x + index * (node_width + horizontal_gap) + node_width / 2
        y = level * (node_height + vertical_gap)
        positions[node[:id]] = { x: x, y: y }
      end
    end

    positions
  end

  # Clean up existing sticky notes and connectors from the board
  def cleanup_board_items(board_id, token)
    deleted_count = 0

    # Delete all connectors first (they reference sticky notes)
    connectors_result = miro_api_request(
      method: :get,
      path: "/boards/#{board_id}/connectors?limit=50",
      token: token
    )

    if connectors_result[:success] && connectors_result[:data]["data"]
      connectors_result[:data]["data"].each do |connector|
        delete_result = miro_api_request(
          method: :delete,
          path: "/boards/#{board_id}/connectors/#{connector['id']}",
          token: token
        )
        deleted_count += 1 if delete_result[:success]
      end
    end

    # Delete all sticky notes
    sticky_notes_result = miro_api_request(
      method: :get,
      path: "/boards/#{board_id}/sticky_notes?limit=50",
      token: token
    )

    if sticky_notes_result[:success] && sticky_notes_result[:data]["data"]
      sticky_notes_result[:data]["data"].each do |sticky_note|
        delete_result = miro_api_request(
          method: :delete,
          path: "/boards/#{board_id}/sticky_notes/#{sticky_note['id']}",
          token: token
        )
        deleted_count += 1 if delete_result[:success]
      end
    end

    deleted_count
  end

  def miro_api_request(method:, path:, token:, body: nil)
    uri = URI("#{MIRO_API_BASE}#{path}")
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = true
    http.read_timeout = 30

    request = case method
              when :get then Net::HTTP::Get.new(uri)
              when :post then Net::HTTP::Post.new(uri)
              when :put then Net::HTTP::Put.new(uri)
              when :delete then Net::HTTP::Delete.new(uri)
              end

    request["Authorization"] = "Bearer #{token}"
    request["Content-Type"] = "application/json"
    request["Accept"] = "application/json"
    request.body = body.to_json if body

    response = http.request(request)

    if response.is_a?(Net::HTTPSuccess)
      { success: true, data: JSON.parse(response.body) }
    else
      { success: false, error: response.body, status: response.code }
    end
  rescue => e
    { success: false, error: e.message }
  end
end