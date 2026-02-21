const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const TAG = "[DEBUG:external-terminal]";
const DEBUG = process.env.OPENSWARM_DEBUG_TERMINAL === "1";
const debug = (...args) => {
  if (DEBUG) console.log(TAG, ...args);
};

// ── Known terminal applications by platform ──

const KNOWN_TERMINALS = {
  darwin: [
    {
      id: "terminal",
      name: "Terminal",
      app: "Terminal",
      bundleId: "com.apple.Terminal",
      check: () => fs.existsSync("/System/Applications/Utilities/Terminal.app")
    },
    {
      id: "iterm2",
      name: "iTerm2",
      app: "iTerm",
      bundleId: "com.googlecode.iterm2",
      check: () =>
        fs.existsSync("/Applications/iTerm.app") ||
        fs.existsSync(`${os.homedir()}/Applications/iTerm.app`)
    },
    {
      id: "warp",
      name: "Warp",
      app: "Warp",
      bundleId: "dev.warp.Warp-Stable",
      check: () =>
        fs.existsSync("/Applications/Warp.app") ||
        fs.existsSync(`${os.homedir()}/Applications/Warp.app`)
    },
    {
      id: "alacritty",
      name: "Alacritty",
      app: "Alacritty",
      bundleId: "org.alacritty",
      check: () =>
        fs.existsSync("/Applications/Alacritty.app") ||
        fs.existsSync(`${os.homedir()}/Applications/Alacritty.app`)
    },
    {
      id: "kitty",
      name: "Kitty",
      app: "kitty",
      bundleId: "net.kovidgoyal.kitty",
      check: () =>
        fs.existsSync("/Applications/kitty.app") ||
        fs.existsSync(`${os.homedir()}/Applications/kitty.app`)
    },
    {
      id: "hyper",
      name: "Hyper",
      app: "Hyper",
      bundleId: "co.zeit.hyper",
      check: () =>
        fs.existsSync("/Applications/Hyper.app") ||
        fs.existsSync(`${os.homedir()}/Applications/Hyper.app`)
    }
  ],
  win32: [
    {
      id: "windows-terminal",
      name: "Windows Terminal",
      exe: "wt.exe",
      check: () => commandExists("wt.exe")
    },
    {
      id: "cmd",
      name: "Command Prompt",
      exe: "cmd.exe",
      check: () => true // always available
    },
    {
      id: "powershell",
      name: "PowerShell",
      exe: "powershell.exe",
      check: () => true // always available
    }
  ],
  linux: [
    {
      id: "gnome-terminal",
      name: "GNOME Terminal",
      exe: "gnome-terminal",
      check: () => commandExists("gnome-terminal")
    },
    {
      id: "konsole",
      name: "Konsole",
      exe: "konsole",
      check: () => commandExists("konsole")
    },
    {
      id: "xfce4-terminal",
      name: "Xfce Terminal",
      exe: "xfce4-terminal",
      check: () => commandExists("xfce4-terminal")
    },
    {
      id: "alacritty",
      name: "Alacritty",
      exe: "alacritty",
      check: () => commandExists("alacritty")
    },
    {
      id: "kitty",
      name: "Kitty",
      exe: "kitty",
      check: () => commandExists("kitty")
    },
    {
      id: "xterm",
      name: "XTerm",
      exe: "xterm",
      check: () => commandExists("xterm")
    }
  ]
};

function commandExists(cmd) {
  try {
    const { execFileSync } = require("node:child_process");
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect which terminal applications are installed on this system.
 * Returns an array of { id, name } objects.
 */
function detectInstalledTerminals() {
  const platform = os.platform();
  const terminals = KNOWN_TERMINALS[platform] || [];
  const installed = [];

  for (const terminal of terminals) {
    try {
      if (terminal.check()) {
        installed.push({ id: terminal.id, name: terminal.name });
      }
    } catch {
      // skip terminals that fail detection
    }
  }

  debug("detectInstalledTerminals", { platform, found: installed.map((t) => t.id) });
  return installed;
}

/**
 * Get the system default terminal application.
 * Returns the id of the default terminal.
 */
function getSystemDefaultTerminal() {
  const platform = os.platform();

  if (platform === "darwin") {
    // On macOS, the "default terminal" is Terminal.app unless the user has
    // configured a different one. We just return the first installed one.
    return "terminal";
  }

  if (platform === "linux") {
    // Try x-terminal-emulator alternative, then common ones
    if (commandExists("x-terminal-emulator")) return "x-terminal-emulator";
    const installed = detectInstalledTerminals();
    return installed.length > 0 ? installed[0].id : "xterm";
  }

  if (platform === "win32") {
    return commandExists("wt.exe") ? "windows-terminal" : "cmd";
  }

  return null;
}

/**
 * Open an external terminal application at the given directory.
 * @param {string} cwd - The directory to open in the terminal.
 * @param {string} terminalId - The terminal app identifier (e.g., "iterm2", "terminal", "warp").
 *                              If "system-default", uses the system's default terminal.
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function openExternalTerminal(cwd, terminalId) {
  const platform = os.platform();
  const resolvedId = terminalId === "system-default" ? getSystemDefaultTerminal() : terminalId;

  debug("openExternalTerminal", { cwd, terminalId, resolvedId, platform });

  if (!cwd || typeof cwd !== "string") {
    return { success: false, error: "Invalid directory path" };
  }

  const normalizedCwd = path.resolve(cwd.trim());
  if (!fs.existsSync(normalizedCwd)) {
    return { success: false, error: `Directory does not exist: ${normalizedCwd}` };
  }

  try {
    if (platform === "darwin") {
      return await openMacTerminal(normalizedCwd, resolvedId);
    }
    if (platform === "linux") {
      return await openLinuxTerminal(normalizedCwd, resolvedId);
    }
    if (platform === "win32") {
      return await openWindowsTerminal(normalizedCwd, resolvedId);
    }
    return { success: false, error: `Unsupported platform: ${platform}` };
  } catch (err) {
    debug("openExternalTerminal error", err.message);
    return { success: false, error: err.message };
  }
}

async function openMacTerminal(cwd, terminalId) {
  const terminals = KNOWN_TERMINALS.darwin;
  const terminal = terminals.find((t) => t.id === terminalId);

  if (!terminal) {
    // Fallback: use `open` with Terminal.app
    return spawnDetached("open", ["-a", "Terminal", cwd]);
  }

  // Special handling for iTerm2 - use AppleScript for better directory support
  if (terminalId === "iterm2") {
    const script = `
      tell application "iTerm"
        activate
        set newWindow to (create window with default profile)
        tell current session of newWindow
          write text "cd ${escapeAppleScript(cwd)} && clear"
        end tell
      end tell
    `;
    return runAppleScript(script);
  }

  // Special handling for Warp
  if (terminalId === "warp") {
    return spawnDetached("open", ["-a", "Warp", cwd]);
  }

  // For Terminal.app, use AppleScript for proper cd
  if (terminalId === "terminal") {
    const script = `
      tell application "Terminal"
        activate
        do script "cd ${escapeAppleScript(cwd)} && clear"
      end tell
    `;
    return runAppleScript(script);
  }

  // Generic macOS: use `open -a <App> <cwd>`
  return spawnDetached("open", ["-a", terminal.app, cwd]);
}

async function openLinuxTerminal(cwd, terminalId) {
  const terminals = KNOWN_TERMINALS.linux;
  const terminal = terminals.find((t) => t.id === terminalId);

  if (terminalId === "x-terminal-emulator" || !terminal) {
    const exe = terminalId === "x-terminal-emulator" ? "x-terminal-emulator" : (terminal?.exe || "x-terminal-emulator");
    return spawnDetached(exe, [], { cwd });
  }

  // Most Linux terminals support --working-directory or similar
  switch (terminalId) {
    case "gnome-terminal":
      return spawnDetached("gnome-terminal", ["--working-directory=" + cwd]);
    case "konsole":
      return spawnDetached("konsole", ["--workdir", cwd]);
    case "xfce4-terminal":
      return spawnDetached("xfce4-terminal", ["--working-directory=" + cwd]);
    case "alacritty":
      return spawnDetached("alacritty", ["--working-directory", cwd]);
    case "kitty":
      return spawnDetached("kitty", ["--directory", cwd]);
    default:
      return spawnDetached(terminal.exe, [], { cwd });
  }
}

async function openWindowsTerminal(cwd, terminalId) {
  switch (terminalId) {
    case "windows-terminal":
      return spawnDetached("wt.exe", ["-d", cwd]);
    case "powershell":
      return spawnDetached("powershell.exe", ["-NoExit", "-Command", `Set-Location '${cwd}'`]);
    case "cmd":
    default:
      return spawnDetached("cmd.exe", ["/K", `cd /d "${cwd}"`]);
  }
}

// ── Helpers ──

function spawnDetached(cmd, args, options = {}) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, {
        detached: true,
        stdio: "ignore",
        ...options
      });
      child.unref();
      child.on("error", (err) => {
        debug("spawnDetached error", { cmd, error: err.message });
        resolve({ success: false, error: err.message });
      });
      // Give it a moment to check for spawn errors
      setTimeout(() => resolve({ success: true }), 200);
    } catch (err) {
      resolve({ success: false, error: err.message });
    }
  });
}

function runAppleScript(script) {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], (error) => {
      if (error) {
        debug("AppleScript error", error.message);
        resolve({ success: false, error: error.message });
      } else {
        resolve({ success: true });
      }
    });
  });
}

function escapeAppleScript(str) {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

module.exports = {
  openExternalTerminal,
  detectInstalledTerminals,
  getSystemDefaultTerminal
};
