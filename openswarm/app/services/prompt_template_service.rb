# frozen_string_literal: true

class PromptTemplateService
  PROMPT_PATH = Rails.root.join("config", "prompt.json")

  DEFAULT_PROMPTS = {
    "merge_conflict_resolver" => <<~PROMPT.strip,
      Resolve the current Git merge conflict in this worktree.

      Context:
      - Parent worktree path: {parent_path}
      - Merge source branch: {source_branch}
      - Merge target branch: {target_branch}
      - Conflicted files:
      {conflicted_files}

      Instructions:
      1) Inspect conflict markers and resolve carefully; prefer minimal safe edits.
      2) Keep intended behavior from both branches when possible.
      3) Run `git diff --name-only --diff-filter=U` and ensure it is empty.
      4) Stage resolved files with `git add`.
      5) Summarize what was resolved and any risks.
      6) Do not push. Stop after conflicts are resolved and staged.
    PROMPT
    "orchestrator" => <<~PROMPT.strip
      You are a worktree orchestrator. Your job is to break down a feature request into appropriate git worktrees for parallel development.

      Context:
      - Parent worktree path: {parent_path}
      - Feature request: {feature_description}

      Instructions:
      1) Analyze the feature request and determine what worktrees are needed.
      2) Do NOT output a JSON plan. Create the worktrees directly.
      3) Consider splitting worktrees by:
         - Frontend vs Backend concerns
         - API contracts vs implementation
         - Database/migrations vs application code
         - Configuration vs feature code
      4) Keep branch names short, lowercase, and use hyphens (e.g., "auth-api", "auth-frontend", "auth-migrations").
      5) Determine the current parent branch from the parent worktree.
      6) Use this command pattern for every planned worktree:
         git -C "{parent_path}" worktree add -b "<branch-name>" "$(dirname "{parent_path}")/<branch-name-with-slashes-replaced-by-dashes>" "<current-parent-branch>"
      7) You must execute the commands. Do not stop after planning.
      8) After creating all worktrees, run:
         git -C "{parent_path}" worktree list
      9) Report what you created as a concise human-readable list (branch -> path).
      10) Do NOT implement code, modify files, or run project changes inside any created worktree; only create the worktrees.
    PROMPT
  }.freeze

  class << self
    def merge_conflict_resolver_prompt(parent_path:, source_branch:, target_branch:, conflicted_files:)
      template = load_prompts.fetch("merge_conflict_resolver", DEFAULT_PROMPTS["merge_conflict_resolver"])
      files = conflicted_files.presence || ["(none reported)"]
      formatted_files = files.map { |file| "- #{file}" }.join("\n")

      template
        .to_s
        .gsub("{parent_path}", parent_path.to_s)
        .gsub("{source_branch}", source_branch.to_s)
        .gsub("{target_branch}", target_branch.to_s)
        .gsub("{conflicted_files}", formatted_files)
    end

    def orchestrator_prompt(parent_path:, feature_description:)
      template = load_prompts.fetch("orchestrator", DEFAULT_PROMPTS["orchestrator"])

      template
        .to_s
        .gsub("{parent_path}", parent_path.to_s)
        .gsub("{feature_description}", feature_description.to_s)
    end

    private

    def load_prompts
      ensure_prompt_file!

      raw = File.read(PROMPT_PATH)
      parsed = JSON.parse(raw)
      parsed.is_a?(Hash) ? parsed : {}
    rescue JSON::ParserError, Errno::ENOENT
      {}
    end

    def ensure_prompt_file!
      return if File.file?(PROMPT_PATH)

      File.write(PROMPT_PATH, "#{JSON.pretty_generate(DEFAULT_PROMPTS)}\n")
    rescue Errno::EACCES, Errno::ENOENT
      nil
    end
  end
end
