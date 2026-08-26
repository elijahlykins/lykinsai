"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isPrivateIpMain, assertPublicHttpUrl, openExternalSafe } = require("./safeFetch.cjs");

test("rejects loopback and private IPv4", () => {
  assert.equal(isPrivateIpMain("127.0.0.1"), true);
  assert.equal(isPrivateIpMain("10.0.0.1"), true);
  assert.equal(isPrivateIpMain("192.168.1.1"), true);
  assert.equal(isPrivateIpMain("172.16.0.1"), true);
  assert.equal(isPrivateIpMain("169.254.169.254"), true);
  assert.equal(isPrivateIpMain("0.0.0.0"), true);
  assert.equal(isPrivateIpMain("100.64.0.1"), true);
});

test("allows public IPv4", () => {
  assert.equal(isPrivateIpMain("1.1.1.1"), false);
  assert.equal(isPrivateIpMain("8.8.8.8"), false);
});

test("rejects loopback and link-local IPv6", () => {
  assert.equal(isPrivateIpMain("::1"), true);
  assert.equal(isPrivateIpMain("fe80::1"), true);
});

test("assertPublicHttpUrl rejects non-http schemes and raw private IPs", async () => {
  assert.equal((await assertPublicHttpUrl("file:///etc/passwd")).ok, false);
  assert.equal((await assertPublicHttpUrl("http://127.0.0.1/")).error, "private_ip");
  assert.equal((await assertPublicHttpUrl("http://192.168.0.5/x")).error, "private_ip");
  assert.equal((await assertPublicHttpUrl("not a url")).error, "invalid_url");
});

test("openExternalSafe refuses file and custom schemes", () => {
  assert.equal(openExternalSafe("file:///tmp/x"), false);
  assert.equal(openExternalSafe("smb://host/share"), false);
  assert.equal(openExternalSafe("lykn://auth"), false);
});
