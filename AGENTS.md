These are common instructions for agents across all scenarios.

## General Guidelines

* Never use the em dash "——". Use plain dash "-" instead.
* When writing commit messages, NEVER auto-add your agent name as co-author.
* When writing or substantially editing long markdown files, put each full sentence on its own line. Preserve normal markdown structure, but avoid wrapping multiple sentences onto one physical line.
* When making technical decisions, do not give much weight to development cost and time. Instead, prefer quality, simplicity, robustness, scalability, and long-term maintainability.
* When end-to-end testing a product, be picky about the UI you see and be obsessed with pixel perfection. If something clearly looks off, even if it is not directly related to what you are doing, try to get it fixed along the way.
* Apply that same high standard to engineering excellence: lint, test failures, and test flakiness. If you see one, even if it is not caused by what you are working on right now, still get it fixed.

## Architecture and File Size

- Do not allow source files to grow indefinitely.
- Treat 1,000 lines as a review threshold, not an automatic failure.
- At 1,500 lines, explicitly justify why the file is still cohesive before adding substantial new logic.
- At 2,000 lines, do not add another major responsibility. Extract a cohesive subsystem first unless the file is intentionally generated, declarative, or a proven cohesive low-level implementation.
- Composition roots may be larger, but should primarily construct, register, and connect subsystems rather than implement subsystem behavior.
- Never create a new "manager", "runtime", "service", or hook merely to move thousands of unrelated lines out of another file.
- Do not solve decomposition by creating giant manager/runtime/context objects.
- Prefer ownership boundaries over line-count reduction.
- When adding a feature, first identify its canonical owner. If no appropriate owner exists, create a focused module rather than adding the feature to the nearest large file.
- A subsystem should have one canonical authority for lifecycle/state. Do not add fallback implementations or duplicate execution paths without an explicit compatibility requirement.

For canonical LYKN subsystem ownership, read:
docs/architecture/OWNERSHIP.md

## Composition roots

- `server.js` constructs and registers server subsystems. Route and chat implementation belongs in `server/ai`, `server/services`, and `server/routes`.
- `electron/main.cjs` constructs Electron lifecycle. Task execution belongs in TaskRuntime and the canonical executors.
- `src/pages/LyknChat.tsx` and `src/pages/Vault.jsx` are page composition roots, not dumping grounds.

## Dependency direction

- `electron/task-runtime` must not import `electron/main.cjs`.
- `server/memory` and `server/ai` must not import `server.js`.
- MCP modules must not import Vault page/UI modules.
- Executors must not import renderer page components.
- Frontend must not import server implementation modules.

## Completion validation

Before completing substantial code changes, run the relevant `npm run test:*` suites and `npm run test:architecture`.
File budgets and exceptions are ratchets. Do not silently raise them or move unrelated lines into a new file to dodge a budget.
If a currently healthy large file needs an exception, document owner, maxLines, and reason in `scripts/architecture/architecture-budgets.json`.
