# Electron characterization tests

Offline tests that lock the main-process IPC surface and security gates
during the Electron shell decomposition.

They do not launch Electron.

- `ipcManifest.test.cjs` — lost/new/duplicate channels and handle/on mode
- `securityGates.test.cjs` — approval tokens, agent-home identity, browser allowlist, SSRF, runtime AGENTS.md
- `electron/net/safeFetch.test.cjs` — SSRF unit tests

Regenerate the IPC contract after an intentional channel change:

```
npm run test:electron:update-manifest
```
