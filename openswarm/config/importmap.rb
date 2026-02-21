# Pin npm packages by running ./bin/importmap

pin "application"
pin "cable_consumer", to: "cable_consumer.js"
pin "@hotwired/turbo-rails", to: "turbo.min.js"
pin "@hotwired/stimulus", to: "stimulus.min.js"
pin "@hotwired/stimulus-loading", to: "stimulus-loading.js"
pin "@rails/actioncable", to: "https://cdn.jsdelivr.net/npm/@rails/actioncable@8.0.100/+esm"
pin "xterm", to: "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/+esm"
pin "@xterm/addon-fit", to: "https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/+esm"
pin_all_from "app/javascript/controllers", under: "controllers"
