"use strict";

const dns = require("node:dns/promises");
const net = require("node:net");

function isPrivateIpMain(ip) {
  if (!ip) return true;
  const v = String(ip).toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIPv6(v)) {
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fe80") || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("ff")) return true;
    const mapped = v.match(/(?:::ffff:)((?:\d{1,3}\.){3}\d{1,3})$/);
    if (mapped) return isPrivateIpMain(mapped[1]);
    return false;
  }
  if (!net.isIPv4(v)) return true;
  const [a, b] = v.split(".").map((n) => parseInt(n, 10));
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

async function assertPublicHttpUrl(urlStr) {
  let parsed;
  try {
    parsed = new URL(String(urlStr || ""));
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "bad_scheme" };
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isPrivateIpMain(host)) return { ok: false, error: "private_ip" };
    return { ok: true, url: parsed.toString() };
  }
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    return { ok: false, error: "dns_failed" };
  }
  if (!addrs || !addrs.length) return { ok: false, error: "dns_empty" };
  for (const { address } of addrs) {
    if (isPrivateIpMain(address)) return { ok: false, error: "private_ip" };
  }
  return { ok: true, url: parsed.toString() };
}

async function safeFetchMain(url, init = {}, { maxRedirects = 5 } = {}) {
  let current = String(url || "");
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const safe = await assertPublicHttpUrl(current);
    if (!safe.ok) {
      const err = new Error(`ssrf_blocked:${safe.error}`);
      err.code = "SSRF_BLOCKED";
      throw err;
    }
    const res = await fetch(safe.url, { ...init, redirect: "manual" });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, safe.url).toString();
      continue;
    }
    return res;
  }
  const err = new Error("ssrf_blocked:too_many_redirects");
  err.code = "SSRF_BLOCKED";
  throw err;
}

const OPEN_EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);
function openExternalSafe(url) {
  try {
    const proto = new URL(String(url || "")).protocol;
    if (OPEN_EXTERNAL_SCHEMES.has(proto)) {
      const { shell } = require("electron");
      shell.openExternal(url);
      return true;
    }
  } catch {
    /* unparseable → never open */
  }
  return false;
}

module.exports = {
  isPrivateIpMain,
  assertPublicHttpUrl,
  safeFetchMain,
  openExternalSafe,
};
