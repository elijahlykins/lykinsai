/**
 * Rich-document reading and editing through the local tools — the capability
 * the bots reach via local_computer.
 *
 * What's worth pinning down: local_read_file extracts real text from PDF /
 * Word / Excel instead of refusing them as binary; local_edit_file edits
 * spreadsheet cells in place (formulas survive), regenerates PDFs and Word
 * docs from their text, defaults to a sibling "(edited)" file so the lossy
 * paths can never destroy an original, and honors overwrite when asked.
 * Fixtures are generated at runtime, so nothing binary is checked in.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const localSystem = require("./localSystem.cjs");

let dir;

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-doc-"));
});

function run(name, args) {
  // No local-mode config in the temp userData → syncAll default, all paths
  // allowed. approved covers the write-side approval gate.
  return localSystem.run(name, args, { approved: true, userDataPath: dir });
}

async function makeXlsx(file) {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Budget");
  ws.getCell("A1").value = "Item";
  ws.getCell("B1").value = "Cost";
  ws.getCell("A2").value = "Office chair";
  ws.getCell("B2").value = 250;
  ws.getCell("A3").value = "Standing desk";
  ws.getCell("B3").value = 400;
  ws.getCell("B4").value = { formula: "SUM(B2:B3)" };
  await wb.xlsx.writeFile(file);
}

function makePdf(file, text) {
  const { jsPDF } = require("jspdf");
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  doc.setFontSize(11);
  doc.text(text, 18, 24);
  return fsp.writeFile(file, Buffer.from(doc.output("arraybuffer")));
}

function makeDocx(file, text) {
  const tmp = file.replace(/\.docx$/, ".txt");
  fs.writeFileSync(tmp, text, "utf8");
  return new Promise((resolve, reject) => {
    execFile("textutil", ["-convert", "docx", tmp, "-output", file], (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

const onMac = process.platform === "darwin";

// ── Reading ──────────────────────────────────────────────────────────────────

test("local_read_file extracts spreadsheet text sheet by sheet", async () => {
  const file = path.join(dir, "budget.xlsx");
  await makeXlsx(file);
  const out = await run("local_read_file", { path: file });
  assert.equal(out.ok, true);
  assert.equal(out.format, "xlsx");
  assert.match(out.content, /Sheet: Budget/);
  assert.match(out.content, /Office chair/);
  assert.match(out.content, /Standing desk/);
});

test("local_read_file extracts PDF text page by page", async () => {
  const file = path.join(dir, "report.pdf");
  await makePdf(file, "The quarterly total was 90 dollars.");
  const out = await run("local_read_file", { path: file });
  assert.equal(out.ok, true);
  assert.equal(out.format, "pdf");
  assert.equal(out.pageCount, 1);
  assert.match(out.content, /quarterly total was 90 dollars/);
});

test("local_read_file extracts Word documents", { skip: !onMac }, async () => {
  const file = path.join(dir, "memo.docx");
  await makeDocx(file, "Please ship the beta on Friday.");
  const out = await run("local_read_file", { path: file });
  assert.equal(out.ok, true);
  assert.match(out.content, /ship the beta on Friday/);
});

test("plain text files still read straight through", async () => {
  const file = path.join(dir, "notes.txt");
  fs.writeFileSync(file, "plain text stays plain", "utf8");
  const out = await run("local_read_file", { path: file });
  assert.equal(out.ok, true);
  assert.equal(out.content, "plain text stays plain");
  assert.equal(out.format, undefined);
});

// ── Editing: xlsx in place ───────────────────────────────────────────────────

test("xlsx edit updates the matching cell and keeps formulas", async () => {
  const file = path.join(dir, "budget.xlsx");
  await makeXlsx(file);
  const out = await run("local_edit_file", {
    path: file,
    oldText: "Office chair",
    newText: "Ergonomic chair",
  });
  assert.equal(out.ok, true);
  assert.equal(out.replacements, 1);
  assert.equal(out.outputPath, path.join(dir, "budget (edited).xlsx"));

  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out.outputPath);
  const ws = wb.getWorksheet("Budget");
  assert.equal(ws.getCell("A2").value, "Ergonomic chair");
  assert.equal(ws.getCell("B4").value.formula, "SUM(B2:B3)");

  // The original is untouched.
  const original = await run("local_read_file", { path: file });
  assert.match(original.content, /Office chair/);
});

test("xlsx edit refuses ambiguous matches without replaceAll", async () => {
  const ExcelJS = require("exceljs");
  const file = path.join(dir, "dupes.xlsx");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("S");
  ws.getCell("A1").value = "repeat me";
  ws.getCell("A2").value = "repeat me";
  await wb.xlsx.writeFile(file);

  const out = await run("local_edit_file", { path: file, oldText: "repeat me", newText: "once" });
  assert.equal(out.ok, false);
  assert.match(out.error, /2 times/);

  const all = await run("local_edit_file", {
    path: file,
    oldText: "repeat me",
    newText: "once",
    replaceAll: true,
  });
  assert.equal(all.ok, true);
  assert.equal(all.replacements, 2);
});

// ── Editing: pdf regeneration ────────────────────────────────────────────────

test("pdf edit writes a sibling copy with the replaced text", async () => {
  const file = path.join(dir, "report.pdf");
  await makePdf(file, "The quarterly total was 90 dollars.");
  const out = await run("local_edit_file", {
    path: file,
    oldText: "90 dollars",
    newText: "95 dollars",
  });
  assert.equal(out.ok, true);
  assert.equal(out.outputPath, path.join(dir, "report (edited).pdf"));
  assert.match(out.note, /original is untouched/);

  const edited = await run("local_read_file", { path: out.outputPath });
  assert.match(edited.content, /95 dollars/);
  const original = await run("local_read_file", { path: file });
  assert.match(original.content, /90 dollars/);
});

test("pdf edit with overwrite replaces the original", async () => {
  const file = path.join(dir, "inplace.pdf");
  await makePdf(file, "Version A of the plan.");
  const out = await run("local_edit_file", {
    path: file,
    oldText: "Version A",
    newText: "Version B",
    overwrite: true,
  });
  assert.equal(out.ok, true);
  assert.equal(out.outputPath, file);
  assert.match(out.note, /overwritten/);
  const read = await run("local_read_file", { path: file });
  assert.match(read.content, /Version B of the plan/);
});

test("pdf edit reports a missing snippet instead of writing anything", async () => {
  const file = path.join(dir, "miss.pdf");
  await makePdf(file, "Nothing to see here.");
  const out = await run("local_edit_file", { path: file, oldText: "absent text", newText: "x" });
  assert.equal(out.ok, false);
  assert.match(out.error, /not found/);
  assert.equal(fs.existsSync(path.join(dir, "miss (edited).pdf")), false);
});

// ── Editing: Word via textutil ───────────────────────────────────────────────

test("docx edit round-trips through textutil", { skip: !onMac }, async () => {
  const file = path.join(dir, "memo.docx");
  await makeDocx(file, "Please ship the beta on Friday.");
  const out = await run("local_edit_file", {
    path: file,
    oldText: "Friday",
    newText: "Monday",
  });
  assert.equal(out.ok, true);
  assert.equal(out.outputPath, path.join(dir, "memo (edited).docx"));
  const edited = await run("local_read_file", { path: out.outputPath });
  assert.match(edited.content, /ship the beta on Monday/);
});

// ── Text files keep today's behavior ─────────────────────────────────────────

test("text file edits stay in place, no sibling copies", async () => {
  const file = path.join(dir, "config.txt");
  fs.writeFileSync(file, "mode: draft\n", "utf8");
  const out = await run("local_edit_file", { path: file, oldText: "draft", newText: "final" });
  assert.equal(out.ok, true);
  assert.equal(out.path, file);
  assert.equal(out.outputPath, undefined);
  assert.equal(fs.readFileSync(file, "utf8"), "mode: final\n");
});

// ── Approval copy ────────────────────────────────────────────────────────────

test("the approval card says where a document edit will land", () => {
  const sibling = localSystem.classifyRisk("local_edit_file", {
    path: path.join(dir, "report.pdf"),
    oldText: "a",
    newText: "b",
  });
  assert.equal(sibling.risky, true);
  assert.match(sibling.summary, /\(edited\)' copy beside the original/);

  const overwrite = localSystem.classifyRisk("local_edit_file", {
    path: path.join(dir, "report.pdf"),
    oldText: "a",
    newText: "b",
    overwrite: true,
  });
  assert.match(overwrite.summary, /overwrites the original/);

  const text = localSystem.classifyRisk("local_edit_file", {
    path: path.join(dir, "notes.txt"),
    oldText: "a",
    newText: "b",
  });
  assert.match(text.summary, /^Edit file:/);
});
