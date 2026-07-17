/**
 * Browser control for the ⌘L overlay — read interactable elements and execute
 * clicks/types via AppleScript JavaScript (Chrome/Safari + Apple Events).
 */

const crypto = require("node:crypto");
const {
  pageSignature,
  questionSignature,
  snapshotFlags,
  comparePageSnapshots,
  formatPageDiff,
} = require("../lib/browserScreen.cjs");

let nutMouse = null;
try {
  const nut = require("@nut-tree-fork/nut-js");
  nutMouse = { mouse: nut.mouse, Button: nut.Button, Point: nut.Point };
} catch {
  /* optional — falls back to osascript clicks */
}

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
  "var items=[],q='input,textarea,select,button,a[href],img[alt],img[title],picture,canvas,[role=button],[role=link],[role=searchbox],[role=combobox],[role=radio],[role=option],[role=tab],[role=img],[role=row],[role=listitem],[role=gridcell],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=treeitem],[role=checkbox],[role=switch],tr,li,figure,label,input[type=radio],input[type=checkbox],[tabindex],[onclick]';" +
  "document.querySelectorAll(q).forEach(function(el,i){if(items.length>=170||i>2000)return;var r=el.getBoundingClientRect();" +
  "if(r.width<2||r.height<2)return;var st=getComputedStyle(el);" +
  "if(st.visibility==='hidden'||st.display==='none'||st.pointerEvents==='none')return;" +
  "var ti=el.getAttribute('tabindex');if(ti!==null&&parseInt(ti,10)<0)return;var tag=el.tagName.toLowerCase()," +
  "type=el.getAttribute('type')||'',role=el.getAttribute('role')||''," +
  "lab=(el.getAttribute('aria-label')||el.getAttribute('alt')||el.getAttribute('title')||el.innerText||el.placeholder||el.name||el.id||'').trim().slice(0,120);" +
  "if(!lab&&tag==='img')lab='image';" +
  "if(!lab&&tag!=='input'&&tag!=='textarea'&&role!=='searchbox'&&tag!=='img'&&tag!=='canvas')return;" +
  "function isSel(el){if(!el)return false;if(el.checked||el.getAttribute('aria-checked')==='true'||el.getAttribute('aria-selected')==='true'||el.getAttribute('aria-pressed')==='true')return true;" +
  "function selCls(c){var s=(' '+String(c||'').toLowerCase().replace(/[^a-z0-9_-]+/g,' ')+' ');" +
  "return s.indexOf(' selected ')>-1||s.indexOf(' checked ')>-1||s.indexOf(' active ')>-1||s.indexOf(' is-selected ')>-1||s.indexOf(' is-checked ')>-1||s.indexOf(' choice-selected ')>-1||s.indexOf(' answer-selected ')>-1;}" +
  "if(selCls(el.className))return true;" +
  "var n=el.parentElement;for(var d=0;d<5&&n;d++){if(n.getAttribute('aria-checked')==='true'||n.getAttribute('aria-selected')==='true'||n.getAttribute('aria-pressed')==='true')return true;" +
  "if(selCls(n.className))return true;n=n.parentElement;}return false;}" +
  "items.push({id:'el'+items.length,tag:tag,type:type,role:role,selector:p(el),label:lab,value:(el.value||'').slice(0,80),href:(el.href||'').slice(0,200),checked:isSel(el),clientX:Math.round(r.left+r.width/2),clientY:Math.round(r.top+r.height/2),clientW:Math.round(r.width),clientH:Math.round(r.height)});});" +
  "return btoa(unescape(encodeURIComponent(JSON.stringify({url:location.href,title:document.title,items:items}))));})()";

// Visible viewport text — what the user actually sees on screen.
const EXTRACT_PAGE_CONTEXT_JS =
  "(function(){var sp=/ +/g,nl=String.fromCharCode(10);" +
  "var vh=window.innerHeight||800,vw=window.innerWidth||1200;" +
  "function vis(el){if(!el)return false;var r=el.getBoundingClientRect();if(r.width<2||r.height<2)return false;" +
  "if(r.bottom<0||r.top>vh||r.right<0||r.left>vw)return false;" +
  "var st=getComputedStyle(el);return st.visibility!=='hidden'&&st.display!=='none'&&st.opacity!=='0';}" +
  "function txt(el){return ((el.getAttribute('aria-label')||el.innerText||el.textContent||'')+'').replace(sp,' ').trim();}" +
  "var seen=new Set(),parts=[],root=document.querySelector('main')||document.querySelector('[role=main]')||document.body;" +
  "var nodes=root.querySelectorAll('h1,h2,h3,h4,p,li,label,button,[role=radio],[role=button],[role=heading],[role=option],span,div');" +
  "for(var i=0;i<nodes.length&&parts.length<150;i++){var n=nodes[i];if(!vis(n))continue;var t=txt(n);if(!t||t.length<2||seen.has(t))continue;" +
  "if(t.length>300&&n.children.length>2)continue;seen.add(t);parts.push(t);}" +
  "if(!parts.length){var raw=(root.innerText||'').replace(sp,' ').trim();parts.push(raw.slice(0,8000));}" +
  "var text=((document.title||'')+nl+parts.join(nl)).replace(sp,' ').trim().slice(0,9000);" +
  "return btoa(unescape(encodeURIComponent(JSON.stringify({text:text}))));})()";

const RUN_ACTION_JS_PREFIX =
  "(function(b){try{var a=JSON.parse(decodeURIComponent(escape(atob(b))));" +
  "function vis(el){if(!el)return false;var r=el.getBoundingClientRect();if(r.width<2||r.height<2)return false;" +
  "var st=getComputedStyle(el);return st.visibility!=='hidden'&&st.display!=='none'&&st.pointerEvents!=='none';}" +
  "function labOf(n){return (n.getAttribute('aria-label')||n.getAttribute('placeholder')||n.getAttribute('name')||n.innerText||n.textContent||'').replace(/ +/g,' ').trim().toLowerCase();}" +
  "function pickClickTarget(el){if(!el)return null;" +
  "if(el.tagName==='LABEL'){var fid=el.getAttribute('for');if(fid){var inp=document.getElementById(fid);if(inp)return inp;}}" +
  "if(el.querySelector){var inner=el.querySelector('input[type=radio],input[type=checkbox],[role=radio]');if(inner)return inner;}" +
  "var role=el.getAttribute('role')||'';if(role==='radio'||role==='option'||role==='button')return el;" +
  "var p=el.parentElement;if(p&&p.getAttribute&&p.getAttribute('role')==='radio')return p;return el;}" +
  "function findEl(a){var el=document.querySelector(a.selector);if(el&&vis(el))el=pickClickTarget(el);" +
  "if(el&&vis(el))return el;var want=(a.label||'').toLowerCase().trim();if(!want)return null;" +
  "var nodes=document.querySelectorAll('input,textarea,select,button,a,img,picture,canvas,[role=button],[role=link],[role=searchbox],[role=combobox],[role=radio],[role=option],[role=img],figure,label,[contenteditable=true],[tabindex],[onclick]');" +
  "var best=null,bestScore=0;for(var i=0;i<nodes.length;i++){var n=nodes[i],lab=labOf(n);if(!lab)continue;" +
  "if(lab.indexOf(want)<0&&want.indexOf(lab)<0)continue;if(!vis(n))continue;n=pickClickTarget(n);if(!n||!vis(n))continue;" +
  "var r=n.getBoundingClientRect();var inView=r.top>=-4&&r.left>=-4&&r.bottom<=(window.innerHeight||800)+4&&r.right<=(window.innerWidth||1200)+4;" +
  "var score=(inView?200:0)+Math.min(r.width*r.height,8000);if(score>bestScore){bestScore=score;best=n;}}return best;}" +
  "function setVal(el,v){el.focus();if(el.isContentEditable){el.textContent=v;" +
  "el.dispatchEvent(new InputEvent('input',{bubbles:true,data:v,inputType:'insertFromPaste'}));return;}" +
  "var p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;" +
  "var d=Object.getOwnPropertyDescriptor(p,'value');if(d&&d.set)d.set.call(el,v);else el.value=v;" +
  "el.dispatchEvent(new InputEvent('input',{bubbles:true,data:v,inputType:'insertFromPaste'}));" +
  "el.dispatchEvent(new Event('change',{bubbles:true}));}" +
  "function doClick(el){var t=pickClickTarget(el)||el;t.scrollIntoView({block:'center',inline:'center'});t.focus();" +
  "try{if(typeof t.click==='function')t.click();}catch(x){}" +
  "if(t.type==='radio'||t.type==='checkbox'){try{t.checked=true;t.dispatchEvent(new Event('input',{bubbles:true}));t.dispatchEvent(new Event('change',{bubbles:true}));}catch(x){}}" +
  "['pointerdown','mousedown','mouseup','click'].forEach(function(ev){try{t.dispatchEvent(new MouseEvent(ev,{bubbles:true,cancelable:true,view:window}));}catch(x){}});}" +
  "function doPress(el,k){el.focus();var key=k||'Enter';" +
  "if(key==='Enter'){var o={key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true};" +
  "el.dispatchEvent(new KeyboardEvent('keydown',o));el.dispatchEvent(new KeyboardEvent('keypress',o));" +
  "el.dispatchEvent(new KeyboardEvent('keyup',o));if(el.form){try{if(el.form.requestSubmit)el.form.requestSubmit();else el.form.submit();}catch(x){}}return;}" +
  "el.dispatchEvent(new KeyboardEvent('keydown',{key:key,bubbles:true}));" +
  "el.dispatchEvent(new KeyboardEvent('keyup',{key:key,bubbles:true}));}" +
  "var el=findEl(a);if(!el)return btoa(unescape(encodeURIComponent(JSON.stringify({ok:false,error:'Element not found'}))));" +
  "if(a.type==='click_point'){var t=pickClickTarget(el)||el;try{t.scrollIntoView({block:'center',inline:'center',behavior:'instant'});}catch(e){t.scrollIntoView(true);}var r=t.getBoundingClientRect();" +
  "var chromeOffset=Math.max(0,(window.outerHeight||0)-(window.innerHeight||0));" +
  "var wx=window.screenX!=null?window.screenX:(window.screenLeft||0);" +
  "var wy=window.screenY!=null?window.screenY:(window.screenTop||0);" +
  "var sx=Math.round(wx+r.left+r.width/2);var sy=Math.round(wy+chromeOffset+r.top+r.height/2);" +
  "return btoa(unescape(encodeURIComponent(JSON.stringify({ok:true,screenX:sx,screenY:sy,clientX:Math.round(r.left+r.width/2),clientY:Math.round(r.top+r.height/2),chromeH:chromeOffset}))));}" +
  "if(a.type==='click'){doClick(el);return btoa(unescape(encodeURIComponent(JSON.stringify({ok:true,clicked:true}))));}" +
  "if(a.type==='type'){setVal(el,a.value||'');return btoa(unescape(encodeURIComponent(JSON.stringify({ok:true}))));}" +
  "if(a.type==='press'){doPress(el,a.key||'Enter');return btoa(unescape(encodeURIComponent(JSON.stringify({ok:true}))));}" +
  "if(a.type==='scroll'){window.scrollBy(0,Number(a.delta)||400);return btoa(unescape(encodeURIComponent(JSON.stringify({ok:true}))));}" +
  "return btoa(unescape(encodeURIComponent(JSON.stringify({ok:false,error:'Unknown action'}))));" +
  "}catch(e){return btoa(unescape(encodeURIComponent(JSON.stringify({ok:false,error:String(e.message||e)}))));}})('";

const VERIFY_CLICK_JS_PREFIX =
  "(function(b){try{var a=JSON.parse(decodeURIComponent(escape(atob(b))));" +
  "function vis(el){if(!el)return false;var r=el.getBoundingClientRect();return r.width>1&&r.height>1;}" +
  "function labOf(n){return (n.getAttribute('aria-label')||n.innerText||n.textContent||'').replace(/ +/g,' ').trim().toLowerCase();}" +
  "function pickClickTarget(el){if(!el)return null;" +
  "if(el.tagName==='LABEL'){var fid=el.getAttribute('for');if(fid){var inp=document.getElementById(fid);if(inp)return inp;}}" +
  "if(el.querySelector){var inner=el.querySelector('input[type=radio],input[type=checkbox],[role=radio]');if(inner)return inner;}" +
  "return el;}" +
  "function findEl(a){var el=document.querySelector(a.selector);if(el&&vis(el))el=pickClickTarget(el);" +
  "if(el&&vis(el))return el;var want=(a.label||'').toLowerCase().trim();if(!want)return null;" +
  "var nodes=document.querySelectorAll('input,button,a,[role=button],[role=radio],[role=option],label,[tabindex]');" +
  "for(var i=0;i<nodes.length;i++){var n=nodes[i],lab=labOf(n);if(!lab)continue;" +
  "if(lab.indexOf(want)<0&&want.indexOf(lab)<0)continue;if(!vis(n))continue;n=pickClickTarget(n);if(n&&vis(n))return n;}return null;}" +
  "var el=findEl(a);if(!el)return btoa(unescape(encodeURIComponent(JSON.stringify({ok:true,activated:false,missing:true}))));" +
  "var activated=!!el.checked||el.getAttribute('aria-checked')==='true'||el.getAttribute('aria-selected')==='true'||" +
  "el.getAttribute('aria-pressed')==='true'||el.matches&&el.matches(':focus');" +
  "if(!activated){var n=el.parentElement;for(var d=0;d<5&&n;d++){if(n.getAttribute('aria-checked')==='true'||n.getAttribute('aria-selected')==='true'){activated=true;break;}n=n.parentElement;}}" +
  "var role=el.getAttribute('role')||'';" +
  "return btoa(unescape(encodeURIComponent(JSON.stringify({ok:true,activated:activated,role:role,tag:el.tagName.toLowerCase()}))));" +
  "}catch(e){return btoa(unescape(encodeURIComponent(JSON.stringify({ok:false,error:String(e.message||e)}))));}})('";

async function runBrowserJavascript(runOsascript, appName, js) {
  if (/["\\]/.test(js)) {
    return {
      error:
        "browser JS embed error (quotes/backslashes) — restart the app after updating LYKN",
    };
  }
  const script = buildRunJavascriptScript(appName, js);
  return runOsascript(script, 12000);
}

async function activateBrowser(runOsascript, appName) {
  await runOsascript(`tell application "${appName}" to activate`, 4000);
  await new Promise((r) => setTimeout(r, 300));
}

async function focusBrowserTab(runOsascript, appName, pageUrl) {
  if (!pageUrl || /^Safari/.test(appName)) {
    await activateBrowser(runOsascript, appName);
    return;
  }
  let needle = "";
  try {
    const u = new URL(pageUrl);
    needle = (u.host + u.pathname).slice(0, 160);
  } catch {
    needle = String(pageUrl).slice(0, 48);
  }
  needle = needle.replace(/["\\]/g, "");
  if (!needle) {
    await activateBrowser(runOsascript, appName);
    return;
  }
  const script = `tell application "${appName}"
    activate
    repeat with w in windows
      set ti to 1
      repeat with t in tabs of w
        try
          if (URL of t as text) contains "${needle}" then
            set active tab index of w to ti
            set index of w to 1
            return
          end if
        end try
        set ti to ti + 1
      end repeat
    end repeat
  end tell`;
  await runOsascript(script, 8000);
  await new Promise((r) => setTimeout(r, 500));
}

function refreshActionSelectors(actions, items) {
  if (!Array.isArray(items) || !items.length) return actions;
  const norm = (s) => String(s || "").trim().toLowerCase();
  return actions.map((action) => {
    if (action.type === "scroll") return action;
    const want = norm(action.label);
    if (!want) return action;
    let best = items.find((it) => norm(it.label) === want);
    if (!best) {
      best = items.find((it) => {
        const lab = norm(it.label);
        return lab && (lab.includes(want) || want.includes(lab));
      });
    }
    if (best && best.selector) return { ...action, selector: best.selector };
    return action;
  });
}

// A stable signature for an action so we can detect when the planner re-fires the
// exact same step (the hallucinated "press it again even though it's done" loop).
// Coordinates are bucketed so near-identical vision clicks count as the same.
function actionSignature(action) {
  if (!action) return "";
  const t = String(action.type || "");
  const sel = String(action.selector || "").trim().toLowerCase();
  const lab = String(action.label || "").trim().toLowerCase();
  const val = String(action.value || "").trim().toLowerCase();
  const key = String(action.key || "").trim().toLowerCase();
  const coord =
    action.type === "click_coord"
      ? `${Math.round(Number(action.x) / 40)},${Math.round(Number(action.y) / 40)}`
      : "";
  return [t, sel || lab, val, key, coord].join("|");
}

// The DOM scan is comprehensive (rows, list items, etc.), so a coordinate guess
// is almost always worse than the real element. When the planner returns a
// click_coord but an element with a matching label exists, click that element's
// exact selector instead — this is the fix for dense pages (e.g. Gmail) where
// the model eyeballs the wrong pixel and lands on a toolbar button.
function preferSelectorOverCoord(steps, items) {
  if (!Array.isArray(items) || !items.length) return steps;
  const norm = (s) => String(s || "").trim().toLowerCase();
  return steps.map((action) => {
    if (action.type !== "click_coord") return action;
    const want = norm(action.label);
    if (/^#\d+(\s|$)/.test(want)) return action;
    if (want.length < 2) return action;
    let best = items.find((it) => norm(it.label) === want);
    if (!best) {
      best = items.find((it) => {
        const lab = norm(it.label);
        return lab.length >= 3 && (lab.includes(want) || want.includes(lab));
      });
    }
    if (best && best.selector) {
      return { type: "click", selector: best.selector, label: best.label || action.label };
    }
    return action;
  });
}

function isSearchLikeTypeAction(action) {
  if (!action || action.type !== "type") return false;
  const label = String(action.label || "").toLowerCase();
  const sel = String(action.selector || "").toLowerCase();
  return (
    /search|query|lookup|find/.test(label) ||
    /\[name=['"]?q['"]?\]|type=search|role=searchbox|searchbox|combobox/.test(sel)
  );
}

function isSearchSubmitClick(action) {
  if (!action || action.type !== "click") return false;
  const label = String(action.label || "").toLowerCase();
  return /search|submit|go|find|lookup/.test(label);
}

function takeActionBatch(actions) {
  const list = Array.isArray(actions) ? actions : [];
  if (!list.length) return [];
  const first = list[0];
  if (first?.type === "type" && list[1]?.type === "press") {
    return list.slice(0, 2);
  }
  return [first];
}

function normalizeSearchSteps(steps) {
  const out = [];
  for (let i = 0; i < steps.length; i += 1) {
    const action = steps[i];
    if (!isSearchLikeTypeAction(action)) {
      out.push(action);
      continue;
    }
    out.push(action);
    const next = steps[i + 1];
    if (next?.type === "press") {
      out.push(next);
      i += 1;
      continue;
    }
    if (next?.type === "click" && isSearchSubmitClick(next)) {
      i += 1;
    }
    out.push({
      type: "press",
      key: "Enter",
      selector: action.selector,
      label: `${action.label || "Search"} — submit`,
    });
  }
  return out;
}

async function collectBrowserPageContext(runOsascript, appName) {
  const r = await runBrowserJavascript(runOsascript, appName, EXTRACT_PAGE_CONTEXT_JS);
  if (r.error) return null;
  const data = decodeBrowserPayload(r.out);
  if (!data || typeof data.text !== "string") return null;
  return { text: data.text };
}

// Cheap "is the page still moving?" probe — a single tiny eval (URL + text length
// + element count). Used to poll for settle without a full scrape + screenshot.
const QUICK_SIG_JS =
  "(function(){try{var b=document.body;var t=b?(b.innerText||'').length:0;" +
  "var n=document.querySelectorAll('button,a,input,textarea,select,[role]').length;" +
  "return btoa(unescape(encodeURIComponent((location.href||'')+'|'+t+'|'+n)));}catch(e){return '';}})()";

async function readQuickSignature(runOsascript, appName) {
  const r = await runBrowserJavascript(runOsascript, appName, QUICK_SIG_JS);
  if (r.error || !r.out) return "";
  try {
    return Buffer.from(String(r.out).trim(), "base64").toString("utf8");
  } catch {
    return String(r.out || "").trim();
  }
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

async function physicalClickAtNut(screenX, screenY) {
  if (!nutMouse) return { ok: false, error: "nut_unavailable" };
  try {
    await nutMouse.mouse.setPosition(new nutMouse.Point(Math.round(screenX), Math.round(screenY)));
    await nutMouse.mouse.click(nutMouse.Button.LEFT);
    return { ok: true, x: screenX, y: screenY, via: "nut" };
  } catch (e) {
    return { ok: false, error: String(e?.message || e || "mouse click failed") };
  }
}

async function physicalClickAt(runOsascript, appName, point) {
  const proc = String(appName || "").replace(/"/g, "");
  const clientX = point && point.clientX;
  const clientY = point && point.clientY;
  const hasClient = typeof clientX === "number" && typeof clientY === "number";
  const chromeH = point && typeof point.chromeH === "number" ? point.chromeH : 88;
  let screenX;
  let screenY;

  // Most reliable target: anchor on the OS window's top-left (from AppleScript
  // window bounds, which are real screen points) + the element's position INSIDE
  // the viewport (clientX/clientY) + the browser chrome height. We deliberately
  // do NOT trust the page's window.screenX/screenY here: on macOS Chrome those
  // values are inconsistent across versions about whether they include the tab
  // strip / toolbar, which throws clicks off vertically by ~the chrome height.
  if (proc && hasClient) {
    const b = await runOsascript(`tell application "${proc}" to get bounds of front window`, 4000);
    if (!b.error && b.out) {
      const parts = String(b.out)
        .replace(/[{}]/g, "")
        .split(",")
        .map((s) => parseInt(String(s).trim(), 10));
      if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
        screenX = parts[0] + clientX;
        screenY = parts[1] + chromeH + clientY;
      }
    }
  }

  // Fallbacks if window bounds were unavailable: the page's absolute screen
  // coords, then viewport coords offset by the chrome height.
  if (typeof screenX !== "number" || typeof screenY !== "number") {
    if (typeof point?.screenX === "number" && typeof point?.screenY === "number") {
      screenX = point.screenX;
      screenY = point.screenY;
    } else if (hasClient) {
      screenX = clientX;
      screenY = clientY + chromeH;
    } else {
      return { ok: false, error: "bad_click_point" };
    }
  }

  // Click from the Electron process (Accessibility → Electron/LYKN, not osascript).
  const nutClick = await physicalClickAtNut(screenX, screenY);
  if (nutClick.ok) {
    await runOsascript(`tell application "${proc}" to activate`, 4000);
    return nutClick;
  }

  const script =
    `tell application "${proc}" to activate\n` +
    `delay 0.6\n` +
    `tell application "System Events"\n` +
    `  click at {${Math.round(screenX)}, ${Math.round(screenY)}}\n` +
    `end tell`;
  const r = await runOsascript(script, 10000);
  if (r.error) {
    const hint = /1743|not authorized|assistive|accessibility|-25211|-1719/i.test(r.error)
      ? " Enable Accessibility for LYKN (or Electron in dev) in System Settings → Privacy & Security → Accessibility, then quit and reopen the app."
      : "";
    return { ok: false, error: (r.error || "physical click failed") + hint };
  }
  return { ok: true, x: screenX, y: screenY, via: "osascript" };
}

async function readPageSignature(runOsascript, appName) {
  const ctx = await collectBrowserPageContext(runOsascript, appName);
  return pageSignature(ctx?.text || "");
}

async function verifyClickRegistered(runOsascript, appName, action) {
  const payload = Buffer.from(
    JSON.stringify({
      selector: action.selector || "",
      label: action.label || "",
    }),
    "utf8",
  ).toString("base64");
  const js = VERIFY_CLICK_JS_PREFIX + payload + "')";
  const r = await runBrowserJavascript(runOsascript, appName, js);
  if (r.error) return { activated: false, error: r.error };
  const data = decodeBrowserPayload(r.out);
  if (!data) return { activated: false };
  return { activated: !!data.activated, missing: !!data.missing, role: data.role || "" };
}

let electronScreen = null;
let electronClipboard = null;
try {
  const electron = require("electron");
  electronScreen = electron.screen;
  electronClipboard = electron.clipboard;
} catch {
  /* not in electron context */
}

function resolveVisionCoords(action) {
  const rawX = Number(action?.x ?? action?.screenX);
  const rawY = Number(action?.y ?? action?.screenY);
  if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return null;
  if (!electronScreen) return { screenX: Math.round(rawX), screenY: Math.round(rawY) };
  const display = electronScreen.getPrimaryDisplay();
  const w = display.size.width;
  const h = display.size.height;
  if (rawX >= 0 && rawX <= 1000 && rawY >= 0 && rawY <= 1000) {
    return { screenX: Math.round((rawX / 1000) * w), screenY: Math.round((rawY / 1000) * h) };
  }
  return { screenX: Math.round(rawX), screenY: Math.round(rawY) };
}

async function executeBrowserAction(runOsascript, appName, action, { pageUrl, physicalClick, pageSigBefore, skipClickVerify } = {}) {
  if (pageUrl) {
    await focusBrowserTab(runOsascript, appName, pageUrl);
  } else {
    await activateBrowser(runOsascript, appName);
  }

  if (action.type === "click_coord") {
    const pt = resolveVisionCoords(action);
    if (!pt) {
      return { ok: false, error: "Invalid vision coordinates", label: action.label || "vision click" };
    }
    const clickResult = await physicalClickAt(runOsascript, appName, pt);
    if (!clickResult?.ok) {
      return {
        ok: false,
        error: clickResult?.error || "Vision click failed",
        label: action.label || "vision click",
      };
    }
    await new Promise((res) => setTimeout(res, 500));
    return {
      ok: true,
      physical: true,
      label: action.label || "vision click",
      type: action.type,
      coords: { x: clickResult.x, y: clickResult.y },
    };
  }

  if (action.type === "os_write") {
    const text = String(action.text || action.value || "");
    if (!text) {
      return { ok: false, error: "empty_text", label: action.label || "type" };
    }
    if (electronClipboard) {
      electronClipboard.writeText(text);
    }
    const pasteScript =
      'tell application "System Events" to keystroke "v" using command down';
    const pasteResult = await runOsascript(pasteScript, 8000);
    if (pasteResult.error) {
      return {
        ok: false,
        error: pasteResult.error || "paste failed",
        label: action.label || "type",
      };
    }
    if (action.pressEnter) {
      await runOsascript('tell application "System Events" to key code 36', 4000);
    }
    await new Promise((res) => setTimeout(res, action.pressEnter ? 700 : 450));
    return {
      ok: true,
      label: action.label || text.slice(0, 60),
      type: action.type,
    };
  }

  const pointAction =
    physicalClick && action.type === "click" ? { ...action, type: "click_point" } : action;
  const payload = Buffer.from(JSON.stringify(pointAction), "utf8").toString("base64");
  const js = RUN_ACTION_JS_PREFIX + payload + "')";
  const r = await runBrowserJavascript(runOsascript, appName, js);
  if (r.error) {
    return { ok: false, error: r.error, label: action.label || action.selector };
  }
  const data = decodeBrowserPayload(r.out);
  if (!data) return { ok: false, error: "bad_result", label: action.label || action.selector };

  if (physicalClick && action.type === "click") {
    if (!data.ok || (typeof data.screenX !== "number" && typeof data.clientX !== "number")) {
      return {
        ok: false,
        error: data.error || "Could not locate click target on screen",
        label: action.label || action.selector,
      };
    }
    const clickResult = await physicalClickAt(runOsascript, appName, {
      screenX: data.screenX,
      screenY: data.screenY,
      clientX: data.clientX,
      clientY: data.clientY,
      chromeH: data.chromeH,
    });
    if (!clickResult || !clickResult.ok) {
      return {
        ok: false,
        error: (clickResult && clickResult.error) || "Physical click failed",
        label: action.label || action.selector,
      };
    }
    await new Promise((res) => setTimeout(res, 400));
    if (!skipClickVerify) {
      const sigAfter = await readPageSignature(runOsascript, appName);
      const pageChanged = !!(pageSigBefore && sigAfter && sigAfter !== pageSigBefore);
      const verify = await verifyClickRegistered(runOsascript, appName, action);
      if (!pageChanged && !verify.activated) {
        return {
          ok: false,
          error:
            "Click did not register on the page. Enable Accessibility + Automation (System Events) for LYKN, click the Chrome tab, then Run again.",
          label: action.label || action.selector,
          coords: { x: clickResult.x, y: clickResult.y },
        };
      }
    }
    return {
      ok: true,
      physical: true,
      label: action.label || action.selector,
      type: action.type,
      coords: { x: clickResult.x, y: clickResult.y },
    };
  }

  return { ...data, label: action.label || action.selector, type: action.type };
}

async function executeBrowserActions(runOsascript, appName, actions, { pageUrl } = {}) {
  await focusBrowserTab(runOsascript, appName, pageUrl);

  const collected = await collectBrowserInteractables(runOsascript, appName);
  if (collected.error === "apple_events_disabled") {
    return [
      {
        ok: false,
        error: "Allow JavaScript from Apple Events in Chrome (View → Developer)",
        label: "page scan",
      },
    ];
  }
  if (collected.error) {
    return [
      {
        ok: false,
        error: collected.message || collected.error || "Could not scan page",
        label: "page scan",
      },
    ];
  }

  let steps = normalizeSearchSteps(actions);
  if (collected.ok && collected.page?.items?.length) {
    steps = refreshActionSelectors(steps, collected.page.items);
  }

  const results = [];
  for (const action of steps) {
    const result = await executeBrowserAction(runOsascript, appName, action, {
      pageUrl,
      physicalClick: action.type === "click",
    });
    results.push(result);
    if (!result.ok) break;
    await new Promise((r) => setTimeout(r, action.type === "type" ? 900 : 650));
  }
  return results;
}

function buildSessionSummary(completed, taskPlan) {
  const steps = Array.isArray(completed) ? completed : [];
  const parts = [];
  if (taskPlan) parts.push(`Plan: ${String(taskPlan).slice(0, 300)}`);
  const recent = steps.slice(-8).map((s, i) => {
    const status = s.ok ? "ok" : "failed";
    const changed =
      s.screenChanged === true ? " (screen changed)" : s.screenChanged === false ? " (no change)" : "";
    return `${i + 1}. ${s.type || "step"} “${String(s.label || "").slice(0, 60)}” ${status}${changed}`;
  });
  if (recent.length) parts.push(`Done so far:\n${recent.join("\n")}`);
  return parts.join("\n\n").slice(0, 1200);
}


function userWantsVisionClick(intent) {
  return /click (on |the )?(image|picture|photo|thumbnail|icon|graphic)|find (the |a )?(image|picture|photo|one that|one with|one showing)|select (the |a )?(image|picture|photo)|looks like|that shows|showing a|with (a |the )?(cat|dog|bird|face|person|logo|map|chart|diagram)|visual/i.test(
    String(intent || "").toLowerCase(),
  );
}

function userWantsComplexTask(intent) {
  return (
    userWantsVisionClick(intent) ||
    /multiple|several|all of them|each one|one by one|keep going|step by step|go through|find .+ and click|click on (all|each|every)/i.test(
      String(intent || "").toLowerCase(),
    )
  );
}

function userWantsSearchOrType(intent) {
  return /search( for| up)?|look up|look for|google|find (info|information|out about)|type into|type in|enter .+ (into|in)|fill in|query for/i.test(
    String(intent || "").toLowerCase(),
  );
}

function planFailureMessage(plan) {
  const explanation = String(plan?.explanation || "").trim();
  const pf = plan?.planFailed;
  if (typeof pf === "string" && pf.trim()) return pf.trim();
  if (explanation) return explanation;
  if (pf) return "Planning failed. Could not determine the next step.";
  return String(plan?.message || plan?.error || "Re-plan failed");
}

async function readFullPageSnapshot(runOsascript, appName, captureScreen) {
  // Run the three independent reads concurrently — the page-text eval, the
  // interactables eval, and the screenshot don't depend on each other, so doing
  // them in parallel roughly thirds the wall-clock cost of a full read.
  const [pageCtxRaw, collected, screenShot] = await Promise.all([
    collectBrowserPageContext(runOsascript, appName).catch(() => null),
    collectBrowserInteractables(runOsascript, appName).catch(() => ({})),
    captureScreen ? captureScreen().catch(() => "") : Promise.resolve(""),
  ]);
  const pageCtx = pageCtxRaw || { text: "" };
  const pageText = pageCtx.text || "";
  const items = collected.page?.items || [];
  return {
    pageText,
    items,
    url: collected.page?.url || "",
    title: collected.page?.title || "",
    pageSig: pageSignature(pageText),
    questionSig: questionSignature(pageText),
    screenHash: screenFingerprint(screenShot),
    imageUrl: screenShot,
    itemCount: items.length,
    flags: snapshotFlags(items, pageText),
    error: collected.error,
    message: collected.message,
  };
}

// Poll a CHEAP signature (one tiny eval, no screenshot/scrape) until the page
// stops moving, then do ONE full read. This replaces the old loop that ran a
// full scrape + screenshot on every poll — the single biggest per-step cost.
async function waitForPageUpdate(runOsascript, appName, captureScreen, before, { timeoutMs = 6500, intervalMs = 280, minWaitMs = 800 } = {}) {
  const start = Date.now();
  const initialSig = await readQuickSignature(runOsascript, appName);
  let prev = initialSig;
  let stable = 1;
  let sawChange = false;
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const sig = await readQuickSignature(runOsascript, appName);
    if (sig && sig !== initialSig) sawChange = true;
    if (sig && sig === prev) {
      stable += 1;
      // Settled = two identical cheap reads, once we've either seen a change or
      // waited out the minimum window (so a slow-to-render change isn't missed).
      if (stable >= 2 && (sawChange || Date.now() - start >= minWaitMs)) break;
    } else {
      stable = 1;
    }
    prev = sig;
  }
  const after = await readFullPageSnapshot(runOsascript, appName, captureScreen);
  const diff = comparePageSnapshots(before, after);
  return {
    changed: !!(diff.textChanged || diff.screenChanged || diff.itemsChanged),
    after,
    diff,
    waitedMs: Date.now() - start,
  };
}

async function observeAfterAction(runOsascript, appName, captureScreen, before) {
  await new Promise((r) => setTimeout(r, 250));
  const update = await waitForPageUpdate(runOsascript, appName, captureScreen, before, {
    timeoutMs: 6000,
  });
  return {
    ...update.after,
    diff: update.diff,
    diffNote: formatPageDiff(update.diff),
    changed: update.changed,
    waitedMs: update.waitedMs,
  };
}

function maxRoundsForIntent(intent) {
  if (userWantsComplexTask(intent)) return 30;
  return 25;
}

// Perceptual screen fingerprint: decode the screenshot, downscale to a small
// grayscale grid, and quantize each cell. Two fingerprints can then be compared
// by how many cells moved (screenDiffRatio), which is robust to JPEG noise,
// cursor blink, and clock ticks — unlike hashing the raw bytes (which flipped on
// every capture and made "screen changed" meaningless).
let nativeImageMod = null;
try {
  nativeImageMod = require("electron").nativeImage;
} catch {
  /* not in electron context */
}

function screenFingerprint(imageUrl) {
  if (!imageUrl || typeof imageUrl !== "string") return "";
  if (nativeImageMod) {
    try {
      const img = nativeImageMod.createFromDataURL(imageUrl);
      if (!img.isEmpty()) {
        const small = img.resize({ width: 32, height: 32, quality: "good" });
        const buf = small.toBitmap(); // BGRA bytes
        const cells = [];
        for (let i = 0; i + 3 < buf.length; i += 4) {
          const lum = (buf[i + 2] * 299 + buf[i + 1] * 587 + buf[i] * 114) / 1000;
          cells.push(Math.round(lum / 16)); // quantize 0..15
        }
        if (cells.length >= 16) return cells.join(",");
      }
    } catch {
      /* fall through to byte hash */
    }
  }
  const raw = imageUrl.replace(/^data:image\/\w+;base64,/, "");
  if (!raw) return "";
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 20);
}

// Read screen → plan → act → wait for pixels to change → re-read until done.
function holoToolNameForAction(action) {
  if (!action || typeof action !== "object") return null;
  if (action.type === "click_coord") return "click";
  if (action.type === "os_write") return "write";
  return null;
}

async function executeAdaptiveBrowserTask(
  runOsascript,
  planNext,
  appName,
  intent,
  pageUrl,
  { maxRounds, onProgress, captureScreen, initialTaskPlan, conversationHistory } = {},
) {
  await focusBrowserTab(runOsascript, appName, pageUrl);
  const results = [];
  const completed = [];
  const roundLimit = typeof maxRounds === "number" ? maxRounds : maxRoundsForIntent(intent);
  let stalePageRounds = 0;
  let lastPageSig = "";
  let taskPlan = String(initialTaskPlan || "").slice(0, 2000);
  let lastReasoning = "";
  const convHistory = Array.isArray(conversationHistory) ? conversationHistory.slice(-8) : [];
  let pageText = "";
  // Verify-as-you-go state: what the last action changed, and how many actions in
  // a row produced no visible effect (used to detect a stuck loop).
  let lastActionDiff = "";
  let noEffectStreak = 0;
  // Repeat-suppression: the signature of the last action we executed and how the
  // screen reacted. Lets us catch the planner re-firing a step that already took
  // effect (the "keep pressing even though it's done" hallucination).
  let lastExecutedSig = "";
  let lastTransition = "";
  let repeatNoEffect = 0;
  // The post-action observe step already does a full read of the settled page.
  // Carry it into the next round instead of re-reading an unchanged page — saves
  // a full scrape + screenshot every round.
  let carrySnapshot = null;

  let lastHoloToolName = null;
  let lastHoloToolResult = null;

  for (let round = 0; round < roundLimit; round += 1) {
    const carried = carrySnapshot;
    carrySnapshot = null;
    if (!carried) onProgress?.(`Reading screen… (step ${round + 1})`);

    const beforeSnapshot = carried || (await readFullPageSnapshot(runOsascript, appName, captureScreen));
    if (beforeSnapshot.error === "apple_events_disabled") {
      results.push({
        ok: false,
        error: "Allow JavaScript from Apple Events in Chrome (View → Developer)",
        label: "page scan",
      });
      return { results, done: false, completed };
    }
    if (beforeSnapshot.error || (!captureScreen && !beforeSnapshot.items.length)) {
      results.push({
        ok: false,
        error: beforeSnapshot.message || beforeSnapshot.error || "Could not scan page",
        label: "page scan",
      });
      return { results, done: false, completed };
    }

    pageText = beforeSnapshot.pageText;
    const screenShot = beforeSnapshot.imageUrl;
    const collected = {
      page: {
        url: beforeSnapshot.url,
        title: beforeSnapshot.title,
        items: beforeSnapshot.items,
      },
    };

    const pageSigBefore = beforeSnapshot.pageSig;
    const complexTask = userWantsComplexTask(intent);
    const staleLimit = complexTask ? 7 : 4;
    // If the screen hasn't changed for several rounds, the task is either finished
    // or stuck — stop so we don't spin. A no-effect click is handled separately
    // (noEffectStreak); this catches the planner re-reading an unchanged page.
    if (pageSigBefore && pageSigBefore === lastPageSig) {
      stalePageRounds += 1;
      if (stalePageRounds >= staleLimit) {
        return {
          results,
          done: true,
          completed,
          explanation: "Done — the page stopped changing.",
        };
      }
    } else {
      stalePageRounds = 0;
      lastPageSig = pageSigBefore;
    }

    onProgress?.(userWantsSearchOrType(intent) ? "Finding where to search…" : "Reading screen…");

    const plan = await planNext({
      intent,
      url: collected.page.url,
      title: collected.page.title,
      items: collected.page.items,
      pageText,
      imageUrl: screenShot,
      completedSteps: completed,
      taskPlan,
      lastReasoning,
      lastActionDiff,
      sessionSummary: buildSessionSummary(completed, taskPlan, pageText),
      conversationHistory: convHistory,
      toolName: lastHoloToolName,
      toolOutput: lastHoloToolResult,
    });
    lastHoloToolName = null;
    lastHoloToolResult = null;

    if (!plan || plan.error) {
      results.push({
        ok: false,
        error: planFailureMessage(plan),
        label: `step ${round + 1}`,
      });
      return { results, done: false, completed };
    }

    if (plan.taskPlan) taskPlan = String(plan.taskPlan).slice(0, 2000);
    if (plan.reasoning) lastReasoning = String(plan.reasoning).slice(0, 800);

    if (plan.done) {
      return { results, done: true, completed, explanation: plan.explanation || "" };
    }

    const status = plan.reasoning || plan.explanation;
    if (status) {
      onProgress?.(String(status).slice(0, 140));
    }

    if (!Array.isArray(plan.actions) || !plan.actions.length) {
      results.push({
        ok: false,
        error: planFailureMessage(plan),
        label: round === 0 ? "step 1" : `step ${round + 1}`,
      });
      return { results, done: !!plan.done, completed, explanation: plan.explanation || "" };
    }

    let steps = normalizeSearchSteps(takeActionBatch(plan.actions));
    try {
      const { resolveOrdinalDomClick } = await import("../lib/holo/ordinalIntent.js");
      const domStep = resolveOrdinalDomClick(intent, collected.page.items);
      if (domStep) steps = [domStep];
    } catch (_) {
      /* optional ESM import */
    }
    steps = preferSelectorOverCoord(steps, collected.page.items);
    if (!steps.length) continue;

    // Stop the hallucinated repeat: if the planner asks for the exact same action
    // it just performed, decide based on what that action already did.
    const plannedSig = actionSignature(steps[0]);
    if (plannedSig && plannedSig === lastExecutedSig) {
      const meaningfulLast =
        lastTransition === "navigated" ||
        lastTransition === "updated" ||
        lastTransition === "modal";
      if (meaningfulLast) {
        // It already worked (screen changed) — re-firing it is a hallucination.
        return {
          results,
          done: true,
          completed,
          explanation:
            plan.explanation || "Done — that action already took effect; not repeating it.",
        };
      }
      // Same action that changed nothing — force a different approach, then bail.
      repeatNoEffect += 1;
      lastActionDiff =
        `You already tried “${String(steps[0].label || "").slice(0, 60)}” and the screen did NOT change. ` +
        "Do NOT repeat it — choose a DIFFERENT element/approach, or set done:true if the goal is already met.";
      if (repeatNoEffect >= 2) {
        return {
          results,
          done: false,
          completed,
          message:
            "Stopped — kept retrying the same action with no effect. Rephrase the task or try a different page.",
        };
      }
      continue;
    }
    repeatNoEffect = 0;
    lastExecutedSig = plannedSig;
    lastTransition = "";

    for (let si = 0; si < steps.length; si += 1) {
      const action = steps[si];
      const isLastInBatch = si === steps.length - 1;
      const label = action.label || action.type || "step";
      onProgress?.(`${action.type === "os_write" || action.type === "type" ? "Typing" : action.type === "press" ? "Pressing" : action.type === "click_coord" ? "Clicking (vision)" : "Clicking"}: ${label.slice(0, 60)}`);
      const isClickLike = action.type === "click" || action.type === "click_coord";
      const result = await executeBrowserAction(runOsascript, appName, action, {
        pageUrl: collected.page.url,
        physicalClick: isClickLike,
        pageSigBefore: isClickLike ? pageSigBefore : undefined,
        skipClickVerify: isClickLike && !!captureScreen,
      });
      results.push(result);
      const stepRecord = {
        label,
        type: action.type,
        ok: !!result.ok,
      };
      completed.push(stepRecord);
      if (!result.ok) return { results, done: false, completed };

      const holoTool = holoToolNameForAction(action);
      if (holoTool) {
        lastHoloToolName = holoTool;
        lastHoloToolResult = result.ok ? "ok" : String(result.error || "failed");
      }

      // Verify after every page-affecting action: re-read the settled screen, diff
      // it against the pre-action snapshot, and feed the result back to the planner
      // next round. This is what lets LYKN adapt when the UI changes after a click
      // instead of trusting a stale screenshot.
      const affectsPage =
        isClickLike || action.type === "press" || action.type === "type" || action.type === "os_write";
      const shouldObserve = stepRecord.ok && isLastInBatch && affectsPage;

      if (shouldObserve) {
        onProgress?.("Verifying screen…");
        const observed = await observeAfterAction(runOsascript, appName, captureScreen, beforeSnapshot, {});
        pageText = observed.pageText;
        lastPageSig = observed.pageSig;
        // Reuse this freshly-read, settled snapshot as the next round's read.
        carrySnapshot = observed;
        stepRecord.pageDiff = observed.diffNote;
        stepRecord.screenChanged = observed.changed;
        stepRecord.transition = observed.diff?.transition || (observed.changed ? "updated" : "none");
        lastTransition = stepRecord.transition;
        const labelShort = String(label).slice(0, 60);
        if (holoTool) {
          lastHoloToolResult =
            stepRecord.transition === "navigated"
              ? `navigated — ${observed.diffNote || "new screen"}`
              : stepRecord.transition === "none"
                ? "no visible change"
                : observed.diffNote || "screen updated";
        }
        if (stepRecord.transition === "navigated") {
          lastActionDiff =
            `The screen CHANGED to a NEW screen after “${labelShort}”. ` +
            `Do not assume your earlier plan still applies — read what is on screen NOW and decide the next step from scratch. (${observed.diffNote})`;
        } else if (stepRecord.transition === "modal") {
          lastActionDiff =
            `A popup/overlay appeared after “${labelShort}”. Deal with it first (dismiss or read it) before continuing. (${observed.diffNote})`;
        } else if (stepRecord.transition === "none") {
          lastActionDiff =
            `“${labelShort}” produced NO visible change — the screen is exactly the same. That element did nothing; choose a different element or approach.`;
        } else {
          lastActionDiff = `After “${labelShort}”: ${observed.diffNote || "page updated"}.`;
        }

        onProgress?.(observed.diffNote || "Screen re-read complete");

        // Track no-effect clicks. A single no-op is fine (some toggles are subtle),
        // but several in a row means the click isn't registering or the planner is
        // stuck — surface a hint and, if it persists, stop with an actionable error.
        if (isClickLike && !observed.changed) {
          const verify = await verifyClickRegistered(runOsascript, appName, action);
          if (!verify.activated) {
            noEffectStreak += 1;
            stepRecord.noEffect = true;
            lastReasoning =
              `The last action (“${String(label).slice(0, 60)}”) did not change the page. ` +
              "Pick a different element or approach to make progress toward the goal.";
            if (noEffectStreak >= 3) {
              results[results.length - 1] = {
                ok: false,
                error:
                  "Several clicks in a row changed nothing — enable Accessibility + Automation (System Events) for LYKN, focus the page, then Run again.",
                label: action.label || action.selector,
                coords: result.coords,
              };
              stepRecord.ok = false;
              return { results, done: false, completed };
            }
          } else {
            noEffectStreak = 0;
          }
        } else {
          noEffectStreak = 0;
        }
      } else if (isClickLike || action.type === "press") {
        await new Promise((r) => setTimeout(r, 450));
      }

      // One logical action per round: break so the next round re-reads a fresh
      // snapshot before planning again (never act twice on a stale page).
      if (stepRecord.ok && isLastInBatch) {
        break;
      }

      await new Promise((r) => setTimeout(r, action.type === "type" ? 500 : 250));
    }
  }

  return {
    results,
    done: false,
    completed,
    message: "Reached the step limit — click Run again to continue, or narrow the task.",
  };
}

function sanitizePlanActions(raw, knownSelectors) {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set(["click", "type", "press", "scroll", "click_coord", "os_write"]);
  const known =
    knownSelectors instanceof Set
      ? knownSelectors
      : new Set(Array.isArray(knownSelectors) ? knownSelectors : []);
  const out = [];
  for (const a of raw.slice(0, 8)) {
    if (!a || typeof a !== "object") continue;
    const type = String(a.type || "").trim().toLowerCase();
    if (!allowed.has(type)) continue;
    if (type === "click_coord") {
      const x = Number(a.x ?? a.screenX);
      const y = Number(a.y ?? a.screenY);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      out.push({
        type,
        x,
        y,
        screenX: x,
        screenY: y,
        label: String(a.label || "vision click").trim().slice(0, 120),
      });
      continue;
    }
    if (type === "os_write") {
      out.push({
        type,
        text: String(a.text || a.value || "").slice(0, 500),
        pressEnter: !!a.pressEnter,
        label: String(a.label || a.text || "type").trim().slice(0, 120),
      });
      continue;
    }
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

/**
 * Turn planner output into one executable step. The planner refers to elements
 * by their short id ("el7") — we look the real selector up here. This is far more
 * reliable than asking the model to copy long CSS selectors (it truncates and
 * invents them). Falls back to id-less coordinate clicks and label matching.
 */
function resolvePlanActions(raw, items) {
  const list = Array.isArray(items) ? items : [];
  const byId = new Map(list.map((it) => [String(it.id || "").trim(), it]).filter(([k]) => k));
  const norm = (s) => String(s || "").trim().toLowerCase();

  const buildStep = (a, item) => {
    const type = String(a.type || "").trim().toLowerCase();
    const step = {
      type,
      selector: String(item?.selector || a.selector || "").trim(),
      label: String(a.label || item?.label || "").trim().slice(0, 120) || (item?.selector || "").slice(0, 80),
    };
    if (type === "type") step.value = String(a.value ?? "").slice(0, 500);
    if (type === "press") step.key = String(a.key || "Enter").slice(0, 20);
    if (type === "scroll") step.delta = Number(a.delta) || 400;
    return step;
  };

  for (const a of Array.isArray(raw) ? raw : []) {
    if (!a || typeof a !== "object") continue;
    const type = String(a.type || "").trim().toLowerCase();

    if (type === "click_coord") {
      const x = Number(a.x ?? a.screenX);
      const y = Number(a.y ?? a.screenY);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      return [{ type, x, y, screenX: x, screenY: y, label: String(a.label || "vision click").trim().slice(0, 120) }];
    }

    if (type === "os_write") {
      const text = String(a.text || a.value || "").slice(0, 500);
      if (!text) continue;
      return [{
        type,
        text,
        pressEnter: !!a.pressEnter,
        label: String(a.label || text).trim().slice(0, 120),
      }];
    }

    if (!["click", "type", "press", "scroll"].includes(type)) continue;
    if (type === "scroll") return [buildStep(a, null)];

    // 1. By id (the reliable path).
    const id = String(a.id || a.elementId || "").trim();
    if (id && byId.has(id)) return [buildStep(a, byId.get(id))];

    // 2. By label match against the scanned elements.
    const want = norm(a.label);
    if (want) {
      let best = list.find((it) => norm(it.label) === want);
      if (!best) {
        best = list.find((it) => {
          const lab = norm(it.label);
          return lab && (lab.includes(want) || want.includes(lab));
        });
      }
      if (best?.selector) return [buildStep(a, best)];
    }

    // 3. A selector the model supplied that we actually know about.
    const sel = String(a.selector || "").trim();
    if (sel && list.some((it) => String(it.selector || "").trim() === sel)) {
      return [buildStep(a, null)];
    }
  }
  return [];
}

module.exports = {
  collectBrowserInteractables,
  collectBrowserPageContext,
  executeBrowserActions,
  executeAdaptiveBrowserTask,
  sanitizePlanActions,
  resolvePlanActions,
  userWantsSearchOrType,
  userWantsComplexTask,
  userWantsVisionClick,
  buildSessionSummary,
  screenFingerprint,
};
