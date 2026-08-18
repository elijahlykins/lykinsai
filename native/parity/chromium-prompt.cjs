/**
 * Render the full decision-cycle prompt the Chromium agent would send for a
 * captured page — system message, user message, and the routing that produced
 * them.
 *
 * Everything comes from the shipping runtime (contextRouter, taskState,
 * visionPolicy, snapshot), so the output is the real prompt rather than a
 * description of one. The plan is the single stand-in: a real plan comes from
 * the planner stage, which needs a model call, so a fixed four-step plan is
 * substituted to keep this offline and deterministic.
 *
 *   node native/parity/chromium-prompt.cjs <goal> <captured.json>
 */
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.resolve(__dirname, "..", "..");
const AGENT = path.join(ROOT, "electron", "browser-agent");
const cr = require(path.join(AGENT, "runtime", "contextRouter.cjs"));
const taskState = require(path.join(AGENT, "runtime", "taskState.cjs"));
const visionPolicy = require(path.join(AGENT, "runtime", "visionPolicy.cjs"));
const { buildSnapshot, formatSnapshotForModel } = require(
  path.join(AGENT, "browser", "snapshot.cjs"),
);

const [goal, capturePath] = process.argv.slice(2);
if (!goal || !capturePath) {
  console.error("usage: node chromium-prompt.cjs <goal> <captured.json>");
  process.exit(2);
}

const snapshot = buildSnapshot(JSON.parse(fs.readFileSync(capturePath, "utf8")));

const task = taskState.createTask({ goal });
taskState.setPlan(task, {
  plan: [
    "Open the page the task refers to",
    "Read the current state",
    "Make the requested change",
    "Confirm it took effect",
  ],
  skills: cr.routeSkills(goal),
});

const browserModules = cr.routeBrowserModules({
  lastActionType: "navigate",
  recovering: false,
  tabCount: snapshot.tabs.length || 1,
  formsLikely: snapshot.elements.some((e) =>
    ["textbox", "combobox", "searchbox"].includes(e.role),
  ),
  goal,
  url: snapshot.url,
  hasDrawnSurface: visionPolicy.countDrawnSurfaces(snapshot) > 0,
  hasEmbeddedFrame: snapshot.elements.some((e) => !!e.frameHost),
});
const safetyModules = cr.routeSafetyModules(goal);
const vision = visionPolicy.shouldSeePixels({ snapshot });

const system = cr.buildDecisionSystem({
  task,
  skills: task.skills,
  browserModules,
  safetyModules,
  userMemory: "",
  websiteMemory: "",
});

const userParts = [
  `TASK STATE:\n${taskState.formatTaskForModel(task)}`,
  `RECENT ACTIONS:\n${taskState.formatHistoryForModel(task)}`,
  `CURRENT BROWSER STATE:\n${formatSnapshotForModel(snapshot)}`,
];
if (vision.see) {
  userParts.push(
    "A screenshot of the current page is attached." +
      (vision.reason ? ` It is attached because ${vision.reason}.` : "") +
      " Read it as the authoritative view of what is on screen. When something " +
      "you need is visible in the image but absent from the element list, act " +
      "on it with click_coord or drag using x/y in 0-1000 of the image " +
      "(0,0 top-left; 1000,1000 bottom-right). Prefer an element reference " +
      "whenever one exists — coordinates are for what the DOM cannot describe.",
  );
}
userParts.push("Decide the next structured step now.");
const user = userParts.join("\n\n");

console.log("################ ROUTING ################");
console.log("browser modules :", browserModules.join(", "));
console.log("safety modules  :", safetyModules.join(", "));
console.log("skills          :", task.skills.join(", ") || "(none)");
console.log(
  "screenshot      :",
  vision.see ? `YES — ${vision.reason} (everyRound=${vision.everyRound})` : "no",
);
console.log("system chars    :", system.length);
console.log("user chars      :", user.length);
console.log("\n################ SYSTEM MESSAGE ################\n");
console.log(system);
console.log("\n################ USER MESSAGE ################\n");
console.log(user);
