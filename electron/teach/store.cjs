"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { validateWorkflowDefinition } = require("./workflow.cjs");

const STORE_FILE = "teach-workflows.json";
const STORE_VERSION = 1;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createWorkflowStore({ userDataPath, maxPreviousVersions = 3 } = {}) {
  if (!String(userDataPath || "").trim()) throw new TypeError("Workflow store requires userDataPath");
  const file = path.join(userDataPath, STORE_FILE);
  const previousLimit = Math.max(0, Math.min(20, Number(maxPreviousVersions) || 0));
  const records = new Map();

  function load() {
    records.clear();
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return { ok: true, loaded: 0 };
    }
    for (const record of Array.isArray(parsed?.workflows) ? parsed.workflows : []) {
      try {
        const current = validateWorkflowDefinition(record.current);
        const previousVersions = (Array.isArray(record.previousVersions) ? record.previousVersions : [])
          .map((item) => {
            try {
              return validateWorkflowDefinition(item);
            } catch {
              return null;
            }
          })
          .filter(Boolean)
          .slice(0, previousLimit);
        records.set(current.id, { current, previousVersions });
      } catch {
        // Invalid or legacy records never become executable.
      }
    }
    return { ok: true, loaded: records.size };
  }

  function serialize() {
    return JSON.stringify({
      storeVersion: STORE_VERSION,
      workflows: [...records.values()],
    });
  }

  function persistNow() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, serialize(), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  function put(definition) {
    const current = validateWorkflowDefinition(definition);
    if (records.has(current.id)) throw new Error("workflow_already_exists");
    records.set(current.id, { current, previousVersions: [] });
    persistNow();
    return clone(current);
  }

  function update(id, nextDefinition, { expectedVersion } = {}) {
    const record = records.get(String(id || ""));
    if (!record) throw new Error("workflow_not_found");
    if (expectedVersion !== undefined && record.current.version !== expectedVersion) {
      throw new Error("workflow_version_conflict");
    }
    const candidate = validateWorkflowDefinition({
      ...clone(nextDefinition),
      id: record.current.id,
      version: record.current.version + 1,
      createdAt: record.current.createdAt,
      updatedAt: new Date().toISOString(),
    });
    const previousVersions = [record.current, ...record.previousVersions].slice(0, previousLimit);
    records.set(candidate.id, { current: candidate, previousVersions });
    persistNow();
    return clone(candidate);
  }

  function get(id, { version } = {}) {
    const record = records.get(String(id || ""));
    if (!record) return null;
    if (version === undefined || version === record.current.version) return clone(record.current);
    return clone(record.previousVersions.find((item) => item.version === version) || null);
  }

  function history(id) {
    const record = records.get(String(id || ""));
    return record ? clone([record.current, ...record.previousVersions]) : [];
  }

  function list() {
    return [...records.values()].map((record) => clone(record.current));
  }

  function remove(id) {
    const removed = records.delete(String(id || ""));
    if (removed) persistNow();
    return removed;
  }

  return { file, load, put, update, get, history, list, remove, persistNow };
}

module.exports = { createWorkflowStore, STORE_FILE, STORE_VERSION };
