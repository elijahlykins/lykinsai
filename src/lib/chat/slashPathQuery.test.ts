import test from "node:test";
import assert from "node:assert/strict";
import {
  findSlashPathToken,
  rankSlashPathItems,
  replaceSlashPathToken,
  slashPathDisplay,
  splitSlashPathQuery,
  type SlashPathItem,
} from "./slashPathQuery";

test("findSlashPathToken picks a slash at the start or after whitespace", () => {
  assert.deepEqual(findSlashPathToken("/Documents", 10), {
    start: 0,
    end: 10,
    raw: "/Documents",
  });
  assert.deepEqual(findSlashPathToken("look at /Users/a", 16), {
    start: 8,
    end: 16,
    raw: "/Users/a",
  });
  assert.equal(findSlashPathToken("and/or", 6), null);
  assert.equal(findSlashPathToken("https://example.com/a", 21), null);
  assert.deepEqual(findSlashPathToken("see https://x.com /file", 23), {
    start: 18,
    end: 23,
    raw: "/file",
  });
});

test("splitSlashPathQuery treats a lone slash as home + roots", () => {
  assert.deepEqual(splitSlashPathQuery("/"), { dir: "~", filter: "", useRoots: true });
  assert.deepEqual(splitSlashPathQuery("/Doc"), {
    dir: "~",
    filter: "Doc",
    useRoots: true,
  });
  assert.deepEqual(splitSlashPathQuery("/Users/lykn/Des"), {
    dir: "/Users/lykn",
    filter: "Des",
    useRoots: false,
  });
  assert.deepEqual(splitSlashPathQuery("/Users/lykn/"), {
    dir: "/Users/lykn",
    filter: "",
    useRoots: false,
  });
});

test("rankSlashPathItems prefers prefix matches", () => {
  const items: SlashPathItem[] = [
    { name: "readme.md", path: "/a/readme.md", kind: "file" },
    { name: "Desktop", path: "/a/Desktop", kind: "folder" },
    { name: "Documents", path: "/a/Documents", kind: "folder" },
  ];
  assert.deepEqual(
    rankSlashPathItems(items, "Do").map((i) => i.name),
    ["Documents"],
  );
  assert.deepEqual(
    rankSlashPathItems(items, "Des").map((i) => i.name),
    ["Desktop"],
  );
  assert.deepEqual(
    rankSlashPathItems(items, "read").map((i) => i.name),
    ["readme.md"],
  );
});

test("rankSlashPathItems puts the closest name first", () => {
  const items: SlashPathItem[] = [
    { name: "notes-LYKN.md", path: "/a/notes-LYKN.md", kind: "file" },
    { name: "LYKN-example-more", path: "/a/Projects/LYKN-example-more", kind: "folder" },
    { name: "LYKN-example", path: "/a/Projects/LYKN-example", kind: "folder" },
    { name: "myLYKN", path: "/a/myLYKN", kind: "folder" },
    { name: "LYKN.txt", path: "/a/LYKN.txt", kind: "file" },
    { name: "LYKN", path: "/a/LYKN", kind: "folder" },
  ];
  assert.deepEqual(
    rankSlashPathItems(items, "LYKN").map((i) => i.name),
    ["LYKN", "LYKN-example", "LYKN-example-more", "LYKN.txt", "notes-LYKN.md", "myLYKN"],
  );
});

test("replaceSlashPathToken swaps the /query for a chip-sized hole", () => {
  assert.equal(replaceSlashPathToken("look at /file please", { start: 8, end: 13, raw: "/file" }, ""), "look at  please");
  assert.equal(
    replaceSlashPathToken("/Doc", { start: 0, end: 4, raw: "/Doc" }, "/Documents/"),
    "/Documents/",
  );
});

test("slashPathDisplay folds the home directory to ~", () => {
  assert.equal(slashPathDisplay("/Users/lykn/Desktop", "/Users/lykn"), "~/Desktop");
  assert.equal(slashPathDisplay("/Users/lykn", "/Users/lykn"), "~");
  assert.equal(slashPathDisplay("/Volumes/SSD", "/Users/lykn"), "/Volumes/SSD");
});

test("splitSlashPathQuery treats /specificfolderexample as a name search, not a path", () => {
  assert.deepEqual(splitSlashPathQuery("/specificfolderexample"), {
    dir: "~",
    filter: "specificfolderexample",
    useRoots: true,
  });
});
