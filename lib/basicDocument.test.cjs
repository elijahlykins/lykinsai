"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assembleDocument,
  filenameFromTitle,
  isHtmlDocument,
  looksLikeWrittenDocumentAsk,
  markdownToHtml,
  parseDocumentInstruction,
  sanitizeTitle,
} = require("./basicDocument.cjs");

test("filenameFromTitle makes a safe html name", () => {
  assert.equal(filenameFromTitle("Cover Letter"), "Cover-Letter.html");
  assert.equal(filenameFromTitle('A / B: "notes"?'), "A-B-notes.html");
});

test("assembleDocument wraps markdown as a standalone html file", () => {
  const doc = assembleDocument({
    title: "Cover Letter",
    content: "# Cover Letter\n\nDear Hiring Manager,\n\nI am writing to apply.",
  });
  assert.equal(doc.ok, true);
  assert.equal(doc.filename, "Cover-Letter.html");
  assert.match(doc.html, /<!doctype html>/i);
  assert.match(doc.html, /<title>Cover Letter<\/title>/);
  assert.match(doc.html, /<h1>Cover Letter<\/h1>/);
  assert.match(doc.html, /Dear Hiring Manager/);
  assert.match(doc.markdown, /Dear Hiring Manager/);
});

test("assembleDocument keeps a full html document", () => {
  const html = "<!DOCTYPE html><html><head></head><body><p>Hi</p></body></html>";
  const doc = assembleDocument({ content: html });
  assert.equal(doc.ok, true);
  assert.match(doc.html, /<p>Hi<\/p>/);
  assert.match(doc.html, /<title>Document<\/title>/);
});

test("assembleDocument refuses empty content", () => {
  assert.equal(assembleDocument({ title: "X", content: "  " }).ok, false);
});

test("isHtmlDocument detects a real document and ignores mentions", () => {
  assert.equal(isHtmlDocument("<!DOCTYPE html><html></html>"), true);
  assert.equal(isHtmlDocument("Use the <html> tag"), false);
});

test("parseDocumentInstruction reads Title: and headings", () => {
  const a = parseDocumentInstruction("Title: Thank-you note\n\nThanks for lunch.");
  assert.equal(a.title, "Thank-you note");
  assert.match(a.content, /Thanks for lunch/);
  const b = parseDocumentInstruction("# Meeting notes\n- ship date");
  assert.equal(b.title, "Meeting notes");
});

test("looksLikeWrittenDocumentAsk catches letters and write-outs", () => {
  assert.equal(looksLikeWrittenDocumentAsk("write me a letter to my landlord"), true);
  assert.equal(looksLikeWrittenDocumentAsk("draft a memo about the hire"), true);
  assert.equal(looksLikeWrittenDocumentAsk("write this out"), true);
  assert.equal(looksLikeWrittenDocumentAsk("put this in a document"), true);
  assert.equal(looksLikeWrittenDocumentAsk("write me something I can send"), true);
});

test("looksLikeWrittenDocumentAsk leaves research, apps, and chat alone", () => {
  assert.equal(looksLikeWrittenDocumentAsk("write me a report on espresso machines"), false);
  assert.equal(looksLikeWrittenDocumentAsk("write me a landing page"), false);
  assert.equal(looksLikeWrittenDocumentAsk("what should I say to my boss"), false);
  assert.equal(looksLikeWrittenDocumentAsk("hello"), false);
});

test("markdownToHtml renders lists and emphasis", () => {
  const html = markdownToHtml("Hello **there**\n\n- one\n- two");
  assert.match(html, /<strong>there<\/strong>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<li>one<\/li>/);
});

test("sanitizeTitle strips tags and caps length", () => {
  assert.equal(sanitizeTitle("<b>Hi</b>"), "Hi");
  assert.equal(sanitizeTitle(""), "Document");
});
