"use strict";

const crypto = require("node:crypto");
const { normalizeRawEvent } = require("./events.cjs");

class TeachSession {
  constructor({ maxRawEvents = 500, now = () => new Date().toISOString(), idFactory } = {}) {
    this.maxRawEvents = Math.max(1, Math.min(5000, Number(maxRawEvents) || 500));
    this.now = now;
    this.idFactory = idFactory || (() => `teach_${crypto.randomBytes(10).toString("hex")}`);
    this.current = null;
  }

  get active() {
    return this.current?.status === "active";
  }

  start(input = {}) {
    if (this.active) throw new Error("teach_session_already_active");
    const startedAt = this.now();
    this.current = {
      id: this.idFactory(),
      botId: String(input.botId || "").trim().slice(0, 120),
      name: String(input.name || "").trim().slice(0, 120),
      objective: String(input.objective || input.objectiveHint || "").trim().slice(0, 1000),
      sourceTaskId: String(input.sourceTaskId || "").trim().slice(0, 120),
      sensitiveDataPolicy: "exclude_credentials_and_require_human_takeover",
      status: "active",
      startedAt,
      finishedAt: null,
      rawEventCount: 0,
      normalizedEvents: [],
      droppedEventCount: 0,
      human_takeover: false,
    };
    return this.snapshot();
  }

  record(rawEvent) {
    if (!this.active) return { accepted: false, reason: "no_active_teach_session" };
    const normalized = normalizeRawEvent(rawEvent, { now: this.now });
    this.current.rawEventCount += 1;
    this.current.normalizedEvents.push(normalized);
    if (this.current.normalizedEvents.length > this.maxRawEvents) {
      this.current.normalizedEvents.shift();
      this.current.droppedEventCount += 1;
    }
    if (normalized.human_takeover) this.current.human_takeover = true;
    return { accepted: true, event: normalized };
  }

  finish() {
    if (!this.active) throw new Error("no_active_teach_session");
    const result = {
      id: this.current.id,
      botId: this.current.botId,
      name: this.current.name,
      objective: this.current.objective,
      sourceTaskId: this.current.sourceTaskId,
      sensitiveDataPolicy: this.current.sensitiveDataPolicy,
      status: "finished",
      startedAt: this.current.startedAt,
      finishedAt: this.now(),
      events: [...this.current.normalizedEvents],
      droppedEventCount: this.current.droppedEventCount,
      human_takeover: this.current.human_takeover,
    };
    this.clear("finished", result.finishedAt);
    return result;
  }

  cancel(reason = "cancelled") {
    if (!this.active) return { status: "cancelled", ignored: true, reason: "no_active_teach_session" };
    const result = {
      id: this.current.id,
      status: "cancelled",
      reason: String(reason || "cancelled").slice(0, 300),
      finishedAt: this.now(),
      eventCount: this.current.normalizedEvents.length,
    };
    this.clear("cancelled", result.finishedAt);
    return result;
  }

  clear(status, finishedAt) {
    this.current.normalizedEvents.length = 0;
    this.current.status = status;
    this.current.finishedAt = finishedAt;
    this.current = null;
  }

  snapshot() {
    if (!this.current) return null;
    const { normalizedEvents, ...safe } = this.current;
    return {
      ...safe,
      eventCount: normalizedEvents.length,
      rawEventCount: Math.min(this.current.rawEventCount, this.maxRawEvents),
    };
  }
}

module.exports = { TeachSession };
