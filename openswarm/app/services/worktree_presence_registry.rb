# frozen_string_literal: true

class WorktreePresenceRegistry
  STALE_AFTER_SECONDS = 30
  CACHE_TTL = 2.hours

  class << self
    def upsert(room_key:, member:)
      with_roster(room_key) do |roster|
        sanitized = sanitize_member(member)

        roster.delete_if do |_member_id, existing|
          existing[:identity_id] == sanitized[:identity_id] && existing[:id] != sanitized[:id]
        end

        roster[sanitized[:id]] = sanitized
      end
    end

    def remove(room_key:, member_id:)
      with_roster(room_key) do |roster|
        roster.delete(member_id.to_s)
      end
    end

    def snapshot(room_key:)
      roster = read_roster(room_key)
      prune_stale!(roster)
      write_roster(room_key, roster)
      roster.values.sort_by { |entry| [entry[:name].to_s.downcase, entry[:id].to_s] }
    end

    private

    def with_roster(room_key)
      roster = read_roster(room_key)
      prune_stale!(roster)
      yield(roster)
      prune_stale!(roster)
      write_roster(room_key, roster)
      roster.values.sort_by { |entry| [entry[:name].to_s.downcase, entry[:id].to_s] }
    end

    def read_roster(room_key)
      key = cache_key(room_key)
      raw = Rails.cache.read(key)
      raw.is_a?(Hash) ? raw.deep_symbolize_keys : {}
    end

    def write_roster(room_key, roster)
      Rails.cache.write(cache_key(room_key), roster, expires_in: CACHE_TTL)
    end

    def prune_stale!(roster)
      cutoff = Time.now.to_i - STALE_AFTER_SECONDS
      roster.delete_if do |_member_id, member|
        member[:updated_at].to_i < cutoff
      end
    end

    def sanitize_member(member)
      {
        id: member[:id].to_s,
        identity_id: safe_identity(member[:identity_id]),
        name: safe_name(member[:name]),
        github_login: safe_github(member[:github_login]),
        branch: safe_text(member[:branch]),
        mode: safe_mode(member[:mode]),
        selected_worktree_id: safe_text(member[:selected_worktree_id]),
        updated_at: Time.now.to_i
      }
    end

    def safe_name(value)
      cleaned = value.to_s.strip
      cleaned = cleaned[0, 40]
      cleaned.empty? ? "dev" : cleaned
    end

    def safe_text(value)
      text = value.to_s.strip
      text.empty? ? nil : text[0, 120]
    end

    def safe_identity(value)
      token = value.to_s.strip.downcase
      token = token.gsub(/[^a-z0-9._:@-]/, "")
      token = token[0, 120]
      token.presence || "anonymous"
    end

    def safe_github(value)
      login = value.to_s.strip
      return nil if login.empty?

      login = login.gsub(/[^A-Za-z0-9-]/, "")
      login[0, 39].presence
    end

    def safe_mode(value)
      mode = value.to_s
      return mode if %w[local zed-shared].include?(mode)

      "local"
    end

    def cache_key(room_key)
      "worktree_presence:#{room_key}"
    end
  end
end
