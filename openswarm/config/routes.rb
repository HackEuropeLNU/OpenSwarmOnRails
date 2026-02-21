Rails.application.routes.draw do
  # Worktree graph UI
  root "worktrees#index"

  resources :worktrees, only: [:index] do
    collection do
      post :refresh
      post :create_worktree
    end
  end

  # Health check
  get "up" => "rails/health#show", as: :rails_health_check
end
