Rails.application.routes.draw do
  # Worktree graph UI
  root "worktrees#index"

  resources :worktrees, only: [:index] do
    collection do
      post :refresh
      post :open_project
      post :create_worktree
      post :delete_worktree
      post :open_terminal
      post :fetch_pull_parent
      post :rebase_onto_parent
      post :commit_selected
      post :push_selected
      post :merge_to_parent
      post :orchestrator
    end
  end

  # Health check
  get "up" => "rails/health#show", as: :rails_health_check

  # Route for syncing with Miro
  post "/miro/sync", to: "miro#sync"

  mount ActionCable.server => "/cable"
end
