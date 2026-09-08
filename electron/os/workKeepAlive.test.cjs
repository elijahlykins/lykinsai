"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createWorkKeepAlive, BLOCKER_TYPE } = require("./workKeepAlive.cjs");

function mockBlocker() {
  const started = new Set();
  let nextId = 1;
  const types = [];
  return {
    types,
    start(type) {
      types.push(type);
      const id = nextId++;
      started.add(id);
      return id;
    },
    stop(id) {
      started.delete(id);
    },
    isStarted(id) {
      return started.has(id);
    },
    get size() {
      return started.size;
    },
  };
}

test("in-flight work holds prevent-app-suspension so the display can go black", () => {
  const powerSaveBlocker = mockBlocker();
  const keep = createWorkKeepAlive({ powerSaveBlocker, powerMonitor: new EventEmitter() });
  keep.hold("overlay-ask");
  assert.equal(powerSaveBlocker.size, 1);
  assert.equal(powerSaveBlocker.types[0], BLOCKER_TYPE);
  keep.hold("overlay-ask");
  assert.equal(powerSaveBlocker.size, 1);
  keep.release("overlay-ask");
  assert.equal(powerSaveBlocker.size, 0);
  assert.equal(keep.isHeld(), false);
});

test("independent sources keep the machine awake until the last turn ends", () => {
  const powerSaveBlocker = mockBlocker();
  const keep = createWorkKeepAlive({ powerSaveBlocker, powerMonitor: new EventEmitter() });
  keep.hold("overlay-ask:1");
  keep.hold("agents");
  keep.release("overlay-ask:1");
  assert.equal(powerSaveBlocker.size, 1);
  keep.release("agents");
  assert.equal(powerSaveBlocker.size, 0);
});

test("full sleep while working broadcasts Paused and drops the blocker", () => {
  const powerSaveBlocker = mockBlocker();
  const powerMonitor = new EventEmitter();
  const events = [];
  const paused = [];
  const keep = createWorkKeepAlive({
    powerSaveBlocker,
    powerMonitor,
    broadcast: (channel, payload) => events.push({ channel, payload }),
  });
  keep.attachPowerListeners();
  keep.onPause((reason, sources) => paused.push({ reason, sources }));
  keep.hold("chat");
  assert.equal(powerSaveBlocker.size, 1);

  powerMonitor.emit("suspend");
  assert.equal(keep.pause("suspend"), false, "second pause is a no-op");
  assert.deepEqual(paused, [{ reason: "suspend", sources: ["chat"] }]);
  assert.equal(events[0].channel, "lykn:work-paused");
  assert.equal(events[0].payload.reason, "suspend");
  assert.equal(powerSaveBlocker.size, 0);
  assert.equal(keep.isHeld(), false);
});

test("shutdown while working also pauses; idle sleep does not", () => {
  const powerSaveBlocker = mockBlocker();
  const powerMonitor = new EventEmitter();
  const events = [];
  const keep = createWorkKeepAlive({
    powerSaveBlocker,
    powerMonitor,
    broadcast: (channel, payload) => events.push({ channel, payload }),
  });
  keep.attachPowerListeners();

  powerMonitor.emit("suspend");
  powerMonitor.emit("shutdown");
  assert.equal(events.length, 0);

  keep.hold("imagine");
  powerMonitor.emit("shutdown");
  assert.equal(events[0].payload.reason, "shutdown");
  assert.equal(powerSaveBlocker.size, 0);
});
