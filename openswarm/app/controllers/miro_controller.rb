class MiroController < ApplicationController
  require 'net/http'
  require 'json'

  MIRO_API_BASE = "https://api.miro.com/v2"

  def sync
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
      message: "Synced #{created_items.count { |i| i[:type] == 'sticky_note' }} nodes and #{created_items.count { |i| i[:type] == 'connector' }} connectors to Miro",
      board_id: board_id,
      board_name: repo_name,
      board_url: board_url,
      items_created: created_items.length
    }, status: :ok

  rescue => e
    Rails.logger.error("[MiroController] Sync error: #{e.class}: #{e.message}\n#{e.backtrace.first(5).join("\n")}")
    render json: { error: "Sync failed: #{e.message}" }, status: :internal_server_error
  end

  private

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