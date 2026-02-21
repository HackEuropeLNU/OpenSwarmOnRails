# frozen_string_literal: true

require "pty"
require "securerandom"
require "base64"

class WebTerminalService
  DETACHED_SESSION_TTL = 30.minutes

  Result = Struct.new(:success, :data, :error, keyword_init: true)
  Session = Struct.new(
    :id,
    :path,
    :master,
    :pid,
    :reader_thread,
    :subscribers,
    :detached_at,
    :shell,
    keyword_init: true
  )

  class << self
    def open(path)
      return Result.new(success: false, error: "Path does not exist") unless File.directory?(path)

      cleanup_closed_sessions!

      existing = find_reusable_session(path)
      if existing
        return Result.new(success: true, data: { session_id: existing.id, path: existing.path, shell: existing.shell })
      end

      shell = default_shell
      session_id = SecureRandom.hex(16)
      env = shell_environment(path, shell)

      master, pid = PTY.spawn(env, shell, "-il", chdir: path)
      session = Session.new(id: session_id, path: path, master: master, pid: pid, subscribers: 0, shell: shell)
      session.reader_thread = start_reader_thread(session)

      mutex.synchronize { sessions[session_id] = session }

      Result.new(success: true, data: { session_id: session_id, path: path, shell: shell })
    rescue PTY::ChildExited
      Result.new(success: false, error: "Shell exited before terminal attached")
    rescue => e
      Result.new(success: false, error: "#{e.class}: #{e.message}")
    end

    def subscribe(session_id)
      with_session(session_id) do |session|
        session.subscribers += 1
        session.detached_at = nil
        true
      end || false
    end

    def unsubscribe(session_id)
      with_session(session_id) do |session|
        session.subscribers = [ session.subscribers.to_i - 1, 0 ].max
        session.detached_at = Time.current if session.subscribers.zero?
        true
      end || false
    end

    def write(session_id, data)
      return false if data.to_s.empty?

      with_session(session_id) do |session|
        session.master.write(data)
        true
      end || false
    rescue Errno::EIO, IOError
      close(session_id)
      false
    end

    def resize(session_id, cols:, rows:)
      width = cols.to_i.clamp(20, 1000)
      height = rows.to_i.clamp(4, 500)

      with_session(session_id) do |session|
        session.master.winsize = [ height, width ]
        true
      end || false
    rescue Errno::EIO, IOError
      close(session_id)
      false
    end

    def close(session_id)
      session = mutex.synchronize { sessions.delete(session_id.to_s) }
      return false unless session

      begin
        session.master.close unless session.master.closed?
      rescue IOError
        nil
      end

      begin
        Process.kill("TERM", session.pid)
      rescue Errno::ESRCH
        nil
      end

      begin
        Process.waitpid(session.pid, Process::WNOHANG)
      rescue Errno::ECHILD
        nil
      end

      true
    end

    def stream_name_for(session_id)
      "terminal:#{session_id}"
    end

    private

    def sessions
      @sessions ||= {}
    end

    def mutex
      @mutex ||= Mutex.new
    end

    def with_session(session_id)
      session = mutex.synchronize { sessions[session_id.to_s] }
      return nil unless session

      yield(session)
    end

    def start_reader_thread(session)
      Thread.new do
        loop do
          chunk = session.master.readpartial(4096)
          ActionCable.server.broadcast(
            stream_name_for(session.id),
            {
              type: "output",
              encoding: "base64",
              data: Base64.strict_encode64(chunk)
            }
          )
        end
      rescue EOFError, Errno::EIO, IOError
        ActionCable.server.broadcast(stream_name_for(session.id), { type: "closed" })
        close(session.id)
      end
    end

    def cleanup_closed_sessions!
      stale_ids = mutex.synchronize do
        sessions.each_with_object([]) do |(id, session), ids|
          ids << id if session.master.closed?

          next unless session.subscribers.to_i.zero?
          next unless session.detached_at

          ids << id if session.detached_at <= Time.current - DETACHED_SESSION_TTL
        end
      end

      stale_ids.each { |id| close(id) }
    end

    def find_reusable_session(path)
      normalized = File.expand_path(path)

      mutex.synchronize do
        sessions.values.find do |session|
          next false if session.master.closed?

          File.expand_path(session.path) == normalized
        end
      end
    end

    def default_shell
      shell = ENV["SHELL"].to_s.strip
      shell.empty? ? "/bin/zsh" : shell
    end

    def shell_environment(path, shell)
      {
        "HOME" => ENV["HOME"].to_s,
        "USER" => ENV["USER"].to_s,
        "LOGNAME" => ENV["LOGNAME"].to_s,
        "SHELL" => shell,
        "PWD" => path,
        "TERM" => "xterm-256color",
        "LANG" => ENV.fetch("LANG", "en_US.UTF-8"),
        "LC_ALL" => ENV["LC_ALL"].to_s
      }.compact
    end
  end
end
