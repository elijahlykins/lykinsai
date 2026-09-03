import test from "node:test";
import assert from "node:assert/strict";

import { openAppTool } from "./openApp.js";

/**
 * What the user says and what the code calls something are rarely the same
 * word ("my to-do list" → todos, "workout tracker" → workout-tracker-a1b2).
 * These pin down that translation, and the two ways it can go wrong: opening
 * the wrong thing when a name is ambiguous, and claiming success for something
 * that doesn't exist.
 */

const INSTALLED = [
  { id: "workout-tracker-a1b2", name: "Workout Tracker" },
  { id: "recipe-box-c3d4", name: "Recipe Box" },
];

/** A believable /Applications for the person running these. */
const MAC_APPS = ["Safari", "Google Chrome", "Spotify", "Slack", "Notes", "Mail"];

/** What LYKN has built for them, as the client reports AI Drive. */
const AI_DRIVE = [
  { id: "note-11", name: "Sales Dashboard", folder: "artifacts" },
  { id: "note-22", name: "Q3 Revenue Chart", folder: "artifacts" },
  { id: "note-33", name: "AI Generated Aug 20-1a2b.png", folder: "images" },
];

async function open(app, installedApps = INSTALLED, extra = {}) {
  const res = await openAppTool.handler(
    { app },
    {
      userId: "u1",
      installedApps,
      macApps: MAC_APPS,
      localMode: true,
      aiDrive: AI_DRIVE,
      ...extra,
    },
  );
  return JSON.parse(res.content[0].text);
}

test("the pages people ask for by name", async () => {
  for (const [asked, id] of [
    ["todos", "todos"],
    ["my to-do list", "todos"],
    ["To Do List", "todos"],
    ["tasks", "todos"],
    ["the calendar", "calendar"],
    ["my schedule", "calendar"],
    ["Projects", "projects"],
    ["project board", "projects"],
    ["vault", "vault"],
    ["my stuff", "vault"],
    ["files", "files"],
    ["browser", "browser"],
  ]) {
    const r = await open(asked);
    assert.equal(r.ok, true, `"${asked}" did not resolve`);
    assert.equal(r.kind, "page");
    assert.equal(r.id, id, `"${asked}" opened ${r.id}`);
  }
});

test("a page carries the route its window opens", async () => {
  assert.equal((await open("todos")).src, "/todos");
  // Files and Browser have their own handling in Studio, so no route.
  assert.equal((await open("browser")).src, null);
});

test("an app the user built opens by name, however they capitalise it", async () => {
  for (const asked of ["Workout Tracker", "workout tracker", "my workout tracker"]) {
    const r = await open(asked);
    assert.equal(r.ok, true, `"${asked}" did not resolve`);
    assert.equal(r.kind, "installed");
    assert.equal(r.id, "workout-tracker-a1b2");
  }
});

test("a partial name opens the app only when one app could be meant", async () => {
  const one = await open("workout");
  assert.equal(one.ok, true);
  assert.equal(one.id, "workout-tracker-a1b2");

  // Two apps start with "Recipe" — guessing between them is worse than asking.
  const ambiguous = await open("recipe", [
    ...INSTALLED,
    { id: "recipe-planner-e5f6", name: "Recipe Planner" },
  ]);
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error, "unknown_app");
});

test("a built-in page wins a name it shares with an app the user built", async () => {
  const r = await open("calendar", [{ id: "calendar-x1", name: "Calendar" }]);
  assert.equal(r.kind, "page");
  assert.equal(r.id, "calendar");
  // Their own app is still reachable, by its id.
  const theirs = await open("calendar-x1", [{ id: "calendar-x1", name: "Calendar" }]);
  assert.equal(theirs.kind, "installed");
  assert.equal(theirs.id, "calendar-x1");
});

test("an app that isn't there is reported, not invented", async () => {
  // A name LYKN has never heard of — not a page, not one of theirs, and not on
  // the known-Mac-app list either.
  const r = await open("Sparkle Widget");
  assert.equal(r.ok, false);
  assert.equal(r.error, "unknown_app");
  // What they DO have, so the model can offer the nearest thing.
  assert.deepEqual(r.installedApps, ["Workout Tracker", "Recipe Box"]);
});

test("without their Mac list, it points at the Mac rather than assuming the web", async () => {
  const res = await openAppTool.handler({ app: "Sparkle Widget" }, { userId: "u1" });
  const r = JSON.parse(res.content[0].text);
  assert.match(r.message, /local_open_app/);
});

test("a turn that sent no app list still opens pages", async () => {
  // The browser build has no local store, so installedApps never arrives.
  const res = await openAppTool.handler({ app: "todos" }, { userId: "u1" });
  assert.equal(JSON.parse(res.content[0].text).id, "todos");
});

test("an empty ask is an error, not a silent open", async () => {
  const r = await open("   ");
  assert.equal(r.ok, false);
  assert.equal(r.error, "missing_app");
});

test("an app they actually have opens as the app, not the web", async () => {
  // The bug: "pull up Spotify" opened spotify.com instead of Spotify.
  for (const named of ["Spotify", "spotify", "Slack", "Google Chrome", "Safari"]) {
    const r = await open(named);
    assert.equal(r.ok, false, `${named} resolved to something in LYKN`);
    assert.equal(r.error, "mac_app", `${named} was not recognised as their app`);
    assert.match(r.message, /local_open_app/);
  }
});

test("the same name goes to the web for someone who doesn't have it", async () => {
  // Nothing about Spotify is special — it is only an app for people who
  // installed it. The person below did not.
  const r = await open("Spotify", INSTALLED, { macApps: ["Safari", "Mail"] });
  assert.equal(r.ok, false);
  assert.equal(r.error, "unknown_app");
  assert.match(r.message, /not installed on their Mac/);
  assert.match(r.message, /web is the right answer/);
});

test("the bare word still opens LYKN's own browser", async () => {
  for (const asked of ["browser", "the browser", "the web"]) {
    const r = await open(asked);
    assert.equal(r.ok, true, `"${asked}" did not open the browser`);
    assert.equal(r.id, "browser");
  }
});

test("a Mac app whose name reads like a LYKN surface goes to the Mac", async () => {
  // "Notes" used to open the vault, which is not what anyone means by it.
  for (const named of ["Notes", "Mail"]) {
    const r = await open(named);
    assert.equal(r.ok, false, `${named} resolved inside LYKN`);
    assert.equal(r.error, "mac_app");
  }
});

test("an app they built beats the Mac app of the same name", async () => {
  const r = await open("Notes", [{ id: "notes-9x8y", name: "Notes" }]);
  assert.equal(r.ok, true);
  assert.equal(r.kind, "installed");
  assert.equal(r.id, "notes-9x8y");
});

test("with Local Mode off it explains, rather than opening the web instead", async () => {
  const r = await open("Spotify", INSTALLED, { localMode: false });
  assert.equal(r.ok, false);
  assert.equal(r.error, "mac_app");
  assert.match(r.message, /Local Mode is OFF/);
  assert.match(r.message, /Do NOT quietly open the website/);
});

test("AI Drive and its two folders open by the words people use for them", async () => {
  for (const [asked, src] of [
    ["ai drive", "/vault?pane=drive"],
    ["my drive", "/vault?pane=drive"],
    ["what you built", "/vault?pane=drive"],
    ["docs", "/vault?pane=drive&folder=docs"],
    ["artifacts", "/vault?pane=drive&folder=artifacts"],
    ["image gen", "/vault?pane=drive&folder=images"],
    ["generated images", "/vault?pane=drive&folder=images"],
  ]) {
    const r = await open(asked);
    assert.equal(r.ok, true, `"${asked}" did not resolve`);
    assert.equal(r.kind, "drive");
    assert.equal(r.src, src, `"${asked}" opened ${r.src}`);
  }
});

test("that image opens the newest generated picture, not the Finder", async () => {
  const r = await open("that image");
  assert.equal(r.ok, true);
  assert.equal(r.kind, "drive");
  assert.equal(r.id, "note-33");
  assert.equal(r.folder, "images");
  assert.match(r.message, /view mode/);
});

test("something LYKN built opens on its own, not just the drive it lives in", async () => {
  const r = await open("Sales Dashboard");
  assert.equal(r.ok, true);
  assert.equal(r.kind, "drive");
  assert.equal(r.id, "note-11");
  // Folder AND row: the window has to enter the folder to show the item.
  assert.equal(r.src, "/vault?pane=drive&folder=artifacts&note=note-11");
});

test("a partial name opens a drive item only when one item could be meant", async () => {
  const one = await open("revenue chart");
  assert.equal(one.ok, true);
  assert.equal(one.id, "note-22");

  const ambiguous = await open("chart", INSTALLED, {
    aiDrive: [
      { id: "note-22", name: "Q3 Revenue Chart", folder: "artifacts" },
      { id: "note-44", name: "Headcount Chart", folder: "artifacts" },
    ],
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error, "unknown_app");
});

test("an app they built beats a drive item of the same name", async () => {
  const r = await open("Recipe Box", INSTALLED, {
    aiDrive: [{ id: "note-55", name: "Recipe Box", folder: "artifacts" }],
  });
  assert.equal(r.kind, "installed");
  assert.equal(r.id, "recipe-box-c3d4");
});

test("what is in the drive is reported when nothing matches, as a recent slice", async () => {
  const r = await open("Sparkle Widget");
  assert.deepEqual(r.aiDriveRecent, [
    "Sales Dashboard",
    "Q3 Revenue Chart",
    "AI Generated Aug 20-1a2b.png",
  ]);
  // The drive is deeper than the names we sent, and a miss here must not be
  // reported as "you never made that".
  assert.match(r.aiDriveNote, /only the most recently made items/);
});

test("an empty drive still lets the drive itself open", async () => {
  const r = await open("ai drive", INSTALLED, { aiDrive: [] });
  assert.equal(r.ok, true);
  assert.equal(r.src, "/vault?pane=drive");
});

test("off the desktop there is no Mac list, and nothing pretends otherwise", async () => {
  const res = await openAppTool.handler({ app: "Spotify" }, { userId: "u1" });
  const r = JSON.parse(res.content[0].text);
  assert.equal(r.ok, false);
  assert.equal(r.error, "unknown_app");
  // Can't claim it isn't installed — we have no idea what they have.
  assert.doesNotMatch(r.message, /not installed on their Mac/);
});
