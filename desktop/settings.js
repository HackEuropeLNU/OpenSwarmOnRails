const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

const TAG = "[DEBUG:settings]";
const DEBUG = process.env.OPENSWARM_DEBUG_TERMINAL === "1";
const debug = (...args) => {
  if (DEBUG) console.log(TAG, ...args);
};

const SETTINGS_FILE = "openswarm-settings.json";

const DEFAULTS = {
  // "system-default" = use the OS default terminal app (Terminal.app, iTerm2, Windows Terminal, etc.)
  // "built-in" = use the built-in xterm.js terminal
  // "<terminal-id>" = use a specific terminal app (e.g., "iterm2", "warp")
  terminalMode: "system-default"
};

let _settings = null;
let _settingsPath = null;

function getSettingsPath() {
  if (_settingsPath) return _settingsPath;

  try {
    const userDataDir = app.getPath("userData");
    _settingsPath = path.join(userDataDir, SETTINGS_FILE);
  } catch {
    // Fallback if app is not ready
    _settingsPath = path.join(
      process.env.HOME || process.env.USERPROFILE || "/tmp",
      ".openswarm",
      SETTINGS_FILE
    );
  }

  debug("settings path:", _settingsPath);
  return _settingsPath;
}

function loadSettings() {
  if (_settings) return _settings;

  const settingsPath = getSettingsPath();

  try {
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, "utf-8");
      _settings = { ...DEFAULTS, ...JSON.parse(raw) };
      debug("loaded settings", _settings);
    } else {
      _settings = { ...DEFAULTS };
      debug("no settings file, using defaults", _settings);
    }
  } catch (err) {
    debug("failed to load settings, using defaults", err.message);
    _settings = { ...DEFAULTS };
  }

  return _settings;
}

function saveSettings(settings) {
  const settingsPath = getSettingsPath();
  _settings = { ...DEFAULTS, ...settings };

  try {
    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(settingsPath, JSON.stringify(_settings, null, 2), "utf-8");
    debug("saved settings", _settings);
    return true;
  } catch (err) {
    debug("failed to save settings", err.message);
    return false;
  }
}

function getSetting(key) {
  const settings = loadSettings();
  return settings[key] ?? DEFAULTS[key] ?? null;
}

function setSetting(key, value) {
  const settings = loadSettings();
  settings[key] = value;
  return saveSettings(settings);
}

module.exports = {
  loadSettings,
  saveSettings,
  getSetting,
  setSetting
};
