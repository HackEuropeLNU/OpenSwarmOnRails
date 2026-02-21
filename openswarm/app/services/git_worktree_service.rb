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
      enrich_worktrees!(worktrees, main_root.strip)

      Result.new(success: true, data: {
        repo_root: main_root.strip,
        worktrees: worktrees,
        tree: build_tree(worktrees)
      })
    rescue => e
      Result.new(success: false, error: "#{e.class}: #{e.message}")
    end

    def create_worktree(repo_root:, parent_branch:, branch_name:)
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
        return Result.new(success: false, error: "Worktree path already exists: #{worktree_path}")
      end

      branch_exists = git(main_root, "show-ref", "--verify", "refs/heads/#{branch}")
      if branch_exists
        return Result.new(success: false, error: "Branch already exists: #{branch}")
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

      Result.new(success: true, data: {
        id: branch.gsub(/[^a-zA-Z0-9_-]/, "_"),
        branch: branch,
        path: worktree_path
      })
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
        id: branch.gsub(/[^a-zA-Z0-9_-]/, "_"),
        path: path,
        branch: branch,
        head: data[:head] || "",
        bare: data[:bare] || false,
        detached: data[:detached] || false,
        dirty: false,
        ahead: 0,
        behind: 0,
        state: is_main ? "main" : "committed",
        parent_branch: is_main ? nil : "main"
      )
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

    # Build a simple tree structure: { node: worktree, children: [...] }
    # For now, we treat the first worktree (main) as root and all others as children.
    # A smarter version could use branch naming or merge-base analysis.
    def build_tree(worktrees)
      return {} if worktrees.empty?

      root = worktrees.find { |wt| wt.parent_branch.nil? } || worktrees.first
      children = worktrees.reject { |wt| wt == root }

      {
        id: root.id,
        branch: root.branch,
        children: children.map { |c| { id: c.id, branch: c.branch, children: [] } }
      }
    end
  end
end
