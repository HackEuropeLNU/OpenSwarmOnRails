# frozen_string_literal: true

# Discovers and inspects git worktrees for registered repository roots.
# Uses Open3 + git CLI for reliable worktree support.
class GitWorktreeService
  Result = Struct.new(:success, :data, :error, keyword_init: true)

  WorktreeInfo = Struct.new(
    :id, :path, :branch, :head, :bare, :detached,
    :dirty, :ahead, :behind, :state, :parent_branch,
    keyword_init: true
  )

  class << self
    # Discover all worktrees for a given repo root.
    # repo_root: absolute path to the main git repository (or any worktree in it)
    def discover(repo_root)
      return Result.new(success: false, error: "Path does not exist: #{repo_root}") unless File.directory?(repo_root)

      # Find the main worktree root first
      main_root = git(repo_root, "rev-parse", "--show-toplevel")
      return Result.new(success: false, error: "Not a git repository: #{repo_root}") unless main_root

      porcelain = git(repo_root, "worktree", "list", "--porcelain")
      return Result.new(success: false, error: "Failed to list worktrees") unless porcelain

      worktrees = parse_porcelain(porcelain, main_root.strip)
      assign_parent_branches!(worktrees, main_root.strip)
      enrich_worktrees!(worktrees, main_root.strip)

      Result.new(success: true, data: {
        repo_root: main_root.strip,
        worktrees: worktrees,
        tree: build_tree(worktrees)
      })
    rescue => e
      Result.new(success: false, error: "#{e.class}: #{e.message}")
    end

    def create_worktree(repo_root:, parent_branch:, branch_name:, replace_existing: false, force_replace: false)
      return Result.new(success: false, error: "Path does not exist: #{repo_root}") unless File.directory?(repo_root)
      return Result.new(success: false, error: "Parent branch is required") if parent_branch.to_s.strip.empty?

      branch = normalize_branch_name(branch_name)
      return Result.new(success: false, error: "Worktree name is invalid") if branch.nil?

      if branch == "main"
        return Result.new(success: false, error: "Choose a branch name other than main")
      end

      main_root = git(repo_root, "rev-parse", "--show-toplevel")
      return Result.new(success: false, error: "Not a git repository: #{repo_root}") unless main_root

      main_root = main_root.strip
      workspace_root = File.join(File.dirname(main_root), ".#{File.basename(main_root)}-workspaces")
      require "fileutils"
      FileUtils.mkdir_p(workspace_root)

      path_slug = branch.tr("/", "__")
      worktree_path = File.join(workspace_root, path_slug)

      if File.exist?(worktree_path)
        unless replace_existing
          return Result.new(success: false, error: "Worktree path already exists: #{worktree_path}")
        end
      end

      branch_exists = git(main_root, "show-ref", "--verify", "refs/heads/#{branch}")
      if branch_exists
        unless replace_existing
          return Result.new(success: false, error: "Branch already exists: #{branch}")
        end

        cleanup_result = remove_existing_branch_and_worktree(
          main_root: main_root,
          branch: branch,
          force: force_replace
        )
        return cleanup_result unless cleanup_result.success
      end

      if replace_existing && File.exist?(worktree_path)
        unless worktree_path.start_with?("#{workspace_root}/")
          return Result.new(success: false, error: "Refusing to remove unexpected path: #{worktree_path}")
        end

        FileUtils.rm_rf(worktree_path)
      end

      stdout, stderr, status = git_capture3(
        main_root,
        "worktree", "add", "-b", branch, worktree_path, parent_branch
      )

      unless status.success?
        error = stderr.to_s.strip
        error = stdout.to_s.strip if error.empty?
        error = "Failed to create worktree" if error.empty?
        return Result.new(success: false, error: error)
      end

      save_parent_hint(main_root, branch, parent_branch)

      Result.new(success: true, data: {
        id: worktree_id_for(worktree_path, branch),
        branch: branch,
        path: worktree_path
      })
    rescue => e
      Result.new(success: false, error: "#{e.class}: #{e.message}")
    end

    def delete_worktree(repo_root:, worktree_path:, force: false)
      return Result.new(success: false, error: "Path does not exist: #{repo_root}") unless File.directory?(repo_root)

      main_root = git(repo_root, "rev-parse", "--show-toplevel")
      return Result.new(success: false, error: "Not a git repository: #{repo_root}") unless main_root

      main_root = main_root.strip
      target_path = worktree_path.to_s.strip
      return Result.new(success: false, error: "Worktree path is required") if target_path.empty?
      return Result.new(success: false, error: "Cannot delete main worktree") if target_path == main_root

      args = ["worktree", "remove"]
      args << "--force" if force
      args << target_path

      stdout, stderr, status = git_capture3(main_root, *args)
      unless status.success?
        error = stderr.to_s.strip
        error = stdout.to_s.strip if error.empty?
        error = "Failed to delete worktree" if error.empty?
        return Result.new(success: false, error: error)
      end

      Result.new(success: true, data: { path: target_path })
    rescue => e
      Result.new(success: false, error: "#{e.class}: #{e.message}")
    end

    # Scan known workspace patterns to find repo roots automatically.
    # Returns array of repo root paths.
    def scan_workspaces(*roots)
      roots.flat_map do |root|
        next [] unless File.directory?(root)

        # Check if root itself is a git repo
        candidates = []
        if git_repo?(root)
          candidates << root
        end

        # Check subdirectories
        Dir.glob(File.join(root, "*")).each do |child|
          next unless File.directory?(child)
          candidates << child if git_repo?(child)
        end

        candidates.uniq
      end.compact.uniq
    end

    private

    def git(working_dir, *args)
      stdout, _stderr, status = git_capture3(working_dir, *args)
      status.success? ? stdout : nil
    end

    def git_capture3(working_dir, *args)
      require "open3"
      Open3.capture3("git", *args, chdir: working_dir)
    end

    def normalize_branch_name(raw_name)
      name = raw_name.to_s.strip
      return nil if name.empty?

      name = name.gsub(/\s+/, "-")
      name = name.gsub(%r{[^a-zA-Z0-9_./-]}, "-")
      name = name.gsub(%r{/+}, "/")
      name = name.gsub(%r{\A/+|/+$}, "")
      name = name.gsub(/-+/, "-")
      return nil if name.empty?
      return nil if name.start_with?(".") || name.end_with?(".")
      return nil if name.include?("..")
      return nil if name.end_with?(".lock")

      name
    end

    def git_repo?(path)
      result = git(path, "rev-parse", "--git-dir")
      !result.nil?
    end

    def remove_existing_branch_and_worktree(main_root:, branch:, force:)
      discovery = discover(main_root)
      return Result.new(success: false, error: discovery.error) unless discovery.success

      existing = discovery.data[:worktrees].find { |wt| wt.branch == branch && !wt.detached }
      if existing
        if existing.parent_branch.nil?
          return Result.new(success: false, error: "Cannot replace main worktree branch: #{branch}")
        end

        removal = delete_worktree(repo_root: main_root, worktree_path: existing.path, force: force)
        return removal unless removal.success
      end

      delete_flag = force ? "-D" : "-d"
      stdout, stderr, status = git_capture3(main_root, "branch", delete_flag, branch)
      unless status.success?
        error = stderr.to_s.strip
        error = stdout.to_s.strip if error.empty?
        error = "Failed to delete existing branch: #{branch}" if error.empty?
        return Result.new(success: false, error: error)
      end

      Result.new(success: true, data: { branch: branch })
    rescue => e
      Result.new(success: false, error: "#{e.class}: #{e.message}")
    end

    def parse_porcelain(output, main_root)
      worktrees = []
      current = {}

      output.each_line do |line|
        line = line.strip
        if line.empty?
          worktrees << build_worktree_info(current, main_root) if current[:worktree]
          current = {}
        elsif line.start_with?("worktree ")
          current[:worktree] = line.sub("worktree ", "")
        elsif line.start_with?("HEAD ")
          current[:head] = line.sub("HEAD ", "")
        elsif line.start_with?("branch ")
          current[:branch] = line.sub("branch ", "").sub("refs/heads/", "")
        elsif line == "bare"
          current[:bare] = true
        elsif line == "detached"
          current[:detached] = true
        end
      end

      # Handle last entry (porcelain output ends with blank line, but just in case)
      worktrees << build_worktree_info(current, main_root) if current[:worktree]
      worktrees
    end

    def build_worktree_info(data, main_root)
      path = data[:worktree]
      branch = data[:branch] || "(detached)"
      is_main = (path == main_root)

      WorktreeInfo.new(
        id: worktree_id_for(path, branch),
        path: path,
        branch: branch,
        head: data[:head] || "",
        bare: data[:bare] || false,
        detached: data[:detached] || false,
        dirty: false,
        ahead: 0,
        behind: 0,
        state: is_main ? "main" : "committed",
        parent_branch: nil
      )
    end

    def worktree_id_for(path, branch)
      require "digest"

      branch_part = branch.to_s.gsub(/[^a-zA-Z0-9_-]/, "_")
      branch_part = "worktree" if branch_part.empty?
      "#{branch_part}_#{Digest::SHA1.hexdigest(path.to_s)[0, 10]}"
    end

    def assign_parent_branches!(worktrees, main_root)
      root = worktrees.find { |wt| wt.path == main_root }
      root_branch = root&.branch || "main"
      hints = load_parent_hint_map(main_root)

      branch_to_worktree = worktrees.each_with_object({}) do |wt, acc|
        next if wt.detached || wt.branch.empty? || wt.branch == "(detached)"

        acc[wt.branch] ||= wt
      end

      worktrees.each do |wt|
        wt.parent_branch = nil
        next if wt == root
        next if wt.detached || wt.branch.empty? || wt.branch == "(detached)"

        hinted_parent = hints[wt.branch]
        parent_branch = if hinted_parent && hinted_parent != wt.branch && branch_to_worktree.key?(hinted_parent)
          hinted_parent
        else
          find_branch_parent_branch(wt.branch, branch_to_worktree)
        end

        parent_branch ||= root_branch
        parent_branch = root_branch if parent_branch == wt.branch
        wt.parent_branch = parent_branch
      end

      repair_parent_cycles!(worktrees, root_branch)
    end

    def find_branch_parent_branch(branch, branch_to_worktree)
      parts = branch.to_s.split("/")
      while parts.length > 1
        parts.pop
        candidate = parts.join("/")
        return candidate if branch_to_worktree.key?(candidate)
      end

      nil
    end

    def workspaces_container_for_root(main_root)
      File.join(File.dirname(main_root), ".#{File.basename(main_root)}-workspaces")
    end

    def parent_hint_map_path(main_root)
      File.join(workspaces_container_for_root(main_root), ".parent-hints")
    end

    def load_parent_hint_map(main_root)
      path = parent_hint_map_path(main_root)
      return {} unless File.file?(path)

      map = {}
      File.readlines(path, chomp: true).each do |line|
        row = line.strip
        next if row.empty? || row.start_with?("#")

        child, parent = row.split("\t", 2)
        next if child.to_s.strip.empty? || parent.to_s.strip.empty?

        map[child.strip] = parent.strip
      end

      map
    rescue
      {}
    end

    def save_parent_hint(main_root, child_branch, parent_branch)
      return if child_branch.to_s.strip.empty? || parent_branch.to_s.strip.empty?

      require "fileutils"
      path = parent_hint_map_path(main_root)
      FileUtils.mkdir_p(File.dirname(path))

      map = load_parent_hint_map(main_root)
      map[child_branch.to_s.strip] = parent_branch.to_s.strip

      content = map.sort_by { |child, _| child }
        .map { |child, parent| "#{child}\t#{parent}" }
        .join("\n")
      content = "#{content}\n" unless content.empty?
      File.write(path, content)
    rescue
      nil
    end

    def repair_parent_cycles!(worktrees, root_branch)
      by_branch = worktrees.each_with_object({}) do |wt, acc|
        next if wt.detached || wt.branch.empty? || wt.branch == "(detached)"

        acc[wt.branch] ||= wt
      end

      branch_to_parent = worktrees.each_with_object({}) do |wt, acc|
        next if wt.detached || wt.branch.empty? || wt.branch == "(detached)"
        next if wt.parent_branch.to_s.empty?

        acc[wt.branch] = wt.parent_branch
      end

      loop do
        changed = false

        branch_to_parent.keys.each do |start_branch|
          seen = {}
          current = start_branch

          loop do
            parent = branch_to_parent[current]
            break if parent.to_s.empty?

            if parent == current || seen[parent]
              branch_to_parent[current] = root_branch
              if (wt = by_branch[current])
                wt.parent_branch = root_branch
              end
              changed = true
              break
            end

            seen[current] = true
            current = parent
          end
        end

        break unless changed
      end
    end

    # Enrich worktrees with dirty status, ahead/behind counts
    def enrich_worktrees!(worktrees, main_root)
      worktrees.each do |wt|
        next if wt.bare
        next unless File.directory?(wt.path)

        # Check dirty status
        status_output = git(wt.path, "status", "--porcelain")
        wt.dirty = status_output && !status_output.strip.empty?

        # Determine state based on dirty and other info
        if wt.dirty
          wt.state = "dirty"
        end

        # Check ahead/behind relative to remote tracking branch
        tracking = git(wt.path, "rev-parse", "--abbrev-ref", "#{wt.branch}@{upstream}")
        if tracking && !tracking.strip.empty?
          rev_list = git(wt.path, "rev-list", "--left-right", "--count", "#{wt.branch}...#{tracking.strip}")
          if rev_list
            parts = rev_list.strip.split(/\s+/)
            wt.ahead = parts[0].to_i
            wt.behind = parts[1].to_i
          end
        end

        # Check ahead/behind relative to main branch (parent)
        if wt.parent_branch
          rev_list = git(wt.path, "rev-list", "--left-right", "--count", "#{wt.branch}...#{wt.parent_branch}")
          if rev_list
            parts = rev_list.strip.split(/\s+/)
            wt.ahead = parts[0].to_i
            wt.behind = parts[1].to_i
          end
        end

        # Refine state
        if wt.state != "dirty"
          if wt.behind > 0
            wt.state = "behind parent"
          elsif wt.ahead > 0
            wt.state = "ahead"
          else
            wt.state = wt.parent_branch.nil? ? "main" : "committed"
          end
        end
      end
    end

    # Build nested tree structure based on parent_branch links.
    def build_tree(worktrees)
      return {} if worktrees.empty?

      by_branch = worktrees.each_with_object({}) { |wt, acc| acc[wt.branch] = wt }
      root = worktrees.find { |wt| wt.parent_branch.nil? } || by_branch["main"] || worktrees.first
      children_by_id = Hash.new { |h, k| h[k] = [] }

      worktrees.each do |wt|
        next if wt == root

        parent = by_branch[wt.parent_branch]
        parent = root if parent.nil? || parent == wt
        children_by_id[parent.id] << wt
      end

      build_node = nil
      visited = {}
      build_node = lambda do |wt|
        return { id: wt.id, branch: wt.branch, children: [] } if visited[wt.id]

        visited[wt.id] = true
        {
          id: wt.id,
          branch: wt.branch,
          children: children_by_id[wt.id].map { |child| build_node.call(child) }
        }
      end

      build_node.call(root)
    end
  end
end
