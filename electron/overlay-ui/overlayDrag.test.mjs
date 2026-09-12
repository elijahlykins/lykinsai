import test from "node:test";
import assert from "node:assert/strict";
import { attachOverlayDrag } from "./overlayDrag.js";

function fakeNode() {
  const listeners = new Map();
  return {
    classList: {
      add() {},
      remove() {},
    },
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    emit(type, event) {
      for (const fn of listeners.get(type) || []) fn(event);
    },
  };
}

function pointerEvent(partial) {
  return {
    button: 0,
    buttons: 1,
    pointerId: 1,
    screenX: 0,
    screenY: 0,
    preventDefault() {},
    ...partial,
  };
}

test("a click does not start cursor follow", () => {
  const calls = [];
  const api = {
    moveStart: () => calls.push("start"),
    moveEnd: () => calls.push("end"),
  };
  const el = fakeNode();
  const drag = attachOverlayDrag({ api, root: fakeNode() });
  drag.bind(el, { onClick: () => calls.push("click") });
  el.emit("pointerdown", pointerEvent({ screenX: 10, screenY: 10 }));
  assert.equal(drag.active, true);
  assert.deepEqual(calls, []);
  el.emit("pointerup", pointerEvent({ screenX: 10, screenY: 10 }));
  assert.equal(drag.active, false);
  assert.deepEqual(calls, ["end", "click"]);
});

test("moving the pointer starts cursor follow and keeps going after capture loss", () => {
  const calls = [];
  const api = {
    moveStart: () => calls.push("start"),
    moveEnd: () => calls.push("end"),
  };
  const el = fakeNode();
  const root = fakeNode();
  const captures = [];
  el.setPointerCapture = (id) => captures.push(id);
  const drag = attachOverlayDrag({ api, root, spuriousUpMs: 80 });
  drag.bind(el);
  el.emit("pointerdown", pointerEvent({ screenX: 10, screenY: 20 }));
  root.emit("pointermove", pointerEvent({ screenX: 40, screenY: 50 }));
  assert.equal(drag.active, true);
  assert.deepEqual(calls, ["start"]);
  el.emit("lostpointercapture", pointerEvent({ screenX: 40, screenY: 50 }));
  el.emit("pointercancel", pointerEvent({ screenX: 40, screenY: 50 }));
  assert.equal(drag.active, true);
  assert.deepEqual(calls, ["start"]);
  assert.ok(captures.length >= 2);
});

test("a ghost pointerup on the first moved frame does not end the drag", () => {
  const calls = [];
  const api = {
    moveStart: () => calls.push("start"),
    moveEnd: () => calls.push("end"),
  };
  const el = fakeNode();
  const drag = attachOverlayDrag({ api, root: fakeNode(), spuriousUpMs: 1000 });
  drag.bind(el);
  el.emit("pointerdown", pointerEvent({ screenX: 0, screenY: 0 }));
  el.emit("pointermove", pointerEvent({ screenX: 10, screenY: 0 }));
  el.emit("pointerup", pointerEvent({ screenX: 10, screenY: 0 }));
  assert.equal(drag.active, true);
  assert.deepEqual(calls, ["start"]);
});

test("Esc cancel ends an in-flight drag", () => {
  const calls = [];
  const api = {
    moveStart: () => calls.push("start"),
    moveEnd: () => calls.push("end"),
  };
  const el = fakeNode();
  const drag = attachOverlayDrag({ api, root: fakeNode() });
  drag.bind(el);
  el.emit("pointerdown", pointerEvent());
  el.emit("pointermove", pointerEvent({ screenX: 12, screenY: 0 }));
  drag.cancel();
  assert.equal(drag.active, false);
  assert.deepEqual(calls, ["start", "end"]);
});
