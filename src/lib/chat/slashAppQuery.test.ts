import test from "node:test";
import assert from "node:assert/strict";
import {
  attachedAppsFromComposer,
  findSlashAppToken,
  looksLikeAppShortcut,
  mergeSlashAppOptions,
  rankSlashAppOptions,
  slashAppFromMac,
  slashAppFromManaged,
  slashAppFromMcp,
  type SlashAppOption,
} from "./slashAppQuery";

test("findSlashAppToken treats /app as the picker command", () => {
  assert.deepEqual(findSlashAppToken("/app", 4), {
    start: 0,
    end: 4,
    raw: "/app",
    query: "",
    kind: "picker",
  });
  assert.deepEqual(findSlashAppToken("/app ", 5), {
    start: 0,
    end: 5,
    raw: "/app ",
    query: "",
    kind: "picker",
  });
  assert.deepEqual(findSlashAppToken("/app gmail", 10), {
    start: 0,
    end: 10,
    raw: "/app gmail",
    query: "gmail",
    kind: "search",
  });
  assert.equal(findSlashAppToken("/apple", 6), null);
  assert.equal(findSlashAppToken("/applications", 13), null);
});

test("findSlashAppToken matches /gmail and /spotify shortcuts", () => {
  assert.deepEqual(findSlashAppToken("/gmail", 6), {
    start: 0,
    end: 6,
    raw: "/gmail",
    query: "gmail",
    kind: "search",
  });
  assert.deepEqual(findSlashAppToken("check /spotify", 14), {
    start: 6,
    end: 14,
    raw: "/spotify",
    query: "spotify",
    kind: "search",
  });
  assert.equal(findSlashAppToken("/Documents", 10), null);
  assert.equal(findSlashAppToken("/Users/lykn", 11), null);
  assert.equal(findSlashAppToken("/gpt-5", 6), null);
});

test("looksLikeAppShortcut ignores folders and the /app command itself", () => {
  assert.equal(looksLikeAppShortcut("gmail"), true);
  assert.equal(looksLikeAppShortcut("spotify"), true);
  assert.equal(looksLikeAppShortcut("Documents"), false);
  assert.equal(looksLikeAppShortcut("app"), false);
  assert.equal(looksLikeAppShortcut("Music"), false);
});

test("rankSlashAppOptions puts connected apps first, then closest name", () => {
  const options: SlashAppOption[] = [
    { id: "mac:/Apps/Spotify.app", name: "Spotify", source: "mac" },
    { id: "connected:g1", name: "Gmail", source: "connected", catalogId: "gmail" },
    { id: "connected:s1", name: "Slack", source: "connected", catalogId: "slack" },
    { id: "mac:/Apps/Safari.app", name: "Safari", source: "mac" },
  ];
  assert.deepEqual(
    rankSlashAppOptions(options, "").map((o) => o.name),
    ["Gmail", "Slack", "Spotify", "Safari"],
  );
  assert.deepEqual(
    rankSlashAppOptions(options, "spot").map((o) => o.name),
    ["Spotify"],
  );
  assert.deepEqual(
    rankSlashAppOptions(options, "gmail").map((o) => o.name),
    ["Gmail"],
  );
});

test("builders skip disconnected rows and merge connected before Mac", () => {
  assert.equal(slashAppFromMcp({ id: "1", name: "Gmail", status: "disconnected" }), null);
  assert.equal(slashAppFromManaged({ provider: "gmail", label: "Gmail", connected: false }), null);
  const gmail = slashAppFromMcp({
    id: "c1",
    name: "Gmail",
    status: "connected",
    catalogId: "gmail",
  });
  const managed = slashAppFromManaged({
    provider: "gmail",
    label: "Gmail",
    connected: true,
    status: "connected",
  });
  const spotify = slashAppFromMac({ name: "Spotify", path: "/Applications/Spotify.app" });
  assert.equal(gmail?.source, "connected");
  assert.equal(spotify?.source, "mac");
  const merged = mergeSlashAppOptions(
    [gmail, managed].filter(Boolean) as SlashAppOption[],
    [spotify!],
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].name, "Gmail");
  assert.equal(merged[1].name, "Spotify");
});

test("attachedAppsFromComposer serializes app chips without file bytes", () => {
  assert.deepEqual(
    attachedAppsFromComposer([
      { type: "app", name: "Gmail", appSource: "connected", appId: "connected:c1", catalogId: "gmail" },
      { kind: "app", name: "Spotify", source: "mac", appId: "mac:/Applications/Spotify.app", path: "/Applications/Spotify.app" },
      { type: "image", name: "shot.png" },
    ]),
    [
      { name: "Gmail", source: "connected", id: "connected:c1", catalogId: "gmail" },
      {
        name: "Spotify",
        source: "mac",
        id: "mac:/Applications/Spotify.app",
        path: "/Applications/Spotify.app",
      },
    ],
  );
});
