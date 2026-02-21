# frozen_string_literal: true

class TerminalChannel < ApplicationCable::Channel
  def subscribed
    @session_id = params[:session_id].to_s
    if @session_id.empty?
      reject
      return
    end

    unless WebTerminalService.subscribe(@session_id)
      reject
      return
    end

    stream_from WebTerminalService.stream_name_for(@session_id)
    transmit(type: "ready")
  end

  def unsubscribed
    WebTerminalService.unsubscribe(@session_id) if @session_id
  end

  def input(data)
    WebTerminalService.write(@session_id, data["data"].to_s)
  end

  def resize(data)
    WebTerminalService.resize(
      @session_id,
      cols: data["cols"],
      rows: data["rows"]
    )
  end

  def close
    WebTerminalService.close(@session_id)
  end
end
