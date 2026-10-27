import os from "node:os";
import path from "node:path";

// Always under HOME. XDG_DATA_HOME / XDG_STATE_HOME are deliberately not
// read: Panel.qml, About.js and omostrich.service's ReadWritePaths use these
// same fixed paths, and an existing vault must keep being found where it is.
// A separate HOME is what isolates a test instance.
const home = os.homedir();

export const dataDir = path.join(home, ".local", "share", "omostrich");
export const stateDir = path.join(home, ".local", "state", "omarchy", "omostrich");

export const vaultPath = path.join(dataDir, "vault.json");
export const configPath = path.join(dataDir, "config.json");
export const profileCachePath = path.join(dataDir, "profile-cache.json");
export const socketPath = path.join(stateDir, "control.sock");
export const logPath = path.join(stateDir, "daemon.log");
export const tcpTokenPath = path.join(stateDir, "tcp-token");
