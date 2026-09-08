"use strict";

/**
 * Native mouse and keyboard for the desktop agent.
 *
 * Bound directly to the platform binary (@nut-tree-fork/libnut-darwin and its
 * win32/linux siblings) rather than to the nut-js or libnut wrappers.
 *
 * That choice is worth its paragraph. The nut-js wrapper's runtime closure is
 * 97 packages and its `shared` module depends on Jimp, which it loads EAGERLY:
 * requiring it pulls 226 modules and the entire image-matching stack, for
 * template matching we never use. The platform binary exposes the same C++
 * surface in 7 modules across 4 packages. That is the difference between a
 * defensible electron-builder allowlist and an indefensible one, and it is why
 * the key table below is written out here instead of imported.
 *
 * THIS IS THE ONE NATIVE INPUT IMPLEMENTATION. electron/browserAct.cjs held a
 * second, near-identical one bound to the nut-js wrapper that was never added
 * to electron-builder.json, so in every packaged build its require() threw,
 * an empty catch swallowed it, and clicks silently degraded to AppleScript.
 *
 * Three silent-failure modes in the layer beneath, all verified by hand:
 *
 *   1. require() throws in a packaged app when the .node binaries were not
 *      unpacked from asar. Reported loudly below rather than swallowed.
 *   2. keyTap() with an unrecognized key name presses NOTHING and reports no
 *      error. Every key is resolved through the table below first, and a miss
 *      is an error. (Note "Pause" maps to null upstream — a real example.)
 *   3. The window API reports an unavailable window as handle -1 with a 0x0
 *      rect instead of throwing. Handled in windows.cjs / frame.cjs.
 */

/**
 * Model-facing key name -> native key string.
 *
 * Transcribed from the upstream lookup table so we do not depend on the
 * package that carries Jimp. Keys are matched case-insensitively.
 */
const NATIVE_KEYS = (() => {
  const m = new Map();
  const put = (name, native) => m.set(String(name).toLowerCase(), native);

  for (let c = 97; c <= 122; c += 1) put(String.fromCharCode(c), String.fromCharCode(c));
  for (let d = 0; d <= 9; d += 1) {
    put(String(d), String(d));
    put(`num${d}`, String(d));
    put(`numpad${d}`, `numpad_${d}`);
    put(`numpad_${d}`, `numpad_${d}`);
  }
  for (let f = 1; f <= 24; f += 1) put(`f${f}`, `f${f}`);

  const named = {
    space: "space", escape: "escape", esc: "escape", tab: "tab",
    enter: "enter", return: "return", backspace: "backspace", delete: "delete",
    del: "delete", insert: "insert", ins: "insert", home: "home", end: "end",
    pageup: "pageup", pgup: "pageup", pagedown: "pagedown", pgdn: "pagedown",
    left: "left", up: "up", right: "right", down: "down",
    grave: "`", "`": "`", minus: "-", "-": "-", equal: "=", "=": "=",
    leftbracket: "[", "[": "[", rightbracket: "]", "]": "]",
    backslash: "\\", "\\": "\\", semicolon: ";", ";": ";",
    quote: "'", "'": "'", comma: ",", ",": ",", period: ".", ".": ".",
    slash: "/", "/": "/",
    add: "add", plus: "add", subtract: "subtract", multiply: "multiply", divide: "divide",
    decimal: "numpad_decimal", numpadequal: "numpad_equal",
    printscreen: "printscreen", print: "printscreen", clear: "clear",
    capslock: "caps_lock", scrolllock: "scroll_lock", numlock: "num_lock",
    menu: "menu", fn: "fn",
    // Modifiers
    shift: "shift", leftshift: "shift", rightshift: "right_shift",
    ctrl: "control", control: "control", leftcontrol: "control", rightcontrol: "right_control",
    alt: "alt", option: "alt", opt: "alt", leftalt: "alt", rightalt: "right_alt",
    cmd: "cmd", command: "cmd", leftcmd: "cmd", rightcmd: "right_cmd",
    meta: "meta", super: "meta", win: "win", rightwin: "right_win",
    // Media
    audiomute: "audio_mute", audiovoldown: "audio_vol_down", audiovolup: "audio_vol_up",
    audioplay: "audio_play", audiostop: "audio_stop", audiopause: "audio_pause",
    audioprev: "audio_prev", audionext: "audio_next",
  };
  for (const [k, v] of Object.entries(named)) put(k, v);
  put(" ", "space");
  return m;
})();

const BUTTONS = Object.freeze({ left: "left", middle: "middle", right: "right" });

let native = null;
let loadError = null;

function loadNative() {
  if (native || loadError) return native;
  try {
    // Mirrors the upstream platform dispatch so a Windows build resolves its
    // own binary rather than the darwin one.
    /* eslint-disable global-require */
    native =
      process.platform === "win32"
        ? require("@nut-tree-fork/libnut-win32")
        : process.platform === "linux"
          ? require("@nut-tree-fork/libnut-linux")
          : require("@nut-tree-fork/libnut-darwin");
    /* eslint-enable global-require */
    native.setMouseDelay(0);
    native.setKeyboardDelay(0);
  } catch (e) {
    loadError = e;
    native = null;
    // Loud on purpose. This exact failure shipped silently.
    console.error(
      "[LYKN] native input unavailable — the libnut platform binary failed to load. " +
        "Desktop control and physical clicks are disabled. In a packaged app this " +
        "almost always means the .node binaries were not unpacked from asar " +
        "(electron-builder.json asarUnpack). Cause: " + (e && e.message ? e.message : String(e)),
    );
  }
  return native;
}

/** @returns {{available:boolean, reason:string}} */
function nativeInputStatus() {
  const n = loadNative();
  if (n) return { available: true, reason: "" };
  return {
    available: false,
    reason:
      "Native input is unavailable in this build (the libnut binary did not load), " +
      "so LYKN cannot move the mouse or type.",
  };
}

const unavailable = () => ({ ok: false, error: "native_input_unavailable", hint: nativeInputStatus().reason });

/**
 * Resolve a model-supplied key name to its native string.
 * @returns {{ok:true, key:string}|{ok:false, error:string, hint:string}}
 */
function resolveKey(name) {
  const raw = String(name == null ? "" : name).trim();
  if (!raw) return { ok: false, error: "bad_key", hint: "No key given." };
  const key = NATIVE_KEYS.get(raw.toLowerCase());
  if (!key) {
    return {
      ok: false,
      error: "bad_key",
      // Naming the miss matters: the layer below would press nothing and
      // report success.
      hint:
        `"${raw}" is not a key this system recognizes. Use names like Enter, Escape, Tab, ` +
        `F5, a, 5, Up, Delete, or a modifier such as cmd/ctrl/alt/shift.`,
    };
  }
  return { ok: true, key };
}

function resolveModifiers(modifiers) {
  const keys = [];
  for (const m of Array.isArray(modifiers) ? modifiers : []) {
    const r = resolveKey(m);
    if (!r.ok) return r;
    keys.push(r.key);
  }
  return { ok: true, keys };
}

function resolveButton(name) {
  const key = BUTTONS[String(name || "left").toLowerCase()];
  if (!key) {
    return { ok: false, error: "bad_button", hint: `Unknown mouse button "${name}". Use left, right, or middle.` };
  }
  return { ok: true, button: key };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function cursorPosition() {
  const n = loadNative();
  if (!n) return unavailable();
  try {
    const p = n.getMousePos();
    return { ok: true, x: p.x, y: p.y };
  } catch (e) {
    return { ok: false, error: "cursor_read_failed", hint: String(e?.message || e) };
  }
}

async function screenSize() {
  const n = loadNative();
  if (!n) return unavailable();
  try {
    const s = n.getScreenSize();
    return { ok: true, width: s.width, height: s.height };
  } catch (e) {
    return { ok: false, error: "screen_read_failed", hint: String(e?.message || e) };
  }
}

async function moveTo(x, y) {
  const n = loadNative();
  if (!n) return unavailable();
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, error: "bad_coordinates", hint: "Move needs finite x and y." };
  }
  try {
    n.moveMouse(Math.round(x), Math.round(y));
    return { ok: true, x: Math.round(x), y: Math.round(y) };
  } catch (e) {
    return { ok: false, error: "move_failed", hint: String(e?.message || e) };
  }
}

/**
 * Click at a screen point, holding any modifiers across the press so
 * shift-click and cmd-click (multi-select in every native list) work.
 */
async function click({ x, y, button = "left", count = 1, modifiers = [] } = {}) {
  const n = loadNative();
  if (!n) return unavailable();
  const btn = resolveButton(button);
  if (!btn.ok) return btn;
  const mods = resolveModifiers(modifiers);
  if (!mods.ok) return mods;

  const moved = await moveTo(x, y);
  if (!moved.ok) return moved;
  // Apps that track motion (menus, hover-reveal toolbars) need a beat between
  // the move and the press, or they treat the click as landing on the old spot.
  await sleep(16);

  try {
    for (const m of mods.keys) n.keyToggle(m, "down", []);
    try {
      n.mouseClick(btn.button, Number(count) >= 2);
    } finally {
      for (const m of [...mods.keys].reverse()) n.keyToggle(m, "up", []);
    }
    return { ok: true, x: moved.x, y: moved.y, button: btn.button, count: Number(count) >= 2 ? 2 : 1 };
  } catch (e) {
    return { ok: false, error: "click_failed", hint: String(e?.message || e) };
  }
}

/**
 * Press, move along an interpolated path, release.
 *
 * The interpolation is not cosmetic. Blender's viewport orbit, sculpt strokes,
 * slider drags and marquee selections all read intermediate motion events; a
 * single jump from press point to release point registers as a plain click in
 * most of them, which presents as "the drag silently did nothing".
 */
async function drag({
  fromX, fromY, toX, toY,
  button = "left", modifiers = [], steps = 24, stepDelayMs = 8,
} = {}) {
  const n = loadNative();
  if (!n) return unavailable();
  const btn = resolveButton(button);
  if (!btn.ok) return btn;
  const mods = resolveModifiers(modifiers);
  if (!mods.ok) return mods;
  if (![fromX, fromY, toX, toY].every(Number.isFinite)) {
    return { ok: false, error: "bad_coordinates", hint: "Drag needs finite from and to coordinates." };
  }

  const start = await moveTo(fromX, fromY);
  if (!start.ok) return start;
  await sleep(24);

  const count = Math.max(2, Math.min(200, Math.round(steps)));
  try {
    for (const m of mods.keys) n.keyToggle(m, "down", []);
    n.mouseToggle("down", btn.button);
    try {
      for (let i = 1; i <= count; i += 1) {
        const t = i / count;
        n.dragMouse(Math.round(fromX + (toX - fromX) * t), Math.round(fromY + (toY - fromY) * t));
        await sleep(stepDelayMs);
      }
    } finally {
      n.mouseToggle("up", btn.button);
      for (const m of [...mods.keys].reverse()) n.keyToggle(m, "up", []);
    }
    return {
      ok: true,
      from: { x: start.x, y: start.y },
      to: { x: Math.round(toX), y: Math.round(toY) },
      button: btn.button,
    };
  } catch (e) {
    return { ok: false, error: "drag_failed", hint: String(e?.message || e) };
  }
}

/** Scroll wheel. up/down/left/right, in wheel ticks. */
async function scroll({ x = null, y = null, direction = "down", amount = 3, modifiers = [] } = {}) {
  const n = loadNative();
  if (!n) return unavailable();
  const mods = resolveModifiers(modifiers);
  if (!mods.ok) return mods;

  const dir = String(direction || "down").toLowerCase();
  const ticks = Math.max(1, Math.min(50, Math.round(Number(amount) || 3)));
  const delta = { up: [0, ticks], down: [0, -ticks], left: [-ticks, 0], right: [ticks, 0] }[dir];
  if (!delta) {
    return { ok: false, error: "bad_direction", hint: `Unknown scroll direction "${direction}". Use up, down, left, or right.` };
  }

  if (Number.isFinite(x) && Number.isFinite(y)) {
    const moved = await moveTo(x, y);
    if (!moved.ok) return moved;
    await sleep(16);
  }
  try {
    for (const m of mods.keys) n.keyToggle(m, "down", []);
    try {
      n.scrollMouse(delta[0], delta[1]);
    } finally {
      for (const m of [...mods.keys].reverse()) n.keyToggle(m, "up", []);
    }
    return { ok: true, direction: dir, amount: ticks };
  } catch (e) {
    return { ok: false, error: "scroll_failed", hint: String(e?.message || e) };
  }
}

/** Type literal text as real keystrokes (not a clipboard paste). */
async function typeText(text) {
  const n = loadNative();
  if (!n) return unavailable();
  const value = String(text == null ? "" : text);
  if (!value) return { ok: false, error: "empty_text", hint: "No text to type." };
  try {
    n.typeString(value);
    return { ok: true, length: value.length };
  } catch (e) {
    return { ok: false, error: "type_failed", hint: String(e?.message || e) };
  }
}

/** Press one key, optionally with modifiers held. */
async function pressKey({ key, modifiers = [] } = {}) {
  const n = loadNative();
  if (!n) return unavailable();
  const k = resolveKey(key);
  if (!k.ok) return k;
  const mods = resolveModifiers(modifiers);
  if (!mods.ok) return mods;
  try {
    n.keyTap(k.key, mods.keys);
    return { ok: true, key: k.key, modifiers: mods.keys };
  } catch (e) {
    return { ok: false, error: "key_failed", hint: String(e?.message || e) };
  }
}

/** The native window provider, for windows.cjs. One load site, one report. */
function nativeWindowProvider() {
  return loadNative();
}

module.exports = {
  nativeInputStatus,
  nativeWindowProvider,
  resolveKey,
  resolveModifiers,
  resolveButton,
  cursorPosition,
  screenSize,
  moveTo,
  click,
  drag,
  scroll,
  typeText,
  pressKey,
  NATIVE_KEYS,
};
