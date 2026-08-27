"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { attachBrowserTeachingCapture } = require("../../electron/teach/index.cjs");

function browserFixture(results = []) {
  const wc = new EventEmitter();
  wc.id = 7;
  wc.session = new EventEmitter();
  wc.isDestroyed = () => false;
  wc.getOwnerBrowserWindow = () => ({ getContentBounds: () => ({ width: 1000, height: 800 }) });
  wc.executeJavaScript = async () => results.shift() || null;
  return wc;
}

test("browser capture records semantic navigation and clicks, then detaches", async () => {
  const wc = browserFixture([{
    target: { role: "button", name: "Save" },
    value: null,
    sensitive: false,
    tag: "button",
  }]);
  const events = [];
  const detach = attachBrowserTeachingCapture({ webContents: wc, onEvent: (event) => events.push(event) });
  wc.emit("did-navigate", {}, "https://example.test/form");
  wc.emit("input-event", {}, { type: "mouseDown", x: 100, y: 80 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map((event) => event.action), ["navigate", "click"]);
  assert.equal(events[1].target.name, "Save");
  detach();
  wc.emit("did-navigate", {}, "https://example.test/after");
  assert.equal(events.length, 2);
});

test("sensitive fields emit only a human takeover boundary", async () => {
  const wc = browserFixture([{
    target: { role: "textbox", name: "Password" },
    value: null,
    sensitive: true,
    tag: "input",
    type: "password",
  }]);
  const events = [];
  const detach = attachBrowserTeachingCapture({
    webContents: wc,
    debounceMs: 100,
    onEvent: (event) => events.push(event),
  });
  wc.emit("input-event", {}, { type: "keyDown", key: "x" });
  await new Promise((resolve) => setTimeout(resolve, 120));
  detach();
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "authenticate");
  assert.equal(events[0].human_takeover, true);
  assert.equal("input" in events[0], false);
});

test("download capture stores only URL and final local path", async () => {
  const wc = browserFixture();
  const item = new EventEmitter();
  item.getFilename = () => "report.pdf";
  item.getURL = () => "https://example.test/report.pdf";
  item.getSavePath = () => "/Users/example/Downloads/report.pdf";
  const events = [];
  const detach = attachBrowserTeachingCapture({ webContents: wc, onEvent: (event) => events.push(event) });
  wc.session.emit("will-download", {}, item, wc);
  item.emit("done", {}, "completed");
  detach();
  assert.deepEqual(events[0], {
    kind: "browser",
    action: "download",
    target: { url: "https://example.test/report.pdf" },
    output: { filename: "report.pdf", path: "/Users/example/Downloads/report.pdf" },
    metadata: { actor: "user" },
  });
});
