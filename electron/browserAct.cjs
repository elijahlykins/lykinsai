/**
 * Browser control for the ⌘L overlay — read interactable elements and execute
 * clicks/types via AppleScript JavaScript (Chrome/Safari + Apple Events).
 */

function decodeBrowserPayload(out) {
  if (!out) return null;
  try {
    const json = Buffer.from(String(out).trim(), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function buildRunJavascriptScript(appName, js) {
  if (/["\\]/.test(js)) {
    throw new Error("browser JS must not contain double quotes or backslashes");
  }
  const isSafari = /^Safari/.test(appName);
  return isSafari
    ? `tell application "${appName}" to do JavaScript "${js}" in current tab of front window`
    : `tell application "${appName}" to execute active tab of front window javascript "${js}"`;
}

// Collect buttons, links, and fields with stable CSS selectors (base64 JSON out).
const COLLECT_INTERACTABLES_JS =
  "(function(){function p(el){if(!el||el.nodeType!==1)return'';if(el.id)return '#'+CSS.escape(el.id);" +
  "var a=[],n=el;while(n&&n.nodeType===1&&a.length<6){var t=n.nodeName.toLowerCase();" +
  "if(n.id){a.unshift('#'+CSS.escape(n.id));break;}var s=n,x=1;" +
  "while(s=s.previousElementSibling){if(s.nodeName===n.nodeName)x++;}" +
  "a.unshift(t+(x>1?':nth-of-type('+x+')':''));n=n.parentElement;}return a.join(' > ');}" +
  "var items=[],q='a[href],button,input,textarea,select,[role=button],[role=link],[contenteditable=true]';" +
  "document.querySelectorAll(q).forEach(function(el,i){if(i>80)return;var r=el.getBoundingClientRect();" +
  "if(r.width<2||r.height<2)return;var st=getComputedStyle(el);" +
  "if(st.visibility==='hidden'||st.display==='none')return;var tag=el.tagName.toLowerCase()," +
  "type=el.getAttribute('type')||'',lab=(el.getAttribute('aria-label')||el.innerText||el.placeholder||el.name||el.id||'').trim().slice(0,120);" +
  "if(!lab&&tag!=='input'&&tag!=='textarea')return;" +
  "items.push({id:'el'+items.length,tag:tag,type:type,selector:p(el),label:lab,value:(el.value||'').slice(0,80),href:(el.href||'').slice(0,200)});});" +
  "return btoa(unescape(encodeURIComponent(JSON.stringify({url:location.href,title:document.title,items:items}))));})()";

const RUN_ACTION_JS_PREFIX =
  "(function(b){try{var a=JSON.parse(decodeURIComponent(escape(atob(b))));" +
  "var el=document.querySelector(a.selector);if(!el)return btoa(unescape(encodeURIComponent(JSON.stringify({ok:false,error:'Element not found'}))));" +
  "el.scrollIntoView({block:'center',inline:'center'});" +
  "if(a.type==='click'){el.click();return btoa(unescape(encodeURIComponent(JSON.stringify({ok:true}))));}" +
  "if(a.type==='type'){el.focus();el.value=a.value||'';el.dispatchEvent(new Event('input',{bubbles:true}));" +
  "el.dispatchEvent(new Event('change',{bubbles:true}));return btoa(unescape(encodeURIComponent(JSON.stringify({ok:true}))));}" +
  "if(a.type==='press'){el.focus();var k=a.key||'Enter';" +
  "el.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true}));" +
  "el.dispatchEvent(new KeyboardEvent('keyup',{key:k,bubbles:true}));" +
  "return btoa(unescape(encodeURIComponent(JSON.stringify({ok:true}))));}" +
  "if(a.type==='scroll'){window.scrollBy(0,Number(a.delta)||400);" +
  "return btoa(unescape(encodeURIComponent(JSON.stringify({ok:true}))));}" +
  "return btoa(unescape(encodeURIComponent(JSON.stringify({ok:false,error:'Unknown action'}))));" +
  "}catch(e){return btoa(unescape(encodeURIComponent(JSON.stringify({ok:false,error:String(e.message||e)}))));}})('";

async function runBrowserJavascript(runOsascript, appName, js) {
  const script = buildRunJavascriptScript(appName, js);
  return runOsascript(script, 12000);
}

async function activateBrowser(runOsascript, appName) {
  await runOsascript(`tell application "${appName}" to activate`, 4000);
  await new Promise((r) => setTimeout(r, 250));
}

async function collectBrowserInteractables(runOsascript, appName) {
  const r = await runBrowserJavascript(runOsascript, appName, COLLECT_INTERACTABLES_JS);
  if (r.error) {
    if (/turned off|not allowed|Allow JavaScript|Apple Events/i.test(r.error)) {
      return { error: "apple_events_disabled", message: r.error };
    }
    return { error: "script_failed", message: r.error };
  }
  const data = decodeBrowserPayload(r.out);
  if (!data || !Array.isArray(data.items)) {
    return { error: "parse_failed" };
  }
  return { ok: true, page: data };
}

async function executeBrowserAction(runOsascript, appName, action) {
  const payload = Buffer.from(JSON.stringify(action), "utf8").toString("base64");
  const js = RUN_ACTION_JS_PREFIX + payload + "')";
  const r = await runBrowserJavascript(runOsascript, appName, js);
  if (r.error) {
    return { ok: false, error: r.error, label: action.label || action.selector };
  }
  const data = decodeBrowserPayload(r.out);
  if (!data) return { ok: false, error: "bad_result", label: action.label || action.selector };
  return { ...data, label: action.label || action.selector, type: action.type };
}

async function executeBrowserActions(runOsascript, appName, actions) {
  await activateBrowser(runOsascript, appName);
  const results = [];
  for (const action of actions) {
    const result = await executeBrowserAction(runOsascript, appName, action);
    results.push(result);
    if (!result.ok) break;
    await new Promise((r) => setTimeout(r, 350));
  }
  return results;
}

function sanitizePlanActions(raw, knownSelectors) {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set(["click", "type", "press", "scroll"]);
  const known =
    knownSelectors instanceof Set
      ? knownSelectors
      : new Set(Array.isArray(knownSelectors) ? knownSelectors : []);
  const out = [];
  for (const a of raw.slice(0, 8)) {
    if (!a || typeof a !== "object") continue;
    const type = String(a.type || "").trim().toLowerCase();
    if (!allowed.has(type)) continue;
    const selector = String(a.selector || "").trim();
    if (type !== "scroll" && !selector) continue;
    if (type !== "scroll" && known.size > 0 && !known.has(selector)) continue;
    const step = {
      type,
      selector,
      label: String(a.label || "").trim().slice(0, 120) || selector.slice(0, 80),
    };
    if (type === "type") step.value = String(a.value ?? "").slice(0, 500);
    if (type === "press") step.key = String(a.key || "Enter").slice(0, 20);
    if (type === "scroll") step.delta = Number(a.delta) || 400;
    out.push(step);
  }
  return out;
}

module.exports = {
  collectBrowserInteractables,
  executeBrowserActions,
  sanitizePlanActions,
};
