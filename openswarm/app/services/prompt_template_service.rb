# frozen_string_literal: true

class PromptTemplateService
  PROMPT_PATH = Rails.root.join("config", "prompt.json")

  DEFAULT_PROMPTS = {
    "merge_conflict_resolver" => <<~PROMPT.strip
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
