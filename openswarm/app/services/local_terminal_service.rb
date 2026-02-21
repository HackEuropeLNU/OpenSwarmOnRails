# frozen_string_literal: true

require "open3"
require "shellwords"

class LocalTerminalService
  Result = Struct.new(:success, :data, :error, keyword_init: true)

  class << self
    def open(path)
      return Result.new(success: false, error: "Path does not exist") unless File.directory?(path)

      command = "cd #{Shellwords.escape(path)}"
      script = %(tell application "Terminal" to do script #{command.inspect})
      activate_script = %(tell application "Terminal" to activate)

      _, stderr, status = Open3.capture3("osascript", "-e", script, "-e", activate_script)
      return Result.new(success: true, data: { app: "Terminal" }) if status.success?

      error = stderr.to_s.strip
      error = "Failed to open local terminal" if error.empty?
      Result.new(success: false, error: error)
    rescue => e
      Result.new(success: false, error: "#{e.class}: #{e.message}")
    end
  end
end
