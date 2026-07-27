#!/usr/bin/env node
// Wait until a TCP port accepts connections (used so Electron doesn't race Vite).
import net from "node:net";

const host = process.argv[2] || "127.0.0.1";
const port = Number(process.argv[3] || 5173);
const timeoutMs = Number(process.argv[4] || 60_000);
const started = Date.now();

function tryOnce() {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

while (Date.now() - started < timeoutMs) {
  if (await tryOnce()) {
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 250));
}

console.error(`[wait-for-port] timed out waiting for ${host}:${port}`);
process.exit(1);
