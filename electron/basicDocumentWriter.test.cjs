"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { writeBasicDocument } = require("./basicDocumentWriter.cjs");

test("writes html to Downloads and broadcasts it for AI Drive / Docs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-doc-"));
  const opened = [];
  const result = await writeBasicDocument(
    { title: "Cover Letter", content: "Dear team,\n\nThanks." },
    {
      downloadsDir: dir,
      shell: { openPath: (p) => opened.push(p) },
      broadcastToAllWindows: (channel, payload) => opened.push({ channel, payload }),
      app: null,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.filename, "Cover-Letter.html");
  assert.ok(result.path.startsWith(dir));
  assert.ok(fs.existsSync(result.path));
  const html = fs.readFileSync(result.path, "utf8");
  assert.match(html, /Dear team/);
  assert.equal(
    opened.some((entry) => typeof entry === "string"),
    false,
    "must not open Safari / Chrome via shell.openPath",
  );
  assert.equal(opened[0].channel, "lykn:open-ai-drive-item");
  assert.equal(opened[0].payload.folder, "docs");
  assert.equal(opened[0].payload.filename, "Cover-Letter.html");
  assert.match(String(opened[0].payload.html || ""), /Dear team/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("refuses empty content", async () => {
  const result = await writeBasicDocument({ title: "Empty", content: "" }, { app: null });
  assert.equal(result.ok, false);
});
