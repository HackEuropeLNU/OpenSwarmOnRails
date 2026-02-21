import { Controller } from "@hotwired/stimulus"

// Theme controller — single light theme, no toggle needed.
// Kept as a no-op stub so existing data-controller="theme" references don't error.
export default class extends Controller {
  connect() {}
}
