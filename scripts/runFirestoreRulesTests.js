import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const host = "127.0.0.1";
const port = 8080;
const firebaseCli = path.resolve("node_modules/firebase-tools/lib/bin/firebase.js");
const vitestCli = path.resolve("node_modules/vitest/vitest.mjs");
const emulator = spawn(process.execPath, [
  firebaseCli,
  "emulators:start",
  "--only",
  "firestore",
  "--project",
  "demo-fonos-community",
], { stdio: "inherit" });

let exitCode = 1;
try {
  await waitForPort(host, port, 30_000);
  const tests = spawnSync(process.execPath, [vitestCli, "run", "test/firestore.rules.test.js"], {
    stdio: "inherit",
    env: { ...process.env, FIRESTORE_EMULATOR_HOST: `${host}:${port}` },
  });
  exitCode = tests.status ?? 1;
} finally {
  stopProcessTree(emulator.pid);
}
process.exitCode = exitCode;

function waitForPort(targetHost, targetPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host: targetHost, port: targetPort });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error("Firestore emulator did not start in time"));
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

function stopProcessTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    try { process.kill(pid, "SIGTERM"); } catch { /* already stopped */ }
  }
}
