/**
 * Actuator for LYKN-owned agent browser sessions (Electron webContents).
 * Parallel-safe: no global lock; each agent owns its own webContents.
 */

const fsSync = require("node:fs");
const pathMod = require("node:path");
const browserOverlays = require("./browserOverlays.cjs");
// One detector for both agent paths. A 404 is the same page whichever loop is
// driving, and duplicating the copy-matching is how one of them ends up stale.
const deadEndPage = require("./browser-agent/runtime/deadEnd.cjs");

// Collection order matters: open dialogs/popovers first (their controls are
// what the user is interacting with — e.g. Gmail's compose window sits at the
// END of the DOM and used to fall past the item cap behind 200+ inbox rows),
// then the rest of the page with repetitive rows capped so long lists can't
// crowd real controls out of the catalog.
/**
 * Document-lifetime element identity, injected ahead of every catalog scan.
 *
 * Refs used to be the element's index in the scan, so anything that inserted a
 * node — a cookie banner, a lazy-loaded row, a re-render — renumbered every
 * element after it. The model would read "[e12] button Checkout", the page
 * would shift by one, and e12 would resolve to something else entirely with
 * nothing in the system able to notice.
 *
 * The WeakMap hangs off `window`, so it survives across executeJavaScript
 * calls for as long as the document lives and is collected with it. Numbers
 * are handed out monotonically and never reused, so a stale ref is always
 * unknown rather than quietly wrong. Guarded with `||` so re-injection on a
 * later scan reuses the existing store instead of resetting it.
 */
const REF_STORE_JS =
  "var __lyknRefStore=window.__lyknRefStore||(window.__lyknRefStore={m:new WeakMap(),n:0});" +
  "function __lyknUid(el){try{var v=__lyknRefStore.m.get(el);" +
  "if(!v){v=++__lyknRefStore.n;__lyknRefStore.m.set(el,v);}return v;}catch(e){return 0;}}";

const COLLECT_INTERACTABLES_JS =
  "(function(){" + REF_STORE_JS +
  "function p(el){if(!el||el.nodeType!==1)return'';if(el.id)return '#'+CSS.escape(el.id);" +
  "var a=[],n=el;while(n&&n.nodeType===1&&a.length<6){var t=n.nodeName.toLowerCase();" +
  "if(n.id){a.unshift('#'+CSS.escape(n.id));break;}var s=n,x=1;" +
  "while(s=s.previousElementSibling){if(s.nodeName===n.nodeName)x++;}" +
  "a.unshift(t+(x>1?':nth-of-type('+x+')':''));n=n.parentElement;}return a.join(' > ');}" +
  "var items=[],seen=new Set(),q='input,textarea,select,button,a[href],img[alt],img[title],picture,canvas,[contenteditable=true],[role=button],[role=link],[role=searchbox],[role=combobox],[role=radio],[role=option],[role=tab],[role=img],[role=row],[role=listitem],[role=gridcell],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=treeitem],[role=checkbox],[role=switch],[role=textbox],tr,li,figure,label,input[type=radio],input[type=checkbox],[tabindex],[onclick]';" +
  "var vw=window.innerWidth||1200,vh=window.innerHeight||800;" +
  // Dialogs come in three kinds and the catalog must not confuse them.
  // Closed-but-mounted modals and visually hidden widgets (opacity 0,
  // aria-hidden, inert, offscreen) still match [role=dialog] — cataloging
  // their controls invents a "dialog is open" the user cannot see, and the
  // agent burns rounds fighting the phantom. Small non-modal dialogs (chat
  // bubbles, feedback tabs) are real but do NOT block the page, so their
  // elements are listed as ordinary controls; only a genuinely modal surface
  // (aria-modal, alertdialog, or covering a big share of the viewport) earns
  // the [dialog] marker that tells the model everything else is behind it.
  "var hiddenDlgs=[];" +
  "function add(el,dlg){if(items.length>=170||seen.has(el))return false;" +
  "for(var hd=0;hd<hiddenDlgs.length;hd++){if(hiddenDlgs[hd].contains(el))return false;}" +
  "var r=el.getBoundingClientRect();" +
  "if(r.width<2||r.height<2)return false;var st=getComputedStyle(el);" +
  "if(st.visibility==='hidden'||st.display==='none'||st.pointerEvents==='none')return false;" +
  "var ti=el.getAttribute('tabindex');if(ti!==null&&parseInt(ti,10)<0)return false;" +
  // Anything nested INSIDE a rich-text editor is document content, not UI —
  // and a nested editable region duplicates its parent editor in the catalog
  // (Gmail's body produced two "Message Body" refs; typing went in twice).
  "if(el.parentElement&&el.parentElement.closest&&el.parentElement.closest('[contenteditable=true]'))return false;" +
  "var tag=el.tagName.toLowerCase()," +
  "type=el.getAttribute('type')||'',role=el.getAttribute('role')||''," +
  "lab=(el.getAttribute('aria-label')||el.getAttribute('alt')||el.getAttribute('title')||el.innerText||el.placeholder||el.getAttribute('data-placeholder')||el.getAttribute('aria-placeholder')||el.name||el.id||'').trim().slice(0,120);" +
  "if(!lab&&tag==='img')lab='image';" +
  // An empty rich editor has no text, no placeholder and no label — it lands in
  // the list as an anonymous div, so the agent hunts for the writing surface by
  // pixel instead of clicking it. Name it.
  "if(!lab&&(el.isContentEditable===true||el.getAttribute('contenteditable')==='true'))lab='writing area';" +
  "if(!lab&&tag!=='input'&&tag!=='textarea'&&role!=='searchbox'&&role!=='textbox'&&tag!=='img'&&tag!=='canvas'&&el.getAttribute('contenteditable')!=='true')return false;" +
  "var inView=r.bottom>0&&r.top<vh&&r.right>0&&r.left<vw;" +
  // Rich-text editors (contenteditable) have no .value — surface their text so
// the agent can SEE what it already wrote instead of retyping it every round.
"var val=el.value!=null?el.value:(el.isContentEditable?(el.innerText||''):'');" +
// A disabled control reads as a normal button; clicking it changes nothing and
// the agent scores that as its own failure. Say it up front instead.
"var dis=el.disabled===true||el.getAttribute('aria-disabled')==='true'||el.getAttribute('disabled')!==null;" +
// Panels, palettes and lists that scroll internally — window.scrollBy does
// nothing for these, so the agent has to scroll the container itself.
"var sc=false;try{sc=(el.scrollHeight-el.clientHeight>24||el.scrollWidth-el.clientWidth>24)&&/auto|scroll/.test(st.overflowY+' '+st.overflowX);}catch(e){}" +
// The state a widget carries in ARIA rather than in a DOM property. Without
// these, a menu opening, a tab being chosen, a toggle flipping and a custom
// checkbox ticking are all completely invisible: same label, same text, so
// the action that caused one reads back as "nothing happened".
// null means the attribute is absent — distinct from present-and-false.
"function tri(a){var v=el.getAttribute(a);return v===null?null:v==='true';}" +
"var ariaChecked=el.getAttribute('aria-checked');" +
"var cur=el.getAttribute('aria-current');" +
"seen.add(el);items.push({uid:__lyknUid(el),id:'el'+items.length,tag:tag,type:type,role:role,selector:p(el),label:lab,value:(''+val).slice(0,80),checked:el.checked===true||ariaChecked==='true',editable:(el.isContentEditable===true||el.getAttribute('contenteditable')==='true'||tag==='input'||tag==='textarea'),expanded:tri('aria-expanded'),selected:tri('aria-selected'),pressed:tri('aria-pressed'),current:cur&&cur!=='false'?(''+cur).slice(0,20):'',disabled:dis,scrollable:sc,href:(el.href||'').slice(0,200),clientX:Math.round(r.left+r.width/2),clientY:Math.round(r.top+r.height/2),inView:inView,inDialog:!!dlg});return true;}" +
  "var dlgs=document.querySelectorAll('[role=dialog],[role=alertdialog],[aria-modal=true]');" +
  "var liveDlgs=[];" +
  "for(var d0=0;d0<dlgs.length;d0++){var dg=dlgs[d0];var dr=dg.getBoundingClientRect();" +
  "var ds=null;try{ds=getComputedStyle(dg);}catch(e){}" +
  "var dgHidden=!ds||ds.visibility==='hidden'||ds.display==='none'||parseFloat(ds.opacity||'1')<0.05||" +
  "dg.getAttribute('aria-hidden')==='true'||dg.hasAttribute('inert')||" +
  "dr.width<40||dr.height<40||dr.bottom<=0||dr.top>=vh||dr.right<=0||dr.left>=vw;" +
  "if(dgHidden){hiddenDlgs.push(dg);continue;}" +
  "var dgModal=dg.getAttribute('aria-modal')==='true'||dg.getAttribute('role')==='alertdialog'||" +
  "(dr.width*dr.height)>=(vw*vh*0.25);" +
  "liveDlgs.push({dg:dg,modal:dgModal});}" +
  "for(var d=0;d<liveDlgs.length;d++){var dels=liveDlgs[d].dg.querySelectorAll(q);" +
  "for(var j=0;j<dels.length&&j<400;j++){add(dels[j],liveDlgs[d].modal);}}" +
  "var rows=0,all=document.querySelectorAll(q);" +
  "for(var i=0;i<all.length&&i<=2000;i++){var el=all[i];" +
  "var t2=el.tagName.toLowerCase(),r2=el.getAttribute('role')||'';" +
  "var rowish=t2==='tr'||t2==='li'||r2==='row'||r2==='listitem'||r2==='option'||r2==='gridcell';" +
  "if(rowish&&rows>=60)continue;" +
  "if(add(el,false)&&rowish)rows++;}" +
  // The viewport the catalog was measured against. Element geometry, inView
  // flags and screenshot coordinates are all relative to this box; if the view
  // is resized after the scan (the agent rail opening beside the browser does
  // exactly that), everything positional in this catalog is stale — and this
  // is the number that lets the controller notice.
  "return {url:location.href,title:document.title,viewport:{w:vw,h:vh},items:items};})()";

// Reads the WHOLE document (not just the viewport) so dashboards, tables and
// below-the-fold data all land in the scrape. Rendered-but-offscreen content
// counts; only display:none / visibility:hidden are skipped.
const EXTRACT_PAGE_CONTEXT_JS =
  "(function(){var sp=/ +/g,nl='\\n';" +
  "function shown(el){if(!el)return false;var st=getComputedStyle(el);return st.visibility!=='hidden'&&st.display!=='none';}" +
  "function txt(el){return ((el.getAttribute('aria-label')||el.innerText||el.textContent||'')+'').replace(sp,' ').trim();}" +
  "var seen=new Set(),parts=[],root=document.querySelector('main')||document.querySelector('[role=main]')||document.body;" +
  "var nodes=root.querySelectorAll('h1,h2,h3,h4,p,li,th,td,dt,dd,label,button,[role=radio],[role=button],[role=heading],[role=option],[role=gridcell],[role=cell],[role=columnheader],[role=rowheader],span,div');" +
  "for(var i=0;i<nodes.length&&parts.length<400;i++){var n=nodes[i];if(!shown(n))continue;var t=txt(n);if(!t||t.length<2||seen.has(t))continue;" +
  "if(t.length>400&&n.children.length>2)continue;seen.add(t);parts.push(t);}" +
  "var text=((document.title||'')+nl+parts.join(nl)).replace(sp,' ').trim();" +
  "if(text.length<600){var raw=((document.body&&document.body.innerText)||'').replace(sp,' ').trim();" +
  "if(raw.length>text.length)text=((document.title||'')+nl+raw).trim();}" +
  "return {url:location.href,title:document.title,text:text.slice(0,16000)};})()";

// Lightweight text grab for sub-frames — dashboards like Stripe render their
// real content inside iframes that main-frame JS can't see.
const EXTRACT_FRAME_TEXT_JS =
  "(function(){try{var t=((document.body&&document.body.innerText)||'').replace(/ +/g,' ').trim();" +
  "return t.slice(0,8000);}catch(e){return '';}})()";

// A frame can't know where it sits in the top-level viewport (cross-origin
// blocks walking up to window.parent), but its PARENT can measure the <iframe>
// element. Run this in each parent to get the rects, then match them to child
// frames by URL so element coordinates can be offset into page space — that is
// what makes real input-event clicks land inside embedded editors.
const COLLECT_FRAME_RECTS_JS =
  "(function(){var out=[];try{var els=document.querySelectorAll('iframe,frame');" +
  "for(var i=0;i<els.length&&i<40;i++){var el=els[i];var r=el.getBoundingClientRect();" +
  "if(r.width<8||r.height<8)continue;" +
  "var st=getComputedStyle(el);if(st.visibility==='hidden'||st.display==='none')continue;" +
  "out.push({src:(el.src||'')+'',name:(el.getAttribute('name')||'')+''," +
  "x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)});}" +
  "}catch(e){}return out;})()";

function buildActionJs(action) {
  const payload = Buffer.from(JSON.stringify(action || {}), "utf8").toString("base64");
  return (
    "(function(){try{var a=JSON.parse(decodeURIComponent(escape(atob('" +
    payload +
    "'))));" +
    "function vis(el){if(!el)return false;var r=el.getBoundingClientRect();if(r.width<2||r.height<2)return false;" +
    "var st=getComputedStyle(el);return st.visibility!=='hidden'&&st.display!=='none'&&st.pointerEvents!=='none';}" +
    "function findEl(a){var el=null;try{el=document.querySelector(a.selector);}catch(e){}if(el&&vis(el))return el;" +
    "var want=(a.label||'').toLowerCase().trim();if(!want)return null;" +
    "var nodes=document.querySelectorAll('input,textarea,select,button,a,img,tr,li,[role=button],[role=link],[role=radio],[role=option],[role=row],[role=listitem],[role=tab],[role=menuitem],label,[tabindex],div.zA,tr.zA');" +
    "for(var i=0;i<nodes.length;i++){var n=nodes[i],lab=((n.getAttribute('aria-label')||n.innerText||n.placeholder||'')+'').toLowerCase().replace(/\\s+/g,' ').trim();" +
    "if(lab&&(lab.indexOf(want)>-1||want.indexOf(lab.slice(0,40))>-1)&&vis(n))return n;}return null;}" +
    // The native value setter belongs to HTMLInputElement / HTMLTextAreaElement
    // and REFUSES any other receiver — calling it on a contenteditable div or a
    // custom widget throws "Illegal invocation", which is not a failure the
    // agent can read or route around. (It cost a real run: correcting a
    // mistyped recipient in Google Drive's share box died here, and the agent
    // spent the rest of its budget clicking at the field it could no longer
    // address.) Match the setter to the element, handle contenteditable in its
    // own terms, and report anything else as a plain, actionable error.
    "function setVal(el,v){" +
    "try{el.scrollIntoView({block:'center',inline:'nearest'});}catch(e){}" +
    "try{el.click();}catch(e1){} try{el.focus();}catch(e2){}" +
    "var isInput=(typeof HTMLInputElement!=='undefined')&&(el instanceof HTMLInputElement);" +
    "var isArea=(typeof HTMLTextAreaElement!=='undefined')&&(el instanceof HTMLTextAreaElement);" +
    "if(isInput||isArea){" +
    "var p=isArea?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;" +
    "var d=Object.getOwnPropertyDescriptor(p,'value');" +
    "try{if(d&&d.set)d.set.call(el,v);else el.value=v;}catch(e3){el.value=v;}}" +
    "else if(el.isContentEditable||el.getAttribute('contenteditable')==='true'){" +
    "el.textContent=v;}" +
    "else if('value' in el){el.value=v;}" +
    "else{return false;}" +
    "el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));" +
    "return true;}" +
    "var el=findEl(a);if(!el)return {ok:false,error:'Element not found'};" +
    "if(a.type==='type'||a.type==='fill'){" +
    "var before=((el.value!=null?el.value:el.innerText)||'')+'';" +
    "if(!setVal(el,a.text||a.value||''))" +
    "return {ok:false,error:'field_not_writable',hint:'This control does not take a value directly — click it and type instead.'};" +
    "var after=((el.value!=null?el.value:el.innerText)||'')+'';" +
    "var fr=el.getBoundingClientRect();" +
    "return {ok:true,type:a.type,changed:after!==before,valueLen:after.length," +
    "clientX:Math.round(fr.left+fr.width/2),clientY:Math.round(fr.top+fr.height/2)};}" +
    "if(a.type==='focus'){el.scrollIntoView({block:'center',inline:'center'});try{el.click();}catch(e){} el.focus();" +
    "var fr=el.getBoundingClientRect();return {ok:true,type:'focus',clientX:Math.round(fr.left+fr.width/2),clientY:Math.round(fr.top+fr.height/2)};}" +
    "if(a.type==='select'){var v=((a.value||a.text||'')+'').trim();" +
    "var sel=el.tagName==='SELECT'?el:(el.querySelector&&el.querySelector('select'));" +
    "if(!sel)return {ok:false,error:'not_a_select'};var hit=-1,vl=v.toLowerCase();" +
    "for(var j=0;j<sel.options.length;j++){var o=sel.options[j],ot=((o.textContent||'')+'').trim().toLowerCase();" +
    "if(o.value===v||ot===vl||(vl&&ot.indexOf(vl)>-1)){hit=j;break;}}" +
    "if(hit<0)return {ok:false,error:'option_not_found'};" +
    "sel.selectedIndex=hit;sel.dispatchEvent(new Event('input',{bubbles:true}));sel.dispatchEvent(new Event('change',{bubbles:true}));" +
    "return {ok:true,type:'select',value:sel.value};}" +
    "if(a.type==='check'||a.type==='uncheck'||a.type==='toggle'){" +
    "var box=(el.tagName==='INPUT'&&(el.type==='checkbox'||el.type==='radio'))?el:(el.querySelector&&el.querySelector('input[type=checkbox],input[type=radio]'))||el;" +
    "var want=a.type==='check'?true:a.type==='uncheck'?false:!box.checked;" +
    "if(typeof box.checked==='boolean'){if(box.checked!==want)box.click();}else{box.click();}" +
    "return {ok:true,type:a.type,checked:typeof box.checked==='boolean'?box.checked:null};}" +
    "if(a.type==='press'){el.focus();el.dispatchEvent(new KeyboardEvent('keydown',{key:a.key||'Enter',bubbles:true}));" +
    "el.dispatchEvent(new KeyboardEvent('keyup',{key:a.key||'Enter',bubbles:true}));return {ok:true,type:'press'};}" +
    "if(a.type==='scroll'){window.scrollBy(0,a.dy||400);return {ok:true,type:'scroll'};}" +
    "el.scrollIntoView({block:'center',inline:'center'});" +
    "var r=el.getBoundingClientRect();var cx=Math.round(r.left+r.width/2),cy=Math.round(r.top+r.height/2);" +
    "el.focus();try{el.click();}catch(e){}" +
    "['pointerdown','mousedown','mouseup','click'].forEach(function(ev){try{el.dispatchEvent(new MouseEvent(ev,{bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy}));}catch(x){}});" +
    "return {ok:true,type:a.type||'click',clientX:cx,clientY:cy};}catch(e){return {ok:false,error:String(e&&e.message||e)};}})()"
  );
}

/** Planner key names → Electron accelerator key codes for sendInputEvent. */
function normalizeKeyCode(key) {
  const k = String(key || "Enter").trim();
  const map = {
    enter: "Enter",
    return: "Enter",
    escape: "Escape",
    esc: "Escape",
    tab: "Tab",
    space: "Space",
    " ": "Space",
    backspace: "Backspace",
    delete: "Delete",
    arrowdown: "Down",
    arrowup: "Up",
    arrowleft: "Left",
    arrowright: "Right",
    down: "Down",
    up: "Up",
    left: "Left",
    right: "Right",
    pagedown: "PageDown",
    pageup: "PageUp",
    home: "Home",
    end: "End",
  };
  return map[k.toLowerCase()] || k;
}

/**
 * Real keyboard events into the owned tab — synthetic KeyboardEvents are
 * ignored by many SPAs (Google apps especially) and never trigger native
 * behavior like form submit. This presses the key the way a user would.
 */
async function sendRealKey(webContents, key, modifiers = []) {
  if (!webContents || webContents.isDestroyed?.()) return { ok: false, error: "no_webcontents" };
  const keyCode = normalizeKeyCode(key);
  const mods = Array.isArray(modifiers) ? modifiers : [];
  try {
    try {
      webContents.focus();
    } catch {
      /* ignore */
    }
    webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers: mods });
    if (keyCode === "Enter") {
      webContents.sendInputEvent({ type: "char", keyCode: "\u000d", modifiers: mods });
    } else if (keyCode.length === 1) {
      webContents.sendInputEvent({ type: "char", keyCode, modifiers: mods });
    }
    webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers: mods });
    return { ok: true, type: "press", key: keyCode, via: "input_event" };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

const MODIFIER_ALIASES = {
  cmd: "meta",
  command: "meta",
  meta: "meta",
  win: "meta",
  ctrl: "control",
  control: "control",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
  get mod() {
    return process.platform === "darwin" ? "meta" : "control";
  },
};

/** Electron modifier names from whatever the model called them. */
function normalizeModifiers(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const key = String(raw || "").trim().toLowerCase();
    if (!key) continue;
    const mapped = MODIFIER_ALIASES[key] || key;
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

/**
 * Editor keyboard shortcut like "cmd+a", "ctrl+shift+v", "cmd+b". "mod" maps
 * to cmd on macOS / ctrl elsewhere so the planner doesn't have to care.
 */
async function sendShortcut(webContents, combo) {
  const parts = String(combo || "")
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) return { ok: false, error: "empty_shortcut" };
  const key = parts[parts.length - 1];
  const modifiers = normalizeModifiers(parts.slice(0, -1));
  return sendRealKey(webContents, key.length === 1 ? key.toUpperCase() : key, modifiers);
}

/** Last capture metrics per webContents — used to map 0–1000 click_coord accurately. */
const lastScreenshotMeta = new WeakMap();

async function getViewportMetrics(webContents) {
  try {
    return await webContents.executeJavaScript(
      `({
        w: window.innerWidth || 1200,
        h: window.innerHeight || 800,
        cw: document.documentElement.clientWidth || window.innerWidth || 1200,
        ch: document.documentElement.clientHeight || window.innerHeight || 800,
        dpr: window.devicePixelRatio || 1,
        ox: (window.visualViewport && window.visualViewport.offsetLeft) || 0,
        oy: (window.visualViewport && window.visualViewport.offsetTop) || 0
      })`,
      true,
    );
  } catch {
    return { w: 1200, h: 800, cw: 1200, ch: 800, dpr: 1, ox: 0, oy: 0 };
  }
}

/**
 * Map Holo/reader 0–1000 coords → CSS client pixels.
 * Prefer the capture's CSS size when it matches the live viewport; otherwise
 * blend / fall back so we don't drift left (too-narrow width) or right
 * (too-wide capture + nudge).
 */
/**
 * A capture whose CSS size differs from the live viewport by more than this is
 * a different layout, not a rounding artifact: the page has reflowed and no
 * scaling of the old picture lands on the new positions. The agent rail
 * opening beside the docked browser shifts the width by ~20% in one step.
 */
const STALE_CAPTURE_DRIFT = 0.12;

function mapNormCoordToClient(nx, ny, metrics, shotMeta) {
  const m = metrics || {};
  const viewportW = Number(m.w) || Number(m.cw) || 1200;
  const viewportH = Number(m.h) || Number(m.ch) || 800;
  const captureW = Number(shotMeta?.captureCssW) || Number(shotMeta?.cssW) || 0;
  const captureH = Number(shotMeta?.captureCssH) || Number(shotMeta?.cssH) || 0;
  let w = viewportW;
  let h = viewportH;
  let stale = false;
  if (captureW > 0) {
    const drift = Math.abs(captureW - viewportW) / Math.max(viewportW, 1);
    // Near match → trust capture (what the model saw). Moderate mismatch →
    // blend so a wider capture doesn't push every click toward the right edge.
    // Large mismatch → the viewport was resized after the shot; the page has
    // reflowed, and a blended half-scale is a systematic miss dressed up as a
    // click. Report stale so the caller refuses and re-captures instead.
    if (drift > STALE_CAPTURE_DRIFT) stale = true;
    w = drift <= 0.03 ? captureW : Math.round((captureW + viewportW) / 2);
  }
  if (captureH > 0) {
    const driftH = Math.abs(captureH - viewportH) / Math.max(viewportH, 1);
    if (driftH > STALE_CAPTURE_DRIFT) stale = true;
    h = driftH <= 0.03 ? captureH : Math.round((captureH + viewportH) / 2);
  }
  const ox = Number(m.ox) || 0;
  const oy = Number(m.oy) || 0;
  // No X nudge — a prior +0.8%w correction overshot and clicked too far right.
  const x = Math.round((Math.min(Math.max(Number(nx) || 0, 0), 1000) / 1000) * w + ox);
  const y = Math.round((Math.min(Math.max(Number(ny) || 0, 0), 1000) / 1000) * h + oy);
  const maxX = Math.max(2, Math.round(viewportW || w) - 1);
  const maxY = Math.max(2, Math.round(viewportH || h) - 1);
  return {
    x: Math.max(1, Math.min(x, maxX)),
    y: Math.max(1, Math.min(y, maxY)),
    w,
    h,
    stale,
  };
}

/** If a catalog element sits near the raw point, snap to its live center. */
function snapClientPointToCatalog(x, y, catalogItems, radiusPx = 42, labelHint = "") {
  const items = Array.isArray(catalogItems) ? catalogItems : [];
  const hint = String(labelHint || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const hintWords = hint
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !/^(button|link|the|and|for|with)$/i.test(w));
  let best = null;
  let bestScore = Infinity;
  for (const it of items) {
    if (typeof it?.clientX !== "number" || typeof it?.clientY !== "number") continue;
    if (it.inView === false) continue;
    // An element inside a frame we could not place carries FRAME-relative
    // coordinates dressed up as window ones. Snapping to those takes a point
    // that was read correctly off the screenshot and moves it somewhere the
    // control is not — which is how every click in Drive's share dialog
    // landed on nothing while the agent watched the page refuse to respond.
    if (it.frameOffsetKnown === false) continue;
    const lab = String(it.label || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    // When the agent named a target, only snap to a compatible label — never
    // steal the click onto a random nearby control.
    if (hint && hint.length >= 2) {
      const compatible =
        lab === hint ||
        lab.includes(hint) ||
        (lab.length >= 4 && hint.includes(lab.slice(0, 24))) ||
        (hintWords.length > 0 && hintWords.every((w) => lab.includes(w)));
      if (!compatible) continue;
    }
    const dx = Number(it.clientX) - x;
    const dy = Number(it.clientY) - y;
    const d = Math.hypot(dx, dy);
    if (d > radiusPx) continue;
    if (d < bestScore) {
      bestScore = d;
      best = it;
    }
  }
  if (!best) return { x, y, snapped: false };
  return {
    x: Math.round(best.clientX),
    y: Math.round(best.clientY),
    snapped: true,
    label: best.label,
    id: best.id,
  };
}

/**
 * CSS page point → view/input point.
 *
 * The docked agent tabs render at a fit-to-pane ZOOM FACTOR (main.cjs
 * applyAgentTabZoom, floor 0.5, and it stamps what it applied on the
 * webContents). Every point this module computes comes from the page in CSS
 * space — getBoundingClientRect, elementFromPoint, catalog clientX/Y — but
 * Electron's sendInputEvent takes VIEW coordinates. With zoom z a CSS point
 * renders at (x·z, y·z); sending it unscaled overshoots by an error
 * proportional to distance from the top-left corner. That is why clicks on
 * far-right and bottom controls (Gmail's Send, a header's Create button)
 * silently landed on nothing while mid-page clicks worked.
 */
function toInputPoint(webContents, cssX, cssY) {
  let z = Number(webContents?.__lyknZoomFactor);
  if (!Number.isFinite(z) || z <= 0) {
    try {
      z = Number(webContents?.getZoomFactor?.());
    } catch {
      z = 1;
    }
  }
  if (!Number.isFinite(z) || z <= 0.2 || z > 5) z = 1;
  return { x: Math.round(Number(cssX) * z), y: Math.round(Number(cssY) * z) };
}

/** Real mouse events into the owned tab — SPAs (Gmail/YouTube) often ignore el.click(). */
async function clickAtClientPoint(webContents, clientX, clientY) {
  if (!webContents || webContents.isDestroyed?.()) return { ok: false, error: "no_webcontents" };
  const { x, y } = toInputPoint(webContents, clientX, clientY);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    return { ok: false, error: "bad_point" };
  }
  try {
    try {
      webContents.focus();
    } catch {
      /* ignore */
    }
    webContents.sendInputEvent({ type: "mouseMove", x, y });
    webContents.sendInputEvent({
      type: "mouseDown",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    webContents.sendInputEvent({
      type: "mouseUp",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    return { ok: true, type: "click", via: "input_event", x, y };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Drag with real input events: press, move in small steps, release.
 *
 * Whole product categories are built around dragging — email builders drop
 * content blocks into a layout, design tools drag elements onto a page, boards
 * move cards between columns. Without this the agent cannot express the one
 * action the task is made of, so it substitutes clicks that do nothing.
 *
 * Stepped movement matters: a single jump from source to target never triggers
 * the dragover/pointermove handlers these UIs rely on to pick the drop slot.
 */
async function dragByInput(webContents, from, to, { steps = 20, settleMs = 90 } = {}) {
  if (!webContents || webContents.isDestroyed?.()) return { ok: false, error: "no_webcontents" };
  // CSS → view space, same as clicks: a drag whose endpoints miss by the zoom
  // ratio drops the payload on whatever happens to sit at the scaled point.
  const start = toInputPoint(webContents, from?.x, from?.y);
  const end = toInputPoint(webContents, to?.x, to?.y);
  const x1 = start.x;
  const y1 = start.y;
  const x2 = end.x;
  const y2 = end.y;
  if (![x1, y1, x2, y2].every((n) => Number.isFinite(n) && n >= 0)) {
    return { ok: false, error: "bad_points" };
  }
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    try {
      webContents.focus();
    } catch {
      /* ignore */
    }
    webContents.sendInputEvent({ type: "mouseMove", x: x1, y: y1 });
    await pause(60);
    webContents.sendInputEvent({
      type: "mouseDown",
      x: x1,
      y: y1,
      button: "left",
      clickCount: 1,
    });
    // A short hold before moving is what distinguishes a drag from a click for
    // most libraries (many use a movement threshold plus a press delay).
    await pause(settleMs);
    const count = Math.max(4, Math.min(Number(steps) || 20, 60));
    for (let i = 1; i <= count; i += 1) {
      const t = i / count;
      // Ease out so the pointer lingers near the drop target, giving the UI
      // time to compute and show the insertion point.
      const eased = 1 - (1 - t) * (1 - t);
      webContents.sendInputEvent({
        type: "mouseMove",
        x: Math.round(x1 + (x2 - x1) * eased),
        y: Math.round(y1 + (y2 - y1) * eased),
        button: "left",
        buttons: 1,
      });
      await pause(16);
    }
    await pause(settleMs);
    webContents.sendInputEvent({ type: "mouseMove", x: x2, y: y2, button: "left", buttons: 1 });
    await pause(60);
    webContents.sendInputEvent({
      type: "mouseUp",
      x: x2,
      y: y2,
      button: "left",
      clickCount: 1,
    });
    await pause(settleMs);
    return { ok: true, type: "drag", via: "input_event", from: { x: x1, y: y1 }, to: { x: x2, y: y2 } };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * HTML5 drag-and-drop via a shared DataTransfer. Chromium's native drag
 * controller does not reliably pick up synthetic mouse drags, so anything
 * using `draggable="true"` needs the event sequence dispatched directly.
 */
function buildHtml5DragJs({ fromSelector = "", toSelector = "" }) {
  const payload = Buffer.from(
    JSON.stringify({ from: fromSelector, to: toSelector }),
    "utf8",
  ).toString("base64");
  return (
    "(function(){try{var a=JSON.parse(decodeURIComponent(escape(atob('" +
    payload +
    "'))));" +
    "var src=document.querySelector(a.from),dst=document.querySelector(a.to);" +
    "if(!src)return {ok:false,error:'drag_source_not_found'};" +
    "if(!dst)return {ok:false,error:'drop_target_not_found'};" +
    "var dt=new DataTransfer();" +
    "function fire(el,name,rel){var r=el.getBoundingClientRect();" +
    "var ev=new DragEvent(name,{bubbles:true,cancelable:true,composed:true,dataTransfer:dt," +
    "clientX:Math.round(r.left+r.width/2),clientY:Math.round(r.top+r.height/2)});" +
    "el.dispatchEvent(ev);return ev;}" +
    "fire(src,'pointerdown');fire(src,'mousedown');" +
    "fire(src,'dragstart');fire(dst,'dragenter');fire(dst,'dragover');" +
    "var drop=fire(dst,'drop');fire(src,'dragend');" +
    "return {ok:true,dropped:drop.defaultPrevented!==false};" +
    "}catch(e){return {ok:false,error:String(e&&e.message||e)};}})()"
  );
}

/** True when a drag source opts into native HTML5 drag-and-drop. */
async function elementUsesHtml5Drag(webContents, selector, frameId) {
  if (!selector) return false;
  const js =
    `(function(){try{var el=document.querySelector(${JSON.stringify(selector)});` +
    `if(!el)return false;` +
    `if(el.draggable===true||el.getAttribute('draggable')==='true')return true;` +
    `var p=el.closest&&el.closest('[draggable="true"]');return !!p;}catch(e){return false;}})()`;
  try {
    const frame = frameId != null ? frameByRoutingId(webContents, frameId) : null;
    const out = frame
      ? await frame.executeJavaScript(js, true)
      : await webContents.executeJavaScript(js, true);
    return out === true;
  } catch {
    return false;
  }
}

/**
 * One end of a drag, in page coordinates. Accepts a selector/label (re-resolved
 * live), catalog coordinates, or 0–1000 vision coordinates.
 */
async function resolveDragEndpoint(
  webContents,
  { selector = "", label = "", clientX, clientY, nx, ny, frameId } = {},
) {
  if (selector || label) {
    const action = { selector, label };
    const frame = frameId != null ? frameByRoutingId(webContents, frameId) : null;
    if (frame) {
      const offsets = await buildFrameOffsets(webContents).catch(() => null);
      const offset = offsets?.get(frame.routingId) || { x: 0, y: 0, known: false };
      const pt = await resolveFrameElementPoint(frame, action, offset);
      if (pt?.pageCoords) return { x: pt.x, y: pt.y };
    } else {
      const pt = await resolveElementPoint(webContents, action);
      if (pt) return { x: pt.x, y: pt.y };
    }
  }
  if (Number.isFinite(Number(clientX)) && Number.isFinite(Number(clientY))) {
    return { x: Number(clientX), y: Number(clientY) };
  }
  const vx = Number(nx);
  const vy = Number(ny);
  if (Number.isFinite(vx) && Number.isFinite(vy) && vx >= 0 && vx <= 1000 && vy >= 0 && vy <= 1000) {
    try {
      const metrics = await getViewportMetrics(webContents);
      const shotMeta = lastScreenshotMeta.get(webContents) || null;
      const mapped = mapNormCoordToClient(vx, vy, metrics, shotMeta);
      return { x: mapped.x, y: mapped.y };
    } catch {
      return null;
    }
  }
  return null;
}

/** Scroll a specific container — window scrolling does nothing inside a panel. */
function buildScrollElementJs({ selector = "", dy = 400, dx = 0 }) {
  const payload = Buffer.from(JSON.stringify({ selector, dy, dx }), "utf8").toString("base64");
  return (
    "(function(){try{var a=JSON.parse(decodeURIComponent(escape(atob('" +
    payload +
    "'))));" +
    "var el=document.querySelector(a.selector);" +
    "if(!el)return {ok:false,error:'element_not_found'};" +
    // The named element is often a child of the thing that actually scrolls.
    "var box=el;var guard=0;" +
    "while(box&&guard++<8){var st=getComputedStyle(box);" +
    "if((box.scrollHeight-box.clientHeight>8&&/auto|scroll/.test(st.overflowY))||" +
    "(box.scrollWidth-box.clientWidth>8&&/auto|scroll/.test(st.overflowX)))break;" +
    "box=box.parentElement;}" +
    "if(!box)return {ok:false,error:'no_scrollable_container'};" +
    "var before=box.scrollTop;var beforeX=box.scrollLeft;" +
    "box.scrollTop=before+Number(a.dy||0);box.scrollLeft=beforeX+Number(a.dx||0);" +
    "return {ok:true,scrolled:box.scrollTop-before,scrolledX:box.scrollLeft-beforeX," +
    "atEnd:box.scrollTop+box.clientHeight>=box.scrollHeight-2};" +
    "}catch(e){return {ok:false,error:String(e&&e.message||e)};}})()"
  );
}

/** Snapshot of the focused editable — used to verify typing landed. */
async function readActiveEditableState(webContents) {
  if (!webContents || webContents.isDestroyed?.()) {
    return { ok: false, activeOk: false, value: "", valueLen: 0 };
  }
  try {
    return await webContents.executeJavaScript(
      `(function(){
        var el=document.activeElement;
        if(!el) return {ok:true,activeOk:false,value:'',valueLen:0,tag:'',label:''};
        var tag=(el.tagName||'').toLowerCase();
        var role=(el.getAttribute('role')||'').toLowerCase();
        var editable=!!(el.isContentEditable || tag==='input' || tag==='textarea' || role==='textbox' || role==='searchbox' || role==='combobox');
        var val='';
        try{ val=(el.value!=null?el.value:(el.innerText||el.textContent||''))+''; }catch(e){}
        var lab=((el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.getAttribute('name')||'')+'').slice(0,80);
        return {
          ok:true,
          activeOk:editable,
          tag:tag,
          role:role,
          label:lab,
          value:val.slice(0,200),
          valueLen:val.length,
          titleish:/rename|document name|document title/i.test(lab)
        };
      })()`,
      true,
    );
  } catch {
    return { ok: false, activeOk: false, value: "", valueLen: 0 };
  }
}

/**
 * Click into a type target before typing. Retries matter — many SPAs ignore
 * insertText until the field has a real mouse focus.
 */
async function focusTypeTarget(webContents, { hint = "", enriched = null, preferDocsBody = false } = {}) {
  if (!webContents || webContents.isDestroyed?.()) {
    return { ok: false, error: "no_webcontents" };
  }
  const pageUrl = String(webContents.getURL?.() || "");
  const fieldHint = String(hint || enriched?.label || enriched?.target || enriched?.element || "").trim();

  if (preferDocsBody && looksLikeGoogleDocsUrl(pageUrl)) {
    const focused = await focusPageEditor(webContents);
    return { ok: focused?.ok !== false, via: "docs_body", focused };
  }
  if (preferDocsBody && looksLikeCanvasEditorUrl(pageUrl)) {
    await focusPageEditor(webContents).catch(() => {});
    return { ok: true, via: "canvas_editor" };
  }

  // Prefer live element coords → real mouse click (most reliable focus).
  if (enriched && (enriched.selector || enriched.id || fieldHint)) {
    const pt = await resolveElementPoint(webContents, {
      ...enriched,
      label: fieldHint || enriched.label,
    }).catch(() => null);
    if (pt && typeof pt.x === "number") {
      await clickAtClientPoint(webContents, pt.x, pt.y);
      await new Promise((r) => setTimeout(r, 140));
      await clickAtClientPoint(webContents, pt.x, pt.y);
      await new Promise((r) => setTimeout(r, 100));
      return { ok: true, via: "element_point", x: pt.x, y: pt.y };
    }
  }

  if (fieldHint && !/^(type|write|os_write|fill|input|click_type)$/i.test(fieldHint)) {
    const byHint = await clickInPageByHint(webContents, { hint: fieldHint, index: 0 });
    if (byHint?.ok) {
      await new Promise((r) => setTimeout(r, 140));
      return { ok: true, via: "hint", label: byHint.label };
    }
  }

  // Only score editables when the agent named a field — never click the first
  // visible input with an empty hint (that feels random).
  if (!fieldHint || /^(type|write|os_write|fill|input|click_type)$/i.test(fieldHint)) {
    return { ok: false, error: "no_field_target_from_agent" };
  }
  try {
    const hintPayload = Buffer.from(
      JSON.stringify({ hint: fieldHint.slice(0, 120) }),
      "utf8",
    ).toString("base64");
    const hit = await webContents.executeJavaScript(
      `(function(){
        var d=JSON.parse(decodeURIComponent(escape(atob('${hintPayload}'))));
        var hint=String(d.hint||'').toLowerCase();
        if(!hint) return {ok:false,error:'empty_hint'};
        function vis(el){if(!el)return false;var r=el.getBoundingClientRect();
          if(r.width<16||r.height<10)return false;
          var st=getComputedStyle(el);return st.visibility!=='hidden'&&st.display!=='none';}
        function lab(el){
          return ((el.getAttribute('aria-label')||el.getAttribute('placeholder')||
            el.getAttribute('name')||el.getAttribute('data-tooltip')||el.innerText||'')+'').replace(/\\s+/g,' ').trim().toLowerCase();
        }
        var roots=[].slice.call(document.querySelectorAll('[role="dialog"],[aria-modal="true"]'));
        if(!roots.length) roots=[document.body];
        var best=null,bestScore=-1,bestBox=null;
        for(var r=0;r<roots.length;r++){
          var root=roots[r];
          var nodes=root.querySelectorAll(
            'input:not([type=hidden]):not([type=checkbox]):not([type=radio]),textarea,[contenteditable="true"],[role="textbox"],[role="searchbox"],[role="combobox"],div[role="combobox"] input'
          );
          for(var i=0;i<nodes.length;i++){
            var n=nodes[i]; if(!vis(n)) continue;
            var L=lab(n);
            var sc=0;
            if(L===hint) sc=100;
            else if(L.indexOf(hint)!==-1||hint.indexOf(L.slice(0,24))!==-1) sc=80;
            else {
              var words=hint.split(/\\s+/).filter(function(w){return w.length>2;});
              for(var w=0;w<words.length;w++){ if(L.indexOf(words[w])!==-1) sc+=18; }
            }
            if(sc<18) continue;
            if(root!==document.body) sc+=15;
            var box=n.getBoundingClientRect();
            sc+=Math.min(10, Math.floor(box.width/40));
            if(sc>bestScore){ bestScore=sc; best=n; bestBox=box; }
          }
        }
        if(!best||bestScore<18) return {ok:false,error:'no_matching_field',bestScore:bestScore};
        try{best.scrollIntoView({block:'center'});}catch(e){}
        bestBox=best.getBoundingClientRect();
        try{best.click(); best.focus();}catch(e2){}
        return {
          ok:true,
          score:bestScore,
          x:Math.round(bestBox.left+bestBox.width/2),
          y:Math.round(bestBox.top+bestBox.height/2)
        };
      })()`,
      true,
    );
    if (hit?.ok && typeof hit.x === "number") {
      await clickAtClientPoint(webContents, hit.x, hit.y);
      await new Promise((r) => setTimeout(r, 120));
      return { ok: true, via: "scored_editable", x: hit.x, y: hit.y, score: hit.score };
    }
  } catch {
    /* ignore */
  }
  return { ok: false, error: "focus_target_not_found" };
}

/** Select-all + Backspace in the focused field — real keys, SPA-safe. */
/**
 * Put the caret in the field of whatever dialog is open, in whichever frame it
 * lives.
 *
 * The last resort for typing, and the one that does not depend on geometry at
 * all. A dialog raised over a page — a share sheet, an invite box, a rename
 * prompt — has one obvious place to type, and when a click cannot reach it
 * (wrong coordinates, an unmeasurable iframe, something drawn over it) the
 * agent is left able to see the field and unable to use it. That is the loop
 * the share dialog produced over and over: click, nothing, screenshot, click.
 *
 * Focus needs no line of sight and no correct pixel, so this succeeds where
 * the click cannot.
 *
 * @returns {Promise<{ok: boolean, frame?: object, label?: string}>}
 */
function buildFocusDialogFieldJs(hint = "") {
  const payload = Buffer.from(JSON.stringify({ hint: String(hint || "") }), "utf8").toString("base64");
  return `(function(){try{
  var a=JSON.parse(decodeURIComponent(escape(atob('${payload}'))));
  var want=(a.hint||'').toLowerCase().replace(/\\s+/g,' ').trim();
  function vis(el){try{var r=el.getBoundingClientRect();if(r.width<8||r.height<8)return false;
    var s=getComputedStyle(el);return s.visibility!=='hidden'&&s.display!=='none'&&parseFloat(s.opacity||'1')>0.05;}catch(e){return false;}}
  function labOf(el){try{return ((el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.getAttribute('title')||el.name||'')+'').toLowerCase().replace(/\\s+/g,' ').trim();}catch(e){return '';}}
  var sel='input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]),textarea,[contenteditable=true],[role=textbox],[role=combobox],[role=searchbox]';
  var dlgs=[].slice.call(document.querySelectorAll('[role=dialog],[role=alertdialog],[aria-modal=true]')).filter(vis);
  if(!dlgs.length)return {ok:false};
  // The last one in document order is the one on top.
  var dlg=dlgs[dlgs.length-1];
  var fields=[].slice.call(dlg.querySelectorAll(sel)).filter(vis);
  if(!fields.length)return {ok:false};
  // Prefer the field the agent was actually aiming at; fall back to the first,
  // which on a share or invite dialog is the one that matters.
  var f=null;
  if(want){for(var i=0;i<fields.length;i++){var L=labOf(fields[i]);
    if(L&&(L.indexOf(want.slice(0,24))>-1||want.indexOf(L.slice(0,24))>-1)){f=fields[i];break;}}}
  if(!f)f=fields[0];
  try{f.focus();}catch(e){}
  var ok=document.activeElement===f||f.contains(document.activeElement);
  if(!ok)return {ok:false};
  try{if(f.setSelectionRange){var Ln=(f.value||'').length;f.setSelectionRange(Ln,Ln);}}catch(e2){}
  return {ok:true,label:labOf(f).slice(0,80),fields:fields.length};
}catch(e){return {ok:false};}})()`;
}

async function focusOpenDialogField(webContents, { hint = "" } = {}) {
  if (!webContents || webContents.isDestroyed?.()) return { ok: false };
  const js = buildFocusDialogFieldJs(hint);
  const tryFrame = async (frame) => {
    try {
      const res = await frame.executeJavaScript(js, true);
      return res?.ok ? { ...res, frame } : null;
    } catch {
      return null;
    }
  };
  const main = webContents.mainFrame;
  if (main) {
    const hit = await tryFrame(main);
    if (hit) return hit;
    // The dialog is often rendered inside an embed rather than the page.
    const subs = main.framesInSubtree || [];
    for (const frame of subs) {
      if (!frame || frame === main) continue;
      const inFrameHit = await tryFrame(frame);
      if (inFrameHit) return inFrameHit;
    }
  }
  return { ok: false };
}

/**
 * Put text into the focused field using the real clipboard.
 *
 * A different mechanism from `insertText`, not another variation of it.
 * insertText hands characters to the renderer's focused editable; paste goes
 * through the application's own paste handling, which is the path products
 * build deliberately — recipient boxes in particular parse pasted addresses
 * and turn them into chips. On surfaces where insertText silently does nothing
 * (custom widgets that never accept synthetic text), paste still works.
 *
 * The clipboard is the user's, so whatever was on it is put back afterwards.
 */
async function pasteTextIntoFocused(webContents, text) {
  if (!webContents || webContents.isDestroyed?.()) return false;
  const value = String(text ?? "");
  if (!value) return false;
  let clipboard;
  try {
    ({ clipboard } = require("electron"));
  } catch {
    return false;
  }
  let previous = "";
  try {
    previous = clipboard.readText();
  } catch {
    previous = "";
  }
  try {
    clipboard.writeText(value);
    await new Promise((r) => setTimeout(r, 40));
    webContents.focus();
    if (typeof webContents.paste === "function") webContents.paste();
    else await sendShortcut(webContents, `${process.platform === "darwin" ? "meta" : "control"}+v`);
    await new Promise((r) => setTimeout(r, 240));
    return true;
  } catch {
    return false;
  } finally {
    // Never leave the user's clipboard holding our payload.
    try {
      clipboard.writeText(previous);
    } catch {
      /* best effort */
    }
  }
}

async function clearFocusedField(webContents) {
  const mod = process.platform === "darwin" ? "meta" : "control";
  try {
    sendModKey(webContents, "A", mod);
    await new Promise((r) => setTimeout(r, 70));
    await sendRealKey(webContents, "Backspace");
    await new Promise((r) => setTimeout(r, 90));
  } catch (_) {
    /* ignore */
  }
}

/**
 * Click into a field, type, verify the value/page changed; re-click and retry
 * if typing had no effect.
 */
/**
 * Read the CURRENT text of a specific field (by selector, falling back to an
 * aria-label/placeholder match). Strict typing verifies against this — never
 * against the active editable or whole-page text, which pass when the text
 * landed in the WRONG element (e.g. the doc body behind a share dialog).
 */
async function readTargetFieldValue(webContents, { selector = "", label = "" } = {}) {
  if (!webContents || webContents.isDestroyed?.()) return null;
  const payload = Buffer.from(JSON.stringify({ selector, label }), "utf8").toString("base64");
  try {
    return await webContents.executeJavaScript(
      `(function(){try{var a=JSON.parse(decodeURIComponent(escape(atob('${payload}'))));` +
        `function val(el){if(!el)return null;var v=el.value!=null?el.value:(el.isContentEditable?el.innerText:null);return v==null?null:(''+v);}` +
        `function vis(el){if(!el)return false;var r=el.getBoundingClientRect();if(r.width<2||r.height<2)return false;` +
        `var st=getComputedStyle(el);return st.visibility!=='hidden'&&st.display!=='none';}` +
        // Collect ALL candidates and prefer a visible one with content —
        // pages keep hidden twins with the same label (empty), and reading
        // the first match reported "" for text that fully landed.
        `var cands=[];var el=null;try{el=document.querySelector(a.selector);}catch(e){}if(el)cands.push(el);` +
        `var want=(a.label||'').toLowerCase().replace(/\\s+/g,' ').trim();` +
        `if(want){var nodes=document.querySelectorAll('input,textarea,[contenteditable=true],[role=textbox],[role=searchbox],[role=combobox]');` +
        `for(var i=0;i<nodes.length;i++){var n=nodes[i];` +
        `var lab=((n.getAttribute('aria-label')||n.getAttribute('placeholder')||n.getAttribute('title')||n.name||'')+'').toLowerCase().replace(/\\s+/g,' ').trim();` +
        `if(lab&&(lab.indexOf(want.slice(0,40))>-1||want.indexOf(lab)>-1))cands.push(n);}}` +
        `var best=null,bestVal=null;` +
        `for(var j=0;j<cands.length;j++){var c=cands[j],cv=val(c);if(cv==null)continue;` +
        `if(best==null){best=c;bestVal=cv;}` +
        `if(vis(c)&&cv.replace(/\\s+/g,'')!==''){best=c;bestVal=cv;break;}}` +
        `return bestVal==null?null:bestVal.slice(0,8000);}catch(e){return null;}})()`,
      true,
    );
  } catch {
    return null;
  }
}

/**
 * Force DOM focus onto the target field when a synthetic click didn't take,
 * and normalize the caret to the END of the field. The focusing click lands
 * mid-text in a filled editor — inserting there splices new sentences into
 * the middle of existing ones. "type" means append: caret goes to the end.
 */
async function focusTargetFieldDom(webContents, { selector = "", label = "" } = {}) {
  if (!webContents || webContents.isDestroyed?.()) return false;
  const payload = Buffer.from(JSON.stringify({ selector, label }), "utf8").toString("base64");
  try {
    return !!(await webContents.executeJavaScript(
      `(function(){try{var a=JSON.parse(decodeURIComponent(escape(atob('${payload}'))));` +
        `var el=null;try{el=document.querySelector(a.selector);}catch(e){}` +
        `if(!el&&a.label){var want=(a.label||'').toLowerCase().replace(/\\s+/g,' ').trim();` +
        `var nodes=document.querySelectorAll('input,textarea,[contenteditable=true],[role=textbox],[role=searchbox],[role=combobox]');` +
        `for(var i=0;i<nodes.length;i++){var n=nodes[i];` +
        `var lab=((n.getAttribute('aria-label')||n.getAttribute('placeholder')||n.getAttribute('title')||n.name||'')+'').toLowerCase().replace(/\\s+/g,' ').trim();` +
        `if(lab&&(lab.indexOf(want.slice(0,40))>-1||want.indexOf(lab)>-1)){el=n;break;}}}` +
        `if(!el)return false;` +
        `if(!(document.activeElement===el||el.contains(document.activeElement))){try{el.focus();}catch(e){}}` +
        `var ok=document.activeElement===el||el.contains(document.activeElement);` +
        `if(ok){try{` +
        `if(el.isContentEditable){var r=document.createRange();r.selectNodeContents(el);r.collapse(false);` +
        `var s=getSelection();s.removeAllRanges();s.addRange(r);}` +
        `else if(el.setSelectionRange){var L=(el.value||'').length;el.setSelectionRange(L,L);}` +
        `}catch(e2){}}` +
        `return ok;}catch(e){return false;}})()`,
      true,
    ));
  } catch {
    return false;
  }
}

async function typeWithFocusRetry(
  webContents,
  {
    text,
    hint = "",
    pressEnter = false,
    preferDocsBody = false,
    enriched = null,
    verifyNeedle = "",
    maxAttempts = 3,
    useInsertText = true,
    clickPoint = null,
    // Strict mode (modular agent): success ONLY when the text is in the NAMED
    // field (or committed as a chip). Active-editable / page-text hits lie
    // when the text landed somewhere else.
    strictVerify = false,
    verifySelector = "",
    verifyLabel = "",
    // Empty the field before typing, with real keys (select-all then delete).
    // This is how a value gets CORRECTED on surfaces the DOM cannot simply be
    // assigned: contenteditable boxes, recipient fields that commit addresses
    // into chips, and custom widgets. Replacing text was previously only
    // possible on plain inputs, so a mistyped recipient in a share dialog had
    // no route back and the run stalled trying to click the mistake away.
    clearFirst = false,
  } = {},
) {
  const value = String(text ?? "");
  if (!value) return { ok: false, error: "empty_text" };
  // ALL landed-text comparisons collapse whitespace: rich-text editors render
  // "\n\n" back as "\n\n\n" (Gmail's body), so raw substring checks declare
  // typed text missing when it fully landed — the agent then retypes it and
  // duplicates the content.
  const normWs = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  const needle = normWs(String(verifyNeedle || value)).slice(0, 48);
  const pageUrl = String(webContents.getURL?.() || "");
  const canvas = looksLikeCanvasEditorUrl(pageUrl);
  let lastErr = "";

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const before = await readActiveEditableState(webContents);

    // Atomic path: click the provided field point every attempt, then type.
    if (
      clickPoint &&
      Number.isFinite(Number(clickPoint.x)) &&
      Number.isFinite(Number(clickPoint.y))
    ) {
      await clickAtClientPoint(webContents, clickPoint.x, clickPoint.y);
      await new Promise((r) => setTimeout(r, 160));
      // Double-click on stubborn combobox/share fields (focus often needs 2 hits).
      if (attempt > 0 || /people|email|search|combobox|add/i.test(String(hint || ""))) {
        await clickAtClientPoint(webContents, clickPoint.x, clickPoint.y);
        await new Promise((r) => setTimeout(r, 120));
      }
      // Dialog inputs sometimes swallow synthetic clicks without taking focus
      // (insertText then types into whatever WAS focused — e.g. the document
      // body behind the dialog). Force DOM focus onto the named field.
      if (strictVerify && (verifySelector || verifyLabel)) {
        await focusTargetFieldDom(webContents, {
          selector: verifySelector,
          label: verifyLabel,
        }).catch(() => {});
      }
    } else {
      const focused = await focusTypeTarget(webContents, {
        hint,
        enriched,
        preferDocsBody: preferDocsBody || (canvas && attempt === 0),
      });
      // On retries always re-click — first focus often lands on chrome/title.
      if (attempt > 0 || !focused?.ok) {
        await focusTypeTarget(webContents, {
          hint,
          enriched,
          preferDocsBody: preferDocsBody || canvas,
        });
        await new Promise((r) => setTimeout(r, 160));
      }
    }

    // Correcting a value: empty the field with real keys now that focus is in
    // it. Select-all + delete is the one clear that works everywhere — plain
    // inputs, contenteditable, and the chip fields where a committed entry has
    // no text left to overwrite.
    if (clearFirst) {
      await clearFocusedField(webContents);
    }

    // Typing an email into a share dialog: a prior attempt may have committed
    // it as a chip (which empties the field and hides the raw email from page
    // text) — never create a second chip.
    //
    // A deliberate correction is the exception: the chip that is already there
    // is the mistake being fixed, so a matching chip must not report success.
    const emailValue = !clearFirst && /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.test(value.trim())
      ? value.trim()
      : "";
    if (emailValue && !preferDocsBody && !canvas) {
      if (await shareDialogHasRecipientChip(webContents, emailValue)) {
        return {
          ok: true,
          type: "os_write",
          via: "chip_already_present",
          chars: value.length,
          attempts: attempt + 1,
          verified: true,
        };
      }
    }

    // Double-type protection for single-line fields (search boxes, share
    // "Add people" inputs): a prior attempt/round may have landed silently.
    // If the field already holds the exact text, don't type it again; if it
    // holds a doubled value or retry leftovers, clear before retyping.
    if (!preferDocsBody && !canvas) {
      const st = await readActiveEditableState(webContents);
      // Strict mode: "already present" only counts when the ACTIVE element is
      // the named field — the doc body behind a dialog holding the text (from
      // a previous mistyped attempt) must not short-circuit as success.
      const activeMatchesTarget = (() => {
        if (!strictVerify) return true;
        const lab = String(st?.label || "").toLowerCase().replace(/\s+/g, " ").trim();
        const want = String(verifyLabel || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 40);
        if (!want) return true;
        return !!lab && (lab.includes(want) || want.includes(lab));
      })();
      if (st?.activeOk && !st?.titleish && activeMatchesTarget) {
        const stVal = normWs(st.value);
        const wanted = normWs(value).slice(0, 180);
        // Strict mode appends deliberately — only skip as "already present"
        // when the text is distinctive, not a short word the body happens to
        // contain already.
        if (wanted && (!strictVerify || wanted.length >= 12) && stVal.includes(wanted)) {
          const doubled = stVal.split(wanted).length - 1 >= 2;
          if (!doubled) {
            if (pressEnter) await sendRealKey(webContents, "Enter");
            return {
              ok: true,
              type: "os_write",
              via: "already_present",
              chars: value.length,
              attempts: attempt + 1,
              verified: true,
            };
          }
          await clearFocusedField(webContents);
        } else if (
          attempt > 0 &&
          Number(st.valueLen || 0) > 0 &&
          (st.tag === "input" ||
            st.tag === "textarea" ||
            (wanted && stVal.includes(wanted.slice(0, 12))))
        ) {
          // Retry with our partial text (or a plain input's stale value) in
          // the way — replace, never append.
          await clearFocusedField(webContents);
        }
      }
    }

    if (looksLikeGoogleDocsUrl(pageUrl) && (preferDocsBody || value.length > 80)) {
      if (await editorTitleStillFocused(webContents).catch(() => false)) {
        await focusPageEditor(webContents);
      }
      if (value.length > 80) {
        const pasted = await pasteTextIntoPage(webContents, {
          text: value,
          replaceAll: false,
        });
        if (pasted?.ok) {
          return {
            ok: true,
            type: "os_write",
            via: "paste",
            chars: value.length,
            attempts: attempt + 1,
          };
        }
        lastErr = pasted?.error || "paste_failed";
      }
    }

    try {
      webContents.focus();
      if (useInsertText) {
        await webContents.insertText(value);
      } else {
        await webContents.executeJavaScript(buildActionJs({
          ...(enriched || {}),
          type: "fill",
          text: value,
          value,
          label: hint || enriched?.label,
        }), true);
      }
      if (pressEnter) {
        await new Promise((r) => setTimeout(r, 100));
        await sendRealKey(webContents, "Enter");
      }
    } catch (e) {
      lastErr = e?.message || String(e);
      continue;
    }

    await new Promise((r) => setTimeout(r, 280));

    if (looksLikeGoogleDocsUrl(pageUrl) && (await editorTitleStillFocused(webContents).catch(() => false))) {
      lastErr = "typed_into_title";
      await focusPageEditor(webContents);
      continue;
    }

    // Canvas editors rarely expose value — treat successful focus+insert as ok
    // after a re-click attempt, unless title ate the keystrokes.
    if (canvas && attempt >= 1) {
      return {
        ok: true,
        type: "os_write",
        via: "insert_canvas",
        chars: value.length,
        attempts: attempt + 1,
        unverified: true,
      };
    }

    const after = await readActiveEditableState(webContents);
    let pageHit = false;
    if (needle && !canvas && !strictVerify) {
      try {
        const p = await getPageContext(webContents);
        pageHit = normWs(p?.text).includes(needle);
      } catch {
        /* ignore */
      }
    }
    const valueHit = !!needle && normWs(after?.value).includes(needle);
    // Strict mode: the evidence is the NAMED field's own value. Active-editable
    // and page-text hits pass when the text landed in the wrong element.
    let targetHit = false;
    if (strictVerify && needle) {
      const fieldVal = await readTargetFieldValue(webContents, {
        selector: verifySelector,
        label: verifyLabel || hint,
      });
      targetHit = fieldVal != null && normWs(fieldVal).includes(needle);
    }
    // Email committed as a recipient chip: field empties and the raw email
    // leaves the page text — check the dialog DOM so we don't retry-type.
    const chipHit =
      !valueHit &&
      !pageHit &&
      !targetHit &&
      !!emailValue &&
      (await shareDialogHasRecipientChip(webContents, emailValue));
    const grew =
      Number(after?.valueLen || 0) > Number(before?.valueLen || 0) + Math.min(2, value.length - 1);
    const activeOk = !!after?.activeOk && !after?.titleish;

    const passed = strictVerify
      ? targetHit || chipHit
      : valueHit || pageHit || chipHit || (grew && activeOk);
    if (passed) {
      return {
        ok: true,
        type: "os_write",
        via: attempt === 0 ? "insert" : "insert_retry",
        chars: value.length,
        attempts: attempt + 1,
        verified: strictVerify ? true : valueHit || pageHit || chipHit,
      };
    }

    lastErr = strictVerify
      ? "text_not_in_target_field"
      : activeOk
        ? "type_no_effect"
        : "field_not_focused";
    // Re-click path continues loop.
  }

  return {
    ok: false,
    error: lastErr || "type_no_effect",
    chars: value.length,
    attempts: maxAttempts,
    hint:
      lastErr === "text_not_in_target_field"
        ? `The text never landed in the "${verifyLabel || hint}" field — the field may be masked by another element or need a different route.`
        : undefined,
  };
}

/**
 * Fresh, exact click point for an action's target. Finds the element LIVE
 * (selector first, then label), scrolls it into view, re-measures, and
 * hit-tests the point so the click lands on the intended element — not
 * wherever it sat when the catalog was scraped.
 */
function buildResolvePointJs(action) {
  const payload = Buffer.from(JSON.stringify(action || {}), "utf8").toString("base64");
  return (
      `(function(){try{var a=JSON.parse(decodeURIComponent(escape(atob('${payload}'))));` +
        `function visEl(el){if(!el)return null;var r=el.getBoundingClientRect();if(r.width<2||r.height<2)return null;` +
        `var st=getComputedStyle(el);if(st.visibility==='hidden'||st.display==='none')return null;return el;}` +
        `function point(el){try{el.scrollIntoView({block:'center',inline:'center'});}catch(e){}` +
        `var r=el.getBoundingClientRect();` +
        `var x=Math.round(r.left+r.width/2),y=Math.round(r.top+Math.min(r.height/2,120));` +
        `x=Math.max(1,Math.min(x,(window.innerWidth||1200)-1));y=Math.max(1,Math.min(y,(window.innerHeight||800)-1));` +
        // The occluder being a SIBLING LAYER of the same widget is not
        // occlusion. Code editors (CodeMirror, Monaco) keep the real textarea
        // behind drawn layers inside one container; custom controls stack a
        // styled face over their input. Clicking the point still reaches the
        // widget, so accept when the thing at the point lives inside the
        // target's parent or grandparent — sized-guarded so a page-wide
        // wrapper can't launder a genuine dialog into a "sibling".
        `var hitOk=false;try{var hit=document.elementFromPoint(x,y);` +
        `hitOk=!!(hit&&(hit===el||el.contains(hit)||hit.contains(el)));` +
        `if(!hitOk&&hit){var anc=el.parentElement;` +
        `for(var k=0;k<2&&anc&&!hitOk;k++){var ar=anc.getBoundingClientRect();` +
        `if(ar.width*ar.height<=((window.innerWidth||1200)*(window.innerHeight||800)*0.5)&&anc.contains(hit))hitOk=true;` +
        `anc=anc.parentElement;}}}catch(e){}` +
        `return {x:x,y:y,hit:hitOk};}` +
        `function labOf(n){return ((n.getAttribute('aria-label')||n.getAttribute('alt')||n.getAttribute('title')||n.innerText||n.placeholder||n.name||n.id||'')+'').toLowerCase().replace(/\\s+/g,' ').trim();}` +
        `var want=(a.label||'').toLowerCase().replace(/\\s+/g,' ').trim();` +
        `var el=null;try{el=document.querySelector(a.selector);}catch(e){}el=visEl(el);` +
        // Snapshot selectors are nth-of-type paths — after an SPA re-render the
        // same path can address a DIFFERENT element. When we know what label the
        // agent expects, the selector match must still carry it; otherwise fall
        // through to the label search instead of clicking a stranger.
        `if(el&&want){var lw=labOf(el).slice(0,200);` +
        `if(!lw||!(lw.indexOf(want.slice(0,60))>-1||want.indexOf(lw)>-1))el=null;}` +
        `if(el){var pp=point(el);pp.label=labOf(el).slice(0,80);pp.via='selector';return pp;}` +
        `if(!want)return null;` +
        `var nodes=document.querySelectorAll('a,button,input,select,textarea,tr,li,img,[role=button],[role=link],[role=row],[role=listitem],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=combobox],[role=switch],label,div.zA,tr.zA,[tabindex],[onclick]');` +
        `var best=null,bestScore=0;` +
        `for(var i=0;i<nodes.length;i++){var n=nodes[i],lab=labOf(n);` +
        `if(!lab||!visEl(n))continue;` +
        `var score=0;if(lab===want)score=100;else if(lab.indexOf(want)===0)score=80;` +
        `else if(lab.indexOf(want)>-1)score=60-Math.min(40,Math.abs(lab.length-want.length));` +
        `else if(want.indexOf(lab)>-1&&lab.length>=4)score=40;` +
        `if(score>bestScore){bestScore=score;best=n;if(score>=100)break;}}` +
        // minLabelScore (strict callers): weak fuzzy matches click unrelated
        // elements — better to fail and let the agent re-observe.
        `if(best&&bestScore>=(Number(a.minLabelScore)||1)){var pb=point(best);pb.label=labOf(best).slice(0,80);pb.via='label';return pb;}return null;}catch(e){return null;}})()`
  );
}

async function resolveElementPoint(webContents, action) {
  if (!webContents || webContents.isDestroyed?.()) return null;
  try {
    const pt = await webContents.executeJavaScript(buildResolvePointJs(action), true);
    if (pt && typeof pt.x === "number" && typeof pt.y === "number") return pt;
  } catch {
    /* ignore */
  }
  return null;
}

/** Same live re-resolve as the main frame, translated into page coordinates. */
async function resolveFrameElementPoint(frame, action, offset) {
  if (!frame) return null;
  try {
    const pt = await frame.executeJavaScript(buildResolvePointJs(action), true);
    if (!pt || typeof pt.x !== "number" || typeof pt.y !== "number") return null;
    if (!offset?.known) return { ...pt, pageCoords: false };
    return { ...pt, x: pt.x + offset.x, y: pt.y + offset.y, pageCoords: true };
  } catch {
    return null;
  }
}

/** Read a field's live value from inside its own frame — the typing evidence. */
async function readFrameElementValue(frame, selector) {
  if (!frame || !selector) return null;
  try {
    return await frame.executeJavaScript(
      `(function(){try{var el=document.querySelector(${JSON.stringify(selector)});` +
        `if(!el)return null;return ((el.value!=null?el.value:(el.innerText||''))+'').slice(0,2000);` +
        `}catch(e){return null;}})()`,
      true,
    );
  } catch {
    return null;
  }
}

/**
 * Run an action against an element that lives in a sub-frame.
 *
 * Two mechanisms, in preference order. When the frame's position is known we
 * send REAL input events at page coordinates — they cross the frame boundary
 * like a user's mouse does, which is the only thing many editors respect, and
 * it moves focus into the frame so `insertText` types there. When the position
 * can't be measured we fall back to executing inside the frame, which is
 * synthetic but at least addresses the right element.
 */
async function runFrameAction(webContents, frame, offset, action) {
  const type = String(action?.type || "click").toLowerCase();
  const inFrame = async (payload) => {
    try {
      return await frame.executeJavaScript(buildActionJs(payload), true);
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  };

  if (type === "select") {
    const res = await inFrame({ ...action, type: "select" });
    return res?.ok ? { ...res, viaFrame: true } : res || { ok: false, error: "no_result" };
  }

  const point = await resolveFrameElementPoint(frame, action, offset);
  const realClick = async () => {
    if (!point?.pageCoords) return null;
    const hit = await clickAtClientPoint(webContents, point.x, point.y);
    return hit?.ok ? hit : null;
  };

  if (type === "click" || type === "tap" || type === "press_click") {
    if (action.strictTarget && point && point.hit === false) {
      return {
        ok: false,
        error: "element_obscured",
        hint: "Something covers that target inside the embedded frame — re-observe first.",
      };
    }
    const hit = await realClick();
    if (hit) {
      return { ...hit, resolved: "frame_point", viaFrame: true, frameId: frame.routingId };
    }
    const res = await inFrame({ ...action, type: "click" });
    if (res?.ok) return { ...res, viaFrame: true, synthetic: true, frameId: frame.routingId };
    return res || { ok: false, error: "frame_click_failed" };
  }

  if (type === "click_type" || type === "type" || type === "write" || type === "fill") {
    const text = String(action.text ?? action.value ?? "");
    if (!text) return { ok: false, error: "empty_text" };
    const hit = await realClick();
    if (hit) {
      await new Promise((r) => setTimeout(r, 160));
      try {
        webContents.focus();
        await webContents.insertText(text);
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
      if (action.pressEnter) {
        await new Promise((r) => setTimeout(r, 100));
        await sendRealKey(webContents, "Enter");
      }
      await new Promise((r) => setTimeout(r, 260));
      // Verify inside the frame — a main-frame read can't see this element at
      // all, and calling that "no change" is what strands editor edits.
      const landed = await readFrameElementValue(frame, action.selector || "");
      const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
      const needle = norm(text).slice(0, 48);
      const verified = !!needle && norm(landed).includes(needle);
      return {
        ok: true,
        type: "click_type",
        via: "frame_insert_text",
        viaFrame: true,
        frameId: frame.routingId,
        chars: text.length,
        verified,
        // Some editors (code mirrors, canvases) never expose the value back —
        // that is not the same as the typing having failed.
        unverified: !verified,
      };
    }
    // No usable click point — this frame's position in the window could not be
    // measured, so there is nowhere to aim. Focus the element from inside the
    // frame instead and type with real keys, which need no coordinates at all.
    // Without this the only remaining route was assigning .value from script,
    // which fails outright on the custom widgets these dialogs are built from:
    // Drive's "Add people" box refused both, and the run died having never
    // typed a character.
    const focused = await inFrame({ ...action, type: "focus" });
    if (focused?.ok) {
      await new Promise((r) => setTimeout(r, 120));
      try {
        webContents.focus();
        // Correcting a value: empty the field first, in the field itself.
        if (action.mode === "replace" || action.clearFirst === true) {
          await clearFocusedField(webContents);
        }
        await webContents.insertText(text);
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
      if (action.pressEnter) {
        await new Promise((r) => setTimeout(r, 100));
        await sendRealKey(webContents, "Enter");
      }
      await new Promise((r) => setTimeout(r, 260));
      const landed = await readFrameElementValue(frame, action.selector || "");
      const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
      const needle = norm(text).slice(0, 48);
      const verified = !!needle && norm(landed).includes(needle);
      return {
        ok: true,
        type: "click_type",
        via: "frame_focus_insert_text",
        viaFrame: true,
        frameId: frame.routingId,
        chars: text.length,
        verified,
        unverified: !verified,
      };
    }
    const res = await inFrame({ ...action, type: "fill", text, value: text });
    if (res?.ok) return { ...res, viaFrame: true, synthetic: true, frameId: frame.routingId };
    return res || { ok: false, error: "frame_type_failed" };
  }

  if (type === "press" || type === "key" || type === "press_key") {
    const hit = await realClick();
    if (!hit) await inFrame({ ...action, type: "focus" });
    return sendRealKey(webContents, action.key || "Enter", action.modifiers);
  }

  if (type === "hover" || type === "mouseover") {
    if (!point?.pageCoords) return { ok: false, error: "frame_offset_unknown" };
    try {
      const vp = toInputPoint(webContents, point.x, point.y);
      webContents.sendInputEvent({ type: "mouseMove", x: vp.x, y: vp.y });
      return { ok: true, type: "hover", x: point.x, y: point.y, viaFrame: true };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  const res = await inFrame(action);
  return res?.ok ? { ...res, viaFrame: true } : res || { ok: false, error: "no_result" };
}

function enrichActionFromCatalog(action, catalogItems) {
  const a = action && typeof action === "object" ? { ...action } : {};
  if (typeof a.clientX === "number" && typeof a.clientY === "number") return a;
  const items = Array.isArray(catalogItems) ? catalogItems : [];
  const byId = items.find(
    (it) =>
      (a.id && it.id === a.id) ||
      (a.selector && it.selector === a.selector) ||
      (a.href && it.href && it.href === a.href),
  );
  if (byId && typeof byId.clientX === "number") {
    a.clientX = byId.clientX;
    a.clientY = byId.clientY;
    if (!a.selector) a.selector = byId.selector;
    if (!a.label) a.label = byId.label;
    // Without the owning frame the action would run against the main document,
    // where this element does not exist.
    if (a.frameId == null && byId.frameId != null) a.frameId = byId.frameId;
    return a;
  }
  const want = String(a.label || "").toLowerCase().trim();
  if (want) {
    const match = items.find((it) =>
      String(it.label || "")
        .toLowerCase()
        .includes(want.slice(0, 48)),
    );
    if (match && typeof match.clientX === "number") {
      a.clientX = match.clientX;
      a.clientY = match.clientY;
      if (!a.selector) a.selector = match.selector;
      if (a.frameId == null && match.frameId != null) a.frameId = match.frameId;
    }
  }
  return a;
}

async function waitForLoad(webContents, timeoutMs = 15000) {
  if (!webContents || webContents.isDestroyed()) return;
  if (!webContents.isLoading()) {
    // Give SPA redirects a beat (YouTube themeRefresh, etc.).
    await new Promise((r) => setTimeout(r, 120));
    if (!webContents.isLoading()) return;
  }
  await new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    const done = () => {
      clearTimeout(t);
      resolve();
    };
    webContents.once("did-finish-load", done);
    webContents.once("did-navigate", done);
    webContents.once("did-navigate-in-page", done);
  });
}

/**
 * In-page "Loading…" that never resolves: navigation is finished (isLoading
 * is false) but a widget/dialog shows a spinner forever. Detect a VISIBLE
 * spinner/progressbar so the adaptive loop can reload instead of waiting.
 */
async function pageHasActiveSpinner(webContents) {
  if (!webContents || webContents.isDestroyed?.()) return false;
  try {
    return !!(await webContents.executeJavaScript(
      `(function(){try{
        function vis(el){if(!el)return false;var r=el.getBoundingClientRect();
          if(r.width<8||r.height<8)return false;
          var st=getComputedStyle(el);
          return st.visibility!=='hidden'&&st.display!=='none'&&st.opacity!=='0';}
        var nodes=document.querySelectorAll('[role="progressbar"],[aria-busy="true"],progress,[class*="spinner" i],[class*="loading" i]');
        for(var i=0;i<nodes.length;i++){ if(vis(nodes[i])) return true; }
        return false;
      }catch(e){return false;}})()`,
      true,
    ));
  } catch {
    return false;
  }
}

/** Page text dominated by a loading message ("Loading…", "Please wait…"). */
function pageLooksStuckLoadingText(text) {
  const t = String(text || "").slice(0, 6000).toLowerCase();
  if (!t.trim()) return false;
  return /\b(loading|please wait|one moment|just a (moment|sec(ond)?)|still working|preparing|fetching)\b\s*(\.{2,}|…)/.test(
    t,
  );
}

function isAbortNavigationError(err) {
  const msg = String(err?.message || err || "");
  const code = err?.errno ?? err?.code;
  return (
    code === -3 ||
    code === "ERR_ABORTED" ||
    /ERR_ABORTED/i.test(msg) ||
    /\(-3\)/.test(msg) ||
    /navigation.*abort/i.test(msg)
  );
}

function hostKey(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

async function navigate(webContents, url) {
  const target = String(url || "").trim();
  if (!target) return { ok: false, error: "missing_url" };
  let href = target;
  if (!/^https?:\/\//i.test(href) && !/^about:blank$/i.test(href)) {
    href = `https://${href}`;
  }
  // Hard allowlist — agents only load http(s) (and about:blank).
  if (!/^https?:\/\//i.test(href) && !/^about:blank$/i.test(href)) {
    return { ok: false, error: "blocked_url" };
  }
  const wantedHost = hostKey(href);
  try {
    await webContents.loadURL(href);
    await waitForLoad(webContents);
    return { ok: true, url: webContents.getURL() || href };
  } catch (e) {
    // Sites like YouTube abort the first loadURL during redirects
    // (`?themeRefresh=1`). The tab usually still lands on the destination —
    // treat that as success instead of failing the whole agent turn.
    await waitForLoad(webContents, 8000);
    await new Promise((r) => setTimeout(r, 180));
    const landed = String(webContents.getURL?.() || "");
    const landedHost = hostKey(landed);
    const sameSite = wantedHost && landedHost && landedHost.endsWith(wantedHost);
    if (isAbortNavigationError(e) && /^https?:\/\//i.test(landed) && (sameSite || !wantedHost)) {
      return { ok: true, url: landed, abortedRedirect: true };
    }
    if (/^https?:\/\//i.test(landed) && sameSite && !webContents.isLoading()) {
      return { ok: true, url: landed, recovered: true };
    }
    return { ok: false, error: e?.message || String(e) };
  }
}

async function getDOMCatalog(webContents, { includeFrames = true } = {}) {
  if (!webContents || webContents.isDestroyed()) return { ok: false, error: "no_webcontents" };
  try {
    // Reading the page is the last thing that happens before acting on it, so
    // it is where the activity monitor has to be armed: a request fired by the
    // upcoming click is only observable if the patch predates the click.
    webContents.executeJavaScript(ACTIVITY_MONITOR_JS, true).catch(() => {});
    const data = await webContents.executeJavaScript(COLLECT_INTERACTABLES_JS, true);
    const url = data?.url || webContents.getURL?.() || "";
    const items = Array.isArray(data?.items) ? [...data.items] : [];
    // Canvas editors hide the real writing surface from normal interactable
    // scans — inject a stable target so the planner can click into the body.
    if (looksLikeGoogleDocsUrl(url)) {
      let x = 280;
      let y = 320;
      try {
        const spot = await webContents.executeJavaScript(
          `(function(){
            var el=document.querySelector('.kix-page-paginated .kix-page, .kix-page, .kix-appview-editor, .docs-editor-container')||document.body;
            var r=el.getBoundingClientRect();
            return {
              x: Math.max(24, Math.floor(r.left + r.width*0.5)),
              y: Math.max(160, Math.floor(r.top + Math.max(100, Math.min(r.height*0.28, 280))))
            };
          })()`,
          true,
        );
        if (spot?.x) {
          x = spot.x;
          y = spot.y;
        }
      } catch {
        /* defaults */
      }
      items.unshift({
        id: "docs_editor_body",
        tag: "div",
        role: "textbox",
        type: "",
        label: "Document body (click here to write — not the title)",
        selector: ".kix-appview-editor",
        clientX: x,
        clientY: y,
        inView: true,
      });
    }
    // Embedded editors (Mailchimp campaigns, code/rich-text widgets) live in
    // iframes. Without these the model can read the content but has no handle
    // to click or type into it.
    let frameHosts = [];
    if (includeFrames) {
      try {
        const [offsets, viewport] = await Promise.all([
          buildFrameOffsets(webContents),
          getViewportMetrics(webContents),
        ]);
        const frameItems = await collectFrameInteractables(webContents, {
          offsets,
          viewport,
        });
        if (frameItems.length) {
          items.push(...frameItems);
          frameHosts = [...new Set(frameItems.map((it) => it.frameHost).filter(Boolean))];
        }
      } catch {
        /* main-frame catalog still stands on its own */
      }
    }
    return { ok: true, ...(data || {}), url, items, frameHosts };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ─── Cross-frame perception and action ──────────────────────────────────────
// Whole categories of app — Mailchimp's campaign editor, embedded rich-text
// and code editors, Stripe-style dashboards — render the part you actually
// need to touch inside an iframe. A main-frame-only catalog gives the model
// text it can read and no element it can act on, so it clicks the surrounding
// chrome, sees nothing change, and burns its whole budget. These helpers
// catalog every frame and route actions back to the frame that owns them.

/** Total interactables allowed from sub-frames, on top of the main frame's. */
const MAX_FRAME_CATALOG_ITEMS = 90;

/**
 * Pair a child frame with the <iframe> rect its parent measured. URL match
 * first (consumed, so duplicate embeds don't both claim one rect), then
 * document order for the leftovers.
 */
function takeFrameRect(rects, frameUrl, fallbackIndex) {
  const list = Array.isArray(rects) ? rects : [];
  const url = String(frameUrl || "");
  let idx = list.findIndex((r) => r && !r._used && r.src && r.src === url);
  if (idx < 0 && url) {
    // src can differ from the frame's live URL after in-frame navigation —
    // fall back to matching origin + path prefix.
    const base = url.split(/[?#]/)[0];
    idx = list.findIndex((r) => r && !r._used && r.src && r.src.split(/[?#]/)[0] === base);
  }
  if (idx < 0) {
    const free = list.map((r, i) => ({ r, i })).filter((e) => e.r && !e.r._used);
    if (free.length === 1) idx = free[0].i;
    else if (fallbackIndex < free.length) idx = free[fallbackIndex].i;
  }
  if (idx < 0) return null;
  list[idx]._used = true;
  return list[idx];
}

/**
 * Offset of every frame relative to the top-level viewport, walking the tree
 * so nested embeds accumulate their ancestors' offsets. `known: false` means
 * we could not measure it — actions on those elements run inside the frame
 * instead of by coordinate.
 */
async function buildFrameOffsets(webContents) {
  const offsets = new Map();
  const main = webContents?.mainFrame;
  if (!main) return offsets;
  offsets.set(main.routingId, { x: 0, y: 0, known: true, depth: 0 });
  const queue = [main];
  while (queue.length) {
    const parent = queue.shift();
    const base = offsets.get(parent.routingId);
    const children = parent.frames || [];
    if (!children.length) continue;
    let rects = [];
    if (base?.known) {
      rects =
        (await parent.executeJavaScript(COLLECT_FRAME_RECTS_JS, true).catch(() => [])) || [];
    }
    let seen = 0;
    for (const child of children) {
      if (!child) continue;
      const rect = base?.known ? takeFrameRect(rects, child.url, seen) : null;
      seen += 1;
      offsets.set(
        child.routingId,
        rect
          ? {
              x: base.x + rect.x,
              y: base.y + rect.y,
              w: rect.w,
              h: rect.h,
              known: true,
              depth: (base.depth || 0) + 1,
            }
          : { x: 0, y: 0, known: false, depth: (base?.depth || 0) + 1 },
      );
      queue.push(child);
    }
  }
  return offsets;
}

/**
 * Interactables from every sub-frame, with coordinates translated into
 * top-level page space and each item tagged with the frame that owns it.
 */
async function collectFrameInteractables(webContents, { offsets, viewport } = {}) {
  const out = [];
  try {
    const main = webContents?.mainFrame;
    const frames = main?.framesInSubtree || [];
    if (frames.length <= 1) return out;
    const vw = Number(viewport?.w) || 1200;
    const vh = Number(viewport?.h) || 800;
    let budget = MAX_FRAME_CATALOG_ITEMS;
    for (const fr of frames) {
      if (!fr || fr === main) continue;
      if (budget <= 0) break;
      const frUrl = String(fr.url || "");
      if (!frUrl || frUrl === "about:blank") continue;
      const data = await fr.executeJavaScript(COLLECT_INTERACTABLES_JS, true).catch(() => null);
      const items = Array.isArray(data?.items) ? data.items : [];
      if (!items.length) continue;
      const off = offsets?.get(fr.routingId) || { x: 0, y: 0, known: false };
      // A frame scrolled out of the top-level viewport has nothing in view,
      // however "in view" its own contents look from inside.
      const frameOnScreen =
        !off.known ||
        (off.x < vw && off.y < vh && off.x + (off.w || vw) > 0 && off.y + (off.h || vh) > 0);
      let host = "";
      try {
        host = new URL(frUrl).hostname.replace(/^www\./i, "");
      } catch {
        host = "";
      }
      for (const it of items.slice(0, budget)) {
        if (!it) continue;
        out.push({
          ...it,
          // Each frame counts from 1 in its own window — namespace by routing
          // id or frame uid 3 and main-frame uid 3 collide into one ref.
          uid: `${fr.routingId}_${it.uid}`,
          id: `f${fr.routingId}_${it.id}`,
          frameId: fr.routingId,
          frameUrl: frUrl,
          frameHost: host,
          frameOffsetKnown: !!off.known,
          clientX: off.known ? Number(it.clientX) + off.x : Number(it.clientX),
          clientY: off.known ? Number(it.clientY) + off.y : Number(it.clientY),
          inView: frameOnScreen && it.inView !== false,
        });
      }
      budget -= Math.min(items.length, budget);
    }
  } catch {
    /* frame catalog is additive — never break the main-frame scrape */
  }
  return out;
}

/**
 * Clear whatever the page has put in front of itself — cookie walls, consent
 * managers, newsletter modals, "open in app" nags, notification prompts.
 *
 * All of the judgement lives in browserOverlays.cjs; this is the wiring. The
 * scan runs in the main frame and in every sub-frame, because the two most
 * widely deployed consent managers render their wall inside an iframe, where a
 * main-frame scan sees an empty rectangle and the agent sees an unresponsive
 * page. A click goes out as a real mouse event at the point the scan measured,
 * falling back to the element itself when the point is unusable — a frame whose
 * position could not be measured, or a control something else is covering.
 *
 * @returns {Promise<{ok: boolean, dismissed: Array, remaining: Array, tried: string[]}>}
 */
async function dismissOverlays(
  webContents,
  { allowGeneric = true, skipSignatures = [], maxDismissals = 3, includeFrames = true } = {},
) {
  if (!webContents || webContents.isDestroyed?.()) {
    return { ok: false, error: "no_webcontents", dismissed: [], remaining: [], tried: [] };
  }
  const scanJs = browserOverlays.buildScanJs();
  const metrics = await getViewportMetrics(webContents).catch(() => null);
  const vw = Number(metrics?.w) || 1200;
  const vh = Number(metrics?.h) || 800;

  const scanFrames = async () => {
    const frames = [];
    const top = await webContents.executeJavaScript(scanJs, true).catch(() => null);
    if (top?.ok && top.overlays?.length) {
      frames.push({
        frameId: null,
        offsetX: 0,
        offsetY: 0,
        offsetKnown: true,
        docKey: top.docKey,
        overlays: top.overlays,
      });
    }
    const main = webContents.mainFrame;
    const subs = includeFrames ? main?.framesInSubtree || [] : [];
    if (subs.length > 1) {
      const offsets = await buildFrameOffsets(webContents).catch(() => null);
      for (const fr of subs) {
        if (!fr || fr === main) continue;
        const url = String(fr.url || "");
        if (!url || url === "about:blank") continue;
        const res = await fr.executeJavaScript(scanJs, true).catch(() => null);
        if (!res?.ok || !res.overlays?.length) continue;
        const off = offsets?.get(fr.routingId) || { x: 0, y: 0, known: false };
        frames.push({
          frameId: fr.routingId,
          offsetX: Number(off.x) || 0,
          offsetY: Number(off.y) || 0,
          offsetKnown: !!off.known,
          overlays: res.overlays,
        });
      }
    }
    return frames;
  };

  const click = async ({ point, control, frameId }) => {
    if (point && point.x >= 1 && point.y >= 1 && point.x < vw && point.y < vh) {
      const hit = await clickAtClientPoint(webContents, point.x, point.y);
      if (hit?.ok) return hit;
    }
    return runAction(
      webContents,
      {
        type: "click",
        selector: control?.selector || "",
        label: control?.label || "",
        ...(frameId != null ? { frameId } : {}),
      },
      [],
    );
  };

  return browserOverlays.sweepOverlays({
    scanFrames,
    click,
    settle: async (ms) => {
      await waitForDomSettle(webContents, ms).catch(() => {});
    },
    allowGeneric,
    skipSignatures,
    maxDismissals,
  });
}

/** The live WebFrameMain for a catalog item's frame, or null for the main frame. */
function frameByRoutingId(webContents, frameId) {
  const id = Number(frameId);
  if (!Number.isFinite(id)) return null;
  const main = webContents?.mainFrame;
  if (!main || main.routingId === id) return null;
  for (const fr of main.framesInSubtree || []) {
    if (fr && fr.routingId === id) return fr;
  }
  return null;
}

/**
 * Pull text out of every sub-frame (any origin — webFrameMain runs in the
 * frame itself). Dashboards like Stripe render their data in iframes that a
 * main-frame scrape can't see, so without this the agent only gets the URL.
 */
async function collectFrameTexts(webContents, budget = 14000) {
  const out = [];
  try {
    const main = webContents.mainFrame;
    const frames = main?.framesInSubtree || [];
    let total = 0;
    for (const fr of frames) {
      if (!fr || fr === main) continue;
      if (total >= budget) break;
      const frUrl = String(fr.url || "");
      if (!frUrl || frUrl === "about:blank") continue;
      const t = String(
        await fr.executeJavaScript(EXTRACT_FRAME_TEXT_JS, true).catch(() => ""),
      ).trim();
      // Tiny frames are ad pixels / widgets — skip the noise.
      if (t.length < 40) continue;
      out.push(t.slice(0, budget - total));
      total += t.length;
    }
  } catch {
    /* frame scrape is best-effort */
  }
  return out;
}

async function getPageContext(webContents) {
  if (!webContents || webContents.isDestroyed()) return { ok: false, error: "no_webcontents" };
  try {
    const data = await webContents.executeJavaScript(EXTRACT_PAGE_CONTEXT_JS, true);
    const url = data?.url || webContents.getURL?.() || "";
    let text = data?.text || "";
    // The top document may be mostly chrome (nav/shell) with the real content
    // in iframes — merge their text in unless the page is already rich.
    if (text.length < 12000) {
      const frameTexts = await collectFrameTexts(webContents);
      if (frameTexts.length) {
        text = `${text}\n${frameTexts.join("\n")}`.trim().slice(0, 16000);
      }
    }
    // Sheets is canvas-rendered — DOM text is mostly chrome. Don't pretend it's empty.
    if (looksLikeGoogleSheetsUrl(url)) {
      text =
        "[Google Sheets tab — cell values are drawn on a canvas, so this scrape cannot show the grid. " +
        "Do NOT conclude the sheet is blank from this text alone. Use remembered sheet contents if provided.]\n" +
        String(text || "").slice(0, 6000);
    } else if (looksLikeGoogleDocsUrl(url)) {
      text =
        "[Google Docs tab — document body is canvas-rendered. Chrome text (menus, Share, title) barely changes when you type. " +
        "To write: click element docs_editor_body / Document body, then use write/os_write with the essay text. " +
        "Do NOT click the title field. Do NOT stop just because this scrape looks unchanged after typing.]\n" +
        String(text || "").slice(0, 6000);
    }
    return { ok: true, ...(data || {}), url, text };
  } catch (e) {
    const url = webContents.getURL?.() || "";
    return {
      ok: false,
      error: e?.message || String(e),
      url,
      title: webContents.getTitle?.() || "",
      text: looksLikeGoogleSheetsUrl(url)
        ? "[Google Sheets tab — cell values are not readable from the DOM scrape.]"
        : "",
    };
  }
}

async function runAction(webContents, action, catalogItems) {
  if (!webContents || webContents.isDestroyed()) return { ok: false, error: "no_webcontents" };
  const enriched = enrichActionFromCatalog(action, catalogItems);
  const type = String(enriched?.type || "click").toLowerCase();
  // Elements cataloged from a sub-frame need their action executed against
  // that frame; the main document has no such element and every selector
  // lookup would miss.
  if (enriched?.frameId != null && !["navigate", "open", "wait", "scroll", "back", "forward"].includes(type)) {
    const frame = frameByRoutingId(webContents, enriched.frameId);
    if (frame) {
      const offsets = await buildFrameOffsets(webContents).catch(() => null);
      const offset = offsets?.get(frame.routingId) || { x: 0, y: 0, known: false };
      return runFrameAction(webContents, frame, offset, enriched);
    }
    // The frame is gone (editor closed, page re-rendered) — the snapshot is
    // stale, and guessing in the main document would click a stranger.
    if (enriched.strictTarget) {
      return {
        ok: false,
        error: "frame_gone",
        hint: "The embedded frame that held this element no longer exists — re-observe the page.",
      };
    }
  }
  if (type === "navigate" || type === "open") {
    return navigate(webContents, enriched.url || enriched.href || enriched.text);
  }
  if (type === "wait") {
    const ms = Math.min(Math.max(Number(enriched.ms) || 800, 100), 8000);
    await new Promise((r) => setTimeout(r, ms));
    return { ok: true, type: "wait" };
  }
  if (type === "scroll") {
    try {
      let dy = Number(enriched.dy);
      if (!Number.isFinite(dy) || dy === 0) {
        const amount = Math.min(Math.max(Number(enriched.amount) || 600, 100), 2400);
        dy = String(enriched.direction || "").toLowerCase() === "up" ? -amount : amount;
      }
      await webContents.executeJavaScript(
        `window.scrollBy(0, ${dy}); true`,
        true,
      );
      return { ok: true, type: "scroll", dy };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }
  // Browser history navigation — recover from wrong turns / return to lists.
  if (type === "back" || type === "go_back" || type === "goback") {
    try {
      const nav = webContents.navigationHistory;
      const canBack =
        typeof nav?.canGoBack === "function"
          ? nav.canGoBack()
          : typeof webContents.canGoBack === "function"
            ? webContents.canGoBack()
            : false;
      if (!canBack) return { ok: false, error: "cannot_go_back" };
      if (typeof nav?.goBack === "function") nav.goBack();
      else webContents.goBack();
      await waitForLoad(webContents, 8000);
      return { ok: true, type: "back", url: webContents.getURL?.() || "" };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }
  if (type === "forward" || type === "go_forward") {
    try {
      const nav = webContents.navigationHistory;
      const canFwd =
        typeof nav?.canGoForward === "function"
          ? nav.canGoForward()
          : typeof webContents.canGoForward === "function"
            ? webContents.canGoForward()
            : false;
      if (!canFwd) return { ok: false, error: "cannot_go_forward" };
      if (typeof nav?.goForward === "function") nav.goForward();
      else webContents.goForward();
      await waitForLoad(webContents, 8000);
      return { ok: true, type: "forward", url: webContents.getURL?.() || "" };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }
  // Scroll one container rather than the window — palettes, block lists and
  // editor side panels all scroll internally.
  if (type === "scroll_element" || type === "scroll_container") {
    if (!enriched.selector) return { ok: false, error: "missing_selector" };
    const amount = Math.min(Math.max(Number(enriched.amount) || 400, 60), 2400);
    const dy = String(enriched.direction || "").toLowerCase() === "up" ? -amount : amount;
    const js = buildScrollElementJs({ selector: enriched.selector, dy });
    try {
      const frame =
        enriched.frameId != null ? frameByRoutingId(webContents, enriched.frameId) : null;
      const res = frame
        ? await frame.executeJavaScript(js, true)
        : await webContents.executeJavaScript(js, true);
      return res || { ok: false, error: "scroll_failed" };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }
  // Drag one thing onto another — the core gesture of email builders, design
  // tools and kanban boards.
  if (type === "drag" || type === "drag_drop" || type === "drag_to") {
    const toPoint = async () => {
      const src = await resolveDragEndpoint(webContents, {
        selector: enriched.selector,
        label: enriched.label,
        clientX: enriched.clientX,
        clientY: enriched.clientY,
        nx: enriched.x,
        ny: enriched.y,
        frameId: enriched.frameId,
      });
      const dst = await resolveDragEndpoint(webContents, {
        selector: enriched.toSelector,
        label: enriched.toLabel,
        clientX: enriched.toClientX,
        clientY: enriched.toClientY,
        nx: enriched.toX,
        ny: enriched.toY,
        frameId: enriched.toFrameId != null ? enriched.toFrameId : enriched.frameId,
      });
      return { src, dst };
    };
    const { src, dst } = await toPoint();
    if (!src) return { ok: false, error: "drag_source_not_found" };
    if (!dst) return { ok: false, error: "drop_target_not_found" };
    // Native HTML5 drag sources need the event sequence dispatched directly;
    // Chromium's drag controller ignores synthetic mouse drags.
    const html5 =
      enriched.mode === "html5" ||
      (enriched.mode !== "pointer" &&
        enriched.selector &&
        enriched.toSelector &&
        (await elementUsesHtml5Drag(webContents, enriched.selector, enriched.frameId)));
    if (html5) {
      const js = buildHtml5DragJs({
        fromSelector: enriched.selector,
        toSelector: enriched.toSelector,
      });
      try {
        const frame =
          enriched.frameId != null ? frameByRoutingId(webContents, enriched.frameId) : null;
        const res = frame
          ? await frame.executeJavaScript(js, true)
          : await webContents.executeJavaScript(js, true);
        if (res?.ok) return { ...res, type: "drag", via: "html5" };
      } catch {
        /* fall through to a real pointer drag */
      }
    }
    return dragByInput(webContents, src, dst, {
      steps: Number(enriched.steps) || 20,
    });
  }
  // Screenshot-guided click: x,y are 0–1000 normalized viewport coords. Real
  // input events land anywhere on screen — icons, canvases, even inside
  // cross-origin iframes the DOM catalog can't see.
  // Prefer a live label/DOM match when the planner named the target — coords
  // from vision models are often off by enough to miss the Share button.
  if (type === "click_coord" || type === "tap_coord") {
    const labelHint = String(enriched.label || enriched.element || "").trim();
    // Share dialog: never resolve "Send" via fuzzy label/coords (often hits Cancel).
    if (/\bsend\b/i.test(labelHint) && !/\b(cancel|discard)\b/i.test(labelHint)) {
      const sent = await clickSendInShareDialog(webContents);
      if (sent?.ok) {
        return {
          ...sent,
          type: "click",
          resolved: "share_send_before_coord",
          // What the fast path actually clicked — without this, a whole run of
          // hijacked send attempts traced as anonymous successes.
          clickedLabel: String(sent.label || "Send"),
        };
      }
    }
    // Prefer vision coordinates. Label override only when score is excellent
    // AND the live point is near the mapped coords (avoids toolbar twins).
    const nx = Number(enriched.x);
    const ny = Number(enriched.y);
    const hasCoords = Number.isFinite(nx) && Number.isFinite(ny);
    let mappedForLabel = null;
    if (hasCoords) {
      try {
        const metrics = await getViewportMetrics(webContents);
        const shotMeta = lastScreenshotMeta.get(webContents) || null;
        mappedForLabel = mapNormCoordToClient(nx, ny, metrics, shotMeta);
      } catch {
        mappedForLabel = null;
      }
    }
    if (labelHint && labelHint.length >= 2 && !/^#?\d+\s/.test(labelHint)) {
      const byLabel = await clickInPageByHint(webContents, { hint: labelHint, index: 0 });
      const score = Number(byLabel?.score || 0);
      const labelPt =
        typeof byLabel?.x === "number" && typeof byLabel?.y === "number"
          ? { x: byLabel.x, y: byLabel.y }
          : null;
      const nearCoords =
        !mappedForLabel ||
        !labelPt ||
        Math.hypot(labelPt.x - mappedForLabel.x, labelPt.y - mappedForLabel.y) <= 24;
      if (byLabel?.ok && score >= 90 && nearCoords) {
        if (
          /\bsend\b/i.test(labelHint) &&
          /^(cancel|close|discard|done)$/i.test(String(byLabel.label || "").trim())
        ) {
          const sent = await clickSendInShareDialog(webContents);
          if (sent?.ok) return { ...sent, type: "click", resolved: "share_send_after_bad_label" };
          return { ok: false, error: "label_matched_dismiss", label: byLabel.label };
        }
        return { ...byLabel, type: "click", resolved: "label_before_coord" };
      }
    }
    if (!hasCoords) {
      return { ok: false, error: "bad_coords" };
    }
    try {
      const metrics = await getViewportMetrics(webContents);
      const shotMeta = lastScreenshotMeta.get(webContents) || null;
      let mapped =
        mappedForLabel || mapNormCoordToClient(nx, ny, metrics, shotMeta);
      // The screenshot these coordinates were read off no longer matches the
      // live viewport — the view was resized and the page reflowed. Clicking a
      // scaled guess would land on whatever moved under the point, so refuse
      // and make the caller look again. (The label path above already had its
      // chance; it resolves against the live DOM and is immune to this.)
      if (mapped.stale) {
        return {
          ok: false,
          error: "stale_screenshot",
          hint:
            "The browser viewport was resized after this screenshot was taken, so positions read off it " +
            "no longer land where they aim. Take a fresh screenshot and read the point off that instead.",
        };
      }
      // Snap only to a nearby control whose label matches the agent's target.
      const snapped = snapClientPointToCatalog(
        mapped.x,
        mapped.y,
        catalogItems,
        28,
        labelHint,
      );
      if (snapped.snapped && (snapped.id || snapped.label)) {
        const live = await resolveElementPoint(webContents, {
          id: snapped.id,
          label: snapped.label,
          selector: catalogItems?.find((it) => it.id === snapped.id)?.selector,
        });
        if (live && typeof live.x === "number") {
          mapped = { x: live.x, y: live.y, w: mapped.w, h: mapped.h };
        } else {
          mapped = { ...mapped, x: snapped.x, y: snapped.y };
        }
      }
      const hit = await clickAtClientPoint(webContents, mapped.x, mapped.y);
      if (hit?.ok && labelHint) {
        return {
          ...hit,
          resolved: snapped.snapped ? "coord_snapped" : "coord",
          snappedTo: snapped.snapped ? snapped.label || snapped.id : undefined,
        };
      }
      if (!hit?.ok && labelHint) {
        const retry = await clickInPageByHint(webContents, { hint: labelHint, index: 0 });
        if (retry?.ok && Number(retry.score || 0) >= 90) {
          return { ...retry, type: "click", resolved: "label_after_coord" };
        }
      }
      return hit;
    } catch (e) {
      if (labelHint) {
        const retry = await clickInPageByHint(webContents, { hint: labelHint, index: 0 });
        if (retry?.ok && Number(retry.score || 0) >= 90) {
          return { ...retry, type: "click", resolved: "label_after_error" };
        }
      }
      return { ok: false, error: e?.message || String(e) };
    }
  }
  // Editor keyboard shortcut ("cmd+a", "mod+b", "ctrl+shift+v") — how a user
  // actually selects/formats/copies in canvas editors like Google Docs.
  if (type === "shortcut" || type === "hotkey" || type === "keyboard") {
    return sendShortcut(webContents, enriched.value || enriched.key || "");
  }
  // Native editing commands — most reliable path for select/copy/paste/cut in
  // any focused editor (uses the real system clipboard).
  if (type === "select_all" || type === "selectall") {
    try {
      webContents.selectAll();
      return { ok: true, type: "select_all" };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }
  if (type === "copy" || type === "cut" || type === "paste") {
    try {
      webContents[type]();
      return { ok: true, type };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }
  // Atomic click+type (and plain type/write): ONE command — click field, then type.
  // Re-clicks and retries if the value/page did not change.
  if (
    type === "click_type" ||
    type === "type_into" ||
    type === "os_write" ||
    type === "write" ||
    type === "type" ||
    type === "fill" ||
    type === "input"
  ) {
    const text = String(
      enriched.text ?? enriched.value ?? enriched.content ?? "",
    );
    if (!text) return { ok: false, error: "empty_text" };
    const fieldHint = String(
      enriched.label || enriched.target || enriched.element || "",
    ).trim();
    const pageUrl = String(webContents.getURL?.() || "");
    const onCanvasEditor = looksLikeCanvasEditorUrl(pageUrl);
    // Only click the Docs body when the agent named it (or long canvas paste).
    // Never default to a random body click for an unlabeled type action.
    const wantsDocBody =
      /document body|docs_editor|essay|page body|editor/i.test(fieldHint) ||
      (onCanvasEditor && text.length > 80 && (!fieldHint || /^(type|write|os_write|fill|input|click_type)$/i.test(fieldHint)));

    // LIVE-first targeting, same rule as plain click below: catalog pixels go
    // stale the moment the page scrolls or re-renders, and typing at a stale
    // point puts the text into whatever field now sits there. Re-resolve the
    // element's position NOW; stored pixels are only a last resort.
    let clickPoint = null;
    if (enriched.selector || enriched.label) {
      const live = await resolveElementPoint(webContents, enriched);
      if (live) {
        if (live.hit === false && enriched.strictTarget) {
          // Something is drawn over the field. It is still in the document and
          // still focusable, and focus needs no clear line of sight — so put
          // the caret in it from script and type with real keys rather than
          // refusing. Refusing sent the agent back to clicking at a field it
          // could see, could not hit, and was never going to reach that way.
          // Returns a plain boolean: did the caret actually land in the field.
          const focused = await focusTargetFieldDom(webContents, {
            selector: enriched.selector || "",
            label: enriched.label || "",
          }).catch(() => false);
          if (focused) {
            try {
              webContents.focus();
              if (enriched.mode === "replace" || enriched.clearFirst === true) {
                await clearFocusedField(webContents);
              }
              await webContents.insertText(text);
              if (enriched.pressEnter) {
                await new Promise((r) => setTimeout(r, 100));
                await sendRealKey(webContents, "Enter");
              }
              await new Promise((r) => setTimeout(r, 220));
              // Resolves to the field's value as a string, or null.
              const landed = await readTargetFieldValue(webContents, {
                selector: enriched.selector || "",
                label: enriched.label || "",
              }).catch(() => null);
              const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
              const verified = !!landed && norm(landed).includes(norm(text).slice(0, 40));
              return {
                ok: true,
                type: "click_type",
                via: "focus_insert_text_over_overlay",
                chars: text.length,
                verified,
                unverified: !verified,
              };
            } catch (e) {
              return { ok: false, error: e?.message || String(e) };
            }
          }
          return {
            ok: false,
            error: "element_obscured",
            hint: "Another element covers the field (open dialog or menu?) — re-observe the page first.",
          };
        }
        clickPoint = { x: live.x, y: live.y };
      } else if (enriched.strictTarget) {
        return {
          ok: false,
          error: "element_not_relocated",
          hint: "The field from the last snapshot no longer resolves — the page changed; re-observe.",
        };
      }
    }
    if (
      !clickPoint &&
      typeof enriched.clientX === "number" &&
      typeof enriched.clientY === "number" &&
      Number.isFinite(enriched.clientX) &&
      Number.isFinite(enriched.clientY)
    ) {
      // Only trust stored pixels while they are still inside the viewport.
      let vp = null;
      try {
        vp = await webContents.executeJavaScript(
          "({w:window.innerWidth||1200,h:window.innerHeight||800})",
          true,
        );
      } catch {
        /* ignore */
      }
      const withinView =
        !vp ||
        (enriched.clientX >= 0 &&
          enriched.clientX <= vp.w &&
          enriched.clientY >= 0 &&
          enriched.clientY <= vp.h);
      if (withinView) clickPoint = { x: enriched.clientX, y: enriched.clientY };
    }
    if (!clickPoint) {
      const nx = Number(enriched.x);
      const ny = Number(enriched.y);
      const hasNormCoords =
        Number.isFinite(nx) &&
        Number.isFinite(ny) &&
        nx >= 0 &&
        nx <= 1000 &&
        ny >= 0 &&
        ny <= 1000;
      if (hasNormCoords) {
        try {
          const metrics = await getViewportMetrics(webContents);
          const shotMeta = lastScreenshotMeta.get(webContents) || null;
          const mapped = mapNormCoordToClient(nx, ny, metrics, shotMeta);
          if (mapped.stale) {
            // The shot these coordinates came from predates a viewport resize.
            // With a field name we can still focus by label below; without one
            // a scaled guess would type into whatever moved under the point.
            if (!fieldHint) {
              return {
                ok: false,
                error: "stale_screenshot",
                hint:
                  "The browser viewport was resized after this screenshot was taken. " +
                  "Take a fresh screenshot and read the field's position off that instead.",
              };
            }
          } else {
            const snapped = snapClientPointToCatalog(
              mapped.x,
              mapped.y,
              catalogItems,
              40,
              fieldHint,
            );
            clickPoint = {
              x: snapped.snapped ? snapped.x : mapped.x,
              y: snapped.snapped ? snapped.y : mapped.y,
            };
          }
        } catch {
          /* fall through to hint focus */
        }
      }
    }

    // Refuse blind typing with no agent target (label/coords/doc-body intent).
    if (
      !clickPoint &&
      !wantsDocBody &&
      (!fieldHint || /^(type|write|os_write|fill|input|click_type)$/i.test(fieldHint))
    ) {
      return {
        ok: false,
        error: "no_type_target_from_agent",
        hint: "Agent must name the field (label) or give click coords before typing.",
      };
    }

    const typed = await typeWithFocusRetry(webContents, {
      text,
      hint: fieldHint,
      pressEnter: !!enriched.pressEnter,
      preferDocsBody: !!(
        wantsDocBody &&
        (looksLikeGoogleDocsUrl(pageUrl) || onCanvasEditor) &&
        !clickPoint
      ),
      enriched,
      verifyNeedle: text.length <= 80 ? text : text.slice(0, 32),
      maxAttempts: 3,
      useInsertText: true,
      clickPoint,
      strictVerify: !!enriched.strictTarget && !wantsDocBody,
      // "replace" means the field already holds something wrong.
      clearFirst: enriched.mode === "replace" || enriched.clearFirst === true,
      verifySelector: enriched.selector || "",
      verifyLabel: enriched.label || "",
    });
    // The text did not end up where it was aimed — nothing took focus, or it
    // landed somewhere else, or it went nowhere at all. Strict targeting
    // reports the middle case for all three, which is why keying this off one
    // error name missed it entirely. If a dialog is open, its field is the one
    // place the agent was aiming at: reach it by focus rather than by pixel,
    // which is the part that keeps failing on share and invite dialogs.
    const TYPING_MISSED = new Set([
      "field_not_focused",
      "text_not_in_target_field",
      "type_no_effect",
    ]);
    if (!typed?.ok && TYPING_MISSED.has(String(typed?.error || "")) && !wantsDocBody) {
      const dialogField = await focusOpenDialogField(webContents, { hint: fieldHint });
      if (dialogField.ok) {
        try {
          webContents.focus();
          if (enriched.mode === "replace" || enriched.clearFirst === true) {
            await clearFocusedField(webContents);
          }
          const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
          const isEmail = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.test(text.trim());
          const landed = async () => {
            const state = await readActiveEditableState(webContents);
            if (norm(state?.value).includes(norm(text).slice(0, 40))) return true;
            // A recipient field commits what you type into a chip and empties
            // itself, so an empty field is the SUCCESS case here, not a miss.
            if (isEmail) {
              return !!(await shareDialogHasRecipientChip(webContents, text.trim()).catch(() => false));
            }
            return false;
          };

          await webContents.insertText(text);
          await new Promise((r) => setTimeout(r, 200));
          let verified = await landed();
          let via = "dialog_field_focus";
          // insertText reached nothing. Paste is a different mechanism, not a
          // retry of the same one: it runs through the app's own paste
          // handling, which is the path a recipient box is actually built for.
          if (!verified) {
            const pasted = await pasteTextIntoFocused(webContents, text);
            if (pasted) {
              verified = await landed();
              if (verified) via = "dialog_field_paste";
            }
          }
          if (enriched.pressEnter) {
            await new Promise((r) => setTimeout(r, 100));
            await sendRealKey(webContents, "Enter");
            // Committing the entry empties the field, so re-read before
            // deciding it never arrived.
            if (!verified) verified = await landed();
          }
          return {
            ok: true,
            type: "os_write",
            via,
            chars: text.length,
            verified,
            unverified: !verified,
            fieldLabel: dialogField.label || "",
          };
        } catch (e) {
          return { ok: false, error: e?.message || String(e) };
        }
      }
    }
    return typed;
  }
  // Key press the way a user would: focus the target (best-effort), then send
  // REAL keyboard events — synthetic KeyboardEvents don't submit forms and are
  // ignored by most SPAs.
  if (type === "press" || type === "key" || type === "press_key") {
    if (enriched.selector || enriched.label) {
      try {
        await webContents.executeJavaScript(
          buildActionJs({ ...enriched, type: "focus" }),
          true,
        );
      } catch {
        /* focus is best-effort — key still goes to the page */
      }
    }
    return sendRealKey(
      webContents,
      enriched.key || "Enter",
      normalizeModifiers(enriched.modifiers),
    );
  }
  // Hover: real mouseMove at the element's center (reveals menus/tooltips).
  if (type === "hover" || type === "mouseover") {
    let pt =
      (await resolveElementPoint(webContents, enriched)) ||
      (typeof enriched.clientX === "number" && {
        x: enriched.clientX,
        y: enriched.clientY,
      });
    // Vision planners send 0–1000 screenshot coords — map like click_coord.
    if (!pt) {
      const nx = Number(enriched.x);
      const ny = Number(enriched.y);
      if (Number.isFinite(nx) && Number.isFinite(ny) && nx >= 0 && nx <= 1000 && ny >= 0 && ny <= 1000) {
        try {
          const metrics = await getViewportMetrics(webContents);
          const shotMeta = lastScreenshotMeta.get(webContents) || null;
          pt = mapNormCoordToClient(nx, ny, metrics, shotMeta);
        } catch {
          pt = null;
        }
      }
    }
    if (!pt) return { ok: false, error: "Element not found" };
    try {
      const vp = toInputPoint(webContents, pt.x, pt.y);
      webContents.sendInputEvent({ type: "mouseMove", x: vp.x, y: vp.y });
      return { ok: true, type: "hover", x: pt.x, y: pt.y };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }
  // Real input-event clicks (Gmail/YouTube SPAs ignore el.click()). ALWAYS
  // re-resolve the element's LIVE position first — catalog coords go stale the
  // moment the page scrolls or re-renders, and below-fold items sit outside
  // the viewport entirely. Catalog coords are only a last-resort fallback.
  if (type === "click" || type === "tap" || type === "press_click") {
    // Committing an open dialog — Send / Share / Invite. This is the click a
    // whole task comes down to, and aiming at it by pixel or by fuzzy label is
    // where runs end up cycling: a near miss hits the page chrome behind the
    // dialog, which closes it, and the agent reopens and tries again. The
    // resolver scores the dialog's own controls, refuses anything that
    // dismisses, and clicks the real button.
    if (/^\W*(?:send|share|invite)\b/i.test(String(enriched.label || "").trim())) {
      const sent = await clickSendInShareDialog(webContents);
      if (sent?.ok) {
        return {
          ...sent,
          type: "click",
          resolved: "dialog_commit",
          clickedLabel: String(sent.label || enriched.label || ""),
        };
      }
    }
    // Synthetic Docs body target — focus the real editor, not a random chrome hit.
    if (
      enriched.id === "docs_editor_body" ||
      /document body|docs_editor/i.test(String(enriched.label || ""))
    ) {
      const focused = await focusPageEditor(webContents);
      return {
        ok: !!focused?.ok,
        type: "click",
        resolved: "docs_editor_body",
        error: focused?.error,
        x: focused?.x,
        y: focused?.y,
      };
    }
    let pt = null;
    if (enriched.selector || enriched.label) {
      pt = await resolveElementPoint(webContents, enriched);
    }
    // Strict callers (modular agent) never guess: a covered target means a
    // dialog/menu is in the way, and an unresolvable one means the page
    // changed since the snapshot — both need a re-observe, not a blind click.
    if (enriched.strictTarget) {
      if (pt && pt.hit === false) {
        return {
          ok: false,
          error: "element_obscured",
          hint: "Another element covers the target (open dialog or menu?) — re-observe the page first.",
        };
      }
      if (!pt) {
        return {
          ok: false,
          error: "element_not_relocated",
          hint: "The element from the last snapshot no longer resolves — the page changed; re-observe.",
        };
      }
    }
    if (pt) {
      const hit = await clickAtClientPoint(webContents, pt.x, pt.y);
      if (hit.ok) {
        return {
          ...hit,
          resolved: pt.via || "live",
          clickedLabel: pt.label || "",
          hitTest: pt.hit !== false,
        };
      }
    }
    if (
      !pt &&
      typeof enriched.clientX === "number" &&
      typeof enriched.clientY === "number"
    ) {
      // Only trust stale coords when they are still inside the viewport.
      let vp = null;
      try {
        vp = await webContents.executeJavaScript(
          "({w:window.innerWidth||1200,h:window.innerHeight||800})",
          true,
        );
      } catch {
        /* ignore */
      }
      const withinView =
        !vp ||
        (enriched.clientX >= 0 &&
          enriched.clientX <= vp.w &&
          enriched.clientY >= 0 &&
          enriched.clientY <= vp.h);
      if (withinView) {
        const hit = await clickAtClientPoint(webContents, enriched.clientX, enriched.clientY);
        if (hit.ok) return { ...hit, resolved: "catalog" };
      }
    }
  }
  try {
    const result = await webContents.executeJavaScript(buildActionJs(enriched), true);
    if (result?.ok) {
      // Reinforce with input events when JS click returned coords (SPA often needs both).
      if (typeof result.clientX === "number" && typeof result.clientY === "number") {
        await clickAtClientPoint(webContents, result.clientX, result.clientY);
      }
      return result;
    }
    // The value could not be assigned from script — a custom widget, or a
    // wrapper matched instead of the real field. Type it the way a person
    // would instead of giving up: focus the field and use real keys.
    if (result?.error === "field_not_writable" && (type === "fill" || type === "type")) {
      const typed = await typeWithFocusRetry(webContents, {
        text: String(enriched.text ?? enriched.value ?? ""),
        hint: enriched.label || "",
        pressEnter: !!enriched.pressEnter,
        enriched,
        clearFirst: enriched.mode === "replace" || enriched.clearFirst === true,
        strictVerify: !!enriched.strictTarget,
        verifySelector: enriched.selector || "",
        verifyLabel: enriched.label || "",
      });
      if (typed?.ok) return { ...typed, via: typed.via || "real_keys_after_fill" };
    }
    const pt =
      (await resolveElementPoint(webContents, enriched)) ||
      (typeof enriched.clientX === "number" && {
        x: enriched.clientX,
        y: enriched.clientY,
      });
    if (pt) {
      const hit = await clickAtClientPoint(webContents, pt.x, pt.y);
      if (hit.ok) return hit;
    }
    return result || { ok: false, error: "no_result" };
  } catch (e) {
    const pt = await resolveElementPoint(webContents, enriched);
    if (pt) {
      const hit = await clickAtClientPoint(webContents, pt.x, pt.y);
      if (hit.ok) return hit;
    }
    return { ok: false, error: e?.message || String(e) };
  }
}

async function screenshotDataUrl(webContents, { maxWidth = 0, jpegQuality = 0 } = {}) {
  if (!webContents || webContents.isDestroyed()) return null;
  try {
    const metrics = await getViewportMetrics(webContents);
    let img = await webContents.capturePage();
    if (!img || img.isEmpty()) return null;
    const rawSize = img.getSize();
    const dpr = Number(metrics.dpr) || 1;
    // CSS size implied by the capture — more accurate than innerWidth when a
    // scrollbar or DPR rounding would otherwise shift click_coord left/right.
    const cssW = Math.max(1, Math.round(rawSize.width / dpr));
    const cssH = Math.max(1, Math.round(rawSize.height / dpr));
    // Planner rounds run every few seconds — downscale + JPEG keeps the
    // per-round payload small without losing what the model needs to see.
    if (maxWidth > 0) {
      if (rawSize.width > maxWidth) {
        img = img.resize({ width: maxWidth });
      }
    }
    const outSize = img.getSize();
    lastScreenshotMeta.set(webContents, {
      cssW: Number(metrics.cw) || cssW,
      cssH: Number(metrics.ch) || cssH,
      captureCssW: cssW,
      captureCssH: cssH,
      imgW: outSize.width,
      imgH: outSize.height,
      dpr,
      at: Date.now(),
    });
    if (jpegQuality > 0) {
      const buf = img.toJPEG(Math.min(Math.max(jpegQuality, 30), 95));
      if (buf?.length) return `data:image/jpeg;base64,${buf.toString("base64")}`;
    }
    return img.toDataURL();
  } catch {
    return null;
  }
}

async function waitForChange(webContents, prevSig, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ctx = await getPageContext(webContents);
    const sig = `${ctx.url || ""}|${String(ctx.text || "").slice(0, 400)}`;
    if (prevSig && sig !== prevSig) return ctx;
    await new Promise((r) => setTimeout(r, 350));
  }
  return getPageContext(webContents);
}

function normalizeControlLabel(label) {
  return String(label || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function catalogLabelSet(items) {
  const set = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    const lab = normalizeControlLabel(it?.label);
    if (lab && lab.length >= 2) set.add(lab);
  }
  return set;
}

/** Human-readable before/after diff so the planner re-picks from the NEW screen. */
function formatOwnedPageDiff(before, after) {
  const parts = [];
  const bUrl = String(before?.url || "");
  const aUrl = String(after?.url || "");
  const bTitle = String(before?.title || "");
  const aTitle = String(after?.title || "");
  if (bUrl && aUrl && bUrl !== aUrl) {
    parts.push(`URL changed: ${bUrl} → ${aUrl}`);
  }
  if (aTitle && aTitle !== bTitle) {
    parts.push(`Title now: ${aTitle}`);
  }

  const beforeSet = catalogLabelSet(before?.items);
  const afterItems = Array.isArray(after?.items) ? after.items : [];
  const afterSet = catalogLabelSet(afterItems);
  const appeared = [];
  for (const it of afterItems) {
    const lab = normalizeControlLabel(it?.label);
    if (!lab || beforeSet.has(lab)) continue;
    if (appeared.includes(String(it.label || "").trim())) continue;
    appeared.push(String(it.label || "").trim().slice(0, 60));
    if (appeared.length >= 14) break;
  }
  const disappeared = [];
  for (const lab of beforeSet) {
    if (afterSet.has(lab)) continue;
    disappeared.push(lab.slice(0, 60));
    if (disappeared.length >= 8) break;
  }

  if (appeared.length) {
    // When share dialog is open with a recipient chip, demote dismiss controls
    // so the planner doesn't treat Cancel/Done as the "next" step.
    const sharePendingSend = afterItems.some((it) => {
      const lab = normalizeControlLabel(it?.label);
      return /^send(\s+invite)?$/i.test(lab) || /\bsend\s+invite\b/i.test(lab);
    });
    const useful = sharePendingSend
      ? appeared.filter(
          (lab) =>
            !/^(cancel|close|discard|dismiss|done|not now|no thanks)$/i.test(lab.trim()) &&
            !/\b(cancel|close|discard|dismiss)\b/i.test(lab),
        )
      : appeared;
    const shown = useful.length ? useful : appeared;
    parts.push(
      sharePendingSend
        ? `NEW controls (share invite pending — prefer Send / Send invite; NEVER Cancel/Done/Close): ${shown.join(" · ")}`
        : `NEW controls visible now (choose the next step from THESE if they advance the goal): ${shown.join(" · ")}`,
    );
  }
  if (disappeared.length) {
    parts.push(`Controls that disappeared: ${disappeared.join(" · ")}`);
  }

  const bText = String(before?.text || "").slice(0, 500);
  const aText = String(after?.text || "").slice(0, 500);
  if (bText && aText && bText !== aText && !appeared.length && bUrl === aUrl) {
    parts.push("Page content updated (same URL). Re-read the screen.");
  }

  if (!parts.length) {
    return (
      "No clear page change after the last action — the click may have missed or the UI is still loading. " +
      "Do NOT repeat the exact same click; pick a different control or wait briefly."
    );
  }

  parts.push(
    "IMPORTANT: The UI advanced. Forget the previous screen's buttons. " +
      "Pick ONE next control from what is visible NOW that moves USER GOAL forward.",
  );
  return parts.join("\n");
}

/**
 * After a click/type: let the page settle, re-scrape, and describe what changed
 * so the next plan round targets the new screen (dialogs, next buttons, etc.).
 */
async function observeAfterOwnedAction(
  webContents,
  before,
  { settleMs = 950, timeoutMs = 2400 } = {},
) {
  if (!webContents || webContents.isDestroyed()) {
    return {
      after: before,
      diff: "Could not observe — tab gone.",
      changed: false,
    };
  }
  await waitForDomSettle(webContents, settleMs).catch(() => {});
  const prevSig = `${before?.url || ""}|${String(before?.text || "").slice(0, 400)}`;
  const beforeLabels = catalogLabelSet(before?.items);
  const start = Date.now();
  let afterPage = null;
  let afterCatalog = null;
  let afterUrl = webContents.getURL?.() || before?.url || "";

  while (Date.now() - start < timeoutMs) {
    afterUrl = webContents.getURL?.() || afterUrl;
    try {
      afterPage = await getPageContext(webContents);
    } catch {
      afterPage = { text: "", title: "", url: afterUrl };
    }
    try {
      afterCatalog = await getDOMCatalog(webContents);
    } catch {
      afterCatalog = { items: [] };
    }
    const sig = `${afterPage.url || afterUrl}|${String(afterPage.text || "").slice(0, 400)}`;
    const afterLabels = catalogLabelSet(afterCatalog.items);
    let labelsChanged = false;
    if (afterLabels.size !== beforeLabels.size) labelsChanged = true;
    else {
      for (const lab of afterLabels) {
        if (!beforeLabels.has(lab)) {
          labelsChanged = true;
          break;
        }
      }
    }
    const changed =
      (prevSig && sig !== prevSig) ||
      afterUrl !== (before?.url || "") ||
      labelsChanged;
    if (changed) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  if (!afterPage) {
    try {
      afterPage = await getPageContext(webContents);
    } catch {
      afterPage = { text: "", title: before?.title || "", url: afterUrl };
    }
  }
  if (!afterCatalog) {
    try {
      afterCatalog = await getDOMCatalog(webContents);
    } catch {
      afterCatalog = { items: [] };
    }
  }

  const after = {
    url: afterPage.url || afterUrl,
    title: afterPage.title || webContents.getTitle?.() || "",
    text: afterPage.text || "",
    items: afterCatalog.items || [],
  };
  const diff = formatOwnedPageDiff(before, after);
  const changed = !/^No clear page change/i.test(diff);
  return { after, diff, changed };
}

/** Open/visit-only goal with no follow-on act in the same ask. */
function looksLikeBareOpenBrowseGoal(goal) {
  const g = String(goal || "").toLowerCase();
  if (!g) return false;
  // "my ads/account/dashboard" always needs a signed-in surface — never bare open.
  if (looksLikeAccountDashboardAsk(g)) return false;
  if (
    /\b(then|after that|and then|complete|fill|type|submit|all|every|entire|keep going|go through|do the rest|all of it)\b/.test(
      g,
    ) ||
    /\band\s+(open|read|click|find|search|play|watch|draft|reply|complete|finish|write|edit)\b/.test(
      g,
    )
  ) {
    return false;
  }
  if (
    /\b(search|find|click|play|watch|type|fill|reply|draft|summarize|summarise|review|analyze|analyse|edit|write|create|share|invite|solve|answer)\b/.test(
      g,
    )
  ) {
    return false;
  }
  if (looksLikeOpenMailItem(goal)) return false;
  return /\b(go\s+to|open|visit|pull\s+up|navigate|launch|load)\b/.test(g);
}

/**
 * "go to / check my reddit ads account" — must land in the signed-in dashboard,
 * not just the marketing/login redirect.
 */
function looksLikeAccountDashboardAsk(goal) {
  const g = String(goal || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!g) return false;
  if (resolveAccountDashboardUrl(g)) return true;
  return (
    /\bmy\b/.test(g) &&
    ACCOUNT_SURFACE_NOUN_RE.test(g) &&
    /\b(go\s+to|open|visit|pull\s+up|check|review|look\s+at|show|see|log\s*in|sign\s*in)\b/.test(g)
  );
}

/**
 * True when the live tab looks like a signed-in account/workspace
 * (not marketing, login, or "start advertising" landing).
 */
function accountDashboardLooksSignedIn({ url = "", pageText = "", title = "" } = {}) {
  const u = String(url || "");
  const t = String(pageText || "");
  const titleL = String(title || "");
  if (looksLikeSignInWall({ url: u, text: t, title: titleL })) return false;
  const lower = `${titleL}\n${t}`.toLowerCase();

  // Notion workspace (app.notion.com / notion.so/…)
  if (/notion\.(so|site)|app\.notion\.com/i.test(u)) {
    if (
      looksLikeMarketingOrHomeUrl(u, t) &&
      /\b(log\s*in|sign\s*up|get notion free|try notion)\b/i.test(lower)
    ) {
      return false;
    }
    if (
      /\b(new page|add a page|private|workspace|quick find|trash|shared|teamspaces?|all pages|favorites?)\b/i.test(
        lower,
      )
    ) {
      return true;
    }
    // Deep workspace URL with real chrome (not bare marketing home).
    try {
      const path = new URL(u).pathname || "";
      if (
        path.length > 2 &&
        !/\/(login|signup|sign-in|sign-up|product|pricing|templates|enterprise|onboarding)(\/|$)/i.test(
          path,
        ) &&
        t.trim().length >= 60
      ) {
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  if (looksLikeMarketingOrHomeUrl(u, t)) return false;
  const loggedOutChrome =
    /\b(log\s*in|sign\s*in|sign\s*up|log\s*in\s*with|continue with google|get started|create (an )?account|start advertising|advertise (on|with)|try (for )?free|book a demo|for business)\b/i.test(
      lower,
    ) &&
    !/\b(campaigns?|ad groups?|ad sets?|impressions|amount spent|spend|ads manager|delivery|audiences?|reporting|your ads|create campaign|ad account|workspace|dashboard)\b/i.test(
      lower,
    );
  if (loggedOutChrome) return false;
  if (
    /\b(campaigns?|ad groups?|ad sets?|impressions|amount spent|ads manager|create campaign|delivery|audiences?|ad account|billing|payment methods)\b/i.test(
      lower,
    )
  ) {
    return true;
  }
  // On a known ads/dashboard host with real body and no logged-out chrome.
  if (
    /ads\.|adsmanager|campaignmanager|analytics\.google|studio\.youtube|dashboard\.|admin\.|console\./i.test(
      u,
    ) ||
    /business\.reddit\.com/i.test(u)
  ) {
    return t.trim().length >= 100 && !loggedOutChrome;
  }
  return false;
}

/**
 * True when the ask still needs in-page work after landing on a URL —
 * find/complete/fill/share/etc. Used to block "Opened X. What next?" early exits.
 */
function askStillNeedsAdaptiveWork(text) {
  const g = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!g) return false;
  // Account/dashboard asks need sign-in + real dashboard — never stop at marketing.
  if (looksLikeAccountDashboardAsk(g)) return true;
  if (looksLikeMultiStepBrowseGoal(g)) return true;
  // Opening a specific inbox row is NOT done just by landing on #inbox.
  if (
    looksLikeOpenMailItem(g) ||
    /\b(open|read|view|click)\b.{0,48}\b(email|e-mail|mail|message|thread)\b/.test(g)
  ) {
    return true;
  }
  if (
    /\b(find|search|look\s*up|locate|complete|finish|fill|submit|share|invite|write|draft|create|make|build|edit|click|play|watch|answer|take|solve|type|compose|reply|respond|post|upload|select|choose|pick|check|review|summarize|summarise|keep going|go through|do the rest|all of it|work\s+through)\b/.test(
      g,
    )
  ) {
    // Bare "open/play this video" after auto-open is ok to stop — handled by caller.
    if (
      /^(please\s+|can\s+you\s+)?(open|go\s+to|visit|pull\s+up|launch|load)\b/.test(g) &&
      !/\b(and|then|find|search|complete|fill|write|edit|share|click|play|watch|take|answer)\b/.test(
        g.replace(/^(please\s+|can\s+you\s+)?(open|go\s+to|visit|pull\s+up|launch|load)\b/, ""),
      ) &&
      !looksLikeAccountDashboardAsk(g)
    ) {
      return false;
    }
    return true;
  }
  if (/\b(and then|after that|then\s+(click|open|find|type|fill|submit|complete))\b/.test(g)) {
    return true;
  }
  return false;
}

/**
 * Open/check/review/look-at asks with no mutate/complete verbs.
 * Once the right surface is open, more clicks are usually overshoot.
 */
function looksLikeInspectOrReviewAsk(goal) {
  const g = String(goal || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!g) return false;
  // Opening a specific email/message is an action — not "inspect Gmail".
  if (looksLikeOpenMailItem(g)) return false;
  if (/\b(open|read|view|click)\b.{0,48}\b(email|e-mail|mail|message|thread)\b/.test(g)) {
    return false;
  }
  // Account dashboards are inspect-style but need signed-in evidence.
  if (looksLikeAccountDashboardAsk(g)) return true;
  if (
    !/\b(check|review|look\s+(?:at|over)|see|inspect|status|how\s+(?:is|are)|show\s+me|pull\s+up|open|go\s+to)\b/.test(
      g,
    )
  ) {
    return false;
  }
  if (
    /\b(complete|finish|solve|fill|submit|share|invite|write|draft|type|edit|reply|compose|create|make|build|click|take|answer|play|watch|search|find|work\s+through|quiz|exercise|every|all of|and then|keep going|go through)\b/.test(
      g,
    )
  ) {
    return false;
  }
  return true;
}

function hostsMatchForAsk(wantUrl, haveUrl) {
  try {
    const want = new URL(String(wantUrl || ""));
    const have = new URL(String(haveUrl || ""));
    const wh = want.hostname.replace(/^www\./i, "").toLowerCase();
    const hh = have.hostname.replace(/^www\./i, "").toLowerCase();
    if (!wh || !hh) return false;
    if (hh === wh) return true;
    if (hh.endsWith(`.${wh}`) || wh.endsWith(`.${hh}`)) return true;
    // notion.so ↔ app.notion.com ↔ *.notion.site (same product; different hosts)
    if (isNotionProductHost(wh) && isNotionProductHost(hh)) return true;
    // ads.reddit.com ↔ business.reddit.com / reddit.com/ads (same product family)
    const wBase = wh.split(".").slice(-2).join(".");
    const hBase = hh.split(".").slice(-2).join(".");
    if (wBase && wBase === hBase) {
      if (/^ads\./i.test(wh) || /ads\.reddit/i.test(String(wantUrl || ""))) {
        return (
          /^ads\./i.test(hh) ||
          /^business\./i.test(hh) ||
          /\/ads\b/i.test(have.pathname || "")
        );
      }
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function isNotionProductHost(hostname) {
  const h = String(hostname || "")
    .replace(/^www\./i, "")
    .toLowerCase();
  return (
    /^notion\.(so|site)$/i.test(h) ||
    /^app\.notion\.com$/i.test(h) ||
    /\.notion\.(so|site)$/i.test(h)
  );
}

/** Wanted account URL and live tab are the same product (even if hosts differ). */
function sameAccountProductHost(wantUrl, haveUrl) {
  if (hostsMatchForAsk(wantUrl, haveUrl)) return true;
  try {
    const wh = new URL(String(wantUrl || "")).hostname.replace(/^www\./i, "");
    const hh = new URL(String(haveUrl || "")).hostname.replace(/^www\./i, "");
    if (isNotionProductHost(wh) && isNotionProductHost(hh)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** How much typed/pasted text counts as finishing a write/create ask. */
function typedContentMinCharsForGoal(goal) {
  const g = String(goal || "")
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (/\b(essay|paper|article|report|write-?up|memo|letter|proposal|thesis)\b/.test(g)) {
    return 280;
  }
  if (/\b(write|draft|compose|author|write\s+out)\b/.test(g)) return 120;
  if (
    /\b(create|make|new|start)\b/.test(g) &&
    /\b(page|doc|document|note|sheet|deck|presentation)\b/.test(g)
  ) {
    return 40;
  }
  return 2;
}

/**
 * History-verified write that the page now echoes — the content landed even if
 * it is shorter than the goal-size heuristic (e.g. "write a short essay").
 */
function historyTypedContentVisibleOnPage(history, pageText, { minChars = 20 } = {}) {
  const text = String(pageText || "").replace(/\s+/g, " ").toLowerCase();
  if (!text) return false;
  const hist = Array.isArray(history) ? history : [];
  for (const h of hist) {
    if (!h?.result?.ok) continue;
    const t = String(h?.action?.type || "").toLowerCase();
    if (!/^(?:os_write|write|type|fill|paste|click_type|input)$/i.test(t)) continue;
    const val = String(h?.action?.value || h?.action?.text || "")
      .replace(/\s+/g, " ")
      .trim();
    if (val.length < minChars) continue;
    const needle = val.slice(0, 60).toLowerCase();
    if (needle && text.includes(needle)) return true;
  }
  return false;
}

function historyHasTypedContent(history, { minChars = 2 } = {}) {
  const hist = Array.isArray(history) ? history : [];
  let total = 0;
  for (const h of hist) {
    if (!h?.result?.ok) continue;
    const t = String(h?.action?.type || "").toLowerCase();
    if (!/^(?:os_write|write|type|fill|paste|click_type|input)$/i.test(t)) continue;
    const val = String(h?.action?.value || h?.action?.text || "").trim();
    // Bare write/paste with no captured value used to count as done — that
    // falsely cleared essay asks after a no-op or title-field tap.
    if (val.length < 2) continue;
    total += val.length;
    if (val.length >= minChars || total >= minChars) return true;
  }
  return false;
}

/**
 * True when the open editor already has real body content (not just Docs chrome).
 * Lets us skip re-writing when history was lost between plan steps.
 */
function pageShowsSubstantialDocBody(pageText = "", url = "") {
  const u = String(url || "");
  // Marketing / product home is never a filled deliverable.
  if (looksLikeMarketingOrHomeUrl(u, pageText)) return false;
  const onDocs =
    /docs\.google\.com\/document\//i.test(u) ||
    /docs\.google\.com\/spreadsheets\//i.test(u) ||
    /docs\.google\.com\/presentation\//i.test(u);
  const onNotion = /notion\.(so|site)\//i.test(u) || /\.notion\.(so|site)\b/i.test(u);
  const onCanvas = looksLikeCanvasEditorUrl(u);
  if (onNotion) {
    const path = (() => {
      try {
        return new URL(u).pathname || "";
      } catch {
        return "";
      }
    })();
    // Workspace root without a page id isn't the created page yet.
    if (!path || path === "/" || (/^\/[^/]+\/?$/i.test(path) && !/-[\da-f]{16,}/i.test(path))) {
      return false;
    }
  }
  if (!onDocs && !onNotion && !onCanvas && !String(pageText || "").trim()) return false;
  const body = String(pageText || "")
    .replace(
      /\b(File|Edit|View|Insert|Format|Tools|Extensions|Help|Share|Comment|Comments|Editing|Suggesting|Viewing|Untitled document|Untitled spreadsheet|Untitled presentation|Last edit was|Document tabs|Menus|Toolbar|Search the menus|Normal text|Arial|Courier|Get started|Log in|Sign up|Templates|Product|Download|Pricing|Enterprise)\b/gi,
      " ",
    )
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (onDocs || onNotion || onCanvas) {
    if (body.length >= 220) return true;
    const words = body.split(/\s+/).filter((w) => w.length > 2);
    return words.length >= 60;
  }
  if (body.length >= 160) return true;
  const words = body.split(/\s+/).filter((w) => w.length > 2);
  return words.length >= 45;
}

function historyHasUiAct(history) {
  const hist = Array.isArray(history) ? history : [];
  return hist.filter(
    (h) =>
      h?.result?.ok &&
      /^(?:click|tap|press_click|click_coord|tap_coord|os_write|write|type|fill|press|paste|click_type)$/i.test(
        String(h?.action?.type || ""),
      ),
  );
}

function shareInviteSatisfied(goal, pageText, history) {
  const emails = String(goal || "").match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || [];
  const hist = Array.isArray(history) ? history : [];
  if (!emails.length) {
    return (
      pageShowsShareInviteComplete(pageText) ||
      (historyShowsShareSendDone(hist, []) && !pageShowsShareDialogOpen(pageText))
    );
  }
  if (emails.every((e) => pageShowsShareInviteComplete(pageText, e))) return true;
  return (
    historyShowsShareSendDone(hist, emails) &&
    (!pageShowsShareDialogOpen(pageText) || pageShowsShareInviteComplete(pageText))
  );
}

/**
 * Parts of the ORIGINAL user ask that are still unfinished on this page/history.
 * Empty array ⇒ every asked part has evidence. Used to block premature "done".
 */
function unmetBrowseAskRequirements(
  goal,
  {
    url = "",
    pageText = "",
    title = "",
    history = [],
    sawScreenChange = false,
    // The runtime already sent the content via Gmail this turn — share/send
    // evidence lives on the Gmail tab, so doc-page checks can't see it.
    mailSendDone = false,
  } = {},
) {
  const rawGoal = String(goal || "");
  // Email compose/reply is owned end-to-end by the mail path — the modular
  // agent verifies its own draft and asks the user itself when content is
  // missing. The browse residual checker second-guessing it caused bogus
  // "write/type the requested content" re-runs and "Needs you" pauses.
  // Doc share-by-email asks are different and still checked below.
  if (
    !isShareInviteGoal(rawGoal) &&
    (looksLikeMailComposeTask(rawGoal) || looksLikeMailReplyTask(rawGoal))
  ) {
    return [];
  }
  // Continuation goals already list STILL TODO — validate those against the page
  // instead of re-parsing the embedded original ask (which caused rewrite loops).
  if (
    /^\s*ONLY\s+(do|finish|share)\b/i.test(rawGoal) ||
    /\bSTILL TODO:/i.test(rawGoal)
  ) {
    const u0 = String(url || "");
    const text0 = String(pageText || "");
    const hist0 = Array.isArray(history) ? history : [];
    const section =
      (rawGoal.match(/STILL TODO:\s*([\s\S]*?)(?:\nOriginal ask|\nAction now|\nContext:|$)/i) ||
        [])[1] || "";
    const todos = section
      .split("\n")
      .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
      .filter(Boolean);
    const left = [];
    for (const t of todos) {
      if (/write|type/i.test(t)) {
        if (
          historyHasTypedContent(hist0) ||
          pageShowsSubstantialDocBody(text0, u0)
        ) {
          continue;
        }
      }
      if (/share|send/i.test(t)) {
        if (mailSendDone) continue;
        if (shareInviteSatisfied(rawGoal, text0, hist0)) continue;
        // Prefer email from continuation context / original line.
        const emails = rawGoal.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || [];
        if (
          emails.length &&
          emails.every((e) => pageShowsShareInviteComplete(text0, e))
        ) {
          continue;
        }
      }
      if (/quiz|exercise|finish the quiz/i.test(t) && pageShowsExerciseComplete(text0)) {
        continue;
      }
      if (/open the (site|target|requested)/i.test(t)) {
        if (
          /^https?:\/\//i.test(u0) &&
          !isPlaceholderAgentUrl(u0) &&
          !/google\.com\/search/i.test(u0)
        ) {
          continue;
        }
      }
      left.push(t);
    }
    return left;
  }

  const g = rawGoal
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!g) return [];
  const u = String(url || "");
  const text = String(pageText || "");
  const hist = Array.isArray(history) ? history : [];
  const unmet = [];
  const typedOk = historyHasTypedContent(hist);
  const okUi = historyHasUiAct(hist);

  if (!/^https?:\/\//i.test(u) || isPlaceholderAgentUrl(u)) {
    return ["open the requested page"];
  }
  // A dead link outranks every other reading of the page. Nothing asked for can
  // be true on a 404, and describing the gap as "create the thing" invites an
  // ask for controls that are not there.
  if (deadEndPage.looksLikeDeadEnd({ title, visibleText: text }).deadEnd) {
    return ["get off the dead link and onto the real page"];
  }
  if (
    looksLikeSignInWall({
      url: u,
      text,
      title,
    })
  ) {
    return ["sign in so the page is usable"];
  }

  // Account / ads dashboard asks: must be signed in to the real console —
  // marketing redirects (e.g. ads.reddit.com → business.reddit.com logged out)
  // are NOT done.
  if (looksLikeAccountDashboardAsk(goal)) {
    const signedIn = accountDashboardLooksSignedIn({
      url: u,
      pageText: text,
      title,
    });
    const accountUrl = resolveAccountDashboardUrl(goal);
    const hostOk =
      !accountUrl ||
      /google\.com\/search/i.test(accountUrl) ||
      hostsMatchForAsk(accountUrl, u);
    // Already signed in on the right product (notion.so ↔ app.notion.com, etc.)
    // → done for open/check account asks. Don't nag "open the dashboard".
    if (signedIn && (hostOk || sameAccountProductHost(accountUrl, u))) {
      return [];
    }
    if (accountUrl && !/google\.com\/search/i.test(accountUrl) && !hostOk && !signedIn) {
      return ["open the requested dashboard/account"];
    }
    if (!signedIn) {
      return ["sign in to your account dashboard"];
    }
    return [];
  }

  // Inspect/review: landing on the right surface with content is enough.
  // Exception: open-mail asks must reach a thread URL, not bare #inbox.
  if (looksLikeInspectOrReviewAsk(goal)) {
    if (/google\.com\/search|bing\.com\/search|duckduckgo\.com\/\?|youtube\.com\/results/i.test(u)) {
      return ["open the requested page (still on search results)"];
    }
    const accountUrl = resolveAccountDashboardUrl(goal);
    if (accountUrl && !/google\.com\/search/i.test(accountUrl)) {
      const signedIn = accountDashboardLooksSignedIn({
        url: u,
        pageText: text,
        title,
      });
      if (!hostsMatchForAsk(accountUrl, u) && !sameAccountProductHost(accountUrl, u) && !signedIn) {
        return ["open the requested dashboard/account"];
      }
      if (!signedIn) {
        return ["sign in to your account dashboard"];
      }
      return [];
    }
    const dest =
      resolveOpenDestinationUrl(goal) || resolveBrowseTargetUrl(goal) || "";
    if (dest && !/google\.com\/search/i.test(dest)) {
      if (!hostsMatchForAsk(dest, u)) return ["open the requested site/page"];
      if (text.trim().length < 40 && looksLikeMarketingOrHomeUrl(u, text)) {
        return ["get past the marketing/home page to the real content"];
      }
      return [];
    }
    if (text.trim().length >= 80 && !looksLikeMarketingOrHomeUrl(u, text)) return [];
    return ["open/land on the page for this ask"];
  }

  // Open a specific email/message — must be on a thread hash, not bare inbox.
  // NEVER for compose asks: "open gmail and draft an email to X" is about
  // WRITING a new mail ("open" points at Gmail, "email" at the draft) — it
  // must not demand an existing thread be opened.
  const composeMailAsk =
    looksLikeMailComposeTask(goal) ||
    /\b(draft|compose|write|send)\b[^.!?]{0,48}\b(email|e-mail|mail|message)\b/.test(g) ||
    /\b(email|e-mail|mail|message)\b[^.!?]{0,24}\bto\s+\S+@/.test(g);
  const openMailAsk =
    looksLikeOpenMailItem(goal) ||
    (!composeMailAsk &&
      (/\b(open|read|view|click)\b.{0,48}\b(email|e-mail|mail|message|thread)\b/.test(g) ||
        (/\b(first|second|third|top|\d+(?:st|nd|rd|th))\b.{0,40}\b(email|e-mail|mail|message|thread)\b/.test(
          g,
        ) &&
          /\b(open|read|view|click|identify|find|show)\b/.test(g))));
  if (openMailAsk) {
    const threadOpen =
      /mail\.google\.com/i.test(u) &&
      /(?:#|\/)(?:inbox|all|sent|drafts|starred|important|snoozed|label\/[^/]+)\/[A-Za-z0-9]+/i.test(
        u,
      );
    if (!threadOpen) {
      unmet.push("open the email/message");
    } else if (
      // Pure open-mail asks are done once the thread URL is live.
      !/\b(reply|respond|compose|draft|forward|share|invite)\b/.test(g)
    ) {
      return [];
    }
  }

  if (
    /google\.com\/search|bing\.com\/search|duckduckgo\.com\/\?|youtube\.com\/results/i.test(u) &&
    askStillNeedsAdaptiveWork(g)
  ) {
    unmet.push("leave search results and open the target");
  }

  const wantsWrite =
    /\b(write|draft|compose|essay|author|paper)\b/.test(g) ||
    /\bwrite\s+out\b/.test(g) ||
    (/\bfill\b/.test(g) &&
      /\b(form|doc|document|sheet|field|out|in|page|sections?|content|profile|details)\b/.test(g)) ||
    (/\btype\b/.test(g) &&
      !/\b(type of|prototype)\b/.test(g) &&
      /\b(essay|doc|document|content|text|reply|response|message|email|notes?|body|paper|page|sections?)\b/.test(
        g,
      )) ||
    (/\b(add|include)\b/.test(g) &&
      /\b(sections?|content|details|copy|text|profile)\b/.test(g));
  const wantsCreate =
    /\b(create|make|new|start)\b/.test(g) &&
    /\b(page|doc|document|note|sheet|deck|presentation|profile|workspace|file|board|design)\b/.test(g);
  const writeDone = deliverableContentReady(goal, {
    url: u,
    pageText: text,
    history: hist,
  });
  if ((wantsWrite || wantsCreate) && !writeDone) {
    unmet.push(
      wantsCreate && !wantsWrite
        ? "create the page/doc and add the requested content"
        : "write/type the requested content",
    );
  }

  const wantsShare = isShareInviteGoal(goal);
  if (wantsShare && !mailSendDone && !shareInviteSatisfied(goal, text, hist)) {
    unmet.push("share/send the doc to the recipient");
  }
  // Share/email without a concrete address still needs a share action.
  if (
    !wantsShare &&
    !mailSendDone &&
    /\b(share|email|send)\b/.test(g) &&
    /\b(page|doc|document|file|via email|by email|with)\b/.test(g) &&
    !shareInviteSatisfied(goal, text, hist) &&
    !okUi.some((h) => /\bshare\b/i.test(String(h?.action?.label || "")))
  ) {
    unmet.push("open share and send/email the page");
  }

  // Any mutate ask still on a marketing/home URL → not done.
  if (
    (wantsWrite || wantsCreate || askStillNeedsAdaptiveWork(g)) &&
    looksLikeMarketingOrHomeUrl(u, text) &&
    !unmet.some((x) => /create|write|type|open the requested/i.test(x))
  ) {
    unmet.push("get past the home/marketing page into the real workspace");
  }

  const exerciseGoal =
    /\b(quiz|exercise|lesson|practice|complete it|finish it|work\s+through|entire thing)\b/i.test(
      g,
    ) ||
    /\b(complete|finish|solve|take|answer)\b.{0,40}\b(quiz|exercise|lesson|practice|test|exam|form)\b/i.test(
      g,
    );
  if (exerciseGoal && !pageShowsExerciseComplete(text)) {
    unmet.push("finish the quiz/exercise/form");
  }

  if (
    /\b(play|watch)\b/.test(g) &&
    (/\b(youtube|video|vimeo|clip)\b/.test(g) || /youtube\.com|vimeo\.com/i.test(u))
  ) {
    const playing =
      /youtube\.com\/watch|youtu\.be\/|vimeo\.com\/\d+/i.test(u) ||
      okUi.some((h) =>
        /\b(play|watch|video)\b/i.test(String(h?.action?.label || h?.action?.element || "")),
      );
    if (!playing) unmet.push("play/open the video");
  }

  if (
    /\b(reply|respond|response)\b/.test(g) &&
    /\b(email|e-mail|mail|message|gmail|inbox)\b/.test(g) &&
    !wantsWrite
  ) {
    const composing =
      !!isGmailComposeUrl?.(u) ||
      /[#&]compose=/i.test(u) ||
      typedOk;
    if (!composing) unmet.push("draft/reply to the email");
  }

  if (/\b(find|search|look\s*up|locate)\b/.test(g)) {
    if (
      looksLikeMarketingOrHomeUrl(u, text) &&
      okUi.length < 1 &&
      !typedOk
    ) {
      unmet.push("find/search to the target content");
    }
  }

  // Multi-step compound asks: never "done" after only landing.
  if (
    (looksLikeMultiStepBrowseGoal(g) || askStillNeedsAdaptiveWork(g)) &&
    okUi.length < 1 &&
    !writeDone &&
    !exerciseGoal &&
    !wantsShare &&
    !looksLikeBareOpenBrowseGoal(g)
  ) {
    if (!unmet.length) unmet.push("perform the remaining asked actions");
  }

  // Phase coverage (open/find/act/submit/finish) — skip labels already covered above.
  // A completed Gmail send covers every phase of a "send …" ask.
  if (mailSendDone && /\b(send|share|email|forward|mail)\b/.test(g)) {
    return unmet;
  }
  const phaseEv = browseGoalPhasesEvidence(goal, {
    url: u,
    pageText: text,
    history: hist,
    sawScreenChange,
  });
  const phaseLabel = {
    open: "open the site",
    find: "find the target",
    act: "perform the asked click/type",
    submit: "submit/send/confirm",
    finish: "finish every remaining part of the ask",
  };
  for (const m of phaseEv.missing || []) {
    if (m === "act" && wantsWrite && (writeDone || unmet.some((x) => /write\/type/i.test(x)))) {
      continue;
    }
    if (
      m === "submit" &&
      wantsShare &&
      unmet.some((x) => /share\/(invite|send)|share\/send/i.test(x))
    ) {
      continue;
    }
    if (m === "finish" && (exerciseGoal || wantsShare || writeDone) && unmet.length) continue;
    // Don't demand another "act" click when the write is already on the page.
    if (m === "act" && writeDone) continue;
    const label = phaseLabel[m] || m;
    if (!unmet.includes(label)) unmet.push(label);
  }

  void title;
  return unmet;
}

/**
 * Build a continuation goal that only asks for unfinished parts.
 * Prevents re-writing / re-opening when those parts are already done.
 */
function remainingAskGoal(
  goal,
  { url = "", pageText = "", title = "", history = [], sawScreenChange = false } = {},
) {
  const gaps = unmetBrowseAskRequirements(goal, {
    url,
    pageText,
    title,
    history,
    sawScreenChange,
  });
  if (!gaps.length) return "";

  const g = String(goal || "");
  const done = [];
  const u = String(url || "");
  const text = String(pageText || "");
  const hist = Array.isArray(history) ? history : [];
  const writeDone =
    historyHasTypedContent(hist) || pageShowsSubstantialDocBody(text, u);

  if (/^https?:\/\//i.test(u) && !isPlaceholderAgentUrl(u) && !/google\.com\/search/i.test(u)) {
    done.push("opened the target page/editor");
  }
  if (
    /\b(write|draft|compose|essay|author|paper|write\s+out)\b/i.test(g) &&
    writeDone
  ) {
    done.push("wrote the document content (already on screen — do NOT rewrite or paste again)");
  }
  if (isShareInviteGoal(g) && shareInviteSatisfied(g, text, hist)) {
    done.push("shared/sent to the recipient");
  }
  if (
    /\b(quiz|exercise|complete|finish)\b/i.test(g) &&
    pageShowsExerciseComplete(text)
  ) {
    done.push("finished the quiz/exercise");
  }

  const emails = g.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || [];
  const onlyShare =
    gaps.length > 0 && gaps.every((x) => /share|send/i.test(x));
  const onlyWrite =
    gaps.length > 0 && gaps.every((x) => /write|type/i.test(x));

  let focus = `ONLY do what is still unfinished. Do NOT repeat completed work.\n`;
  if (done.length) {
    focus += `ALREADY DONE (skip these):\n${done.map((d) => `- ${d}`).join("\n")}\n`;
  }
  focus += `STILL TODO:\n${gaps.map((x) => `- ${x}`).join("\n")}\n`;
  if (onlyShare) {
    focus +=
      `Action now: open Share, add ${emails[0] || "the recipient email"}, click Send. ` +
      `Do NOT edit or retype the document body.\n`;
  } else if (onlyWrite) {
    focus += `Action now: put the requested content into the editor body once.\n`;
  } else {
    focus += `Action now: the next unfinished TODO item only.\n`;
  }
  // Keep context free of action verbs that would re-trigger write/open detection.
  const topic = stripShareSendInstructions(g)
    .replace(
      /\b(go\s+to|open|visit|pull\s+up|write(?:\s+out)?|draft|compose|create|make|send|share)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  focus += `Context: ${topic || "current document"}`;
  if (emails[0]) focus += `; recipient ${emails[0]}`;
  focus += "\n";
  return focus.slice(0, 2000);
}

/**
 * True when this plan step's work is already satisfied on the live page.
 */
function planStepAlreadySatisfied(
  stepText,
  fullAsk,
  { url = "", pageText = "", title = "", history = [], mailSendDone = false } = {},
) {
  const step = String(stepText || "").trim();
  if (!step) return false;
  const ctx = { url, pageText, title, history, mailSendDone };

  // Share/send step already completed via Gmail this turn — the evidence is
  // on the mail tab, not the current page.
  if (mailSendDone && /\b(share|send|email|forward)\b/i.test(step)) return true;

  // Page Q&A / "what's on my page" always needs a fresh scrape answer —
  // never skip as "already complete" just because a tab is open.
  if (
    looksLikePageQuestionAsk(step) ||
    looksLikePageQuestionAsk(fullAsk || "")
  ) {
    return false;
  }

  // Conditional sign-in step: done only when we're past the wall.
  if (/\bsign[- ]?in|log[- ]?in\b/i.test(step)) {
    return !looksLikeSignInWall({
      url,
      text: pageText,
      title,
    });
  }

  // A step naming a concrete subject (site, brand, product, person) is only
  // "already complete" when that subject actually appears on the live page.
  // "compare the prices to adidas" while a different store is open must RUN.
  {
    const hay = `${String(url)}\n${String(title)}\n${String(pageText)}`.toLowerCase();
    const stop = new Set([
      "this", "that", "these", "those", "with", "from", "into", "about", "after",
      "then", "than", "compare", "comparison", "versus", "against", "price",
      "prices", "pricing", "cost", "costs", "check", "review", "look", "open",
      "find", "search", "show", "page", "site", "tab", "screen", "please",
      "just", "also", "really", "their", "there", "them", "your", "mine",
      "some", "more", "less", "cheaper", "expensive", "difference", "between",
      "current", "product", "products", "item", "items", "thing", "things",
      "stuff", "info", "information", "details", "data", "what", "when",
      "where", "which", "make", "sure", "well", "good", "best", "same",
    ]);
    const tokens = (String(step).toLowerCase().match(/[a-z][a-z0-9'-]{3,}/g) || []).filter(
      (w) => !stop.has(w),
    );
    if (tokens.length && !tokens.some((w) => hay.includes(w))) {
      return false;
    }
  }

  const fullGaps = unmetBrowseAskRequirements(fullAsk || step, ctx);

  // Opening an inbox row is never "already done" on bare #inbox.
  if (
    looksLikeOpenMailItem(step) ||
    /\b(open|read|view|click)\b.{0,48}\b(email|e-mail|mail|message|thread)\b/i.test(step)
  ) {
    const threadOpen =
      /mail\.google\.com/i.test(String(url || "")) &&
      /(?:#|\/)(?:inbox|all|sent|drafts|starred|important|snoozed|label\/[^/]+)\/[A-Za-z0-9]+/i.test(
        String(url || ""),
      );
    if (!threadOpen) return false;
  }

  // Create / fill / write / title steps are never "done" from merely opening the site.
  // Bare "email" in "open the email" is NOT a create/fill step.
  const createOrFillStep =
    !looksLikeOpenMailItem(step) &&
    /\b(create|make|new\s+page|new\s+doc|blank|fill|add\s+sections?|write|draft|compose|essay|author|type|title|content|share|include)\b/i.test(
      step,
    ) &&
    !/\b(open|click|read|view)\b.{0,40}\b(email|e-mail|mail|message|thread)\b/i.test(step);
  if (createOrFillStep) {
    // Only gaps relevant to THIS step block it — a pure write step is not
    // blocked by a later share step's outstanding gap.
    const stepWantsShare = isShareInviteGoal(step) || /\b(share|send|invite)\b/i.test(step);
    const blockingGapRe = stepWantsShare
      ? /write|type|create|share|sign in|open share|home\/marketing/i
      : /write|type|create|sign in|home\/marketing/i;
    if (fullGaps.some((g) => blockingGapRe.test(g))) {
      return false;
    }
    if (
      !deliverableContentReady(fullAsk || step, {
        url,
        pageText,
        history,
      })
    ) {
      return false;
    }
    // Content is actually ready for this create/write step.
    return true;
  }

  if (!fullGaps.length) return true;

  const shareOnlyStep =
    isShareInviteGoal(step) &&
    !/\b(write|draft|compose|essay|author|paper|write\s+out|create|fill)\b/i.test(step);
  if (shareOnlyStep) {
    return !fullGaps.some((g) => /share|send/i.test(g));
  }

  const writeOnlyStep =
    /\b(write|draft|compose|essay|author|paper|write\s+out|fill|add\s+sections?)\b/i.test(step) &&
    !isShareInviteGoal(step);
  if (writeOnlyStep) {
    return !fullGaps.some((g) => /write|type|create/i.test(g));
  }

  // Open-only step while we're already on a real page for the ask.
  // Never treat "open the first email" as done just because inbox loaded.
  if (
    /^(?:please\s+|can\s+you\s+)?(?:open|go\s+to|visit|pull\s+up|navigate\s+to)\b/i.test(step) &&
    !looksLikeOpenMailItem(step) &&
    !/\b(open|read|view|click)\b.{0,48}\b(email|e-mail|mail|message|thread)\b/i.test(step) &&
    !askStillNeedsAdaptiveWork(step) &&
    /^https?:\/\//i.test(url) &&
    !isPlaceholderAgentUrl(url) &&
    !/google\.com\/search/i.test(url)
  ) {
    return true;
  }

  return false;
}

/**
 * Re-check the ORIGINAL user ask against the live page between adaptive rounds.
 * Stops "check my ads" from clicking 1–2 times after the dashboard is already open.
 * Returns false while any part of a multi-step ask is still unmet.
 */
function userAskSatisfiedOnPage(
  goal,
  { url = "", pageText = "", title = "", history = [], sawScreenChange = false } = {},
) {
  const unmet = unmetBrowseAskRequirements(goal, {
    url,
    pageText,
    title,
    history,
    sawScreenChange,
  });
  if (unmet.length > 0) return false;

  if (
    looksBrowseGoalSatisfied(goal, {
      url,
      pageText,
      title,
      history,
    })
  ) {
    return true;
  }

  // Inspect/review with no unmet gaps ⇒ done.
  if (looksLikeInspectOrReviewAsk(goal)) return true;

  // Multi-step / work asks: unmet empty means every asked part has evidence.
  if (looksLikeMultiStepBrowseGoal(goal) || askStillNeedsAdaptiveWork(goal)) {
    return true;
  }

  return false;
}

/** Goal phases that must be evidenced before accepting planner done. */
function extractBrowseGoalPhases(goal) {
  const g = String(goal || "").toLowerCase();
  const phases = [];
  if (/\b(go\s+to|open|visit|pull\s+up|navigate|launch|load)\b/.test(g)) {
    phases.push("open");
  }
  if (/\b(find|search|look\s*up|locate|browse\s+for)\b/.test(g)) {
    phases.push("find");
  }
  if (
    /\b(click|tap|press|select|choose|pick|play|watch|start|type|fill|write|draft|edit|answer|compose|reply)\b/.test(
      g,
    )
  ) {
    phases.push("act");
  }
  if (/\b(submit|send|share|invite|post|publish)\b/.test(g)) {
    phases.push("submit");
  }
  if (
    /\b(complete|finish|solve|work\s+through|entire|whole|all (of )?(it|them|the)|keep going|go through|do the rest)\b/.test(
      g,
    ) ||
    /\b(quiz|exercise|lesson|practice|form|survey)\b/.test(g)
  ) {
    phases.push("finish");
  }
  // Compound asks without a clear finish verb still need an act+finish gate.
  if (!phases.length && /\b(and|then|after)\b/.test(g)) {
    phases.push("act", "finish");
  }
  return phases;
}

/** Hosts that exist only to authenticate: login.*, accounts.*, auth.*, sso.*. */
const AUTH_HOST_RE =
  /^(?:login|log-in|signin|sign-in|accounts?|auth|oauth|sso|identity)\./i;

/** Paths that exist only to authenticate. */
const AUTH_PATH_RE =
  /^\/(login|log-in|signin|sign-in|sign_in|signup|sign-up|sign_up|register|oauth|sso|auth|session\/new)(\/|$)/i;

/**
 * The page's only purpose is signing in.
 *
 * Worth stating as its own idea because the wording of a sign-in page and the
 * wording of a marketing page overlap almost completely — both say "log in" and
 * "sign up" — so text alone cannot separate them. The address can: nobody puts
 * their product pitch on login.example.com.
 */
function looksLikeAuthUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    const host = parsed.hostname.replace(/^www\./i, "");
    const path = (parsed.pathname || "/").replace(/\/+$/, "") || "/";
    return AUTH_HOST_RE.test(host) || AUTH_PATH_RE.test(path);
  } catch {
    return false;
  }
}

function looksLikeMarketingOrHomeUrl(url, pageText = "") {
  const u = String(url || "");
  const t = String(pageText || "").toLowerCase();
  // A sign-in host is never a landing page, whatever its path looks like.
  // Without this, login.mailchimp.com/ is "shallow" (its path is "/") and its
  // form says "log in" and "sign up", so it scores as marketing — which tells
  // the agent to click its way past a wall it should be waiting at, and hides
  // the sign-in from the detector that knows how to hand it to the user.
  if (looksLikeAuthUrl(u)) return false;
  try {
    const parsed = new URL(u);
    const path = (parsed.pathname || "/").replace(/\/+$/, "") || "/";
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const shallow =
      path === "/" ||
      path === "/home" ||
      path === "/en" ||
      path === "/us" ||
      /^\/(product|products|templates?|pricing|enterprise|customers|features|download|desktop|mobile|login|signup|sign-in|sign-up)(\/|$)/i.test(
        path,
      );
    if (shallow) {
      if (
        /\b(get started|sign up|log in|create account|learn more|watch demo|for business|pricing|templates?|free forever|try (it )?free|download)\b/.test(
          t,
        ) ||
        /^(google\.com|microsoft\.com|apple\.com|amazon\.com|notion\.so|notion\.site|canva\.com|figma\.com|dropbox\.com|airtable\.com|miro\.com|asana\.com|trello\.com|slack\.com|business\.reddit\.com|ads\.reddit\.com|reddit\.com)$/i.test(
          host,
        )
      ) {
        return true;
      }
      // Shallow path with little app chrome → treat as landing.
      if (t.length < 80) return true;
    }
  } catch {
    /* ignore */
  }
  return /google\.com\/search|youtube\.com\/results|bing\.com\/search/i.test(u);
}

/**
 * Detect blockers that require the USER (not more clicking): sign-in, paywall,
 * captcha, permission prompts. Used to pause and wait instead of faking Done.
 * Includes a concrete `userAction` so the user knows the bare-minimum step.
 */
function detectBrowseBlocker({ url = "", pageText = "", title = "" } = {}) {
  const u = String(url || "");
  const t = String(pageText || "");
  const titleL = String(title || "");
  let host = "this site";
  try {
    host = new URL(u).hostname.replace(/^www\./i, "") || host;
  } catch {
    /* ignore */
  }

  // A marketing/landing page is never a wall. Its copy overlaps both the
  // sign-in and paywall detectors almost perfectly — "Log In", "Sign Up
  // Free", "Upgrade", "Pricing", "Try free" — but on a public homepage those
  // are invitations, not barriers, and parking the run there handed tasks
  // back to users whose session was live one navigation away ("go to
  // mailchimp.com and…" died on mailchimp.com's own front page, twice, as
  // "sign-in" once and "paywall" once). looksLikeMarketingOrHomeUrl is
  // auth-host aware, so a real login.* or /signin page can never take this
  // exit.
  const onMarketingPage = looksLikeMarketingOrHomeUrl(u, t);

  if (!onMarketingPage && looksLikeSignInWall({ url: u, text: t, title: titleL })) {
    const userAction = describeSignInUserAction({ url: u, pageText: t, title: titleL, host });
    const note = signInPageThirdPartyNote({ pageText: t, title: titleL, url: u });
    return {
      kind: "signin",
      label: "Needs sign-in",
      userAction,
      note,
      message: formatUserHelpBrief({
        userAction,
        host,
        kind: "signin",
        note,
      }),
    };
  }
  // Signed-in app surfaces (inbox, docs/canvas editors) show USER CONTENT —
  // email subjects/snippets and document text routinely contain "captcha",
  // "security check", "upgrade to pro", "allow notifications", etc. Never
  // read blockers out of user content; only sign-in walls (handled above,
  // with their own evidence rules) apply there.
  const onSignedInMail = looksLikeSignedInMailUrl(u);
  const onSignedInApp = onSignedInMail || looksLikeCanvasEditorUrl(u);
  const compactBody = t.replace(/\s+/g, " ").trim();
  // Real captcha / interstitial walls are sparse pages, not full apps.
  const sparsePage = compactBody.length <= 2000;

  if (!onSignedInMail && !onMarketingPage && looksLikePaywall({ url: u, text: t, title: titleL })) {
    const userAction =
      `Clear the upgrade/paywall on **${host}** in the agent browser ` +
      `(upgrade, dismiss, or switch account) — leave me on the page after.`;
    return {
      kind: "paywall",
      label: "Needs upgrade / paywall",
      userAction,
      message: formatUserHelpBrief({ userAction, host, kind: "paywall" }),
    };
  }
  {
    const captchaTitleHit =
      /\b(captcha|attention required|just a moment|verify you are human|are you a robot|security check|unusual traffic)\b/i.test(
        titleL,
      );
    const captchaBodyHit =
      /\b(i('m| am) not a robot|verify (?:that )?you(?:'re| are) (?:a )?human|complete the (?:security check|captcha)|checking your browser|detected unusual traffic|press and hold|hcaptcha|recaptcha)\b/i.test(
        t,
      );
    if (!onSignedInApp && sparsePage && (captchaTitleHit || captchaBodyHit)) {
      const userAction =
        `Complete the captcha / human check in the agent browser tab on **${host}** ` +
        `(check the box or solve the puzzle), then leave the tab open.`;
      return {
        kind: "captcha",
        label: "Needs captcha / human check",
        userAction,
        message: formatUserHelpBrief({ userAction, host, kind: "captcha" }),
      };
    }
  }
  if (
    !onSignedInApp &&
    /\b(allow (notifications|camera|microphone|location)|permission (required|denied)|blocked (pop-?ups|cookies)|enable cookies)\b/i.test(
      t,
    )
  ) {
    const userAction =
      `Click **Allow** (or dismiss) the permission/cookie prompt in the agent browser on **${host}**.`;
    return {
      kind: "permission",
      label: "Needs permission",
      userAction,
      message: formatUserHelpBrief({ userAction, host, kind: "permission" }),
    };
  }
  return null;
}

/** One concrete thing the user must do on a sign-in screen. */
function describeSignInUserAction({ url = "", pageText = "", title = "", host = "this site" } = {}) {
  const t = `${title}\n${pageText}`.toLowerCase();
  if (/\b(2-?step|two-?factor|verification code|authenticator|enter (the )?code|approve (the )?sign-?in|check your (phone|device))\b/i.test(t)) {
    return `Enter the verification / 2FA code for **${host}** in the agent browser (or approve the sign-in on your phone).`;
  }
  if (/\b(choose an account|pick an account|select (an )?account|use another account)\b/i.test(t)) {
    return `Pick your account in the chooser in the agent browser for **${host}**.`;
  }
  if (/\bpassword\b/i.test(t) && !/\b(forgot password|reset password)\b/i.test(t)) {
    return `Type your **password** for **${host}** in the agent browser (field should be ready), then press Enter / Sign in.`;
  }
  if (/\b(email|phone|username)\b/i.test(t) && !/\bpassword\b/i.test(t)) {
    return `Enter your email/username for **${host}** in the agent browser, then click Next — I'll take the next step after that.`;
  }
  return `Finish signing in to **${host}** in the agent browser tab (I'll continue automatically when you're in).`;
}

/**
 * Google refuses its OAuth flow in embedded/desktop-shell browsers on more
 * than the UA string, so "Continue with Google" can silently no-op even with
 * popups allowed. When a sign-in page offers it, point at the path that works.
 */
function signInPageThirdPartyNote({ pageText = "", title = "", url = "" } = {}) {
  const t = `${title}\n${pageText}`.toLowerCase();
  if (
    /\b(this browser or app may not be secure|couldn'?t sign you in|try using a different browser|disallowed_useragent)\b/.test(
      t,
    )
  ) {
    return (
      `_Google refused this sign-in because it happened inside an app browser. ` +
      `Go back and sign in with **email + password** instead — that path works here._`
    );
  }
  const offersGoogle =
    /\b(continue with google|sign in with google|log in with google|google sign-?in)\b/.test(
      t,
    ) || /accounts\.google\./i.test(String(url || ""));
  if (!offersGoogle) return "";
  if (/\b(password|email|username)\b/.test(t)) {
    return (
      `_If **Continue with Google** doesn't respond, use your email + password here — ` +
      `Google restricts its sign-in button inside app-embedded browsers._`
    );
  }
  return (
    `_Google restricts its sign-in button inside app-embedded browsers. If it ` +
    `won't open, use the email/password option instead._`
  );
}

/**
 * Short, specific "needs you" brief — one action, bare minimum for the user.
 */
function formatUserHelpBrief({
  userAction = "",
  host = "",
  kind = "blocked",
  alreadyDone = [],
  stillTodo = [],
  note = "",
} = {}) {
  const action = String(userAction || "").trim() ||
    "Take the next step in the agent browser tab.";
  const done = (Array.isArray(alreadyDone) ? alreadyDone : [])
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .slice(0, 6);
  const todo = (Array.isArray(stillTodo) ? stillTodo : [])
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .slice(0, 6);
  // Sign-in / captcha / paywall walls are watched live, so lead with the fact
  // that the run is paused and self-resuming — "say continue" as an escape
  // hatch, never as the instruction.
  const watched =
    kind === "signin" ||
    kind === "captcha" ||
    kind === "paywall" ||
    kind === "permission";
  const auto =
    kind === "signin"
      ? `**I'm paused and watching this tab.** The moment you're signed in I pick the task back up on my own — you don't have to tell me. (Stuck? Say **"continue"**.)`
      : watched
        ? `**I'm paused and watching this tab.** Say **"continue"** once it's clear and I'll finish the rest.`
        : `When that's done, say **"continue"** and I'll finish the rest.`;
  return [
    watched ? `## Waiting for you` : `## Needs you — 1 step`,
    ``,
    watched ? `**Waiting on you to:** ${action}` : `**Please:** ${action}`,
    ``,
    auto,
    note ? `\n${String(note).trim()}` : "",
    done.length ? `\nAlready done:\n${done.map((s) => `- ${s}`).join("\n")}` : "",
    todo.length
      ? `\nI'll finish the moment you're done:\n${todo.map((s) => `- ${s}`).join("\n")}`
      : "",
    host && kind === "signin" ? `\n_Tab: ${host}_` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Click/type everything the agent CAN before asking the user.
 * Goal: leave the user with a single bare-minimum action (password, 2FA, etc.).
 */
async function advanceTowardUserGate(
  webContents,
  { goal = "", history = [], maxSteps = 5 } = {},
) {
  const taken = [];
  if (!webContents || webContents.isDestroyed?.()) {
    return {
      advanced: false,
      actionsTaken: taken,
      blocker: null,
      userAction: "Open the agent browser tab and continue from where it left off.",
    };
  }

  const emails = String(goal || "").match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || [];
  const primaryEmail = emails[0] || "";
  // Clicking the same control twice on the same page is never progress — the
  // first click either worked or the control does not do what we hoped. Tracking
  // this keeps a stall from being reported to the user as five identical
  // actions, which reads as thrashing and tells them nothing about what to do.
  const spentClicks = new Set();
  // Dead addresses already landed on, so backing out cannot offer one of them
  // again and bounce the run between two 404s.
  const deadUrlsSeen = [];

  for (let step = 0; step < maxSteps; step += 1) {
    let page = { url: "", text: "", title: "" };
    try {
      await waitForDomSettle(webContents, 400);
      page = await getPageContext(webContents);
    } catch {
      break;
    }
    const url = page.url || webContents.getURL?.() || "";
    const text = String(page.text || "");
    const title = String(page.title || "");
    const blocker = detectBrowseBlocker({ url, pageText: text, title });

    // A dead link is not something the user can fix by clicking. Left alone this
    // loop reads the goal, sees "create", and asks them to "click New page /
    // Create / Blank" on a 404 that has no such control — the same shape of
    // nonsense as asking for a password on a marketing page. Route around it.
    const dead = deadEndPage.looksLikeDeadEnd({ title, visibleText: text });
    if (dead.deadEnd) {
      // Structural backout only. Where to go from the page that loads is
      // decided by that page's own links — the marketing/home branch below
      // clicks its "Log in" — never by a table of app addresses.
      const back = deadEndPage.backoutTarget(url, { avoid: deadUrlsSeen });
      deadUrlsSeen.push(url);
      if (back) {
        const nav = await navigate(webContents, back.url).catch(() => null);
        if (nav?.ok) {
          taken.push(`Left a dead link and opened ${back.what}`);
          continue;
        }
      }
      // Nothing left up this route — say what is actually wrong, rather than
      // naming a button that isn't on screen.
      return {
        advanced: taken.length > 0,
        actionsTaken: taken,
        blocker: null,
        userAction:
          `That address is a dead end (${dead.reason}) and I could not find a working page ` +
          `above it. Open the right page for this task in the agent browser and I'll carry on.`,
        label: "Needs you",
        message: formatUserHelpBrief({
          userAction:
            `That address is a dead end (${dead.reason}) and I could not find a working page ` +
            `above it. Open the right page for this task in the agent browser and I'll carry on.`,
          kind: "stuck",
          alreadyDone: taken,
        }),
      };
    }

    // Marketing / home with create goal → click into app / Log in.
    if (
      looksLikeMarketingOrHomeUrl(url, text) &&
      askStillNeedsAdaptiveWork(goal)
    ) {
      const hints = [
        "Log in",
        "Sign in",
        "Continue with Google",
        "Get started",
        "Get Notion free",
        "New page",
        "Create",
      ];
      let clicked = false;
      for (const hint of hints) {
        const spendKey = `${url}|${hint}`;
        if (spentClicks.has(spendKey)) continue;
        const hit = await clickInPageByHint(webContents, { hint });
        if (hit?.ok) {
          spentClicks.add(spendKey);
          taken.push(`Clicked “${hit.label || hint}”`);
          clicked = true;
          break;
        }
      }
      if (clicked) continue;
    }

    // Permission / cookie prompt → clear it ourselves. The sweeper reads the
    // actual banner rather than guessing at three label names, and it will not
    // click a "Manage preferences" that only swaps one wall for a deeper one.
    if (blocker?.kind === "permission") {
      const swept = await dismissOverlays(webContents, { maxDismissals: 2 }).catch(() => null);
      if (swept?.dismissed?.length) {
        for (const d of swept.dismissed) taken.push(`Dismissed the ${d.what}`);
        continue;
      }
      const hit =
        (await clickInPageByHint(webContents, { hint: "Allow" })) ||
        (await clickInPageByHint(webContents, { hint: "Accept" })) ||
        (await clickInPageByHint(webContents, { hint: "I agree" }));
      if (hit?.ok) {
        taken.push(`Clicked “${hit.label || "Allow"}”`);
        continue;
      }
      return {
        advanced: taken.length > 0,
        actionsTaken: taken,
        blocker,
        userAction: blocker.userAction,
        label: blocker.label,
        message: formatUserHelpBrief({
          userAction: blocker.userAction,
          kind: blocker.kind,
          alreadyDone: taken,
        }),
      };
    }

    // Captcha → try the checkbox once.
    if (blocker?.kind === "captcha") {
      const hit =
        (await clickInPageByHint(webContents, { hint: "I'm not a robot" })) ||
        (await clickInPageByHint(webContents, { hint: "Verify" }));
      if (hit?.ok) {
        taken.push(`Clicked “${hit.label || "captcha"}”`);
        // Re-check — if still captcha, user must finish.
        await waitForDomSettle(webContents, 800).catch(() => {});
        const after = await getPageContext(webContents).catch(() => page);
        const still = detectBrowseBlocker({
          url: after.url || url,
          pageText: after.text || "",
          title: after.title || "",
        });
        if (still?.kind === "captcha") {
          return {
            advanced: true,
            actionsTaken: taken,
            blocker: still,
            userAction: still.userAction,
            label: still.label,
            message: formatUserHelpBrief({
              userAction: still.userAction,
              kind: "captcha",
              alreadyDone: taken,
            }),
          };
        }
        continue;
      }
      return {
        advanced: taken.length > 0,
        actionsTaken: taken,
        blocker,
        userAction: blocker.userAction,
        label: blocker.label,
        message: formatUserHelpBrief({
          userAction: blocker.userAction,
          kind: "captcha",
          alreadyDone: taken,
        }),
      };
    }

    // Sign-in: click SSO / Log in / Next; type email if we have it; stop at password/2FA.
    if (blocker?.kind === "signin" || looksLikeSignInPageText(text)) {
      const lower = text.toLowerCase();
      let openedSso = false;
      // Account chooser / Continue with Google — click it for the user.
      for (const hint of [
        "Continue with Google",
        "Sign in with Google",
        "Continue with Apple",
        "Continue with Microsoft",
        "Sign in with Apple",
        "Sign in with Microsoft",
        "Log in",
        "Sign in",
        "Next",
      ]) {
        // Don't click Next if password is already the ask — that's the user's step.
        if (/^next$/i.test(hint) && /\bpassword\b/i.test(lower)) break;
        const hit = await clickInPageByHint(webContents, { hint });
        if (hit?.ok) {
          taken.push(`Clicked “${hit.label || hint}”`);
          if (/google|apple|microsoft|sso|continue with/i.test(hint)) {
            openedSso = true;
          }
          await waitForDomSettle(webContents, openedSso ? 1100 : 700).catch(() => {});
          break;
        }
      }

      // Type email into login if visible and empty-ish (skip when an SSO popup is up).
      if (!openedSso && primaryEmail && /\b(email|phone|username)\b/i.test(lower)) {
        try {
          await clickInPageByHint(webContents, { hint: "Email" });
          const typed = await typeWithFocusRetry(webContents, {
            text: primaryEmail,
            hint: "Email",
            pressEnter: false,
            verifyNeedle: primaryEmail,
          });
          if (typed?.ok) {
            taken.push(`Entered email **${primaryEmail}**`);
            const next = await clickInPageByHint(webContents, { hint: "Next" });
            if (next?.ok) taken.push(`Clicked “${next.label || "Next"}”`);
            await waitForDomSettle(webContents, 800).catch(() => {});
          }
        } catch {
          /* ignore */
        }
      }

      const after = await getPageContext(webContents).catch(() => page);
      const afterBlocker = detectBrowseBlocker({
        url: after.url || url,
        pageText: after.text || "",
        title: after.title || "",
      });
      let host = "this site";
      try {
        host =
          new URL(after.url || url).hostname.replace(/^www\./i, "") || host;
      } catch {
        /* ignore */
      }
      let userAction =
        afterBlocker?.userAction ||
        describeSignInUserAction({
          url: after.url || url,
          pageText: after.text || "",
          title: after.title || "",
          host,
        });
      // SSO click opens a real popup — tell the user to finish there, not type a password on the parent tab.
      if (openedSso) {
        userAction = `Finish signing in in the **Sign in** popup that just opened for **${host}** (Google / Apple / Microsoft). It should be in front of Studio.`;
      }
      // If wall cleared, we're done advancing.
      if (!afterBlocker && !openedSso) {
        return {
          advanced: taken.length > 0,
          actionsTaken: taken,
          blocker: null,
          userAction: "",
          cleared: true,
        };
      }
      return {
        advanced: taken.length > 0,
        actionsTaken: taken,
        blocker: afterBlocker || blocker,
        userAction,
        label: (afterBlocker || blocker)?.label || "Needs sign-in",
        message: formatUserHelpBrief({
          userAction,
          host,
          kind: "signin",
          alreadyDone: taken,
        }),
      };
    }

    if (blocker) {
      return {
        advanced: taken.length > 0,
        actionsTaken: taken,
        blocker,
        userAction: blocker.userAction,
        label: blocker.label,
        message: formatUserHelpBrief({
          userAction: blocker.userAction,
          kind: blocker.kind,
          alreadyDone: taken,
        }),
      };
    }

    // No hard blocker — stuck on UI. Infer one specific next click for the user.
    break;
  }

  let page = { url: "", text: "", title: "" };
  try {
    page = await getPageContext(webContents);
  } catch {
    /* ignore */
  }
  const gaps = unmetBrowseAskRequirements(goal, {
    url: page.url || "",
    pageText: page.text || "",
    title: page.title || "",
    history,
  });
  const userAction = describeStuckUserAction({
    goal,
    gaps,
    url: page.url || "",
    pageText: page.text || "",
  });
  return {
    advanced: taken.length > 0,
    actionsTaken: taken,
    blocker: null,
    userAction,
    label: "Needs you",
    message: formatUserHelpBrief({
      userAction,
      kind: "stuck",
      alreadyDone: taken,
      stillTodo: gaps,
    }),
  };
}

/** Specific next click when the agent is stuck without a hard wall. */
function describeStuckUserAction({
  goal = "",
  gaps = [],
  url = "",
  pageText = "",
  title = "",
} = {}) {
  const g = String(goal || "").toLowerCase();
  const gap0 = String(gaps[0] || "").toLowerCase();
  const t = String(pageText || "").toLowerCase();
  let host = "this page";
  try {
    host = new URL(url).hostname.replace(/^www\./i, "") || host;
  } catch {
    /* ignore */
  }

  // Before anything about the goal: if the page itself is dead, every other ask
  // below names a control that is not on screen. The page is checked directly
  // and not just via the gap list, because the gap list is empty for a whole
  // class of goals (anything reading as an email task short-circuits it) and an
  // empty list is exactly what let the goal-derived "click New page / Create /
  // Blank" ask be written on top of a 404.
  const deadHere =
    /dead link/i.test(gap0) ||
    deadEndPage.looksLikeDeadEnd({ title, visibleText: pageText }).deadEnd;
  if (deadHere) {
    return `Open the page this task needs on **${host}** in the agent browser — the address I tried is a dead end — and I'll carry on from there.`;
  }
  if (/sign in/i.test(gap0) || /account dashboard/i.test(gap0)) {
    return `Sign in to **${host}** in the agent browser — I'll continue into your account right after.`;
  }
  if (/share|send/i.test(gap0) || isShareInviteGoal(goal)) {
    if (/\b(add people|share with|send invite)\b/i.test(t)) {
      return `In the open Share dialog, click **Send** / **Invite** (email should already be entered if I got that far).`;
    }
    return `Click **Share** on **${host}**, add the recipient, and click **Send** — or say **continue** after you do.`;
  }
  // Whatever the goal says, a page asking for a password needs a password. This
  // has to come before the create/marketing branch below, which otherwise reads
  // the word "home" in a gap like "get past the home/marketing page" and asks
  // for a "New page / Create / Blank" click that does not exist on a login form.
  //
  // A landing page is excluded: its nav has "Log in" and "Sign up" in it, which
  // is enough to read as a login form, and asking a signed-in user to sign in on
  // a marketing page is the one thing that must never happen here.
  if (
    (looksLikeSignInPageText(t) || looksLikeAuthUrl(url)) &&
    !(looksLikeMarketingOrHomeUrl(url, pageText) && !looksLikeAuthUrl(url))
  ) {
    return `Sign in to **${host}** in the agent browser — I'll pick it up the moment you're through.`;
  }
  if (/marketing|home page/i.test(gap0)) {
    return `Get into your **${host}** account in the agent browser (sign in, or click through to the dashboard) — I'll take it from there.`;
  }
  if (/create|write|type/i.test(gap0) || /\b(create|new page|write)\b/i.test(g)) {
    if (/\b(new page|add a page|blank|create)\b/i.test(t)) {
      return `Click **New page** / **Create** / **Blank** in the agent browser on **${host}** — I'll write and finish after that.`;
    }
    return `Get into a blank page/editor on **${host}** (New page / Create / Blank), then say **continue**.`;
  }
  if (gaps.length) {
    return `On **${host}**, do this one thing: **${gaps[0]}** — then say **continue** and I'll handle the rest.`;
  }
  return `Take the next click on **${host}** in the agent browser (whatever unlocks the task), then say **continue**.`;
}

/**
 * For create/write/fill asks: landing on a marketing/home page never counts
 * as the deliverable, regardless of site chrome text length.
 */
function deliverableContentReady(goal, { url = "", pageText = "", history = [] } = {}) {
  const g = String(goal || "").toLowerCase();
  const minChars = typedContentMinCharsForGoal(goal);
  const typed = historyHasTypedContent(history, { minChars });
  const body = pageShowsSubstantialDocBody(pageText, url);
  const landing = looksLikeMarketingOrHomeUrl(url, pageText);
  const wantsMutate =
    /\b(write|draft|compose|create|make|fill|type|add sections?|edit|build)\b/.test(g) ||
    (/\b(new|start)\b/.test(g) && /\b(page|doc|document|note|sheet|deck|presentation)\b/.test(g));
  if (!wantsMutate) return body || historyHasTypedContent(history, { minChars: 2 });
  if (landing) return false;
  // Docs/Sheets home is never a finished essay — require real editor body or
  // enough typed/pasted characters for this kind of ask.
  if (/docs\.google\.com\/document\/u\/\d+\/?$/i.test(String(url || ""))) return false;
  // Prefer evidence we actually typed; otherwise require a real non-landing body.
  // A shorter successful write that the page visibly echoes also counts —
  // never demand a rewrite of content that already landed.
  return typed || body || historyTypedContentVisibleOnPage(history, pageText);
}

/**
 * Evidence that required goal phases are covered by URL / history / page text.
 */
function browseGoalPhasesEvidence(
  goal,
  { url = "", pageText = "", history = [], sawScreenChange = false } = {},
) {
  const phases = extractBrowseGoalPhases(goal);
  const hist = Array.isArray(history) ? history : [];
  const missing = [];
  const u = String(url || "");
  const okUi = hist.filter(
    (h) =>
      h?.result?.ok &&
      /^(?:click|tap|press_click|click_coord|tap_coord|os_write|write|type|fill|press|click_type)$/i.test(
        String(h?.action?.type || ""),
      ),
  );
  const shareGoal = isShareInviteGoal(goal);
  const exerciseGoal =
    /\b(quiz|exercise|lesson|practice|complete it|finish it|work\s+through|entire thing)\b/i.test(
      String(goal || ""),
    ) ||
    /\b(complete|finish|solve|take|answer)\b.{0,40}\b(quiz|exercise|lesson|practice|test|exam|form)\b/i.test(
      String(goal || ""),
    );
  const emails = String(goal || "").match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || [];

  for (const phase of phases) {
    if (phase === "open") {
      if (
        !/^https?:\/\//i.test(u) ||
        isPlaceholderAgentUrl(u) ||
        /google\.com\/search|bing\.com\/search|youtube\.com\/results/i.test(u)
      ) {
        missing.push("open");
      }
    } else if (phase === "find") {
      const leftLanding =
        /^https?:\/\//i.test(u) &&
        !looksLikeMarketingOrHomeUrl(u, pageText) &&
        !/google\.com\/search|youtube\.com\/results/i.test(u);
      const searched = hist.some((h) => {
        const t = String(h?.action?.type || "").toLowerCase();
        return (
          h?.result?.ok &&
          (t === "type" || t === "fill" || t === "os_write" || t === "click_type" || t === "navigate")
        );
      });
      const clickedResult = okUi.length >= 1 && leftLanding;
      if (!leftLanding && !searched && !clickedResult) missing.push("find");
    } else if (phase === "act") {
      const writeGoal =
        /\b(write|draft|compose|essay|author|paper|write\s+out)\b/i.test(
          String(goal || ""),
        ) ||
        (/\bfill\b/i.test(String(goal || "")) &&
          /\b(form|doc|document|sheet|field)\b/i.test(String(goal || "")));
      const mailThreadOpen =
        looksLikeOpenMailItem(goal) &&
        /mail\.google\.com/i.test(u) &&
        /(?:#|\/)(?:inbox|all|sent|drafts|starred|important|snoozed|label\/[^/]+)\/[A-Za-z0-9]+/i.test(
          u,
        );
      if (mailThreadOpen) {
        // Opening the thread counts as the asked click.
      } else if (writeGoal) {
        if (
          !historyHasTypedContent(hist) &&
          !pageShowsSubstantialDocBody(pageText, u)
        ) {
          missing.push("act");
        }
      } else if (okUi.length < 1) {
        missing.push("act");
      }
    } else if (phase === "submit") {
      if (shareGoal) {
        const done = shareInviteSatisfied(goal, pageText, hist);
        if (!done) missing.push("submit");
      } else {
        const submitted = hist.some((h) => {
          const lab = String(h?.action?.label || "").toLowerCase();
          return (
            h?.result?.ok &&
            /\b(submit|send|publish|post|share|invite|done|continue|next)\b/i.test(lab)
          );
        });
        if (!submitted && !pageShowsExerciseComplete(pageText)) missing.push("submit");
      }
    } else if (phase === "finish") {
      if (shareGoal) {
        const done = shareInviteSatisfied(goal, pageText, hist);
        if (!done) missing.push("finish");
      } else if (exerciseGoal) {
        if (!pageShowsExerciseComplete(pageText)) missing.push("finish");
      } else {
        // General multi-step: landing + a couple clicks is NOT enough.
        // Require real progress off marketing/home and either typed content
        // (when writing) or several verified UI acts with a screen change.
        const writeGoal = /\b(write|draft|compose|essay|author|fill)\b/i.test(
          String(goal || ""),
        );
        if (writeGoal && !historyHasTypedContent(hist)) {
          missing.push("finish");
        } else if (looksLikeMarketingOrHomeUrl(u, pageText)) {
          missing.push("finish");
        } else if (okUi.length < 2 || (!sawScreenChange && okUi.length < 4)) {
          missing.push("finish");
        }
      }
    }
  }

  return { ok: missing.length === 0, missing, phases };
}

/** Reject planner done while WORKING PLAN still lists unfinished LATER / Final CHECK. */
function taskPlanBlocksDone(taskPlan, goal) {
  const g = String(goal || "");
  if (
    !looksLikeMultiStepBrowseGoal(g) &&
    !/\b(share|invite|quiz|complete|finish|submit|fill|work\s+through)\b/i.test(g)
  ) {
    return false;
  }
  const plan = String(taskPlan || "");
  if (!plan.trim()) return true;
  const laterSection = (plan.match(/LATER:[\s\S]*/i) || [""])[0];
  const laterBody = laterSection.replace(/Final CHECK:[\s\S]*/i, "");
  const pending = laterBody
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*•]/.test(l) || /^when\b/i.test(l));
  const stillOpen = pending.filter(
    (l) => !/\b(done|✓|✔|completed|finished|skipped|n\/a)\b/i.test(l),
  );
  if (stillOpen.length > 0) return true;
  if (
    /Final CHECK:/i.test(plan) &&
    !/Final CHECK:\s*.*\b(done|met|confirmed|satisfied|success|visible)\b/i.test(plan)
  ) {
    return true;
  }
  return false;
}

function pageShowsExerciseComplete(text) {
  return /you('ve| have) (finished|completed)|great work|nice work|way to go|unit complete|lesson complete|practice complete|exercise complete|all done|no more questions|course challenge complete|mastery|congratulations|keep practicing|review lesson|points earned|skill (mastered|completed)|show summary|you got \d|100%|perfect score|end of (the )?(quiz|exercise|practice)|quiz complete|test complete|submitted successfully|response recorded|thank you for (completing|submitting)/i.test(
    String(text || ""),
  );
}

/**
 * True only when a share/invite actually completed — NOT when the Share dialog
 * is merely open. Google Docs always shows "People with access" in the dialog,
 * so that phrase must never count as success by itself.
 */
function pageShowsShareInviteComplete(text, email = "") {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  const strong =
    /\b(access updated|invitation sent|invite sent|invite has been sent|notification sent|shared with|was shared|successfully shared|person added|people added|added as (an? )?(editor|viewer|commenter)|has been invited|invite delivered)\b/i.test(
      t,
    );
  // Post-send "notify people / message optional" sheet means the invite already went out.
  const postSendSheet =
    /\b(message \(optional\)|add a message|notify people|send notification|email notification)\b/i.test(
      t,
    ) && !/\badd people and groups\b/i.test(t);
  if (!strong && !postSendSheet) return false;
  const e = String(email || "")
    .trim()
    .toLowerCase();
  if (!e) return true;
  // Post-send sheets sometimes omit the address — still count if we already typed/sent it.
  if (postSendSheet && !t.includes(e)) return true;
  return t.includes(e);
}

/** History evidence: typed recipient + clicked dialog Send successfully. */
function historyShowsShareSendDone(history, emails = []) {
  const hist = Array.isArray(history) ? history : [];
  const list = (Array.isArray(emails) ? emails : [])
    .map((e) => String(e || "").trim().toLowerCase())
    .filter(Boolean);
  const typed = hist.some((h) => {
    const t = String(h?.action?.type || "").toLowerCase();
    const val = String(h?.action?.value || h?.action?.text || "").trim().toLowerCase();
    if (!h?.result?.ok || !/^(?:os_write|write|type|fill|insert|click_type)$/i.test(t) || !val) {
      return false;
    }
    if (!list.length) return val.includes("@");
    return list.some((e) => val === e || (val.includes(e) && val.length <= e.length + 12));
  });
  const sent = hist.some((h) => {
    const lab = String(h?.action?.label || "").toLowerCase();
    const via = String(h?.result?.via || "").toLowerCase();
    return (
      h?.result?.ok &&
      (via === "share_dialog_send" ||
        /^send(\s+invite)?$/i.test(lab.trim()) ||
        /\bsend\s+invite\b/i.test(lab))
    );
  });
  return typed && sent;
}

function pageShowsShareDialogOpen(text) {
  const t = String(text || "").toLowerCase();
  // Post-send "notify / message" sheets are NOT the invite dialog still being open.
  if (
    /\b(message \(optional\)|add a message|send notification)\b/i.test(t) &&
    !/\badd people\b/i.test(t)
  ) {
    return false;
  }
  return (
    /\b(add people|people and groups|share with people|who do you want to share|send invite)\b/i.test(
      t,
    ) ||
    (/\b(editor|viewer|commenter)\b/i.test(t) &&
      /\b(people with access|pending invites?|enter names|names or email)\b/i.test(t))
  );
}

function pageShowsShareEmailEntered(text, email) {
  const e = String(email || "")
    .trim()
    .toLowerCase();
  if (!e) return false;
  const t = String(text || "").toLowerCase();
  if (!t.includes(e)) return false;
  // Require share-dialog chrome — doc body / essay text containing the email must NOT count.
  return pageShowsShareDialogOpen(t) || /\bpeople with access\b/i.test(t);
}

function looksLikeMultiStepBrowseGoal(goal) {
  const g = String(goal || "").toLowerCase();
  return (
    /\b(then|after that|and then|complete|finish|solve|fill|type|submit|all|every|entire|whole|quiz|exercise|lesson|practice|form|survey|work\s+through|keep going|go through|do the rest|all of it)\b/.test(
      g,
    ) ||
    /\band\s+(open|read|click|find|search|play|complete|finish|answer|take|do|fill|write|edit|share)\b/.test(
      g,
    ) ||
    isShareInviteGoal(goal) ||
    extractBrowseGoalPhases(goal).length >= 2
  );
}

/**
 * Seed a progressive WORKING PLAN from the user goal.
 * NOW is the immediate visible step; LATER lists concrete goal phases
 * (not a single stub) so done cannot fire until those phases clear.
 */
function seedProgressiveTaskPlan(goal) {
  const ask = String(goal || "").replace(/\s+/g, " ").trim().slice(0, 160);
  const share = isShareInviteGoal(ask);
  const write = /\b(write|draft|compose|type|essay|author|paper)\b/i.test(ask);
  const find = /\b(find|search|look\s*up|locate)\b/i.test(ask);
  const quiz =
    /\b(quiz|exercise|lesson|practice|form|survey)\b/i.test(ask) ||
    /\b(complete|finish|solve|work\s+through)\b/i.test(ask);
  const later = [];
  if (find) {
    later.push("When on the site: search/find the target destination — CHECK: left homepage/SERP for the right page");
  }
  if (write) {
    later.push("When the editor body is ready: enter the drafted content — CHECK: text in doc");
  }
  if (quiz) {
    later.push("When questions/controls are visible: answer/act through every step — CHECK: progress advances each time");
    later.push("When the last question/step is done: submit/finish if needed — CHECK: completion confirmation visible");
  }
  if (share) {
    later.push("When Share UI is open: add the recipient email — CHECK: email chip visible");
    later.push("When email chip is visible: click Send in the dialog — CHECK: invitation sent");
  }
  const phases = extractBrowseGoalPhases(ask);
  if (!later.length) {
    if (phases.includes("act")) {
      later.push("When the target control is visible: perform the asked click/type — CHECK: UI reacts");
    }
    if (phases.includes("submit")) {
      later.push("When ready to finish: submit/send/confirm — CHECK: success state visible");
    }
    if (phases.includes("finish") || looksLikeMultiStepBrowseGoal(ask)) {
      later.push("Keep using newly visible controls until every part of the user ask is done — CHECK: no remaining asked steps");
    }
  }
  if (!later.length) {
    later.push("Continue from newly visible controls until the full user ask is done — CHECK: goal satisfied on screen");
  }
  later.push("Final CHECK: success confirmation for the user ask is visible on screen");
  return (
    `WORKING PLAN (rewrite after every screen change — detail only what you can SEE):\n` +
    `DONE: (none yet)\n` +
    `NOW: On the current screen, take the single best click/type toward: ${ask || "the user goal"}\n` +
    `  CHECK: the UI advanced in a way that clearly helps the goal (new dialog/page/field)\n` +
    `LATER: (mark each line done only after its CHECK is true on screen)\n` +
    later.map((l) => `- ${l}`).join("\n")
  ).slice(0, 2000);
}

/** Pull a short status line from the NOW step of a progressive plan. */
function progressivePlanNowLine(taskPlan) {
  const m = String(taskPlan || "").match(/NOW:\s*([^\n]+)/i);
  return m ? String(m[1] || "").trim().slice(0, 120) : "";
}

/**
 * Honest "I need your help with a step" fallback for when the agent has
 * repeatedly failed or run out of ideas. Names the exact step it was on
 * (WORKING PLAN's NOW line when available) so the user can do that one
 * thing and say "continue" — never a vague "couldn't finish".
 */
function formatStuckNeedsHelp({ goal, taskPlan, history, reason = "" } = {}) {
  const nowLine = progressivePlanNowLine(taskPlan);
  const step = (nowLine || String(goal || "this task").trim()).slice(0, 160);
  const hist = Array.isArray(history) ? history : [];
  const lastFail = [...hist]
    .reverse()
    .find((h) => h?.result && h.result.ok === false);
  const failNote = lastFail
    ? `My last attempt — ${String(lastFail.action?.type || "action")}${
        lastFail.action?.label
          ? ` "${String(lastFail.action.label).slice(0, 60)}"`
          : ""
      } — failed (${String(lastFail.result?.error || "no effect").slice(0, 90)}).`
    : "";
  return [
    `I need your help with a step — I couldn't get past: **${step}**.`,
    [String(reason || "").trim(), failNote].filter(Boolean).join(" "),
    `Please do that one step in the agent browser tab, or tell me exactly what to click, then say **continue** and I'll finish the rest.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** True when the page/history already satisfies a simple browse goal — skip more LLM plan rounds. */
function looksBrowseGoalSatisfied(goal, { url = "", pageText = "", title = "", history = [] } = {}) {
  const g = String(goal || "").toLowerCase();
  const u = String(url || "");
  const hist = Array.isArray(history) ? history : [];
  // Share / invite goals: opening Share or typing the email is NOT done.
  // Done when invite confirmation / post-send UI is visible, OR we already
  // typed+Sent and the share dialog has closed (secondary screens are fine).
  if (isShareInviteGoal(goal)) {
    return shareInviteSatisfied(goal, pageText, hist);
  }
  // Quiz / exercise / multi-question goals: only done when the page shows completion.
  if (
    /\b(quiz|exercise|lesson|practice|questions?|complete it|finish it|work\s+through|entire thing)\b/.test(
      g,
    ) ||
    /\b(complete|finish|solve|take|answer)\b.{0,40}\b(quiz|exercise|lesson|practice|test|exam|form)\b/.test(
      g,
    )
  ) {
    return pageShowsExerciseComplete(pageText);
  }
  // Finish-in-tool goals: never done on home/gallery. Editor alone isn't done if they asked to write/fill.
  // If the same ask also includes share/invite, writing alone is never enough.
  if (
    /\b(create|make|build|design|draft|write|customize|edit|fill|compose|finish|notes?|jot)\b/.test(g) &&
    (/\b(inside|in the open|browser tab|working page|external tool)\b/.test(g) ||
      /\b(canva|figma|notion|powerpoint|excel|sheets|docs|resume|cv|presentation|deck|poster|logo|template)\b/.test(
        g,
      ))
  ) {
    if (isShareInviteGoal(goal)) {
      return shareInviteSatisfied(goal, pageText, hist);
    }
    const inEditor =
      /canva\.com\/design\//i.test(u) ||
      /figma\.com\/(file|design|proto|board)\//i.test(u) ||
      (/notion\.(so|site)\//i.test(u) && !/notion\.so\/?$/i.test(u)) ||
      /docs\.google\.com\/(document|spreadsheets|presentation)\/d\//i.test(u);
    if (!inEditor) return false;
    // Landing in the editor is not enough when the ask is to write/fill content.
    if (/\b(write|draft|fill|type|compose|author|content|paste|notes?|jot)\b/.test(g)) {
      const typed = hist.some((h) => {
        const t = String(h?.action?.type || "").toLowerCase();
        return (
          h?.result?.ok &&
          (t === "type" || t === "fill" || t === "paste" || t === "input" || t === "press")
        );
      });
      return typed && hist.length >= 2;
    }
    // "create/open an editor" style asks — editor + at least one successful act.
    return hist.some((h) => h?.result?.ok);
  }
  const okActs = hist.filter((h) => h?.result?.ok);
  const okClicks = okActs.filter((h) => {
    const t = String(h?.action?.type || "click").toLowerCase();
    return t === "click" || t === "tap" || t === "press_click" || t === "";
  });
  const multiPart = looksLikeMultiStepBrowseGoal(goal);
  const wantsMailItem =
    looksLikeOpenMailItem(goal) ||
    /\b(open|read|view)\b.{0,48}\b(email|e-mail|mail|message|thread)\b/.test(g);
  const wantsNthItem =
    /\b(first|second|third|top|\d+(st|nd|rd|th))\s+(email|message|result|link|video|one)\b/.test(g);

  // Opened a Gmail thread / message view (not just the inbox list).
  if (wantsMailItem || (wantsNthItem && /mail\.google\.com/i.test(u))) {
    return (
      /mail\.google\.com/i.test(u) &&
      /(?:#|\/)(?:inbox|all|sent|drafts|label\/[^/]+)\/[A-Za-z0-9]+/i.test(u)
    );
  }

  // Simple single click / open-link goals: one successful click is enough.
  // Never treat one click as done when the ask is clearly multi-step.
  if (okClicks.length >= 1 && /\b(click|tap|press|follow)\b/.test(g) && !multiPart && !wantsNthItem) {
    return true;
  }

  // Bare navigate/open-site goals (no follow-on act in the same ask).
  // Satisfied once we're on a real page — even if navigate happened outside this loop
  // (multi-step "open X" then next task shouldn't burn a plan-next LLM round).
  // Never treat empty pageText as enough when the ask still needs adaptive work.
  if (
    looksLikeBareOpenBrowseGoal(goal) &&
    !multiPart &&
    !wantsNthItem &&
    !askStillNeedsAdaptiveWork(goal) &&
    /^https?:\/\//i.test(u) &&
    !isPlaceholderAgentUrl(u) &&
    !urlMaybeNeedsAuthCheck(u) &&
    !/google\.com\/search/i.test(u) &&
    !/youtube\.com\/results/i.test(u) &&
    !looksLikeMarketingOrHomeUrl(u, pageText)
  ) {
    return true;
  }

  if (
    okActs.some((h) => /^(navigate|open)$/i.test(String(h?.action?.type || ""))) &&
    /\b(go\s+to|open|visit|pull\s+up|navigate)\b/.test(g) &&
    !multiPart &&
    !wantsNthItem &&
    !askStillNeedsAdaptiveWork(goal) &&
    !/\b(search|find|click|play|watch)\b/.test(g) &&
    /^https?:\/\//i.test(u)
  ) {
    return true;
  }

  void title;
  return false;
}

/**
 * Adaptive observe → plan → act loop against an owned webContents.
 * `planNext` is provided by main: async ({ goal, catalog, pageText, history }) => { done, answer, actions }
 */
async function executeOwnedAdaptiveTask({
  webContents,
  goal,
  planNext,
  onProgress,
  signal,
  maxRounds = 16,
  conversationHistory = [],
}) {
  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, error: "no_webcontents" };
  }
  const history = [];
  const convHistory = Array.isArray(conversationHistory)
    ? conversationHistory.slice(-8)
    : [];
  let answer = "";
  // Stall watch: same URL + same text across rounds means our actions are
  // doing nothing — escalate a hint to the planner, then bail honestly
  // instead of burning rounds on "step N browsing…".
  let lastRoundSig = "";
  let stalledRounds = 0;
  // Hung page loads: when a navigation sits loading past this long, force one
  // reload instead of scraping a blank page / burning rounds on "wait".
  let loadingSince = 0;
  let stallReloads = 0;
  let loadStallNote = "";
  // Set when a mid-round reload happens (in-page spinner) — carried into the
  // NEXT round's planner hint since that round starts with a fresh scrape.
  let pendingStallNote = "";
  // Progressive WORKING PLAN — rewritten each round from the visible screen.
  // Seed a skeleton so round 1 already has DONE/NOW/CHECK/LATER structure.
  let taskPlan = seedProgressiveTaskPlan(goal);
  // Holo pipeline continuity: keep the agent conversation + last tool result
  // across rounds so the planner remembers what it already did.
  let holoMessages = null;
  let lastToolName = null;
  let lastToolOutput = null;
  let lastActionDiff = "";
  // Once the goal is visibly satisfied, latch it — follow-up dialogs (notify,
  // message optional, etc.) must not erase success into a "stuck" ending.
  let sawGoalComplete = false;
  let completionAnswer = "";
  let sawScreenChange = false;
  // Small action models love to DESCRIBE the plan via their answer tool
  // instead of acting. Reject "done" until a real click/type has landed.
  let answerRejections = 0;
  let plannerFailures = 0;
  const multiStepGoal = looksLikeMultiStepBrowseGoal(goal);
  const effectiveMaxRounds = multiStepGoal
    ? Math.max(maxRounds, 28)
    : maxRounds;
  const inspectAsk = looksLikeInspectOrReviewAsk(goal);
  const finishIfGoalMet = (pageUrlNow, pageTextNow, pageTitleNow) => {
    // Never satisfy multi-step / work asks from URL alone with empty scrape.
    // Inspect/review may finish once the destination host is correct.
    if (
      !String(pageTextNow || "").trim() &&
      (multiStepGoal || askStillNeedsAdaptiveWork(goal)) &&
      !looksLikeBareOpenBrowseGoal(goal) &&
      !inspectAsk
    ) {
      return null;
    }
    const gaps = unmetBrowseAskRequirements(goal, {
      url: pageUrlNow,
      pageText: pageTextNow,
      title: pageTitleNow,
      history,
      sawScreenChange,
    });
    if (gaps.length) return null;
    const satisfied =
      sawGoalComplete ||
      userAskSatisfiedOnPage(goal, {
        url: pageUrlNow,
        pageText: pageTextNow,
        title: pageTitleNow,
        history,
        sawScreenChange,
      });
    if (!satisfied) return null;
    // Inspect/review: don't let a stale WORKING PLAN force extra clicks.
    if (
      !inspectAsk &&
      (multiStepGoal || askStillNeedsAdaptiveWork(goal)) &&
      taskPlanBlocksDone(taskPlan, goal) &&
      !pageShowsExerciseComplete(pageTextNow) &&
      !pageShowsShareInviteComplete(pageTextNow)
    ) {
      return null;
    }
    sawGoalComplete = true;
    const emails = String(goal || "").match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || [];
    answer =
      completionAnswer ||
      answer ||
      (emails[0]
        ? `Shared with **${emails[0]}** from this page.`
        : inspectAsk
          ? `You're on the page for this ask — **${pageTitleNow || pageUrlNow}**.`
          : `Done — ${pageTitleNow || pageUrlNow}`);
    completionAnswer = answer;
    return {
      ok: true,
      answer,
      history,
      url: pageUrlNow,
      satisfiedEarly: true,
      stuck: false,
    };
  };
  for (let round = 0; round < effectiveMaxRounds; round += 1) {
    if (signal?.aborted) return { ok: false, error: "aborted", answer, history };
    if (typeof onProgress === "function") {
      const nowLine = progressivePlanNowLine(taskPlan);
      onProgress({
        status: nowLine
          ? `Step ${round + 1}: ${nowLine}`
          : `Working on the page… step ${round + 1}`,
        round,
        url: webContents.getURL(),
        taskPlan: String(taskPlan || "").slice(0, 900),
        history,
      });
    }
    // Cheap URL check before heavy DOM scrape — bare "open X" only.
    const quickUrl = webContents.getURL?.() || "";
    if (
      looksLikeBareOpenBrowseGoal(goal) &&
      !multiStepGoal &&
      !askStillNeedsAdaptiveWork(goal)
    ) {
      const early = finishIfGoalMet(
        quickUrl,
        "",
        webContents.getTitle?.() || "",
      );
      if (early) return early;
    }
    // In-flight page load: give it a real chance to finish before scraping a
    // half-rendered page, and if it hangs past ~10s force one reload — slow
    // CDNs / dropped requests otherwise leave the agent staring at a spinner.
    loadStallNote = pendingStallNote;
    pendingStallNote = "";
    try {
      if (webContents.isLoading?.()) {
        if (!loadingSince) loadingSince = Date.now();
        await waitForLoad(webContents, 6000);
        if (
          webContents.isLoading?.() &&
          Date.now() - loadingSince > 10000 &&
          stallReloads < 2
        ) {
          stallReloads += 1;
          try {
            webContents.stop();
          } catch (_) {}
          await new Promise((r) => setTimeout(r, 200));
          try {
            webContents.reload();
          } catch (_) {}
          await waitForLoad(webContents, 12000);
          loadingSince = webContents.isLoading?.() ? Date.now() : 0;
          loadStallNote =
            "NOTE: the page stalled while loading and was just RELOADED. Look at the fresh screen state before acting; do not assume prior partial content is still there.";
        } else if (!webContents.isLoading?.()) {
          loadingSince = 0;
        }
      } else {
        loadingSince = 0;
      }
    } catch (_) {}
    const catalog = await getDOMCatalog(webContents);
    const page = await getPageContext(webContents);
    const pageText = String(page.text || "").slice(0, 9000);
    const pageUrl = page.url || webContents.getURL();
    const pageTitle = page.title || webContents.getTitle() || "";
    if (
      looksLikeSignInWall({
        url: pageUrl,
        text: pageText,
        title: pageTitle,
      })
    ) {
      return {
        ok: false,
        error: "sign_in_required",
        answer,
        history,
        url: pageUrl,
      };
    }
    // Don't ask the model again when the tab already shows the goal is met.
    {
      const doneNow = finishIfGoalMet(pageUrl, pageText, pageTitle);
      if (doneNow) return doneNow;
    }
    const isCanvasEditor = looksLikeCanvasEditorUrl(pageUrl);
    // Docs/Sheets/etc.: chrome text barely changes when you type — do NOT treat
    // a stable scrape as "page stopped responding". Only stall on repeated actions.
    // If the goal is already done, end successfully — never "stuck" after success.
    if (isCanvasEditor) {
      const recent = history.slice(-4);
      const keys = recent.map((h) => {
        const a = h?.action || {};
        return `${String(a.type || "")}|${String(a.label || a.value || a.text || "").slice(0, 48)}`;
      });
      const allSame = keys.length >= 4 && keys.every((k) => k && k === keys[0]);
      const allFailed = recent.length >= 4 && recent.every((h) => !h?.result?.ok);
      stalledRounds = allSame || allFailed ? 3 : 0;
      if (allSame || allFailed) {
        const doneStall = finishIfGoalMet(pageUrl, pageText, pageTitle);
        if (doneStall) return doneStall;
        return {
          ok: true,
          stuck: true,
          needsHelp: true,
          answer:
            answer ||
            formatStuckNeedsHelp({
              goal,
              taskPlan,
              history,
              reason:
                "This editor screen kept ignoring the same action no matter how I retried.",
            }),
          history,
          url: pageUrl,
        };
      }
    } else {
    const roundSig = `${pageUrl}|${pageText.slice(0, 500)}`;
    if (round > 0 && roundSig === lastRoundSig && history.length) {
      stalledRounds += 1;
    } else {
      stalledRounds = 0;
    }
    lastRoundSig = roundSig;
    if (stalledRounds >= 4) {
        const doneStall = finishIfGoalMet(pageUrl, pageText, pageTitle);
        if (doneStall) return doneStall;
      return {
        ok: true,
        stuck: true,
        needsHelp: true,
        answer:
          answer ||
          formatStuckNeedsHelp({
            goal,
            taskPlan,
            history,
            reason:
              "The page stopped responding to my actions — nothing I did changed the screen.",
          }),
        history,
        url: pageUrl,
      };
      }
    }

    // In-page spinner that never resolves (widget/dialog stuck on "Loading…"):
    // isLoading() is false so the top-of-round check can't see it. If the
    // screen hasn't changed for 2 rounds and a live spinner is visible,
    // reload the page — that unsticks most hung widgets.
    if (
      !isCanvasEditor &&
      stalledRounds >= 2 &&
      stallReloads < 2 &&
      (pageLooksStuckLoadingText(pageText) ||
        (await pageHasActiveSpinner(webContents)))
    ) {
      stallReloads += 1;
      try {
        webContents.reload();
      } catch (_) {}
      await waitForLoad(webContents, 12000);
      await waitForDomSettle(webContents, 900).catch(() => {});
      pendingStallNote =
        "NOTE: part of the page was stuck on a loading spinner, so it was just RELOADED. Re-read the fresh screen before acting; do not assume prior dialogs are still open.";
      stalledRounds = 0;
      lastRoundSig = "";
      continue;
    }

    // Safety fallback: several failed actions in a row means the agent is
    // messing up repeatedly — stop and ask the user for help with the current
    // step instead of thrashing until the round budget runs out.
    {
      const recent = history.slice(-5);
      if (
        recent.length >= 5 &&
        recent.every((h) => h?.result && h.result.ok === false)
      ) {
        const doneAnyway = finishIfGoalMet(pageUrl, pageText, pageTitle);
        if (doneAnyway) return doneAnyway;
        return {
          ok: true,
          stuck: true,
          needsHelp: true,
          answer: formatStuckNeedsHelp({
            goal,
            taskPlan,
            history,
            reason: "My last 5 actions in a row all failed to take effect.",
          }),
          history,
          url: pageUrl,
        };
      }
    }

    // Landing / marketing page + create/write goal: click an obvious CTA before
    // waiting on the planner (Log in / New page / Get started). Re-read next round.
    if (
      round <= 2 &&
      looksLikeMarketingOrHomeUrl(pageUrl, pageText) &&
      askStillNeedsAdaptiveWork(goal) &&
      !history.some(
        (h) =>
          h?.result?.ok &&
          /^(?:click|tap|press_click|click_coord|tap_coord)$/i.test(
            String(h?.action?.type || ""),
          ),
      )
    ) {
      const ctaHints = [
        "Log in",
        "Sign in",
        "New page",
        "Add a page",
        "Get Notion free",
        "Get started",
        "Create",
        "Start for free",
        "Continue with Google",
      ];
      let ctaHit = null;
      for (const hint of ctaHints) {
        try {
          const hit = await clickInPageByHint(webContents, { hint });
          if (hit?.ok) {
            ctaHit = { ...hit, hint };
            break;
          }
        } catch {
          /* try next */
        }
      }
      if (ctaHit?.ok) {
        history.push({
          action: {
            type: "click",
            label: ctaHit.label || ctaHit.hint,
          },
          result: { ok: true, via: "marketing_cta" },
          at: new Date().toISOString(),
        });
        lastToolName = "click";
        lastToolOutput = `Clicked "${ctaHit.label || ctaHit.hint}" on the landing page to get into the app.`;
        lastActionDiff =
          "Clicked a landing-page CTA — re-read the new screen and continue the USER GOAL.";
        try {
          await waitForDomSettle(webContents, 900);
        } catch {
          /* ignore */
        }
        continue;
      }
    }

    // On Docs write goals: after a couple of missed clicks, paste drafted content
    // directly into the document body instead of thrashing the planner.
    if (
      looksLikeGoogleDocsUrl(pageUrl) &&
      /\b(write|essay|draft|compose|type|author)\b/i.test(String(goal || "")) &&
      round >= 1 &&
      !history.some(
        (h) =>
          h?.result?.ok &&
          /^(?:os_write|write|type|fill|paste)$/i.test(String(h?.action?.type || "")),
      )
    ) {
      const draftMatch = String(goal || "").match(
        /DRAFTED CONTENT[^\n]*\n([\s\S]+?)(?:\n\n(?:FINISH|User ask|VERIFY|AFTER THE CONTENT|SHARE STEP)|$)/i,
      );
      let draft = sanitizeDraftedDocBody(String(draftMatch?.[1] || "").trim());
      if (!draft || draft.length < 40) {
        // Fall back: use a short seeded paragraph from the ask topic (never the send/share tail).
        const writeOnly = stripShareSendInstructions(goal);
        const topic =
          (String(writeOnly || "").match(
            /\b(?:essay|article|doc|document|paper)\s+(?:about|on|regarding)\s+(.+?)(?:\.|$)/i,
          ) || [])[1] || "";
        if (topic && !/@/.test(topic)) {
          draft = `${topic.trim()}\n\n`;
        }
      }
      if (draft.length >= 40) {
        const pasted = await pasteTextIntoPage(webContents, {
          text: draft.slice(0, 12000),
          replaceAll: false,
        });
        history.push({
          action: { type: "paste", label: "Document body" },
          result: pasted,
          at: new Date().toISOString(),
        });
        lastToolName = "write";
        lastToolOutput = pasted?.ok
          ? `Pasted ${pasted.chars || draft.length} chars into the document body.`
          : `Paste into document body failed (${pasted?.error || "unknown"}). Click docs_editor_body then write.`;
        lastActionDiff = pasted?.ok
          ? "Document body received pasted content (canvas may not show in DOM text)."
          : "Could not paste into document body yet.";
        if (pasted?.ok) {
          stalledRounds = 0;
        }
      }
    }
    let plan;
    try {
      plan = await planNext({
        goal,
        catalog: catalog.items || [],
        pageText,
        url: pageUrl,
        title: pageTitle,
        history,
        round,
        conversationHistory: convHistory,
        holoMessages,
        toolName: lastToolName,
        toolOutput: lastToolOutput,
        lastActionDiff,
        taskPlan,
        stuckHint: [
          loadStallNote,
          /NEW controls/i.test(String(lastActionDiff || ""))
            ? "The UI just advanced and NEW controls are listed in WHAT CHANGED. REWRITE the WORKING PLAN now: mark prior NOW as DONE if its CHECK passed, set NOW to the single best NEW control (Send/Next/Continue/field), keep LATER as placeholders. Do NOT re-click the previous button. Do NOT Cancel/Close/click outside."
            : "",
          taskPlan
            ? "Execute ONLY the WORKING PLAN's NOW step. Do not invent clicks for LATER screens. Do not dismiss dialogs unless NOW says so."
            : "",
          history.some((h) =>
            /type_no_effect|field_not_focused|typed_into_title|email_not_visible_after_type/i.test(
              String(h?.result?.error || ""),
            ),
          )
            ? "TYPING FAILED earlier — click INTO the input/textbox again (Add people / search / editor body), then write. Do not type without re-clicking the field."
            : "",
          isCanvasEditor
            ? stalledRounds >= 1
              ? "Editor screen: DOM text often does NOT change after typing. Click docs_editor_body / Document body (NOT the title), then write the full content. Do not repeat the same failed click."
              : "Google Docs/editor: click Document body (docs_editor_body), then use write with the essay text. Ignore unchanged chrome text."
            : stalledRounds >= 2
            ? `The page has NOT changed after your last ${stalledRounds} rounds of actions — the current approach is failing. Pick a DIFFERENT element (exact id from ELEMENTS), or a different path entirely (menu, keyboard shortcut, scroll, direct URL). Do not repeat any action from the history.`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      });
    } catch (e) {
      return { ok: false, error: e?.message || String(e), answer, history };
    }
    if (signal?.aborted) return { ok: false, error: "aborted", answer, history };
    if (plan?.holoMessages) holoMessages = plan.holoMessages;
    if (plan?.taskPlan) {
      taskPlan = String(plan.taskPlan).slice(0, 2000);
    }

    // Planner API/screenshot failures must NOT enter the "premature done" reject
    // loop — that burns minutes of Thinking… with zero clicks.
    const planActionsEarly = Array.isArray(plan?.actions) ? plan.actions : [];
    if (
      (plan?.plannerFailed || (plan?.stuck && !planActionsEarly.length && !plan?.done && !plan?.answer)) &&
      !planActionsEarly.length
    ) {
      plannerFailures += 1;
      if (plannerFailures >= 2) {
        return {
          ok: true,
          stuck: true,
          needsHelp: true,
          answer:
            String(plan?.answer || "").trim() ||
            formatStuckNeedsHelp({
              goal,
              taskPlan,
              history,
              reason:
                "I can see the page but couldn't figure out the next click after two tries.",
            }),
          history,
          url: webContents.getURL() || pageUrl,
          unmet: unmetBrowseAskRequirements(goal, {
            url: pageUrl,
            pageText,
            title: pageTitle,
            history,
            sawScreenChange,
          }),
        };
      }
      // One retry with a hard "click something visible" nudge.
      lastToolName = "plan";
      lastToolOutput =
        "PLANNING FAILED — return ONE concrete click/type on a visible control that advances the USER GOAL. Prefer Log in / Sign in / New page / Create / Get started if on a landing page.";
      lastActionDiff = "Planner returned no actions — must click something on this screen.";
      continue;
    }
    plannerFailures = 0;

    // An ACTION goal cannot be "done" before real UI work lands AND the page
    // shows evidence. Bounce narrated plans / premature finishes hard.
    const actionGoal =
      /\b(share|send|invite|type|write|fill|click|press|compose|submit|post|reply|upload|create|make|add|delete|rename|move|change|set|edit|complete|finish|solve|answer|take|work\s+through|quiz|exercise|lesson|practice)\b/i.test(
        String(goal || ""),
      );
    const actedOk = history.some(
      (h) =>
        h?.result?.ok &&
        /^(?:click|tap|press_click|click_coord|tap_coord|os_write|write|type|fill|press)$/i.test(
          String(h?.action?.type || ""),
        ),
    );
    const okActCount = history.filter(
      (h) =>
        h?.result?.ok &&
        /^(?:click|tap|press_click|click_coord|tap_coord|os_write|write|type|fill|press)$/i.test(
          String(h?.action?.type || ""),
        ),
    ).length;
    const goalEmails = String(goal || "").match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || [];
    const shareGoal = isShareInviteGoal(goal);
    const exerciseGoal =
      /\b(quiz|exercise|lesson|practice|complete it|finish it|work\s+through|entire thing)\b/i.test(
        String(goal || ""),
      ) ||
      /\b(complete|finish|solve|take|answer)\b.{0,40}\b(quiz|exercise|lesson|practice|test|exam|form)\b/i.test(
        String(goal || ""),
      );
    // Opening Share / typing the email is NOT done — need invite-sent confirmation.
    // Never treat dialog chrome ("People with access") as success.
    // Only count emails typed AFTER Share was opened — doc-body writes that happen
    // to include an address must NOT trigger the force-Send path (that closes Share).
    const shareOpenedIdx = history.findIndex((h) => {
      const lab = String(h?.action?.label || h?.action?.element || "").toLowerCase();
      const t = String(h?.action?.type || "").toLowerCase();
      return (
        h?.result?.ok &&
        /click|tap|press_click|click_coord/i.test(t) &&
        /^(share|share document|invite)\b/i.test(lab.trim())
      );
    });
    const typedEmailOk =
      shareGoal &&
      goalEmails.length > 0 &&
      shareOpenedIdx >= 0 &&
      history.slice(shareOpenedIdx + 1).some((h) => {
        const t = String(h?.action?.type || "").toLowerCase();
        const val = String(h?.action?.value || h?.action?.text || "").trim();
        if (!h?.result?.ok || !/^(?:os_write|write|type|fill|insert)$/i.test(t) || !val) {
          return false;
        }
        return goalEmails.some((e) => {
          const email = String(e).toLowerCase();
          const v = val.toLowerCase();
          // Short values only — essay paste containing the address does not count.
          return v === email || (v.includes(email) && v.length <= email.length + 12);
        });
      });
    const shareEvidence =
      !shareGoal ||
      (goalEmails.length
        ? goalEmails.every((e) => pageShowsShareInviteComplete(pageText, e))
        : pageShowsShareInviteComplete(pageText));
    const shareStillOpen =
      shareGoal && pageShowsShareDialogOpen(pageText) && !shareEvidence;
    const exerciseEvidence = !exerciseGoal || pageShowsExerciseComplete(pageText);
    const phaseEv = browseGoalPhasesEvidence(goal, {
      url: pageUrl,
        pageText,
      history,
      sawScreenChange,
    });
    const planBlocks = taskPlanBlocksDone(taskPlan, goal);
    const askGaps = unmetBrowseAskRequirements(goal, {
      url: pageUrl,
      pageText,
      title: pageTitle,
      history,
      sawScreenChange,
    });
    const askIncomplete = askGaps.length > 0;
    const askAlreadyMet =
      !askIncomplete &&
      userAskSatisfiedOnPage(goal, {
        url: pageUrl,
        pageText,
        title: pageTitle,
        history,
        sawScreenChange,
      });
    // User ask already met — stop even if the planner wants another click.
    if (askAlreadyMet) {
      const doneNow = finishIfGoalMet(pageUrl, pageText, pageTitle);
      if (doneNow) return doneNow;
    }
    const needsFullEvidence =
      !inspectAsk && (multiStepGoal || askStillNeedsAdaptiveWork(goal));
    // General goals used to treat pageEvidence as always-true — that let the
    // planner finish after a few clicks. Require phase coverage for full asks.
    // Plan LATER lines are a soft reject (below), not a hard lock once phases pass.
    const pageEvidence =
      shareEvidence &&
      exerciseEvidence &&
      !shareStillOpen &&
      !askIncomplete &&
      (!needsFullEvidence || phaseEv.ok || askAlreadyMet);
    const maxDoneRejects = multiStepGoal || askStillNeedsAdaptiveWork(goal) ? 14 : 8;
    // Multi-step / share workflows need several real acts before "done" is believable.
    // Inspect/review asks must NOT be forced through 3 extra clicks after landing.
    const tooFewActsForMultiStep =
      !inspectAsk &&
      !askAlreadyMet &&
      (multiStepGoal || shareGoal || askStillNeedsAdaptiveWork(goal)) &&
      okActCount < (shareGoal ? 4 : 3) &&
      !shareEvidence &&
      !pageShowsExerciseComplete(pageText);
    // Share: must have typed the recipient email (or see invite-complete), not just clicked Share.
    const shareNeedsEmail =
      shareGoal &&
      goalEmails.length > 0 &&
      !shareEvidence &&
      !typedEmailOk &&
      !goalEmails.every((e) => pageShowsShareEmailEntered(pageText, e));
    let planActions = Array.isArray(plan?.actions) ? plan.actions : [];
    const emailOnPage =
      shareGoal &&
      goalEmails.length > 0 &&
      goalEmails.every((e) => pageShowsShareEmailEntered(pageText, e));
    const discardBlocking = shareGoal && pageShowsDiscardChangesDialog(pageText);

    // Discard-changes sheet blocks everything — close it via Cancel/Keep (never Discard).
    // Never Escape here — Escape closes the Share dialog too.
    if (discardBlocking && round < effectiveMaxRounds - 1) {
      answerRejections += 1;
      lastToolName = "click";
      lastToolOutput =
        "Discard-changes dialog is open — clicking Cancel/Keep to return to Share (NOT Discard).";
      lastActionDiff = "Discard confirmation visible — dismiss with Cancel, then click Send.";
      const kept = await dismissDiscardChangesDialog(webContents);
      history.push({
        action: { type: "click", label: kept?.label || "Cancel" },
        result: kept,
        at: new Date().toISOString(),
      });
      await waitForDomSettle(webContents, 900).catch(() => {});
      lastToolOutput = kept?.ok
        ? `Closed discard dialog via ${kept.label || "Cancel"} — next: reopen Share if needed and click Send.`
        : "Tried to close discard dialog — if still open, click Cancel (not Discard), then Send.";
      continue;
    }

    // Share dialog open, email not entered: only take over when the agent tries
    // to dismiss/re-click Share, or asks to type/send — never random clicks.
    if (shareStillOpen && shareNeedsEmail && goalEmails[0] && round < effectiveMaxRounds - 1) {
      const dismissOrToggle = planActions.some((a) => looksLikeShareDismissAction(a, goal));
      const planWantsType = planActions.some((a) => {
        const t = String(a?.type || "").toLowerCase();
        const lab = String(a?.label || a?.element || a?.target || "").toLowerCase();
        return (
          /^(type|fill|os_write|write|click_type|input)$/i.test(t) ||
          /\b(add people|email|people|invite|type|recipient)\b/i.test(lab) ||
          /\bsend\b/i.test(lab)
        );
      });
      const shouldForceType =
        dismissOrToggle ||
        planWantsType ||
        !!plan?.done ||
        !!plan?.answer ||
        !planActions.length;
      if (shouldForceType) {
        answerRejections += 1;
        lastToolName = "write";
        lastToolOutput =
          dismissOrToggle || plan?.done || plan?.answer
            ? `REJECTED dismiss while Share is open — typing ${goalEmails[0]} into Add people instead.`
            : `Share dialog open — typing ${goalEmails[0]} into Add people (agent intent).`;
        lastActionDiff = "Share dialog open — enter recipient email; do not dismiss.";
        const typed = await typeEmailIntoShareDialog(webContents, goalEmails[0]);
        history.push({
          action: { type: "type", value: goalEmails[0], label: "Add people" },
          result: typed,
          at: new Date().toISOString(),
        });
        await waitForDomSettle(webContents, 800).catch(() => {});
        lastToolOutput = typed?.ok
          ? `Typed ${goalEmails[0]} into Share — next click Send inside the dialog.`
          : `Could not type email into Share (${typed?.error || "failed"}). Keep the dialog open and try the Add people field.`;
        continue;
      }
    }

    // Ready to send ONLY while the share dialog is still open with a recipient.
    const shareReadyToSend =
      shareGoal &&
      !shareEvidence &&
      shareStillOpen &&
      (emailOnPage || typedEmailOk);

    // Email chip ready: only force Send when the agent asked for Send, or tried
    // to dismiss/finish early. Otherwise let the agent's planned action run.
    if (shareReadyToSend && round < effectiveMaxRounds - 1) {
      const dismissPlanned = planActions.some((a) => looksLikeShareDismissAction(a, goal));
      const planWantsSend = planActions.some((a) =>
        /\bsend\b/i.test(String(a?.label || a?.element || a?.target || "")),
      );
      const shouldForceSend =
        planWantsSend || dismissPlanned || !!plan?.done || !!plan?.answer || !planActions.length;
      if (shouldForceSend) {
        answerRejections += 1;
        lastToolName = "click";
        lastToolOutput =
          dismissPlanned || plan?.done || plan?.answer
            ? `REJECTED dismiss/finish — ${goalEmails[0] || "the email"} is already in Share. ` +
              "Do NOT click Cancel, Close, Done, Discard, or outside the dialog. Clicking Send now."
            : planWantsSend
              ? `Plan says Send — clicking the dialog Send button now (not Cancel).`
              : `${goalEmails[0] || "Recipient"} is ready — agent gave no next click; clicking Send in the dialog.`;
        lastActionDiff =
          `Share dialog has ${goalEmails[0] || "recipient"} ready — only action left is Send (not Done/Cancel).`;
        const sent = await clickSendInShareDialog(webContents);
        history.push({
          action: { type: "click", label: sent?.label || "Send" },
          result: sent,
          at: new Date().toISOString(),
        });
        await waitForDomSettle(webContents, 1100).catch(() => {});
        let afterSendText = pageText;
        try {
          const p = await getPageContext(webContents);
          afterSendText = `${p.title || ""}\n${p.text || ""}`;
        } catch {
          /* ignore */
        }
        if (pageShowsDiscardChangesDialog(afterSendText)) {
          lastToolOutput =
            "A Discard-changes dialog appeared (share was cancelled by mistake). Closing it, then will click Send again.";
          lastActionDiff = "Discard dialog after failed Send — dismiss with Cancel, then Send.";
          const kept = await dismissDiscardChangesDialog(webContents);
          history.push({
            action: { type: "click", label: kept?.label || "Cancel" },
            result: kept,
            at: new Date().toISOString(),
          });
          await waitForDomSettle(webContents, 800).catch(() => {});
          continue;
        }
        if (
          goalEmails.every((e) => pageShowsShareInviteComplete(afterSendText, e)) ||
          pageShowsShareInviteComplete(afterSendText, goalEmails[0])
        ) {
          answer = `Shared with **${goalEmails[0]}** from this page.`;
          return {
            ok: true,
            answer,
            history,
            url: webContents.getURL() || pageUrl,
          };
        }
        lastToolOutput = sent?.ok
          ? `Clicked "${sent.label || "Send"}" in the share dialog — verify invitation-sent, or click Send again if still open.`
          : `Could not click Send (${sent?.error || "not found"}). Look for the blue Send button inside the dialog — never Cancel/Done/toolbar Share.`;
        lastActionDiff = sent?.ok
          ? "Clicked Send — check for invitation-sent confirmation."
          : "Send button not found in dialog; do not dismiss.";
        continue;
      }
      // else: agent planned a purposeful non-dismiss action — execute it below.
    }

    // done/answer/empty/forceContinue all mean "no next action" — reject if unverified.
    // If the USER ASK is already satisfied, accept finish immediately.
    const wantsToFinish = !!(
      plan?.done ||
      plan?.answer ||
      plan?.forceContinue ||
      !planActions.length ||
      askAlreadyMet
    );
    if (askAlreadyMet && (plan?.done || plan?.answer || !planActions.length || plan?.forceContinue)) {
      const doneAsk = finishIfGoalMet(pageUrl, pageText, pageTitle);
      if (doneAsk) {
        if (plan?.answer) doneAsk.answer = String(plan.answer);
        return doneAsk;
      }
    }
    if (
      actionGoal &&
      wantsToFinish &&
      !askAlreadyMet &&
      answerRejections < maxDoneRejects &&
      round < effectiveMaxRounds - 1 &&
      (!actedOk ||
        !pageEvidence ||
        askIncomplete ||
        tooFewActsForMultiStep ||
        shareNeedsEmail ||
        (needsFullEvidence && planBlocks && !phaseEv.ok))
    ) {
      answerRejections += 1;
      lastToolName = "answer";
      if (!actedOk) {
        lastToolOutput =
          "REJECTED — no click or type has been performed yet, so the task is NOT done. " +
          "Do not answer or describe your plan. Return exactly ONE click or write tool_call " +
          "that performs the next concrete step on this screen now.";
        lastActionDiff = "No action has been executed yet.";
      } else if (askIncomplete) {
        const gapList = askGaps.slice(0, 4).join("; ");
        lastToolOutput =
          `REJECTED — RECHECK the full USER GOAL. Still unfinished: ${gapList}. ` +
          "Do NOT mark done after only the first part. Pick the next unfinished part, " +
          "return ONE click or write, verify the screen, then continue until EVERY part is done.";
        lastActionDiff = `Full-ask recheck failed — still need: ${gapList}`;
      } else if (shareGoal && shareNeedsEmail) {
        const who = goalEmails[0] || "the recipient email";
        lastToolOutput =
          `REJECTED — Share may be open, but ${who} has NOT been entered yet. ` +
          `Click the "Add people" / email field, type ${who}, press Enter, then click Send. ` +
          "Do NOT call answer until the invite is confirmed sent.";
        lastActionDiff = `Recipient ${who} is not in the share dialog yet — type it next.`;
      } else if (shareGoal && !shareEvidence) {
        const who = goalEmails[0] || "the recipient";
        lastToolOutput =
          `REJECTED — the invite to ${who} is NOT finished. ` +
          "If the email chip is there, click Send (not just Share). " +
          "Do NOT call answer until you see invitation-sent / access-updated confirmation. " +
          'Dialog labels like "People with access" do NOT mean it was sent.';
        lastActionDiff =
          "Share dialog may be open, but invite-sent confirmation is not visible — keep going.";
      } else if (exerciseGoal && !exerciseEvidence) {
        lastToolOutput =
          "REJECTED — the quiz/exercise/form is NOT finished. " +
          "Read the current screen carefully, answer the visible question or click the next control, " +
          "verify the page advanced, and keep going until completion text is visible. " +
          "Do NOT call answer until the full USER GOAL is done.";
        lastActionDiff =
          "Page does not show quiz/exercise completion — continue with the next question or control.";
      } else if (tooFewActsForMultiStep) {
        lastToolOutput =
          "REJECTED — this is a multi-step workflow and only a couple of actions have run. " +
          "The USER GOAL is not finished. Study the screen, pick the next unfinished step, " +
          "and return ONE click or write tool_call. Verify after each step before continuing.";
        lastActionDiff = `Only ${okActCount} successful UI action(s) so far — keep working through the remaining steps.`;
      } else if (planBlocks || (needsFullEvidence && !phaseEv.ok)) {
        const missing = (phaseEv.missing || []).join(", ") || "remaining steps";
        lastToolOutput =
          `REJECTED — WORKING PLAN / goal phases still unfinished (${missing}). ` +
          "Rewrite DONE/NOW+CHECK/LATER from what you SEE, mark finished LATER lines as done only after their CHECK, " +
          "and return ONE click or write for the current NOW step. Do NOT answer until Final CHECK is met.";
        lastActionDiff = `Phases still missing: ${missing}. Plan LATER/Final CHECK not cleared.`;
      } else {
        lastToolOutput =
          "REJECTED — the page does not show the USER GOAL finished. " +
          "Return exactly ONE click or write that advances the next unfinished step.";
        lastActionDiff = "Premature done rejected — continue acting on screen.";
      }
      continue;
    }
    // USER ASK already satisfied — do not run another speculative click.
    if (askAlreadyMet) {
      const doneAsk = finishIfGoalMet(pageUrl, pageText, pageTitle);
      if (doneAsk) {
        if (plan?.answer) doneAsk.answer = String(plan.answer);
        return doneAsk;
      }
    }

    // Only accept an explicit done/answer — never treat forceContinue as success.
    if ((plan?.done || plan?.answer) && !plan?.forceContinue) {
      answer = String(plan.answer || plan.summary || "Done.");
      const doneUrl = webContents.getURL() || pageUrl;
      // Final full-ask recheck — never finish while parts of the prompt remain.
      if (askIncomplete && round < effectiveMaxRounds - 1 && answerRejections < maxDoneRejects) {
        answerRejections += 1;
        lastToolName = "answer";
        lastToolOutput =
          `REJECTED — RECHECK the full USER GOAL before finishing. Still unfinished: ${askGaps
            .slice(0, 4)
            .join("; ")}. Continue with the next unfinished part.`;
        lastActionDiff = `Full-ask recheck failed — still need: ${askGaps.slice(0, 4).join("; ")}`;
        continue;
      }
      // Never claim success on an action goal that never acted or never verified.
      // Inspect/review may be done on land with zero clicks.
      if (
        actionGoal &&
        !askAlreadyMet &&
        (askIncomplete ||
          !actedOk ||
          !pageEvidence ||
          tooFewActsForMultiStep ||
          shareNeedsEmail)
      ) {
        return {
          ok: true,
          stuck: true,
          needsHelp: true,
          answer:
            (askGaps.length
              ? `I got partway there, but still need to: ${askGaps.slice(0, 4).join("; ")}.`
              : answer ||
                (shareGoal
                  ? "I opened Share but could not verify the invite was sent to the email — still incomplete."
                  : "I could not verify this was finished on the page — the task is still incomplete.")) +
            "\n\nIf you handle that in the agent browser tab — or tell me exactly what to click — say **continue** and I'll finish the rest.",
          history,
          url: doneUrl,
          unmet: askGaps.slice(),
        };
      }
      const createStillOpen =
        /\b(create|make|build|design|draft)\b/i.test(String(goal || "")) &&
        !looksBrowseGoalSatisfied(goal, {
          url: doneUrl,
          pageText,
          title: pageTitle,
          history,
        });
      return {
        ok: true,
        answer,
        history,
        url: doneUrl,
        stuck: !!createStillOpen,
        unmet: [],
      };
    }
    const actions = planActions;
    if (!actions.length) {
      answer = String(plan?.answer || "No further actions.");
      return {
        ok: true,
        answer,
        history,
        url: webContents.getURL(),
        stuck: true,
      };
    }
    const catalogItems = catalog.items || [];
    const roundHistStart = history.length;
    // At most one click per round so we always re-read after the page changes.
    // type → press Enter stays as a pair.
    // click (on a field) → type coalesces into ONE click_type command.
    const queued = actions.slice(0, 4);
    const firstType = String(queued[0]?.type || "").toLowerCase();
    const secondType = String(queued[1]?.type || "").toLowerCase();
    const typeThenEnter =
      (firstType === "type" ||
        firstType === "fill" ||
        firstType === "os_write" ||
        firstType === "write" ||
        firstType === "click_type") &&
      (secondType === "press" || secondType === "key" || secondType === "press_key");
    const clickThenType =
      /^(click|tap|press_click|click_coord|tap_coord)$/i.test(firstType) &&
      /^(type|fill|os_write|write|input|click_type)$/i.test(secondType);
    let toRun = typeThenEnter ? queued.slice(0, 2) : queued.slice(0, 1);
    if (clickThenType && queued[0] && queued[1]) {
      const clickAct = queued[0];
      const typeAct = queued[1];
      const text = String(typeAct.text ?? typeAct.value ?? typeAct.content ?? "");
      toRun = [
        {
          type: "click_type",
          text,
          value: text,
          pressEnter: !!typeAct.pressEnter,
          label:
            String(clickAct.label || typeAct.label || clickAct.element || "field").trim() ||
            "field",
          element: clickAct.element || clickAct.label || typeAct.label,
          id: clickAct.id || typeAct.id,
          selector: clickAct.selector || typeAct.selector,
          x: clickAct.x ?? typeAct.x,
          y: clickAct.y ?? typeAct.y,
          clientX: clickAct.clientX ?? typeAct.clientX,
          clientY: clickAct.clientY ?? typeAct.clientY,
        },
      ];
    }

    const beforeSnap = {
      url: pageUrl,
      title: pageTitle,
      text: pageText,
      items: catalogItems,
    };

    for (let ai = 0; ai < toRun.length; ai += 1) {
      const action = toRun[ai];
      if (signal?.aborted) return { ok: false, error: "aborted", answer, history };
      const actLabel = String(action?.label || action?.element || action?.target || "");
      const wantsShareToggle =
        looksLikeShareDismissAction(action, goal) ||
        /^(share|share document|done)$/i.test(actLabel.trim()) ||
        /\bsend\b/i.test(actLabel);
      // While Share dialog is open: never re-click toolbar Share (it CLOSES the
      // dialog) or Cancel/Done. Type email or click dialog Send instead.
      if (shareGoal && shareStillOpen && !shareEvidence && wantsShareToggle) {
        if (typedEmailOk || emailOnPage || /\bsend\b/i.test(actLabel)) {
          const sent = await clickSendInShareDialog(webContents);
          history.push({
            action: {
              type: "click",
              label: sent?.label || "Send",
              redirectedFrom: actLabel,
            },
            result: sent?.ok ? sent : { ok: false, error: sent?.error || "send_redirect_failed" },
            at: new Date().toISOString(),
          });
          if (typeof onProgress === "function") {
            onProgress({
              status: `Send (blocked ${actLabel || "Share/Cancel"}): ${sent?.label || "dialog Send"}`.slice(
                0,
                80,
              ),
              url: webContents.getURL(),
              round,
              history,
              taskPlan: String(taskPlan || "").slice(0, 900),
            });
          }
        } else if (goalEmails[0]) {
          const typed = await typeEmailIntoShareDialog(webContents, goalEmails[0]);
          history.push({
            action: {
              type: "type",
              value: goalEmails[0],
              label: "Add people",
              redirectedFrom: actLabel,
            },
            result: typed,
            at: new Date().toISOString(),
          });
          if (typeof onProgress === "function") {
            onProgress({
              status: `Type email (blocked re-click ${actLabel || "Share"})`.slice(0, 80),
              url: webContents.getURL(),
              round,
              history,
              taskPlan: String(taskPlan || "").slice(0, 900),
            });
          }
        } else {
          history.push({
            action: { type: "click", label: actLabel || "Share" },
            result: { ok: false, error: "blocked_share_toggle_while_open" },
            at: new Date().toISOString(),
          });
        }
        break;
      }
      const result = await runAction(webContents, action, catalogItems);
      history.push({ action, result, at: new Date().toISOString() });
      if (typeof onProgress === "function") {
        onProgress({
          status: `${action.type || "act"}: ${action.label || action.url || ""}`.slice(0, 80),
          url: webContents.getURL(),
          round,
          history,
          taskPlan: String(taskPlan || "").slice(0, 900),
        });
      }
      if (!result?.ok && action.type !== "wait") break;
    }

    // Verify: settle → re-scrape → list NEW buttons so the next plan targets
    // the updated screen (dialogs, next-step CTAs, etc.).
    if (typeof onProgress === "function") {
      onProgress({
        status: "Checking what changed…",
        url: webContents.getURL(),
        round,
        history,
        taskPlan: String(taskPlan || "").slice(0, 900),
      });
    }
    const observed = await observeAfterOwnedAction(webContents, beforeSnap, {
      settleMs: 1000,
      timeoutMs: 2600,
    });
    const afterUrl = observed.after?.url || webContents.getURL?.() || pageUrl;
    const afterPage = {
      text: observed.after?.text || "",
      title: observed.after?.title || pageTitle,
    };
    if (observed.changed) sawScreenChange = true;
    for (let hi = roundHistStart; hi < history.length; hi += 1) {
      const prev = history[hi]?.result && typeof history[hi].result === "object"
        ? history[hi].result
        : {};
      history[hi].screenChanged = !!observed.changed;
      history[hi].result = { ...prev, screenChanged: !!observed.changed };
    }

    {
      const executed = history
        .slice(roundHistStart)
        .map((h) => {
          const a = h.action || {};
          const label = String(a.label || a.value || a.url || "").slice(0, 60);
          return `${a.type || "act"}${label ? ` "${label}"` : ""} → ${
            h.result?.ok ? "ok" : `FAILED (${h.result?.error || "?"})`
          }`;
        })
        .join("; ");
      lastToolName = plan?.holoToolName || String(toRun[0]?.type || "act");
      const newUi = /NEW controls/i.test(String(observed.diff || ""));
      lastToolOutput =
        `${executed || "no action executed"}\n` +
        (observed.changed
          ? newUi
            ? "Screen updated with NEW controls — rewrite WORKING PLAN (DONE/NOW+CHECK/LATER) and act only on the new NOW step."
            : "Screen updated — verify the prior CHECK, rewrite WORKING PLAN, then take the new NOW step."
          : "Screen may not have changed — do not repeat the same click; adjust NOW or try a different approach.");
      lastActionDiff = observed.diff || lastActionDiff;
      if (newUi && taskPlan) {
        // Keep DONE history, but force the planner to replace NOW from new UI.
        taskPlan = String(taskPlan)
          .replace(
            /NOW:[\s\S]*?(?=LATER:|$)/i,
            "NOW: (rewrite from NEW controls listed in WHAT CHANGED — one visible action + CHECK)\n",
          )
          .slice(0, 2000);
      }
    }
    {
      const afterDone = finishIfGoalMet(
        afterUrl,
        afterPage.text || "",
        afterPage.title || pageTitle,
      );
      if (afterDone) return afterDone;
    }
  }
  {
    const finalUrl = webContents.getURL?.() || "";
    let finalText = "";
    let finalTitle = webContents.getTitle?.() || "";
    try {
      const p = await getPageContext(webContents);
      finalText = `${p.title || ""}\n${p.text || ""}`;
      finalTitle = p.title || finalTitle;
    } catch {
      /* ignore */
    }
    const finalDone = finishIfGoalMet(finalUrl, finalText, finalTitle);
    if (finalDone) return finalDone;
  }
  return {
    ok: true,
    stuck: true,
    needsHelp: true,
    answer:
      answer ||
      formatStuckNeedsHelp({
        goal,
        taskPlan,
        history,
        reason:
          "I used my full action budget without being able to verify this finished.",
      }),
    history,
    url: webContents.getURL(),
  };
}

/** Common spoken site names → canonical https origin. */
const SITE_ALIASES = {
  youtube: "https://www.youtube.com",
  yt: "https://www.youtube.com",
  google: "https://www.google.com",
  bing: "https://www.bing.com",
  duckduckgo: "https://duckduckgo.com",
  ddg: "https://duckduckgo.com",
  twitter: "https://x.com",
  x: "https://x.com",
  reddit: "https://www.reddit.com",
  github: "https://github.com",
  // Inbox deep-link — bare mail.google.com often lands on the public about page.
  gmail: "https://mail.google.com/mail/u/0/#inbox",
  wikipedia: "https://en.wikipedia.org",
  amazon: "https://www.amazon.com",
  lykn: "https://lykn.io",
  yahoo: "https://finance.yahoo.com",
  tradingview: "https://www.tradingview.com",
  finviz: "https://finviz.com",
  pinterest: "https://www.pinterest.com",
  instagram: "https://www.instagram.com",
  tiktok: "https://www.tiktok.com",
  linkedin: "https://www.linkedin.com",
  facebook: "https://www.facebook.com",
  etsy: "https://www.etsy.com",
  allrecipes: "https://www.allrecipes.com",
  netflix: "https://www.netflix.com",
  khan: "https://www.khanacademy.org",
  khanacademy: "https://www.khanacademy.org",
  // Common misspellings
  kahn: "https://www.khanacademy.org",
  kahnacademy: "https://www.khanacademy.org",
};

/** Multi-word site phrases checked before single-token aliases. */
const SITE_ALIAS_PHRASES = [
  [/yahoo\s+finance/i, "https://finance.yahoo.com"],
  [/yahoo\s+stocks?/i, "https://finance.yahoo.com"],
  [/trading\s*view/i, "https://www.tradingview.com"],
  [/google\s+finance/i, "https://www.google.com/finance"],
  // Google Workspace apps — must beat bare "google" → google.com
  [/\bgoogle\s+sheets?\b/i, "https://docs.google.com/spreadsheets/u/0/"],
  [/\bgoogle\s+docs?\b/i, "https://docs.google.com/document/u/0/"],
  [/\bgoogle\s+slides?\b/i, "https://docs.google.com/presentation/u/0/"],
  [/\bgoogle\s+drive\b/i, "https://drive.google.com/drive/u/0/my-drive"],
  [/\bgoogle\s+calendar\b/i, "https://calendar.google.com/calendar/u/0/r"],
  [/\bgoogle\s+meet\b/i, "https://meet.google.com/"],
  [/\bgoogle\s+forms?\b/i, "https://docs.google.com/forms/u/0/"],
  [/\bgoogle\s+chat\b/i, "https://chat.google.com/"],
  [/\bgoogle\s+keep\b/i, "https://keep.google.com/"],
  [/\bgoogle\s+sites?\b/i, "https://sites.google.com/"],
  [/\bgoogle\s+photos?\b/i, "https://photos.google.com/"],
  [/\bgoogle\s+maps?\b/i, "https://maps.google.com/"],
  [/\bgoogle\s+translate\b/i, "https://translate.google.com/"],
  [/\bgoogle\s+classroom\b/i, "https://classroom.google.com/"],
  // Common apps / products
  [/\bchat\s*gpt\b/i, "https://chatgpt.com/"],
  [/\bclaude\.?ai\b/i, "https://claude.ai/"],
  // Khan Academy + common typos ("kahn acadamy")
  [/\bkhan\s+academ(?:y|ies)\b/i, "https://www.khanacademy.org"],
  [/\bkahn\s+academ(?:y|ies|ay|ey)\b/i, "https://www.khanacademy.org"],
  [/\bkhanacadem(?:y|ies)\b/i, "https://www.khanacademy.org"],
  [/\bkahnacadem(?:y|ies|ay)\b/i, "https://www.khanacademy.org"],
  // Ads / account dashboards — beat Google "… thing/stuff" open fallbacks
  [/\breddit\s+(?:ads?|advertising|ads?\s*manager)\b/i, "https://ads.reddit.com"],
  [/\b(?:ads?|advertising)\s+(?:on\s+)?reddit\b/i, "https://ads.reddit.com"],
  [/\bgoogle\s+(?:ads?|adwords|ads?\s*manager)\b/i, "https://ads.google.com"],
  [/\b(?:facebook|meta)\s+(?:ads?|ads?\s*manager|advertising)\b/i, "https://adsmanager.facebook.com"],
  [/\btik\s?tok\s+(?:ads?|advertising|ads?\s*manager)\b/i, "https://ads.tiktok.com"],
  [/\blinkedin\s+(?:ads?|campaign\s*manager|advertising)\b/i, "https://www.linkedin.com/campaignmanager/"],
  [/\b(?:x|twitter)\s+(?:ads?|advertising)\b/i, "https://ads.x.com"],
];

/** Single-token product aliases (also in SITE_ALIASES where useful). */
Object.assign(SITE_ALIASES, {
  notion: "https://www.notion.so/",
  figma: "https://www.figma.com/",
  canva: "https://www.canva.com/",
  slack: "https://app.slack.com/",
  discord: "https://discord.com/app",
  trello: "https://trello.com/",
  asana: "https://app.asana.com/",
  linear: "https://linear.app/",
  dropbox: "https://www.dropbox.com/",
  zoom: "https://zoom.us/",
  chatgpt: "https://chatgpt.com/",
  sheets: "https://docs.google.com/spreadsheets/u/0/",
  // Short tokens users say after "open …" — not prose words like "presentation".
  sheet: "https://docs.google.com/spreadsheets/u/0/",
  docs: "https://docs.google.com/document/u/0/",
  doc: "https://docs.google.com/document/u/0/",
  slides: "https://docs.google.com/presentation/u/0/",
  drive: "https://drive.google.com/drive/u/0/my-drive",
});

/**
 * Obvious brand/product homes the model "already knows" — go straight here.
 * Unfamiliar names still Google-search + click the top result.
 * Keys are lowercase; spaces optional via resolveWellKnownBrandUrl.
 */
const WELL_KNOWN_OPEN_SITES = {
  // Retail / brands
  nike: "https://www.nike.com",
  adidas: "https://www.adidas.com",
  target: "https://www.target.com",
  walmart: "https://www.walmart.com",
  costco: "https://www.costco.com",
  mcdonalds: "https://www.mcdonalds.com",
  "mcdonald's": "https://www.mcdonalds.com",
  starbucks: "https://www.starbucks.com",
  apple: "https://www.apple.com",
  microsoft: "https://www.microsoft.com",
  samsung: "https://www.samsung.com",
  sony: "https://www.sony.com",
  bestbuy: "https://www.bestbuy.com",
  "best buy": "https://www.bestbuy.com",
  homedepot: "https://www.homedepot.com",
  "home depot": "https://www.homedepot.com",
  ikea: "https://www.ikea.com",
  ebay: "https://www.ebay.com",
  etsy: "https://www.etsy.com",
  shopify: "https://www.shopify.com",
  // Tech / creative
  adobe: "https://www.adobe.com",
  photoshop: "https://www.adobe.com/products/photoshop.html",
  "adobe photoshop": "https://www.adobe.com/products/photoshop.html",
  illustrator: "https://www.adobe.com/products/illustrator.html",
  "adobe illustrator": "https://www.adobe.com/products/illustrator.html",
  lightroom: "https://www.adobe.com/products/photoshop-lightroom.html",
  premiere: "https://www.adobe.com/products/premiere.html",
  "adobe premiere": "https://www.adobe.com/products/premiere.html",
  spotify: "https://open.spotify.com",
  netflix: "https://www.netflix.com",
  hulu: "https://www.hulu.com",
  disneyplus: "https://www.disneyplus.com",
  "disney plus": "https://www.disneyplus.com",
  disney: "https://www.disney.com",
  hbomax: "https://www.max.com",
  "hbo max": "https://www.max.com",
  twitch: "https://www.twitch.tv",
  steam: "https://store.steampowered.com",
  epicgames: "https://store.epicgames.com",
  "epic games": "https://store.epicgames.com",
  // News / media
  cnn: "https://www.cnn.com",
  nytimes: "https://www.nytimes.com",
  "new york times": "https://www.nytimes.com",
  bbc: "https://www.bbc.com",
  reuters: "https://www.reuters.com",
  wikipedia: "https://www.wikipedia.org",
  // Productivity / finance
  paypal: "https://www.paypal.com",
  venmo: "https://venmo.com",
  cashapp: "https://cash.app",
  "cash app": "https://cash.app",
  stripe: "https://stripe.com",
  airbnb: "https://www.airbnb.com",
  uber: "https://www.uber.com",
  lyft: "https://www.lyft.com",
  doordash: "https://www.doordash.com",
  "door dash": "https://www.doordash.com",
  // Dev / cloud
  vercel: "https://vercel.com",
  netlify: "https://www.netlify.com",
  heroku: "https://www.heroku.com",
  aws: "https://aws.amazon.com",
  azure: "https://azure.microsoft.com",
  openai: "https://openai.com",
  anthropic: "https://www.anthropic.com",
  midjourney: "https://www.midjourney.com",
  // Misc common
  craigslist: "https://www.craigslist.org",
  weather: "https://weather.com",
  "weather channel": "https://weather.com",
  usps: "https://www.usps.com",
  ups: "https://www.ups.com",
  fedex: "https://www.fedex.com",
};

Object.assign(SITE_ALIASES, WELL_KNOWN_OPEN_SITES);

for (const [re, url] of [
  [/\badobe\s+photoshop\b/i, WELL_KNOWN_OPEN_SITES["adobe photoshop"]],
  [/\badobe\s+illustrator\b/i, WELL_KNOWN_OPEN_SITES["adobe illustrator"]],
  [/\bbest\s+buy\b/i, WELL_KNOWN_OPEN_SITES["best buy"]],
  [/\bhome\s+depot\b/i, WELL_KNOWN_OPEN_SITES["home depot"]],
  [/\bdisney\s+plus\b/i, WELL_KNOWN_OPEN_SITES["disney plus"]],
  [/\bhbo\s+max\b/i, WELL_KNOWN_OPEN_SITES["hbo max"]],
  [/\bnew\s+york\s+times\b/i, WELL_KNOWN_OPEN_SITES["new york times"]],
  [/\bcash\s+app\b/i, WELL_KNOWN_OPEN_SITES["cash app"]],
  [/\bdoor\s*dash\b/i, WELL_KNOWN_OPEN_SITES.doordash],
  [/\bepic\s+games\b/i, WELL_KNOWN_OPEN_SITES["epic games"]],
]) {
  SITE_ALIAS_PHRASES.push([re, url]);
}

/** Resolve a destination name to a known brand homepage, or "". */
function resolveWellKnownBrandUrl(name) {
  const raw = String(name || "")
    .toLowerCase()
    .replace(/['’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw || raw.length < 2) return "";
  if (WELL_KNOWN_OPEN_SITES[raw]) return WELL_KNOWN_OPEN_SITES[raw];
  if (SITE_ALIASES[raw]) return SITE_ALIASES[raw];
  const collapsed = raw.replace(/[^a-z0-9]+/g, "");
  if (!collapsed) return "";
  for (const [key, url] of Object.entries(WELL_KNOWN_OPEN_SITES)) {
    if (key.replace(/[^a-z0-9]+/g, "") === collapsed) return url;
  }
  for (const [key, url] of Object.entries(SITE_ALIASES)) {
    if (String(key).replace(/[^a-z0-9]+/g, "") === collapsed) return url;
  }
  return "";
}

/**
 * Optional per-session site aliases for "open my …" deep links.
 * Populated via setUserSiteAliases() (tests / future features).
 */
let USER_SITE_ALIASES = Object.create(null);

function setUserSiteAliases(mapOrItems) {
  const next = Object.create(null);
  if (Array.isArray(mapOrItems)) {
    for (const item of mapOrItems) {
      const url = String(item?.url || "").trim();
      if (!url) continue;
      for (const a of [item.name, item.title, ...(item.aliases || [])]) {
        const k = String(a || "")
          .toLowerCase()
          .replace(/['’]/g, "")
          .replace(/[^\w\s.-]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (k.length >= 2 && !next[k]) next[k] = url;
      }
    }
  } else if (mapOrItems && typeof mapOrItems === "object") {
    for (const [k0, url0] of Object.entries(mapOrItems)) {
      const k = String(k0 || "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
      const url = String(url0 || "").trim();
      if (k.length >= 2 && url) next[k] = url;
    }
  }
  USER_SITE_ALIASES = next;
  return { ...USER_SITE_ALIASES };
}

function getUserSiteAliases() {
  return { ...USER_SITE_ALIASES };
}

function normalizeAliasLookup(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\w\s.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Exact / near-exact match on a destination name ("my board", "budget sheet"). */
function matchUserSavedName(name) {
  const cand = normalizeAliasLookup(name);
  if (!cand || cand.length < 2) return "";
  if (USER_SITE_ALIASES[cand]) return USER_SITE_ALIASES[cand];
  const stripped = cand.replace(/^my\s+/, "");
  if (stripped && USER_SITE_ALIASES[stripped]) return USER_SITE_ALIASES[stripped];
  if (stripped && USER_SITE_ALIASES[`my ${stripped}`]) {
    return USER_SITE_ALIASES[`my ${stripped}`];
  }
  // Prefix: saved "Q1 budget sheet" ↔ ask "budget sheet"
  const keys = Object.keys(USER_SITE_ALIASES).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (key.length < 4) continue;
    if (cand === key || cand.endsWith(` ${key}`) || key.endsWith(` ${cand}`)) {
      return USER_SITE_ALIASES[key];
    }
    if (
      (cand.length >= 8 || cand.split(/\s+/).length >= 2) &&
      key.includes(cand)
    ) {
      return USER_SITE_ALIASES[key];
    }
  }
  return "";
}

/**
 * Match user-saved aliases for navigation asks only
 * ("open my board", "go to budget sheet") — not casual mentions.
 */
function resolveUserSavedUrl(text) {
  const keys = Object.keys(USER_SITE_ALIASES);
  if (!keys.length) return "";
  const raw = String(text || "").trim();
  if (!raw) return "";

  const name = extractOpenDestinationName(raw);
  const fromName = matchUserSavedName(name);
  if (fromName) return fromName;

  // Targeted: alias immediately after open/go to / visit…
  const sorted = keys.sort((a, b) => b.length - a.length);
  const lower = normalizeAliasLookup(raw);
  for (const key of sorted) {
    if (key.length < 2) continue;
    const idx = lower.indexOf(key);
    if (idx < 0) continue;
    const before = lower.slice(Math.max(0, idx - 48), idx);
    const targeted =
      /\b(?:open|visit|go\s+(?:to|into)|navigate(?:\s+to)?|launch|pull\s+up|browse(?:\s+to)?|take\s+me(?:\s+to)?|load|show\s+me|bring\s+up)(?:\s+up)?(?:\s+(?:a|an|the|my))?(?:\s+browser)?(?:\s+to)?\s+$/i.test(
        before,
      ) || /\b(?:on|in|at)\s+$/i.test(before);
    if (targeted) return USER_SITE_ALIASES[key];
  }
  return "";
}

/** Company / product names → ticker for stock browse deep links. */
const COMPANY_TICKERS = {
  tesla: "TSLA",
  apple: "AAPL",
  microsoft: "MSFT",
  amazon: "AMZN",
  nvidia: "NVDA",
  alphabet: "GOOGL",
  meta: "META",
  facebook: "META",
  netflix: "NFLX",
  amd: "AMD",
  intel: "INTC",
  disney: "DIS",
  nike: "NKE",
  starbucks: "SBUX",
  costco: "COST",
  "berkshire hathaway": "BRK-B",
  berkshire: "BRK-B",
  // "google stock" — not plain "google" (that's the search site)
};

function extractAliasUrl(text) {
  const raw = String(text || "");
  // Don't steal "open X and search for Y" — on-site search deep links win.
  if (!/\b(search|find(?:\s+me)?|look\s*(?:for|up))\b/i.test(raw)) {
    const userHit = resolveUserSavedUrl(raw);
    if (userHit) return userHit;
  }
  for (const [re, url] of SITE_ALIAS_PHRASES) {
    if (re.test(raw)) return url;
  }
  const lower = raw.toLowerCase();
  // Prefer longer aliases first (duckduckgo before ddg).
  const keys = Object.keys(SITE_ALIASES).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${esc}\\b`, "gi");
    let m;
    while ((m = re.exec(lower)) !== null) {
      const idx = m.index;
      // david@lykn.io — domain of an email, not a site to open
      if (idx > 0 && lower[idx - 1] === "@") continue;
      // Alias must be the immediate navigation target ("open up youtube",
      // "go to gmail") — not a later brand mention ("new LYKN agent feature").
      const before = lower.slice(Math.max(0, idx - 48), idx);
      const after = lower.slice(idx + key.length, idx + key.length + 40);
      // "open google sheets" — don't resolve bare google; phrases handle products.
      if (
        key === "google" &&
        /^\s+(sheets?|docs?|slides?|drive|calendar|meet|maps?|photos?|forms?|chat|keep|sites?|classroom|analytics|ads|translate|finance)\b/i.test(
          after,
        )
      ) {
        continue;
      }
      const targeted =
        /\b(?:open|visit|go\s+(?:to|into)|navigate(?:\s+to)?|launch|pull\s+up|browse(?:\s+to)?|take\s+me(?:\s+to)?|load|show\s+me|bring\s+up)(?:\s+up)?(?:\s+(?:a|an|the|my))?(?:\s+browser)?(?:\s+to)?\s+$/i.test(
          before,
        ) ||
        // "search pinterest for …" / "find reddit …" / "look up youtube …"
        /\b(?:search|find(?:\s+me)?|look(?:\s+(?:for|up))?|browse)\s+(?:on\s+)?$/i.test(
          before,
        ) ||
        // "pinterest search …" / "youtube search for …"
        (/^\s*$/.test(before) && /^\s*search\b/i.test(after)) ||
        /\b(?:on|in|at)\s+$/i.test(before) ||
        new RegExp(`^${esc}\\.(?:com|io|org|net)\\b`, "i").test(lower.slice(idx));
      if (!targeted) continue;
      return SITE_ALIASES[key];
    }
  }
  return "";
}

/**
 * "open google sheets" / "pull up notion" / "go to figma" — open a destination.
 * Not: search/find/research/compose/build asks.
 */
function looksLikeOpenDestinationAsk(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (looksLikeMailComposeTask(t) || looksLikeMailReplyTask(t) || looksLikeOpenMailItem(t)) {
    return false;
  }
  if (looksLikeVideoBrowseIntent(t) && /\b(video|clip|youtube|watch|play)\b/i.test(t)) {
    return false;
  }
  // "go into spotify and play thunderstruck" is open+play, not a bare open.
  if (
    /\b(play|listen\s+to|queue)\b/i.test(t) &&
    !/\b(play\s+(?:store|button)\b)/i.test(t)
  ) {
    return false;
  }
  // "open pinterest and search for recipes" is open+search — not bare open.
  // "create a blank sheet" is handled by resolveContextualBrowseUrl, not here.
  if (
    /\b(search|find(?:\s+me)?|look\s*(?:for|up)|research|build|create|draft|write|monitor|watch\s+for|generate)\b/i.test(
      t,
    )
  ) {
    return false;
  }
  return /(?:^|\b)(?:please\s+|can\s+you\s+|could\s+you\s+)?(?:open(?:\s+up)?|go\s+(?:to|into)|visit|pull\s+up|launch|load|navigate(?:\s+to)?|take\s+me\s+to|bring\s+up)\b/i.test(
    t,
  );
}

/** Extract "google sheets" from "open up google sheets for me". */
function extractOpenDestinationName(text) {
  // Don't treat "." as end — that truncates "nike.com" to "nike".
  const m = String(text || "").match(
    /(?:open(?:\s+up)?|go\s+(?:to|into)|visit|pull\s+up|launch|load|navigate(?:\s+to)?|take\s+me\s+to|bring\s+up)\s+(?:up\s+)?(?:(?:a|an|the|my)\s+)?(.+?)(?:\s+and\s+|\s+then\s+|[!?]|$)/i,
  );
  if (!m) return "";
  let name = String(m[1] || "")
    .replace(
      /\s+(?:for\s+me|for\s+us|please|now|real\s*quick|quickly|thanks|thank\s+you)\s*$/i,
      "",
    )
    .replace(/\s+(?:website|web\s*site|webapp|web\s*app|app|application|page|site|tab)\s*$/i, "")
    // Vague filler: "reddit ads thing/stuff/area" → "reddit ads"
    .replace(/\s+(?:thing|stuff|area|place|section|bit|dealio|whatsit|whatchamacallit)s?\s*$/i, "")
    .replace(/\.+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return name.slice(0, 80);
}

/**
 * "that's not right" / "wrong site" after an auto-open — re-search without clicking.
 */
function looksLikeWrongOpenDestinationAsk(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 220) return false;
  const lower = t.toLowerCase();
  if (
    /\b(that'?s?\s+not\s+right|that'?s?\s+wrong|wrong\s+(one|site|page|link|result|place)|not\s+(the\s+)?(right|correct)\s+(one|site|page|link)|not\s+that(\s+one)?|nope|incorrect|try\s+again|different\s+(one|site|page|result)|not\s+what\s+i\s+(meant|wanted|asked))\b/i.test(
      lower,
    )
  ) {
    return true;
  }
  // Short negation after an open: "no", "wrong", "not adobe"
  if (/^(?:no+|nope|wrong|nah)\b/.test(lower) && lower.length <= 48) return true;
  if (/^not\s+\S+/.test(lower) && lower.length <= 60) return true;
  return false;
}

/** Create-new deep links for Google Workspace apps. */
const GOOGLE_CREATE_URLS = {
  sheets: "https://docs.google.com/spreadsheets/create",
  docs: "https://docs.google.com/document/create",
  slides: "https://docs.google.com/presentation/create",
  forms: "https://docs.google.com/forms/create",
};

/**
 * Infer sheets/docs/slides/forms from the ask and recent chat / tab context.
 * So "open a blank sheet" after "open google sheets" (or while on Sheets) creates a sheet.
 */
function inferGoogleCreateProduct(text, ctx = {}) {
  const t = String(text || "").toLowerCase();
  if (/\b(spreadsheets?|sheets?)\b/.test(t)) return "sheets";
  if (/\b(documents?|docs?)\b/.test(t) && !/\b(sheets?|spreadsheets?)\b/.test(t)) {
    return "docs";
  }
  if (/\b(slides?|presentations?|decks?)\b/.test(t)) return "slides";
  if (/\bforms?\b/.test(t) && !/\b(sheets?|docs?)\b/.test(t)) return "forms";

  const blob = [
    ctx.currentUrl,
    ctx.priorUrl,
    ctx.priorGoal,
    ctx.priorAssistant,
    ctx.recentUserGoals,
  ]
    .flat()
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (
    /docs\.google\.com\/spreadsheets|sheets\.google|google\s*sheets?|\bspreadsheet\b/.test(blob)
  ) {
    return "sheets";
  }
  if (/docs\.google\.com\/document|google\s*docs?\b/.test(blob)) return "docs";
  if (/docs\.google\.com\/presentation|google\s*slides?/.test(blob)) return "slides";
  if (/docs\.google\.com\/forms|google\s*forms?/.test(blob)) return "forms";
  return "";
}

/** "open a blank sheet" / "create a new doc" / "make a blank one" (with Sheets context). */
function looksLikeNewBlankWorkspaceAsk(text, ctx = {}) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (looksLikeMailComposeTask(t) || looksLikeMailReplyTask(t)) return false;

  // "open a blank one" / "make a new one" — product from chat/tab context.
  if (
    /\b(?:a\s+)?(?:brand\s+)?(?:new|blank|empty|fresh)\s+one\b/i.test(t) ||
    /\b(?:make|create|start|open(?:\s+up)?|pull\s+up|launch)\s+(?:me\s+)?(?:a\s+)?(?:new|blank|empty|fresh)\s+one\b/i.test(
      t,
    )
  ) {
    return !!inferGoogleCreateProduct("", ctx);
  }

  // "open a blank" / "open the blank" / "start blank" while already on Docs/Sheets.
  if (
    /\b(?:open(?:\s+up)?|create|make|start|pull\s+up|launch|click|press|tap)\s+(?:me\s+)?(?:a\s+|the\s+|up\s+)?(?:brand\s+)?(?:new|blank|empty|fresh)\b/i.test(
      t,
    ) &&
    !/\b(email|message|tab|window|browser|page|image|video)\b/i.test(t)
  ) {
    if (inferGoogleCreateProduct(t, ctx) || inferGoogleCreateProduct("", ctx)) return true;
  }

  // Explicit product noun + blank/new/create.
  if (
    /\b(?:blank|new|empty|fresh)\s+(?:google\s+)?(sheets?|spreadsheets?|docs?|documents?|slides?|presentations?|decks?|forms?)\b/i.test(
      t,
    ) ||
    /\b(sheets?|spreadsheets?|docs?|documents?|slides?|presentations?|decks?|forms?)\s+(?:that\s+is\s+)?(?:blank|new|empty|fresh)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(create|make|start|open(?:\s+up)?|pull\s+up|launch)\b.{0,40}\b(?:a\s+)?(?:brand\s+)?(?:new|blank|empty|fresh)\b.{0,24}\b(sheets?|spreadsheets?|docs?|documents?|slides?|presentations?|decks?|forms?)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(create|make|start)\s+(?:me\s+)?(?:a\s+)?(?:new\s+|blank\s+)?(sheets?|spreadsheets?|docs?|documents?|slides?|presentations?|decks?|forms?)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  // "click the blank doc" / "blank document button" on the Docs home UI.
  if (
    /\b(click|press|tap|select|hit)\b.{0,40}\b(?:blank|new|empty|fresh)\b.{0,24}\b(sheets?|spreadsheets?|docs?|documents?|slides?|presentations?|decks?|forms?|one|button|tile|card)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

function resolveNewBlankWorkspaceUrl(text, ctx = {}) {
  if (!looksLikeNewBlankWorkspaceAsk(text, ctx)) return "";
  const product = inferGoogleCreateProduct(text, ctx);
  return (product && GOOGLE_CREATE_URLS[product]) || "";
}

/**
 * Follow-ups that need prior chat / live tab context
 * ("blank sheet" after Sheets, "a blank one", etc.).
 */
function resolveContextualBrowseUrl(text, ctx = {}) {
  const t = String(text || "").trim();
  if (!t) return "";
  const blank = resolveNewBlankWorkspaceUrl(t, ctx);
  if (blank) return blank;

  // Short follow-ups ("play it", "open that", "do it") → resume on the open host.
  if (looksLikeDeicticFollowUp(t) || looksLikePlayMediaFollowUp(t)) {
    const referent = resolveFollowUpReferent(ctx);
    const cur = String(ctx.currentUrl || ctx.priorUrl || "");
    const priorGoal = String(ctx.priorGoal || "").trim();
    const recentBlob = Array.isArray(ctx.recentUserGoals)
      ? ctx.recentUserGoals.join(" ")
      : String(ctx.recentUserGoals || "");
    if (referent && cur) {
      const onTab = searchDeepLinkForUrl(cur, referent);
      if (onTab) return onTab;
    }
    // Known media hosts even if the live URL briefly drifted.
    if (referent) {
      const blob = `${cur} ${priorGoal} ${recentBlob}`;
      if (/spotify/i.test(blob)) {
        return `https://open.spotify.com/search/${encodeURIComponent(referent.slice(0, 160))}`;
      }
      if (/youtube|youtu\.be|\bvideo\b/i.test(blob) && looksLikePlayMediaFollowUp(t)) {
        return youtubeSearchUrl(referent);
      }
    }
  }
  return "";
}

/**
 * Resolve "open X" to a deep link when known, else a Google search for X
 * (caller auto-opens the first result in the background).
 * @param {string} text
 * @param {{ currentUrl?: string, priorGoal?: string, priorAssistant?: string, recentUserGoals?: string[] }} [ctx]
 */
function resolveOpenDestinationUrl(text, ctx = {}) {
  const t = String(text || "").trim();
  if (!t) return "";

  const blank = resolveNewBlankWorkspaceUrl(t, ctx);
  if (blank) return blank;

  // User-starred links beat built-in aliases ("open my board" → their URL).
  const userHit = resolveUserSavedUrl(t);
  if (userHit) return userHit;

  // "my reddit ads thing" → ads.reddit.com, never Google the filler phrase.
  const accountHit = resolveAccountDashboardUrl(t);
  if (accountHit && !/google\.com\/search/i.test(accountHit)) return accountHit;

  for (const [re, url] of SITE_ALIAS_PHRASES) {
    if (re.test(t)) return url;
  }
  const name = extractOpenDestinationName(t);
  if (!name) return extractAliasUrl(t) || "";

  const accountFromName = resolveAccountDashboardUrl(`open my ${name}`);
  if (accountFromName && !/google\.com\/search/i.test(accountFromName)) {
    return accountFromName;
  }

  // "blank sheet" as the open target — use noun + chat/tab context.
  const blankFromName = resolveNewBlankWorkspaceUrl(`open ${name}`, ctx);
  if (blankFromName) return blankFromName;

  for (const [re, url] of SITE_ALIAS_PHRASES) {
    if (re.test(name)) return url;
  }
  const key = name.toLowerCase().replace(/\s+/g, " ").trim();
  if (USER_SITE_ALIASES[key]) return USER_SITE_ALIASES[key];
  if (SITE_ALIASES[key]) {
    // "open doc" / "open sheet" while asking for blank/new → create URL, not home.
    if (/\b(blank|new|empty|fresh)\b/i.test(t) || looksLikeNewBlankWorkspaceAsk(t, ctx)) {
      const product = inferGoogleCreateProduct(key, ctx) || inferGoogleCreateProduct(t, ctx);
      if (product && GOOGLE_CREATE_URLS[product]) return GOOGLE_CREATE_URLS[product];
    }
    return SITE_ALIASES[key];
  }

  // Bare domain typed as the destination.
  if (/^(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?$/i.test(key)) {
    return `https://${key.replace(/^https?:\/\//i, "")}`;
  }

  // Obvious brands (nike, adobe, spotify…) → homepage. Skip Google when sure.
  const wellKnown = resolveWellKnownBrandUrl(name) || resolveWellKnownBrandUrl(key);
  if (wellKnown) return wellKnown;

  // "google sheets" style: first token is a known site but there's more — search the full name
  // (phrases should have caught known products; this is the magic fallback).
  const parts = key.split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && SITE_ALIASES[parts[0]] && parts[0] === "google") {
    return `https://www.google.com/search?q=${encodeURIComponent(name)}`;
  }

  // Known single-token product / site.
  if (parts.length === 1 && SITE_ALIASES[parts[0]]) {
    if (/\b(blank|new|empty|fresh)\b/i.test(t) || looksLikeNewBlankWorkspaceAsk(t, ctx)) {
      const product = inferGoogleCreateProduct(parts[0], ctx) || inferGoogleCreateProduct(t, ctx);
      if (product && GOOGLE_CREATE_URLS[product]) return GOOGLE_CREATE_URLS[product];
    }
    return SITE_ALIASES[parts[0]];
  }

  // "blank doc" / "new sheet" as the whole destination name (no open verb left).
  const productFromName = inferGoogleCreateProduct(name, ctx);
  if (
    productFromName &&
    GOOGLE_CREATE_URLS[productFromName] &&
    (/\b(blank|new|empty|fresh)\b/i.test(name) || looksLikeNewBlankWorkspaceAsk(`open ${name}`, ctx))
  ) {
    return GOOGLE_CREATE_URLS[productFromName];
  }

  // Magic: search for whatever they named; runtime opens the top result quietly.
  // Never Google-search bare Workspace nouns ("doc", "sheet") — use the product home.
  if (
    productFromName &&
    /^(?:google\s+)?(sheets?|spreadsheets?|docs?|documents?|slides?|presentations?|decks?|forms?)$/i.test(
      key,
    )
  ) {
    return (
      SITE_ALIASES[
        productFromName === "sheets"
          ? "sheets"
          : productFromName === "docs"
            ? "docs"
            : productFromName === "slides"
              ? "slides"
              : "forms"
      ] || GOOGLE_CREATE_URLS[productFromName]
    );
  }
  // Unsure → Google search; runtime auto-clicks the top result.
  if (name.length >= 2) {
    return `https://www.google.com/search?q=${encodeURIComponent(name)}`;
  }
  return extractAliasUrl(t) || "";
}

function extractStockTicker(text) {
  const raw = String(text || "");
  const dollar = raw.match(/\$([A-Za-z]{1,5})\b/);
  if (dollar) return dollar[1].toUpperCase();
  const explicit = raw.match(/\b(?:ticker|symbol)\s*[:=]?\s*([A-Za-z]{1,5})\b/i);
  if (explicit) return explicit[1].toUpperCase();
  const lower = raw.toLowerCase();
  const companies = Object.entries(COMPANY_TICKERS).sort((a, b) => b[0].length - a[0].length);
  for (const [name, ticker] of companies) {
    if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lower)) {
      return ticker;
    }
  }
  // "google stock" / "GOOGLE stock" when company map didn't catch google-as-site
  if (/\bgoogle\s+stocks?\b/i.test(raw) || /\bstocks?\s+of\s+google\b/i.test(raw)) {
    return "GOOGL";
  }
  const stockWord = raw.match(/\b([A-Za-z]{2,5})\s+stocks?\b/);
  if (stockWord) {
    const w = stockWord[1].toLowerCase();
    if (!SITE_ALIASES[w] && w !== "yahoo" && w !== "the" && w !== "a") {
      return stockWord[1].toUpperCase();
    }
  }
  return "";
}

function isStockBrowseIntent(text) {
  const lower = String(text || "").toLowerCase();
  if (
    !/\b(stock|ticker|shares|quote|nasdaq|nyse|equity|chart|diagram|candlestick|price|valuation)\b/.test(
      lower,
    ) &&
    !/\b(live\s*(time)?\s*feed|real-?time\s+(chart|price|quote)|streaming\s+chart)\b/.test(lower) &&
    !/\b(yahoo\s+finance|yahoo\s+stocks?|trading\s*view|finviz)\b/.test(lower)
  ) {
    return false;
  }
  return !!extractStockTicker(text) || /\b[A-Z]{1,5}\b/.test(text);
}

/**
 * Deep-link stock quote / live chart intents (Yahoo / TradingView).
 * Works even when the user doesn't name a full domain ("tesla stock chart").
 */
function resolveStockBrowseUrl(text) {
  if (!isStockBrowseIntent(text)) return "";
  const ticker = extractStockTicker(text);
  if (!ticker) return "";
  const lower = String(text || "").toLowerCase();
  const wantChart =
    /\b(chart|diagram|graph|candlestick|live\s*(time)?\s*feed|real-?time|streaming|livetime)\b/.test(
      lower,
    );
  const preferTradingView =
    /\btrading\s*view\b/.test(lower) ||
    (wantChart && !/\byahoo\b/.test(lower) && !/\bfinviz\b/.test(lower));
  if (/\bfinviz\b/.test(lower)) {
    return `https://finviz.com/quote.ashx?t=${encodeURIComponent(ticker)}`;
  }
  if (preferTradingView) {
    return `https://www.tradingview.com/symbols/NASDAQ-${encodeURIComponent(ticker)}/`;
  }
  if (wantChart) {
    return `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/chart?p=${encodeURIComponent(ticker)}`;
  }
  // Quote page shows current price — good for "current value of tesla stock"
  return `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}`;
}

function extractUrlFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const withScheme = raw.match(/https?:\/\/[^\s<>"')]+/i);
  if (withScheme) return withScheme[0].replace(/[),.]+$/, "");
  // Bare domains: lykn.io, www.lykn.io, LYKN.io/pricing — but never email domains
  // (david@lykn.io must not become https://lykn.io).
  const bareRe =
    /\b(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s<>"')]*)?/gi;
  let bare;
  while ((bare = bareRe.exec(raw)) !== null) {
    if (bare.index > 0 && raw[bare.index - 1] === "@") continue;
    const hostPath = bare[0].replace(/[),.]+$/, "");
    if (hostPath.includes("@")) continue;
    if (
      /^\d+\.\d+/.test(hostPath) &&
      !/\.[a-z]{2,}/i.test(hostPath.replace(/^\d+\.\d+(\.\d+)*/, ""))
    ) {
      continue;
    }
    return `https://${hostPath}`;
  }
  // "open youtube" / "go to google" — no .com required
  return extractAliasUrl(raw);
}

/**
 * Short clarification replies after a misspelled / ambiguous site ask:
 * "youtube.com", "youtube", "i meant trading view", "try https://x.com".
 * These must navigate — chat-only "Understood, opening…" is not enough.
 */
function resolveSiteClarificationUrl(text) {
  const raw = String(text || "").trim();
  if (!raw || raw.length > 120) return "";
  if (/\b(don't|dont|stop|cancel|never\s+mind|forget it)\b/i.test(raw)) return "";

  const clarifyPrefixRe =
    /^(?:ok[,.]?\s*|yes[,.]?\s*|yeah[,.]?\s*|yep[,.]?\s*|sure[,.]?\s*|please\s+|i\s+meant\s+|it'?s\s+|its\s+|try\s+|use\s+|go\s+with\s+|the\s+site\s+is\s+|the\s+website\s+is\s+|open\s+|visit\s+)/i;
  const hadClarifyPrefix = clarifyPrefixRe.test(raw);
  const stripped = raw.replace(clarifyPrefixRe, "").replace(/[.!?]+$/g, "").trim();
  if (!stripped || stripped.length > 80) return "";

  const withScheme = stripped.match(/^https?:\/\/[^\s<>"')]+/i);
  if (withScheme) return withScheme[0].replace(/[),.]+$/, "");

  const userClarify = matchUserSavedName(stripped);
  if (userClarify) return userClarify;

  for (const [re, url] of SITE_ALIAS_PHRASES) {
    if (re.test(stripped)) return url;
  }

  const lower = stripped.toLowerCase();
  if (USER_SITE_ALIASES[lower]) return USER_SITE_ALIASES[lower];
  if (SITE_ALIASES[lower]) {
    // Avoid treating a lone "x" as Twitter unless they said "i meant x".
    if (lower.length <= 1 && !hadClarifyPrefix) return "";
    return SITE_ALIASES[lower];
  }

  // Bare domain only: youtube.com / www.reddit.com/r/all
  if (/^(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?$/i.test(stripped)) {
    return `https://${stripped.replace(/^https?:\/\//i, "")}`;
  }

  // Single alias token: "youtube", "gmail"
  const token = lower.match(/^([a-z][a-z0-9-]{1,32})$/);
  if (token && SITE_ALIASES[token[1]]) {
    if (token[1].length <= 1 && !hadClarifyPrefix) return "";
    return SITE_ALIASES[token[1]];
  }

  return "";
}

function looksLikeBrowseSiteClarification(text) {
  return !!resolveSiteClarificationUrl(text);
}

function priorAskedForSiteClarification(assistantText) {
  const t = String(assistantText || "");
  if (!t.trim()) return false;
  return /\b(which site|which (page|url|website|domain)|did you mean|which one|can you clarify|could you clarify|what site|what website|spell(?:ing)?|typo|not sure which|couldn't (tell|find|open|resolve)|unable to (tell|find|open)|name the site)\b/i.test(
    t,
  );
}

function stripTrailingSiteFromQuery(q) {
  return String(q || "")
    .replace(/\s+\b(on|in|at)\s+(?:you\s*)?tube(?:\.com)?\b.*$/i, "")
    .replace(/\s+\b(on|in|at)\s+[a-z0-9.-]+\.[a-z]{2,}\b.*$/i, "")
    .replace(
      /\s+\b(on|in|at)\s+(?:youtube|google|bing|reddit|gmail|pinterest|instagram|tiktok|linkedin|facebook|etsy|amazon)\b.*$/i,
      "",
    )
    .replace(/^(me\s+)?(a|an|the)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "pinterest for good icons" / "on youtube cats" → "good icons" / "cats" */
function stripLeadingSiteFromQuery(q) {
  const keys = Object.keys(SITE_ALIASES)
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return String(q || "")
    .replace(new RegExp(`^(?:on|in|at)\\s+(?:${keys})\\s+(?:for\\s+)?`, "i"), "")
    .replace(new RegExp(`^(?:${keys})(?:\\.com)?\\s+(?:for\\s+)?`, "i"), "")
    .replace(/\s+/g, " ")
    .trim();
}

function isWeakPickQuery(q) {
  const t = String(q || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return true;
  if (/^one(\s+you\s+like)?$/.test(t)) return true;
  if (/^(one|something)\s+(you\s+like|that\s+is)\b/.test(t)) return true;
  if (/^you\s+like$/.test(t)) return true;
  // Pronoun / empty follow-ups — need chat context, not a Google search for "it".
  if (/^(it|that|this|them|those|one|song|track|video|thing)$/i.test(t)) return true;
  return false;
}

/** "play thunderstruck" / "go into spotify and play X" — media play with a title. */
function looksLikePlayMediaAsk(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (looksLikePlayMediaFollowUp(t)) return false;
  return (
    /\b(play|listen\s+to|queue|start)\b/i.test(t) &&
    !/\b(play\s+(?:store|button|station)\b)/i.test(t) &&
    extractSearchQuery(t).length >= 2
  );
}

/** "play it" / "ok play that" — needs prior search / open-tab context. */
function looksLikePlayMediaFollowUp(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  return (
    /^(?:ok(?:ay)?[,.]?\s+|alright[,.]?\s+|now[,.]?\s+|please\s+|just\s+)*/.test(t) &&
    /\b(play|listen\s+to|start|resume)\b/.test(t) &&
    /\b(it|that|this|the\s+song|the\s+track|the\s+one|them)\b/.test(t) &&
    t.length < 80
  );
}

/**
 * Short deictic / continuation asks that need chat + open-tab context
 * ("do it", "open that", "go ahead", "play it", "the first one").
 * App-agnostic — not Spotify-only.
 */
function looksLikeDeicticFollowUp(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 160) return false;
  if (looksLikePlayMediaFollowUp(t)) return true;
  const bare = t
    .toLowerCase()
    .replace(
      /^(?:ok(?:ay)?|alright|sure|yeah|yep|yup|now|please|just|then|and)[,.]?\s+/i,
      "",
    )
    .replace(/[.!?]+$/g, "")
    .trim();
  if (!bare) return false;
  // Suggestion-chip continuations ("Keep going from here…", "Continue with another step…").
  if (
    /^(?:keep\s+going|continue|finish(?:\s+(?:it|that|this|anything))?|what(?:'s|\s+is)\s+the\s+best\s+next\s+step)/i.test(
      bare,
    )
  ) {
    return true;
  }
  if (
    /^(?:do\s+it|go\s+ahead|continue|keep\s+going|finish\s+(?:it|that|this)|try\s+(?:it|that|this)|use\s+(?:it|that|this)|open\s+(?:it|that|this|one)|click\s+(?:it|that|this)|press\s+(?:it|that|play)|pick\s+(?:it|that|this|one)|choose\s+(?:it|that|this|one)|select\s+(?:it|that|this|one)|start\s+(?:it|that)|submit\s+(?:it|that)|send\s+(?:it|that)|download\s+(?:it|that)|save\s+(?:it|that)|watch\s+(?:it|that)|the\s+first\s+one|that\s+one|this\s+one)$/i.test(
      bare,
    )
  ) {
    return true;
  }
  // Action + referent only — not "what do you think about this" (chat).
  if (/\b(?:what|how|why|when|where|who)\s+do\s+you\b/.test(bare)) return false;
  if (/\bdo\s+you\b/.test(bare) && !/\bdo\s+you\s+(?:want|need)\s+me\s+to\b/.test(bare)) {
    return false;
  }
  return (
    /\b(do|open|play|click|press|try|use|pick|choose|select|start|finish|complete|send|submit|download|save|watch|listen|resume|draft|reply|edit)\b/.test(
      bare,
    ) &&
    /\b(it|that|this|them|those|one|the\s+one|the\s+first|the\s+top|the\s+song|the\s+track|the\s+video|here|thread|page|tab|email|campaign|draft)\b/.test(
      bare,
    )
  );
}

/** Referent string from prior search / goals (not a pronoun). */
function resolveFollowUpReferent(ctx = {}) {
  const priorQ = String(ctx.lastBrowseQuery || "").trim();
  if (priorQ && !isWeakPickQuery(priorQ)) return priorQ.slice(0, 160);
  const priorGoal = String(ctx.priorGoal || "").trim();
  const fromPrior = extractSearchQuery(priorGoal);
  if (fromPrior && !isWeakPickQuery(fromPrior)) return fromPrior.slice(0, 160);
  const recent = Array.isArray(ctx.recentUserGoals) ? ctx.recentUserGoals : [];
  for (const g of recent) {
    const q = extractSearchQuery(g);
    if (q && !isWeakPickQuery(q)) return q.slice(0, 160);
  }
  // Fall back to a trimmed prior goal if it isn't itself a deictic.
  if (priorGoal && !looksLikeDeicticFollowUp(priorGoal) && priorGoal.length >= 3) {
    return priorGoal.slice(0, 160);
  }
  return "";
}

/**
 * Expand a short follow-up into a concrete in-app goal using chat + open URL.
 * Returns "" when there's nothing useful to expand with.
 */
function expandDeicticFollowUp(text, ctx = {}) {
  const t = String(text || "").trim();
  if (!looksLikeDeicticFollowUp(t)) return "";
  const referent = resolveFollowUpReferent(ctx);
  const cur = String(ctx.currentUrl || ctx.priorUrl || "");
  const priorGoal = String(ctx.priorGoal || "").trim();
  let host = "";
  try {
    host = new URL(cur).hostname.replace(/^www\./i, "");
  } catch {
    host = "";
  }
  const lower = t.toLowerCase();
  let verb = "finish";
  if (/\b(play|listen)\b/.test(lower)) verb = "play";
  else if (/\b(watch)\b/.test(lower)) verb = "watch";
  else if (/\b(open|pull\s+up)\b/.test(lower)) verb = "open";
  else if (/\b(click|press|tap)\b/.test(lower)) verb = "click";
  else if (/\b(download|save)\b/.test(lower)) verb = "download";
  else if (/\b(send|submit)\b/.test(lower)) verb = "submit";
  else if (/\b(pick|choose|select)\b/.test(lower)) verb = "pick";
  else if (/\b(do|finish|complete|go\s+ahead|continue)\b/.test(lower)) verb = "finish";

  if (verb === "play" || verb === "watch") {
    if (!referent) {
      return host
        ? `${verb} the top / matching result in the open ${host} tab`
        : "";
    }
    if (/spotify/i.test(cur + priorGoal + host)) return `play ${referent} on spotify`;
    if (/youtube|youtu\.be/i.test(cur + priorGoal + host)) {
      return `${verb} ${referent} on youtube`;
    }
    return host ? `${verb} ${referent} on ${host}` : `${verb} ${referent}`;
  }

  if (referent && host) {
    return `${verb} “${referent}” in the open ${host} tab — stay on this site`.slice(0, 500);
  }
  if (host) {
    const priorBit = priorGoal ? ` Prior: ${priorGoal.slice(0, 140)}.` : "";
    return `${t} — act in the open ${host} app/tab.${priorBit} Do not Google the pronoun.`.slice(
      0,
      500,
    );
  }
  if (referent) return `${verb} ${referent}`.slice(0, 500);
  return "";
}

/**
 * Adaptive clicker goal: keep short asks grounded in chat + open software.
 * When forceContinuation is set (suggestion chips), always seed prior page/goal
 * so the agent clicks through instead of treating the tip as a cold-start task.
 */
function composeAdaptiveBrowseGoal(text, ctx = {}) {
  const t = String(text || "").trim();
  if (!t) return "";
  const expanded = expandDeicticFollowUp(t, ctx);
  if (expanded && !ctx.forceContinuation) return expanded.slice(0, 500);

  const priorGoal = String(ctx.priorGoal || "").trim();
  const lastQ = String(ctx.lastBrowseQuery || "").trim();
  const priorAsst = String(ctx.priorAssistant || "").replace(/\s+/g, " ").trim();
  const title = String(ctx.pageTitle || "").trim();
  const url = String(ctx.currentUrl || ctx.priorUrl || "").trim();
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    host = "";
  }

  const force = !!ctx.forceContinuation;
  const needsCtx =
    force ||
    !!expanded ||
    (t.length < 180 &&
      /\b(it|that|this|them|those|one|here|page|tab|thread|email|campaign|draft|reply|continue|keep\s+going|next|deeper|summarize|dig|open|edit|share|compare|pause|flag)\b/i.test(
        t,
      ) &&
      !!(priorGoal || url || lastQ));

  if (!needsCtx) return t.slice(0, 500);

  if (force || expanded) {
    const bits = [
      "Continue from the CURRENT browser tab — click through the UI to finish this ask.",
      "Do NOT treat this as a brand-new unrelated task. Do NOT Google the tip unless the user clearly asks to leave.",
      `Next ask: ${t}`,
    ];
    if (priorGoal) bits.push(`Prior goal: ${priorGoal.slice(0, 220)}`);
    if (title || host || url) {
      bits.push(
        `Open page: ${title || host || "current tab"}${url ? ` — ${url.slice(0, 140)}` : ""}`,
      );
    }
    if (priorAsst) bits.push(`What we just finished: ${priorAsst.slice(0, 320)}`);
    if (lastQ && !isWeakPickQuery(lastQ)) bits.push(`Last search: ${lastQ.slice(0, 80)}`);
    if (host) bits.push(`Stay on ${host} unless the ask clearly requires another site`);
    bits.push("Use what’s on screen as context; open, click, type, or scrape as needed.");
    return bits.join("\n").slice(0, 1100);
  }

  const bits = [`Goal: ${t}`];
  if (priorGoal) bits.push(`Prior: ${priorGoal.slice(0, 160)}`);
  if (lastQ && !isWeakPickQuery(lastQ)) bits.push(`Last search: ${lastQ.slice(0, 80)}`);
  if (host) bits.push(`Stay on ${host}`);
  return bits.join(". ").slice(0, 500);
}

/**
 * Compose a useful on-site search query from natural language.
 * "find me blue presentation ideas look for one you like" → "blue presentation ideas"
 * (not the leftover "one you like").
 */
function composeBrowseSearchQuery(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";

  const ATTR_RE =
    /\b(blue|red|green|yellow|orange|purple|pink|black|white|navy|teal|gold|silver|minimal(?:ist)?|modern|vintage|corporate|gradient|dark|light)\b/i;
  const STOP_AFTER =
    /\s+(?:look\s+for\s+one|find\s+(?:me\s+)?one|pick\s+one|choose\s+one|open\s+one|one\s+you\s+like|that\s+is|which\s+is|[,.]|$)/i;

  let topic = "";
  // Prefer "find me TOPIC" / "search for TOPIC" over later "look for one…".
  const findMe = raw.match(
    /\bfind(?:\s+me)?\s+(?!one\b)(.+?)(?=\s+(?:look\s+for\s+one|find\s+(?:me\s+)?one|pick\s+one|choose\s+one|one\s+you\s+like|that\s+is|which\s+is|[,.]|$))/i,
  );
  if (findMe && findMe[1] && !isWeakPickQuery(findMe[1])) {
    topic = findMe[1];
  }
  if (!topic) {
    const searchFor = raw.match(
      /\b(?:search\s+for|look\s+for)\s+(.+?)(?=\s+(?:look\s+for\s+one|find\s+(?:me\s+)?one|pick\s+one|choose\s+one|one\s+you\s+like|that\s+is|which\s+is|[,.]|$))/i,
    );
    if (searchFor && searchFor[1] && !isWeakPickQuery(searchFor[1])) {
      topic = searchFor[1];
    }
  }
  if (!topic) {
    // "blue presentation ideas" sitting near a site name
    const ideas = raw.match(
      /\b((?:blue|red|green|navy|minimal(?:ist)?|modern)\s+)?(?:presentation|slide|deck|pin|recipe|design)\s+ideas?\b/i,
    );
    if (ideas) topic = ideas[0];
  }

  topic = stripBrowseFiller(
    String(topic || "")
      .replace(/\s+and\s+(?:complete|finish|do|take|answer|submit|solve|work\s+through)\b[\s\S]*$/i, " ")
      .replace(STOP_AFTER, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  if (isWeakPickQuery(topic)) topic = "";

  let attr = "";
  const thatIs = raw.match(
    /\b(?:that\s+is|which\s+is|in|colored?)\s+([a-z][a-z-]{2,24})\b/i,
  );
  if (thatIs && ATTR_RE.test(thatIs[1])) attr = thatIs[1].toLowerCase();
  if (!attr) {
    const m = raw.match(ATTR_RE);
    if (m) attr = m[1].toLowerCase();
  }

  if (topic) {
    const parts = [];
    if (attr && !new RegExp(`\\b${attr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(topic)) {
      parts.push(attr);
    }
    parts.push(topic);
    return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 160);
  }

  return "";
}

/** User wants a single matching result opened, not a results page quiz. */
function looksLikePickOneBrowseIntent(text) {
  const lower = String(text || "").toLowerCase();
  if (!lower.trim()) return false;
  if (/\bfind\s+(?:me\s+)?one\b/.test(lower)) return true;
  if (/\blook\s+for\s+one\b/.test(lower)) return true;
  if (/\bone\s+you\s+like\b/.test(lower)) return true;
  if (/\b(pick|choose|select|open)\s+(?:me\s+)?(?:a|an|the|one)\b/.test(lower)) return true;
  if (/\b(?:one|something)\s+that\s+is\b/.test(lower)) return true;
  if (/\b(blue|red|green|navy|minimal|modern)\s+one\b/.test(lower)) return true;
  // "find a physics quiz" / "search for a practice exercise" → open a match, don't stall.
  if (
    /\b(find|search|look\s+for|open|pull\s+up)\b/.test(lower) &&
    /\b(quiz|quizzes|exercise|exercises|lesson|lessons|practice|worksheet|test|exam|course)\b/.test(
      lower,
    )
  ) {
    return true;
  }
  return false;
}

function extractSearchQuery(text) {
  const raw = String(text || "");
  // Pronoun / deictic follow-ups — need chat context, not a Google query for "it".
  if (looksLikePlayMediaFollowUp(raw) || looksLikeDeicticFollowUp(raw)) return "";
  // Chatty "look at … ideas on pinterest" — use the inspo topic, not compose's
  // weaker leftover ("design ideas") or the whole sentence.
  if (
    looksLikeInspoBrowseIntent(raw) &&
    /\blook(?:ing)?\s+at\b/i.test(raw) &&
    /\b(pinterest|dribbble|behance)\b/i.test(raw)
  ) {
    const inspoLook = extractInspoSearchQuery(raw);
    if (inspoLook) return inspoLook;
  }
  // On-site "look for X find one that is blue" needs compose (attr + pick).
  const composed = composeBrowseSearchQuery(raw);
  if (composed) return stripBrowseFiller(composed);
  if (looksLikeInspoBrowseIntent(raw)) {
    const inspo = extractInspoSearchQuery(raw);
    if (inspo) return inspo;
  }

  // "search pinterest for good incognito icons" / "pinterest search for icons"
  const siteKeys = Object.keys(SITE_ALIASES)
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const siteFor = raw.match(
    new RegExp(
      `\\b(?:search|find(?:\\s+me)?|look(?:\\s+(?:for|up))?)\\s+(?:on\\s+)?(?:${siteKeys})(?:\\.com)?\\s+for\\s+["']?([^"'.,\\n]+?)["']?(?:\\s*$|[.,]\\s)`,
      "i",
    ),
  );
  if (siteFor && siteFor[1]) {
    const q = stripBrowseFiller(stripTrailingSiteFromQuery(siteFor[1]));
    if (q && !isWeakPickQuery(q) && !SITE_ALIASES[q.toLowerCase()]) return q;
  }
  const siteSearch = raw.match(
    new RegExp(
      `\\b(?:${siteKeys})(?:\\.com)?\\s+search(?:\\s+(?:up|for|on))?\\s+["']?([^"'.,\\n]+?)["']?(?:\\s*$|[.,]\\s)`,
      "i",
    ),
  );
  if (siteSearch && siteSearch[1]) {
    const q = stripBrowseFiller(stripTrailingSiteFromQuery(siteSearch[1]));
    if (q && !isWeakPickQuery(q) && !SITE_ALIASES[q.toLowerCase()]) return q;
  }

  const patterns = [
    // Prefer look-for / search-for before bare "find …"
    /\blook\s+for\s+["']?([^"'.,\n]+?)["']?(?:\s*$|[.,]\s)/i,
    // Require the space after up/for/on so "search up lyknmedia" ≠ query "up lyknmedia".
    /\bsearch(?:\s+(?:up|for|on))?\s+["']?([^"'.,\n]+?)["']?(?:\s*$|[.,]\s)/i,
    /\blook\s+up\s+["']?([^"'.,\n]+?)["']?(?:\s*$|[.,]\s)/i,
    // "find me a mr beast video" — skip "find one that…"
    /\bfind(?:\s+me)?\s+(?!one\b)["']?([^"'.,\n]+?)["']?(?:\s*$|[.,]\s)/i,
    /\bpull\s+up\s+["']?([^"'.,\n]+?)["']?(?:\s*$|[.,]\s)/i,
    /\bshow\s+me\s+["']?([^"'.,\n]+?)["']?(?:\s*$|[.,]\s)/i,
    /\b(?:watch|play)\s+["']?([^"'.,\n]+?)["']?(?:\s*$|[.,]\s)/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m && m[1]) {
      let q = stripLeadingSiteFromQuery(stripTrailingSiteFromQuery(m[1]));
      q = stripBrowseFiller(
        q
          .replace(/\b(?:look\s+for\s+)?one\s+you\s+like\b.*$/i, "")
          .replace(/\bfind\s+(?:me\s+)?one\b.*$/i, "")
          .replace(/\blook\s+for\s+one\b.*$/i, "")
          .replace(/\bthat\s+is\b.*$/i, "")
          .replace(/\s+and\s+(?:complete|finish|do|take|answer|submit|solve|work\s+through)\b[\s\S]*$/i, "")
          .replace(/\s+/g, " ")
          .trim(),
      );
      // Don't treat the site name itself / pick fluff as the query.
      if (
        q &&
        !isWeakPickQuery(q) &&
        !SITE_ALIASES[q.toLowerCase()] &&
        !/^https?:\/\//i.test(q)
      ) {
        return q;
      }
    }
  }
  // "find me a mr beast video the latest one" — loose fallback
  if (
    /\b(find(?:\s+me)?|search(?:\s+(?:up|for))?|look\s+up|look\s+for|pull\s+up|show\s+me|watch|play|looking\s+for)\b/i.test(
      raw,
    )
  ) {
    let q = stripBrowseFiller(stripTrailingSiteFromQuery(cleanBrowseQuery(raw)));
    q = q
      .replace(/\bfind\s+(?:me\s+)?one\b.*$/i, "")
      .replace(/\bthat\s+is\b.*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (q && q.length >= 2 && !SITE_ALIASES[q.toLowerCase()]) return q;
  }
  return "";
}

/** Vague "find me a video / latest MrBeast upload" → YouTube, not a quiz. */
function looksLikeVideoBrowseIntent(text) {
  const lower = String(text || "").toLowerCase();
  if (!lower.trim()) return false;
  // Bare "open youtube" / "go to youtube" is navigation — not "search YouTube for youtube".
  if (
    /^\s*(?:please\s+|can\s+you\s+|could\s+you\s+)?(?:open|go\s+to|visit|pull\s+up|launch|load|browse(?:\s+to)?)\s+(?:up\s+)?(?:(?:a|an|the|my)\s+)?(?:you\s*)?tube(?:\.com)?\s*[.!]?\s*$/i.test(
      text,
    )
  ) {
    return false;
  }
  if (/\b(youtube|youtu\.be|\byt\b)\b/.test(lower)) {
    if (/\b(search|find|look\s*up|pull\s*up|show|watch|play|latest|newest)\b/.test(lower)) {
      return true;
    }
    if (/\b(video|videos|vids?|clip|clips|shorts?|highlights?)\b/.test(lower)) return true;
    // Topic left after stripping the site name ("nba dunks on youtube").
    const withoutYt = lower
      .replace(/\b(on|in|at|via)\s+(?:you\s*)?tube(?:\.com)?\b/g, " ")
      .replace(/\b(?:you\s*)?tube(?:\.com)?\b/g, " ")
      .replace(
        /\b(open|go|to|visit|pull|up|the|a|an|my|please|for|me|can|you|could|and|search|find)\b/g,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim();
    return withoutYt.length >= 2;
  }
  if (/\b(watch|play)\b.{0,48}\b(video|clip|stream|episode|short)\b/.test(lower)) return true;
  if (
    /\b(video|videos|vids?|clip|clips|stream|vlog|shorts?)\b/.test(lower) &&
    /\b(find(?:\s+me)?|search(?:\s+for)?|look\s*up|pull\s*up|show(?:\s+me)?|watch|play|open)\b/.test(
      lower,
    )
  ) {
    return true;
  }
  if (/\b(latest|newest|most\s+recent|recent)\b.{0,48}\b(video|clip|upload|short)\b/.test(lower)) {
    return true;
  }
  if (/\b(video|clip|upload|short)\b.{0,48}\b(latest|newest|most\s+recent)\b/.test(lower)) {
    return true;
  }
  return false;
}

/** User wants the newest upload, not a random result. */
function wantsLatestVideo(text) {
  const lower = String(text || "").toLowerCase();
  return /\b(latest|newest|most\s+recent|recent(?:ly)?\s+(?:uploaded|posted)|new\s+upload)\b/.test(
    lower,
  );
}

/**
 * Turn "a mr beast video the latest one" into a clean YouTube query ("mr beast").
 */
function extractVideoSearchQuery(text) {
  let q = extractSearchQuery(text) || cleanBrowseQuery(text);
  q = stripBrowseFiller(
    String(q || "")
      .replace(/\b(the\s+)?(latest|newest|most\s+recent|recent)\s+(one|video|clip|upload|short)?\b/gi, " ")
      .replace(
        /\b(video|videos|vids?|clip|clips|stream|vlog|shorts?|upload|on\s+youtube|from\s+youtube)\b/gi,
        " ",
      )
      // Trailing play / summarize / research instructions are not part of the query.
      .replace(
        /\s+and\s+(?:play|watch|open|summarize|summarise|research|explain|describe|tell\s+me)\b[\s\S]*$/i,
        " ",
      )
      .replace(/\b(?:play|watch)\s+it\b/gi, " ")
      // "like an nba runns" / "like a cooking" filler
      .replace(/^(?:like\s+)?(?:me\s+)?(?:an?\s+|some\s+|any\s+)/i, "")
      .replace(/\blike\s+(?:an?\s+|some\s+|any\s+)/gi, " ")
      .replace(/^(a|an|the|me|my)\s+/i, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
  // Never search YouTube for the site name itself.
  if (/^(?:you\s*)?tube|yt|youtube\.com$/i.test(q)) return "";
  return q.slice(0, 160);
}

function youtubeSearchUrl(query, { sortByDate = false } = {}) {
  const q = String(query || "").trim();
  if (!q) return "";
  let url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q.slice(0, 160))}`;
  // Sort by upload date (YouTube's "sp" filter token).
  if (sortByDate) url += "&sp=CAI%253D";
  return url;
}

/** Build a search deep-link for a host (YouTube/Google/…). */
function searchDeepLinkForUrl(pageUrl, query, opts = {}) {
  const q = String(query || "").trim();
  if (!q || !pageUrl) return "";
  let host = "";
  try {
    host = new URL(pageUrl).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
  const enc = encodeURIComponent(q.slice(0, 160));
  if (host === "youtube.com" || host === "youtu.be" || host === "m.youtube.com") {
    return youtubeSearchUrl(q, { sortByDate: !!opts.sortByDate });
  }
  if (host === "google.com" || host === "google.co.uk") {
    return `https://www.google.com/search?q=${enc}`;
  }
  if (host === "bing.com") return `https://www.bing.com/search?q=${enc}`;
  if (host === "duckduckgo.com") return `https://duckduckgo.com/?q=${enc}`;
  if (host === "reddit.com" || host === "old.reddit.com") {
    return `https://www.reddit.com/search/?q=${enc}`;
  }
  if (host === "github.com") {
    return `https://github.com/search?q=${enc}&type=repositories`;
  }
  if (host === "amazon.com") {
    return `https://www.amazon.com/s?k=${enc}`;
  }
  if (host === "pinterest.com") {
    return `https://www.pinterest.com/search/pins/?q=${enc}`;
  }
  if (host === "open.spotify.com" || host === "spotify.com") {
    return `https://open.spotify.com/search/${enc}`;
  }
  if (host === "instagram.com") {
    return `https://www.instagram.com/explore/search/keyword/?q=${enc}`;
  }
  if (host === "tiktok.com") {
    return `https://www.tiktok.com/search?q=${enc}`;
  }
  if (host === "linkedin.com") {
    return `https://www.linkedin.com/search/results/all/?keywords=${enc}`;
  }
  if (host === "etsy.com") {
    return `https://www.etsy.com/search?q=${enc}`;
  }
  if (host === "allrecipes.com") {
    return `https://www.allrecipes.com/search?q=${enc}`;
  }
  if (host === "khanacademy.org") {
    return `https://www.khanacademy.org/search?page_search_query=${enc}`;
  }
  if (host === "finance.yahoo.com" || host === "yahoo.com") {
    return `https://finance.yahoo.com/lookup?s=${enc}`;
  }
  if (host === "tradingview.com") {
    return `https://www.tradingview.com/symbols/NASDAQ-${encodeURIComponent(q.toUpperCase().slice(0, 5))}/`;
  }
  return "";
}

/** True when the user is asking to find/search something (likely on the open tab). */
function looksLikeSameTabSearch(text) {
  const lower = String(text || "").toLowerCase();
  if (
    !/\b(find(?:\s+me)?|search(?:\s+for)?|look\s+up|pull\s+up|show\s+me|watch|play)\b/.test(lower)
  ) {
    return false;
  }
  // Explicitly jumping to another major site → not same-tab.
  if (
    /\b(on|in|at|via)\s+(google|bing|duckduckgo|yahoo|reddit|twitter|gmail)\b/.test(lower) &&
    !/\b(on|in|at)\s+(you\s*)?tube\b/.test(lower)
  ) {
    return false;
  }
  return true;
}

/** "pull it up on youtube" / "search that on youtube" — retarget prior query. */
function looksLikeRetargetSearchToSite(text) {
  const lower = String(text || "").toLowerCase();
  return (
    /\b(pull\s+(it\s+)?up|search|find|open|show|watch|play)\b/.test(lower) &&
    /\b(on|in|at)\s+(?:you\s*)?tube\b/.test(lower)
  ) || (
    /\b(no|not\s+google|wrong)\b/.test(lower) &&
    /\b(you\s*)?tube\b/.test(lower)
  );
}

function isPlaceholderAgentUrl(url) {
  const u = String(url || "");
  if (!u || /^about:blank$/i.test(u)) return true;
  // Empty agent tab welcome page (file://…/agent-browser-welcome.html or lykn://new-tab).
  if (/^lykn:\/\/new-tab\b/i.test(u)) return true;
  if (/agent-browser-welcome\.html(?:[?#]|$)/i.test(u)) return true;
  // Report/artifact tabs use data:text/html;base64,… — those are real pages.
  // Only treat tiny non-base64 data URLs (legacy welcome fallback) as empty.
  if (/^data:/i.test(u)) {
    if (/^data:text\/html;charset=utf-8;base64,/i.test(u)) return false;
    if (/;base64,/i.test(u) && u.length > 1500) return false;
    return true;
  }
  return false;
}

/** Follow-ups that mean "keep acting on the already-open tab" (not chat about it). */
function looksLikeCurrentTabTask(text) {
  const lower = String(text || "").toLowerCase();
  // Pure Q&A / opinions about the page are conversational — not browse tasks.
  if (looksLikePageQuestionAsk(text) && !looksLikeBrowseActAsk(text)) return false;
  if (looksLikeCasualConversation(text) && !looksLikeBrowseActAsk(text)) return false;
  // Action-y stay-on-tab language (not mere mention of "this page").
  if (
    /\b(another step here|from here|keep going|continue with|dig deeper|go deeper|draft a reply|edit (or|what)|tighten the|compare spend|open a campaign|open the first|check drafts|add columns|build a quick chart)\b/.test(
      lower,
    )
  ) {
    return true;
  }
  // "go to my gmail and check…" is a navigate+review ask, not a stay-on-tab follow-up.
  if (
    /\b(go\s+to|open|visit|pull\s+up|navigate\s+to|browse\s+to|launch)\b.{0,32}\b(?:my\s+|the\s+)?(gmail|inbox|outlook|mail)\b/.test(
      lower,
    )
  ) {
    return false;
  }
  if (
    /\b(emails?|inbox|messages?|gmail)\b/.test(lower) &&
    /\b(top\s+(ten|\d+)|see|show|list|review|scan|go through|read|check|flag|respond|reply|important|anything i need|can you|could you|what('s| is)|need to)\b/.test(
      lower,
    ) &&
    // "what are emails?"-style definitions stay chat; inbox review keeps browse.
    !/\b(what (?:is|are|does)|define|explain)\b.{0,20}\b(email|inbox|gmail)\b/.test(lower)
  ) {
    return true;
  }
  return false;
}

/** Signed-in Gmail app inbox URL (not the marketing /about page). */
function gmailInboxUrl() {
  return "https://mail.google.com/mail/u/0/#inbox";
}

/** Gmail Drafts label. */
function gmailDraftsUrl() {
  return "https://mail.google.com/mail/u/0/#drafts";
}

/** "check my drafts" / "open drafts" — review the Drafts folder. */
function looksLikeMailDraftsReview(text) {
  const lower = String(text || "").toLowerCase();
  if (!lower.trim()) return false;
  if (looksLikeMailComposeTask(text) || looksLikeMailDraftRevision(text)) return false;
  if (/\bdrafts?\b/.test(lower) && /\b(check|see|show|open|look|review|list|go\s+to|pull\s+up)\b/.test(lower)) {
    return true;
  }
  if (/\b(my\s+)?drafts?\b/.test(lower) && lower.length <= 48) return true;
  return false;
}

/** Public Gmail product/about pages — no inbox rows to scrape. */
function looksLikeGmailPublicPage(url) {
  try {
    const u = new URL(String(url || ""));
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    const path = (u.pathname || "/").toLowerCase();
    if (host === "gmail.com") return true;
    if (host === "google.com" && /^\/gmail(\/|$)/i.test(path)) return true;
    if (host === "workspace.google.com" && /gmail/i.test(path)) return true;
    // Bare mail.google.com (no /mail/u/… app path) often serves the promo interstitial.
    if (host === "mail.google.com" && !/\/mail\//i.test(path)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Marketing / signed-out Gmail interstitial copy — even when the address bar
 * still shows mail.google.com/mail/u/0/#inbox during a redirect.
 */
function looksLikeGmailPublicContent(text, title = "") {
  const t = `${String(title || "")}\n${String(text || "")}`.toLowerCase();
  if (!t.trim()) return false;
  // Real inbox chrome — not the promo page.
  if (
    /\b(compose|primary|social|promotions|updates|forums|\[inbox\]|unread)\b/.test(t) &&
    /\b(inbox|mail\.google\.com)\b/.test(t)
  ) {
    // Still catch explicit promo CTAs that dominate the page.
    if (!/\b(create (an )?account|for work|get gmail|sign in to (continue|gmail))\b/.test(t)) {
      return false;
    }
  }
  const promoHits = [
    /\bcreate (an )?account\b/,
    /\bfor work\b/,
    /\bget gmail\b/,
    /\bsecure, smart, and easy\b/,
    /\bgmail is email\b/,
    /\bsee gmail in action\b/,
    /\bshow me how\b/,
    /\bgoogle workspace\b/,
  ].filter((re) => re.test(t)).length;
  return promoHits >= 2;
}

/** True when the tab is Gmail but not a usable signed-in inbox. */
function looksLikeGmailNeedsSignIn({ url, text, title } = {}) {
  if (looksLikeGmailPublicPage(url)) return true;
  if (looksLikeGmailPublicContent(text, title)) return true;
  const u = String(url || "").toLowerCase();
  if (/accounts\.google\.|serviceLogin|signin/i.test(u) && /mail|gmail|continue=/i.test(u)) {
    return true;
  }
  return false;
}

/** User wants their inbox reviewed (unanswered / top emails / reply needed…). */
function looksLikeMailInboxReview(text) {
  const lower = String(text || "")
    .toLowerCase()
    .replace(/\bun\s+opened\b/g, "unopened")
    .replace(/\bun\s+answered\b/g, "unanswered")
    .replace(/\bun\s+read\b/g, "unread");
  if (!lower.trim()) return false;
  if (
    !/\b(gmail|inbox|emails?|messages?|mail|outlook)\b/.test(lower) &&
    !/\b(unanswered|unopened|unread)\b/.test(lower)
  ) {
    return false;
  }
  return /\b(unanswered|unopened|unread|reply|respond|need to (reply|respond)|top\s+(ten|\d+)|go through|review|check|scan|look\s+(to\s+see|through|at)|see if|anything i need|flag)\b/.test(
    lower,
  );
}

/** Open Gmail / check mail — prefer auth→inbox deep link over bare inbox. */
function looksLikeGmailOpenOrReview(text) {
  const lower = String(text || "").toLowerCase();
  // Compose / rewrite asks stay in-page — not a fresh Gmail login navigation.
  if (looksLikeMailComposeTask(text) || looksLikePasteIntoCompose(text)) return false;
  if (looksLikeMailDraftsReview(text)) return true;
  // "emails here" / "top ten emails" on an already-open tab — not a cold open.
  if (/\b(here|this (page|tab|screen)|on this)\b/.test(lower) && !/\bgmail\b/.test(lower)) {
    return false;
  }
  if (/\bgmail\b/.test(lower)) {
    return (
      looksLikeMailInboxReview(text) ||
      /\b(open|go\s+to|visit|pull\s+up|navigate|browse|check|see|look)\b/.test(lower)
    );
  }
  // "open my inbox" / "go to my email" without saying gmail
  return /\b(open|go\s+to|visit|pull\s+up)\b.{0,24}\b(my\s+)?(inbox|emails?|mail)\b/.test(
    lower,
  );
}

/** "go to the sign in page" / "have it go to sign in" — navigate to auth, never Google the phrase. */
function looksLikeSignInNavigation(text) {
  const lower = String(text || "").toLowerCase();
  if (!lower.trim()) return false;
  if (/\b(sign[- ]?up|register|create (an )?account)\b/.test(lower)) {
    return /\b(go\s+to|open|pull\s+up|navigate|show|bring\s+up|take\s+me|have\s+it)\b/.test(
      lower,
    );
  }
  if (!/\b(sign[- ]?in|log[- ]?in|login)\b/.test(lower)) return false;
  if (/\b(sign[- ]?in|log[- ]?in|login)\s+page\b/.test(lower)) return true;
  if (
    /\b(go\s+to|open|pull\s+up|navigate(?:\s+to)?|show|bring\s+up|take\s+me(?:\s+to)?|have\s+it(?:\s+go)?(?:\s+to)?|load)\b/.test(
      lower,
    )
  ) {
    return true;
  }
  return false;
}

/** Google / Gmail account login that continues into the inbox after auth. */
function gmailSignInUrl() {
  const inbox = gmailInboxUrl();
  return (
    "https://accounts.google.com/ServiceLogin?service=mail&continue=" +
    encodeURIComponent(inbox) +
    "&hl=en"
  );
}

/**
 * Resolve a real sign-in URL for the open tab (or Gmail by default).
 * Never returns a Google search for the words "sign in page".
 */
function resolveSignInUrl(text, currentUrl = "") {
  const lower = String(text || "").toLowerCase();
  const wantsSignUp = /\b(sign[- ]?up|register|create (an )?account)\b/.test(lower);
  const wantsSignIn =
    looksLikeSignInNavigation(text) || /\b(sign[- ]?in|log[- ]?in|login)\b/.test(lower);
  if (!wantsSignIn && !wantsSignUp) return "";

  let host = "";
  let href = String(currentUrl || "");
  try {
    host = new URL(href).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    host = "";
  }

  const mailContext =
    /\bgmail\b/.test(lower) ||
    /\binbox\b/.test(lower) ||
    host === "mail.google.com" ||
    host === "gmail.com" ||
    looksLikeGmailPublicPage(href) ||
    (host === "google.com" && /\/gmail/i.test(href));

  if (host === "youtube.com" || host === "youtu.be" || host === "m.youtube.com") {
    const continueTo = encodeURIComponent("https://www.youtube.com/");
    return `https://accounts.google.com/ServiceLogin?service=youtube&continue=${continueTo}&hl=en`;
  }
  if (host === "github.com") {
    return wantsSignUp ? "https://github.com/signup" : "https://github.com/login";
  }
  if (host === "reddit.com" || host === "old.reddit.com") {
    return "https://www.reddit.com/login/";
  }
  if (host === "x.com" || host === "twitter.com") {
    return "https://x.com/i/flow/login";
  }
  if (host === "amazon.com") {
    return "https://www.amazon.com/ap/signin";
  }
  if (host === "pinterest.com") {
    return "https://www.pinterest.com/login/";
  }
  // Gmail / Google mail context, or bare "sign in page" with no other site → Gmail login.
  if (mailContext || host === "google.com" || host === "accounts.google.com" || !host) {
    return gmailSignInUrl();
  }

  // Unknown host: leave empty so the adaptive clicker can press "Sign in".
  return "";
}

/**
 * Act on the already-open site without naming a domain
 * ("go to the sign in page", "click Subscribe", …).
 */
/**
 * Question / explain / summarize / opine about what's already on screen —
 * scrape + answer, not a multi-step click plan.
 */
/**
 * A question whose answer is not written on the page — it is state you have to
 * open something to see: who a file is shared with, what permissions someone
 * has, which members are in a workspace, a document's version history.
 *
 * These read like questions ("who is it shared with?") and route like chat,
 * which answers them from page text that does not contain the answer. Drive
 * shows sharing in a dialog; nothing about it appears in the page until you
 * open it. So the agent has to go and look, which makes this browser work.
 */
function asksAboutAppState(text) {
  const t = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return false;
  return (
    /\bshared with\b/.test(t) ||
    /\b(who|which people|what people)\b[^?]{0,40}\b(?:has|have|can|with)\b[^?]{0,24}\b(?:access|edit|view|see|it|this)\b/.test(t) ||
    /\b(sharing|permission|permissions|access)\s+(?:settings|options|list|rights|level)?\b/.test(t) ||
    /\b(collaborators|shared users|who it'?s shared with|members of)\b/.test(t) ||
    /\b(version|revision)\s+history\b/.test(t)
  );
}

/**
 * An ask about the user's OWN material inside an app — "my drive", "my inbox",
 * "the final folder", "that doc I made".
 *
 * These are errands, not questions. The answer is in an account, behind a
 * navigation or a dialog, and nothing about it is in the page text unless the
 * agent goes and opens it. Read as questions they route to the chat model,
 * which has no browser and can only narrate ("I'm checking now…") while the
 * task quietly never starts — which is exactly what happened to a run asking
 * who a Drive folder was shared with.
 *
 * Deliberately keyed on the user's OWN content: a possessive plus an app noun,
 * or a named product plus something of theirs in it. General knowledge and
 * questions about the open page do not match.
 */
const OWN_APP_NOUN_RE =
  /\b(drive|inbox|mailbox|e-?mails?|gmail|calendar|schedule|docs?|documents?|sheets?|spreadsheets?|slides?|decks?|folders?|files?|notes?|notion|figma|dropbox|photos|albums?|contacts|tasks|todos?)\b/;

const NAMED_APP_RE =
  /\b(google\s+drive|drive\.google|gmail|google\s+docs?|google\s+sheets?|google\s+calendar|notion|figma|dropbox|onedrive|slack|trello|asana|airtable|canva|mailchimp)\b/;

function looksLikeOwnAppContentAsk(text) {
  const t = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return false;
  // "what do you think of this" / "summarize this page" are about what is
  // already on screen — those stay answerable without going anywhere.
  const aboutThisScreen =
    /\b(this|that|the)\s+(page|screen|tab|site|article|post|video|thing)\b/.test(t) ||
    /\b(on|in)\s+(?:my\s+)?screen\b/.test(t) ||
    /\bhere\b/.test(t);
  if (aboutThisScreen && !NAMED_APP_RE.test(t)) return false;
  const possessive = /\b(my|our|mine)\b/.test(t);
  if (possessive && OWN_APP_NOUN_RE.test(t)) return true;
  // "the final folder", "the Q3 deck" alongside a named product.
  if (NAMED_APP_RE.test(t) && /\b(the|that|a)\s+[\w'-]+\s+(folder|file|doc|document|sheet|deck|note|album|event)\b/.test(t)) {
    return true;
  }
  return false;
}

function looksLikePageQuestionAsk(text) {
  const t = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return false;
  // Navigate / mutate elsewhere → not a pure page question.
  if (looksLikeBrowseActAsk(t)) return false;
  // The answer is behind a dialog, not in the page text — going to look is the
  // only way to answer it, so this is browser work rather than a question the
  // chat model can field from what is already on screen.
  if (asksAboutAppState(t)) return false;
  if (
    /\b(what(?:'s| is| are)|how much|how many|how (?:is|are|does|do)|why|when|where|which|who)\b/.test(
      t,
    ) ||
    /\b(tell me|explain|summarize|summarise|describe|break down|analyse|analyze|walk me through|help me understand|catch me up)\b/.test(
      t,
    ) ||
    /\bbased on (this|the page|the data|the screen|my|what(?:'s| is) (?:on|here))\b/.test(t)
  ) {
    return true;
  }
  // Opinions / judgments about the open page ("thoughts on this?", "is this good?").
  if (
    /\b(thoughts|opinions?|take|feedback|honest(?:ly)?|feel(?:ing)?s?)\b/.test(t) ||
    /\b(what do you (?:think|make of|reckon)|do you (?:think|like|notice)|how does (?:this|that|it) (?:look|read|feel|seem)|does this (?:look|seem|read|make sense)|is this (?:good|bad|okay|ok|weird|wrong|right|clear|confusing))\b/.test(
      t,
    ) ||
    /\b(looks? (?:good|bad|weird|off|fine|great|wrong)|seems? (?:off|weird|fine|good|wrong)|makes? sense|confusing|unclear)\b/.test(
      t,
    )
  ) {
    return true;
  }
  // Casual talk that clearly points at the open surface.
  if (
    /\b(this|the|my)\s+(page|tab|screen|site|article|dashboard|doc|document|email|thread)\b/.test(t) &&
    !/\b(click|press|open|go to|visit|navigate|type|fill|submit|delete|scroll|change|edit|update|remove|add|move|rename|replace|rewrite|resize|format|copy|paste|send|share|invite|compose|play|watch|download|upload)\b/.test(
      t,
    )
  ) {
    return true;
  }
  // "check/review my spend/metrics" on an open dashboard = read the numbers.
  if (
    /\b(check|review|look at|see|show me|look over)\b/.test(t) &&
    /\b(spend|spent|budget|impressions?|clicks?|ctr|cpc|ecpm|metrics?|numbers?|stats?|status|performance|data|results?|campaigns?|balance|total|summary|overview|ads?)\b/.test(
      t,
    )
  ) {
    return true;
  }
  if (/\b(what('s| is) on (this|the|my) (page|tab|screen)|what do you see|what(?:'s| is) (?:here|on screen))\b/.test(t)) {
    return true;
  }
  return false;
}

/**
 * Normal chat / small talk / opinions that should NOT spin up browse/act.
 * Still false when the ask clearly wants clicking, navigating, or building.
 */
function looksLikeCasualConversation(text) {
  const t = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (looksLikeBrowseActAsk(t)) return false;
  if (looksLikeInPageAction(t)) return false;
  // Explicit task verbs that mean work, not chat.
  if (
    /\b(research|build|create|generate|make me|write me|draft me|open|visit|go to|navigate|search for|look up|find me|pull up|click|type|fill|submit|install|deploy|fix|debug)\b/.test(
      t,
    )
  ) {
    return false;
  }
  // Phatic / acknowledgements / short reactions.
  if (
    /^(hi|hello|hey|thanks|thank you|thx|ok|okay|cool|nice|got it|makes sense|yeah|yep|yup|nah|nope|lol|haha|wow|interesting|fair|true|right|sure|alright|all good|sounds good|perfect|great|awesome|love it|hate it|idk|i don'?t know)[\s!.?]*$/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /^(?:yeah|yep|yup|ok|okay|right|sure|alright)[,.]?\s+(?:that\s+)?(?:makes sense|sounds (?:good|right|fair)|figured|true|fair|interesting)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/^(?:that|it)\s+makes sense\b/i.test(t)) return true;
  // Greetings with tails ("hey, how's it going?", "good morning!") — chat, not browse.
  if (
    t.length <= 80 &&
    /^(hi|hello|hey|yo|sup|howdy|good (?:morning|afternoon|evening))\b/.test(t)
  ) {
    return true;
  }
  // Identity / capability / small-talk questions about the assistant itself.
  if (
    /\b(how are you|how's it going|how is it going|what's up|whats up|how's your day|hows your day)\b/.test(t) ||
    /\b(who are you|what are you\??$|what can you (?:do|help with)|what do you do\b|what are you capable of|how do you work|what should i ask you)\b/.test(t)
  ) {
    return true;
  }
  // Conversational follow-ups about prior chat (not the page UI).
  if (
    /\b(tell me more|say more|go on|what do you mean|why do you say|can you expand|elaborate|in other words|plain english)\b/.test(
      t,
    )
  ) {
    return true;
  }
  // General knowledge / advice / opinions with no browse destination.
  if (
    /\b(what do you think|thoughts|opinions?|any advice|should i|would you|how would you|help me think|brainstorm|talk (?:to me |with me )?about|chat about|curious(?:\s+(?:about|if|what|how))?|wondering)\b/.test(
      t,
    ) &&
    !/\bhttps?:\/\/|www\./i.test(t)
  ) {
    return true;
  }
  // Short reflective lines about the open content without asking for UI work.
  if (
    t.length <= 140 &&
    /\b(this|that|it)\b/.test(t) &&
    /\b(interesting|weird|cool|nice|confusing|clear|messy|clean|busy|loud|quiet|pretty|ugly|smart|dumb|good|bad|fine|wrong|right)\b/.test(
      t,
    ) &&
    !/\b(click|open|change|edit|fix|delete|move|send)\b/.test(t)
  ) {
    return true;
  }
  return false;
}

/**
 * Needs real browser automation: navigate, click, type, complete, play, etc.
 */
function looksLikeBrowseActAsk(text) {
  const t = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return false;
  // "open rates" / "open to feedback" are not navigate verbs.
  const hasNavigateVerb =
    /\b(go\s+to|visit|pull\s+up|navigate|launch|load|browse\s+to|take\s+me|bring\s+up)\b/.test(
      t,
    ) ||
    (/\bopen(?:\s+up)?\b/.test(t) &&
      !/\bopen\s+rates?\b/.test(t) &&
      !/\bopen\s+to\b/.test(t));
  if (hasNavigateVerb) {
    // Require browse-ish object or destination — not "open to interpretation".
    if (
      /\b(https?:\/\/|www\.|\.com|\.io|gmail|inbox|youtube|docs?|sheets?|slides?|reddit|spotify|browser|tab|page|site|link|url|dashboard|ads?|account)\b/i.test(
        t,
      ) ||
      /\b(open|go\s+to|visit|pull\s+up)\s+(?:up\s+)?(?:my\s+|the\s+|a\s+)?\S+/i.test(t)
    ) {
      return true;
    }
  }
  if (
    /\b(click|press|tap|type|fill|submit|share|invite|compose|send(?:\s+it)?|complete|finish|solve|work\s+through|play|watch|download|upload|delete|scroll|toggle|uncheck)\b/.test(
      t,
    )
  ) {
    return true;
  }
  // "need to respond" / "should I reply" is review language — not a compose act.
  if (
    /\b(reply|respond)\b/.test(t) &&
    !/\b(need to|should i|anything.*(reply|respond)|what.*(reply|respond))\b/.test(t)
  ) {
    return true;
  }
  // Checkbox-style "check the box" — not "check my spend".
  if (/\b(check|uncheck)\b/.test(t) && /\b(box|checkbox|option|mark|tick)\b/.test(t)) {
    return true;
  }
  if (looksLikeShareCurrentPageAsk(text) || looksLikeMailComposeTask(text)) return true;
  if (looksLikeOpenMailItem(text) || looksLikeOpenSearchResult(text)) return true;
  if (looksLikePasteIntoCompose(text) || looksLikeMailReplyTask(text)) return true;
  if (
    looksLikeDeicticFollowUp(text) &&
    /\b(do|click|open|play|send|submit|finish|continue|keep going)\b/.test(t)
  ) {
    return true;
  }
  return false;
}

function looksLikeInPageAction(text) {
  const lower = String(text || "").toLowerCase();
  if (looksLikeOpenMailItem(text)) return true;
  // Mail folder reviews still need the browse scrape path ("check my drafts").
  if (looksLikeMailDraftsReview(text) || looksLikeMailInboxReview(text)) return true;
  // Page Q&A ("what's my spend?", "check my metrics") is NOT an in-page click loop.
  if (looksLikePageQuestionAsk(text) && !looksLikeBrowseActAsk(text)) return false;
  if (/\b(click|press|tap|select|uncheck|toggle|scroll|type|fill|submit)\b/.test(lower)) {
    return true;
  }
  // "check" alone matched "check my ads" — only treat as UI when it's a checkbox/mark.
  if (/\b(check|uncheck)\b/.test(lower) && /\b(box|checkbox|option|mark|tick)\b/.test(lower)) {
    return true;
  }
  // In-app editing ops on the open doc/sheet/editor: "change the font size",
  // "make it bold", "copy that paragraph", "paste it below", "duplicate the slide".
  if (
    /\b(change|set|adjust|increase|decrease|resize|make|format|apply|turn)\b/.test(lower) &&
    /\b(font|font[- ]?size|text\s+size|bold|italic|underline|strikethrough|heading|title\s+style|colou?r|highlight|spacing|line\s+spacing|margins?|alignment|align(?:ed)?|indent|bullet|numbered|caps|case|style|layout|columns?|rows?|cells?|borders?|theme)\b/.test(
      lower,
    )
  ) {
    return true;
  }
  if (/\b(copy|paste|cut|duplicate|undo|redo|select\s+all|highlight\s+(all|everything|the))\b/.test(lower)) {
    return true;
  }
  if (/\b(insert|add|delete|remove)\b.{0,32}\b(table|image|link|comment|page\s+break|header|footer|slide|row|column|bullet|section)\b/.test(lower)) {
    return true;
  }
  // "complete the quiz" / "finish the entire thing" on the open lesson/tab
  if (
    /\b(complete|finish|solve|work\s+through|take|answer)\b/.test(lower) &&
    /\b(quiz|test|exam|exercise|lesson|practice|problem|questions?|entire|whole|all|it|this|that|thing)\b/.test(
      lower,
    )
  ) {
    return true;
  }
  // "click on one of these videos" / "open the first result"
  if (
    /\b(click|open|play|watch|pick|choose|select)\b.{0,48}\b(video|result|link|one|first|second|third|top|that|this)\b/.test(
      lower,
    )
  ) {
    return true;
  }
  // "pull that video up" / "pull it up" (words between pull … up)
  if (/\bpull\s+(that|this|it|the|one).{0,40}\bup\b/.test(lower)) return true;
  if (/\b(open|play|watch)\b.{0,40}\b(video|that|this|it|result|one|song|track)\b/.test(lower)) {
    return true;
  }
  if (looksLikePlayMediaFollowUp(lower) || looksLikeDeicticFollowUp(lower)) return true;
  if (
    /\b(go to|navigate to|open|take me to|bring me to|show me|find|pull up)\b.{0,48}\b(sign[- ]?in|log[- ]?in|login|sign[- ]?up|register|account|settings|profile|menu|home|inbox|search|subscribe|like|notifications?|compose|draft)\b/.test(
      lower,
    )
  ) {
    return true;
  }
  if (
    /\b(sign[- ]?in|log[- ]?in|login)\b/.test(lower) &&
    /\b(page|button|link|for me|please|screen)\b/.test(lower)
  ) {
    return true;
  }
  if (looksLikeShareCurrentPageAsk(text)) return true;
  if (
    looksLikeMailComposeTask(text) ||
    looksLikePasteIntoCompose(text) ||
    looksLikeMailDraftRevision(text)
  ) {
    return true;
  }
  return false;
}

/**
 * "Share this / email this doc to sarah@x.com" — share the OPEN page/file with
 * someone via the page's own share feature (Docs/Sheets/Notion invite dialog),
 * not a fresh Gmail compose.
 */
/**
 * A short "go ahead" reply approving a send/share the agent already prepared
 * ("send it", "ok send", "looks good") — as opposed to a first-run ask that
 * composes something new ("send an email to bob about the meeting").
 */
function looksLikeSendApprovalFollowUp(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t || t.length > 80) return false;
  // Words that can PRECEDE the send verb ("ok now send it", "please send").
  const prefix =
    "(?:ok(?:ay)?|k+|yes|yeah|yea|ya|yep|yup|sure|alright|perfect|great|please|now|go ahead(?: and)?|do it|looks? good|sounds? good|that works|all good|good to go|(?:that'?s )?(?:good|fine|perfect)|lgtm)";
  if (
    new RegExp(
      `^(?:${prefix}[\\s,!.]*)*(?:please\\s+)?(?:send|share|submit|post|publish|ship)\\b(?:\\s+(?:it|this|that|them|the\\s+(?:email|message|draft|doc|document|invite|post|link)))?\\s*(?:off|now|away|out)?[\\s,!.]*$`,
    ).test(t)
  ) {
    return true;
  }
  // Bare approval with no verb ("ya go ahead", "looks good!") — the agent
  // just asked "say send when ready", so a plain yes releases it. Filler-only
  // words ("now", "please", "great") do NOT count on their own.
  const bare =
    "(?:ok(?:ay)?|k+|yes|yeah|yea|ya|yep|yup|sure|alright|go ahead|do it|looks? good|sounds? good|that works|all good|good to go|(?:that'?s )?(?:good|fine|perfect)|lgtm|perfect|approved?|confirm(?:ed)?|ship it|send away)";
  return new RegExp(`^(?:${bare})(?:[\\s,!.]+(?:${bare}|and (?:send|share) it|thanks?|ty))*[\\s,!.]*$`).test(t);
}

function looksLikeShareCurrentPageAsk(text) {
  const lower = String(text || "").toLowerCase();
  if (!lower) return false;
  // Explicit Gmail compose is not Docs Share.
  if (
    /\b(compose|new\s+email|draft\s+(an?\s+)?email|gmail)\b/.test(lower) &&
    !/\b(doc|document|sheet|slides?|essay|paper|file)\b/.test(lower)
  ) {
    return false;
  }
  // Sending an agent-made image/artifact/file → Gmail attach, not page Share.
  if (looksLikeSendDeliverableAsk(lower)) {
    return false;
  }
  const hasEmailAddr = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/.test(lower);
  const deictic =
    /\b(this|that|it)\b/.test(lower) ||
    /\bthe\s+(doc|document|page|file|sheet|spreadsheet|slides?|deck|presentation|notes?|report|essay|paper|draft)\b/.test(
      lower,
    );
  // "write an email to bob@x.com" asks the agent to AUTHOR a message. It says
  // nothing about the page that happens to be open, so reading it as "share
  // this page with bob" invents both the subject of the email and its whole
  // body — which is exactly what happened: a bare compose ask on a Google tab
  // became "email him this link", and the synthesized instruction then read as
  // the user's own words downstream. Sharing what is on screen has to be
  // asked for: some reference to it ("this", "the doc", "the page").
  if (
    /\b(?:write|compose|draft|send|shoot|fire)\b(?:\s+\w+){0,2}\s+(?:an?|the|another)\s+(?:new\s+|quick\s+|short\s+)?(?:e-?mail|message|note|dm)\b/.test(
      lower,
    ) &&
    !deictic
  ) {
    return false;
  }
  // "click/open the email to open it" is NOT Docs Share — ignore action verbs after to/with.
  const toRecipient =
    hasEmailAddr ||
    /\b(?:with|to)\s+(?!open\b|view\b|read\b|click\b|see\b|check\b|show\b|pull\b)[\w.+@-]/.test(
      lower,
    );
  if (/\b(share|send|email|forward)\b/.test(lower) && deictic && toRecipient) {
    return true;
  }
  // "send to elijah@lykn.io" / "email bob@x.com" after a write ask — no "it" needed.
  if (
    hasEmailAddr &&
    /\b(?:send|share|email|forward|invite)\b.{0,40}\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/.test(
      lower,
    )
  ) {
    return true;
  }
  // "invite bob@x.com (to this doc)" / "give sarah access"
  if (/\binvite\b/.test(lower) && (hasEmailAddr || deictic)) return true;
  if (/\bgive\b.{0,40}\baccess\b/.test(lower) && (hasEmailAddr || deictic)) return true;
  return false;
}

/**
 * Send/email an agent-created image, artifact, PDF, or downloadable file
 * (not sharing the open Docs/Notion page).
 */
function looksLikeSendDeliverableAsk(text) {
  const lower = String(text || "").toLowerCase();
  if (!lower.trim()) return false;
  const hasEmail = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/.test(lower);
  const wantsSend = /\b(send|email|forward|attach|mail)\b/.test(lower);
  if (!hasEmail || !wantsSend) return false;
  // Explicit file/image/artifact language.
  if (
    /\b(image|picture|photo|png|jpe?g|webp|gif|artifact|html|pdf|attachment|download|file you (made|created|generated)|generated (image|file)|last (image|picture|artifact|file))\b/.test(
      lower,
    )
  ) {
    return true;
  }
  // "send this/it to email" when talking about an image/artifact context.
  if (
    /\b(this|that|it)\b/.test(lower) &&
    /\b(image|picture|photo|artifact|file|download)\b/.test(lower)
  ) {
    return true;
  }
  return false;
}

/** User wants the email actually sent (not just drafted). */
function looksLikeExplicitMailSendAsk(text) {
  const lower = String(text || "").toLowerCase();
  if (/\b(don'?t send|do not send|draft only|just draft|don'?t actually send)\b/.test(lower)) {
    return false;
  }
  return /\b(send(\s+it)?(\s+now)?|go ahead and send|actually send|send the (email|message|mail))\b/.test(
    lower,
  );
}

/** True for Docs/Sheets share OR "send/share it to email@…". */
function isShareInviteGoal(text) {
  if (looksLikeSendDeliverableAsk(text)) return false;
  return (
    looksLikeShareCurrentPageAsk(text) ||
    /\b(share|invite|give\b.{0,20}\baccess)\b/i.test(String(text || ""))
  );
}

/**
 * Strip trailing/mid "then send/share it to email@…" so write drafts don't
 * treat the share instruction as essay body.
 */
function stripShareSendInstructions(text) {
  let s = String(text || "");
  if (!s.trim()) return "";
  s = s.replace(
    /\s*[,;.]?\s*(?:and\s+)?(?:then\s+)?(?:please\s+)?(?:share|send|email|forward|invite)\s+(?:it|this|that|the\s+(?:doc|document|file|sheet|deck|essay|paper|report))?\s*(?:out\s+)?(?:to|with)\s+[\w.+-]+@[\w.-]+(?:\.\w+)*\s*[.!]?\s*/gi,
    " ",
  );
  s = s.replace(
    /\s*[,;.]?\s*(?:and\s+)?(?:then\s+)?(?:please\s+)?(?:share|send|email)\s+(?:to|with)\s+[\w.+-]+@[\w.-]+(?:\.\w+)*\s*[.!]?\s*/gi,
    " ",
  );
  return s.replace(/\s+/g, " ").trim();
}

/** Remove leaked "send it to email@…" lines from drafted document bodies. */
function sanitizeDraftedDocBody(draft) {
  let d = String(draft || "").trim();
  if (!d) return "";
  d = d.replace(
    /\n+\s*[^\n]*(?:then\s+)?(?:send|share|email)\s+(?:it|this|that)\s+to\s+[\w.+-]+@[\w.-]+[^\n]*$/i,
    "",
  );
  d = d.replace(
    /\s*(?:then\s+)?(?:send|share)\s+it\s+to\s+[\w.+-]+@[\w.-]+(?:\.\w+)*\s*$/i,
    "",
  );
  // Topic echo + send instruction glued on (seen in the wild).
  d = d.replace(
    /\n+\s*(?:the\s+)?purpose of life\s+then\s+send\s+it\s+to\s+[\w.+-]+@[\w.-]+[^\n]*$/i,
    "",
  );
  return d.trim();
}

/** Open a search-result video/link on the current page (YouTube results, etc.). */
function looksLikeOpenSearchResult(text) {
  const lower = String(text || "").toLowerCase();
  if (
    /\b(click|open|play|watch|pick|choose|select)\b.{0,48}\b(video|result|link|one|first|second|third|top)\b/.test(
      lower,
    )
  ) {
    return true;
  }
  if (/\bpull\s+(that|this|it|the|one).{0,40}\bup\b/.test(lower)) return true;
  if (/\b(open|play|watch)\b.{0,24}\b(that|this|it|the)\b.{0,24}\b(video|one|result)?\b/.test(lower)) {
    return true;
  }
  if (/\b(that|this)\s+video\b/.test(lower) && /\b(open|play|watch|pull|click)\b/.test(lower)) {
    return true;
  }
  return false;
}

function extractQuotedTitle(text) {
  const raw = String(text || "");
  const curly = raw.match(/[“"]([^”"]{4,160})[”"]/);
  if (curly) return curly[1].trim();
  const straight = raw.match(/'([^']{4,160})'/);
  if (straight) return straight[1].trim();
  return "";
}

/** Unwrap Google /url?q= redirectors to the real destination. */
function unwrapGoogleRedirect(href) {
  const h = String(href || "");
  if (!h) return "";
  try {
    const u = new URL(h);
    if (/google\./i.test(u.hostname) && u.pathname.indexOf("/url") === 0) {
      const q = u.searchParams.get("q") || u.searchParams.get("url");
      if (q && /^https?:\/\//i.test(q)) return q;
    }
  } catch {
    /* ignore */
  }
  return h;
}

/**
 * Read organic Google results and pick the best deep link for a venue host
 * (e.g. canva.com resume templates). Used for silent tool-create magic.
 */
async function peekVenueDeepLinkFromSerp(
  webContents,
  { hostIncludes = "", hint = "", preferPath = "" } = {},
) {
  if (!webContents || webContents.isDestroyed()) return { ok: false };
  const clean = {
    host: String(hostIncludes || "")
      .replace(/^www\./i, "")
      .toLowerCase()
      .slice(0, 80),
    hint: String(hint || "").slice(0, 160),
    preferPath: String(preferPath || "").toLowerCase().slice(0, 80),
  };
  if (!clean.host) return { ok: false, error: "no_host" };
  const payload = Buffer.from(JSON.stringify(clean), "utf8").toString("base64");
  try {
    const result = await webContents.executeJavaScript(
      `(function(){
        var d=JSON.parse(new TextDecoder('utf-8').decode(Uint8Array.from(atob('${payload}'),function(c){return c.charCodeAt(0);})));
        function label(a){
          return String(a.getAttribute('title')||a.getAttribute('aria-label')||a.textContent||'')
            .replace(/\\s+/g,' ').trim();
        }
        function absHref(a){
          try { return a.href || ''; } catch (e) { return a.getAttribute('href') || ''; }
        }
        function unwrap(href){
          try {
            var u=new URL(href);
            if(/google\\./i.test(u.hostname) && u.pathname.indexOf('/url')===0){
              var q=u.searchParams.get('q')||u.searchParams.get('url');
              if(q && /^https?:\\/\\//i.test(q)) return q;
            }
          } catch(e){}
          return href;
        }
        var want=String(d.host||'').toLowerCase();
        var sels=[
          '#search a[href^="http"]',
          '#rso a[href^="http"]',
          'div.g a[href^="http"]',
          'a[jsname][href^="http"]',
          'main a[href^="http"]'
        ];
        var links=[], seen={};
        for(var s=0;s<sels.length;s++){
          document.querySelectorAll(sels[s]).forEach(function(a){
            var href=unwrap(absHref(a));
            if(!href||seen[href]) return;
            if(/^javascript:/i.test(href) || href==='#') return;
            var rh='';
            try { rh=new URL(href).hostname.replace(/^www\\./,'').toLowerCase(); } catch(e){ return; }
            if(rh==='accounts.google.com') return;
            if(rh==='google.com' || /^google\\.[a-z]{2,3}(\\.[a-z]{2})?$/.test(rh)) return;
            if(rh.indexOf(want)===-1 && want.indexOf(rh)===-1) return;
            seen[href]=1;
            links.push({href:href,title:label(a),host:rh});
          });
          if(links.length>=24) break;
        }
        if(!links.length) return {ok:false,error:'no_venue_links'};
        var hint=String(d.hint||'').toLowerCase().replace(/[^a-z0-9\\s]/g,' ').replace(/\\s+/g,' ').trim();
        var words=hint.split(' ').filter(function(w){return w.length>2;});
        var prefer=String(d.preferPath||'');
        var best=links[0], bestScore=-1;
        for(var i=0;i<links.length;i++){
          var href=String(links[i].href||'').toLowerCase();
          var t=String(links[i].title||'').toLowerCase();
          var score=0;
          // Prefer create/blank/edit deep links; templates galleries are a weaker start.
          if(/\\/(create|blank|new|design\\/|edit)\\b/i.test(href)) score+=8;
          if(/\\/(templates?)\\b/i.test(href)) score+=3;
          if(/\\/(resume|cv|presentation|poster|logo|doc|file)\\b/i.test(href)) score+=5;
          if(prefer && href.indexOf(prefer)!==-1) score+=8;
          if(/\\/login|\\/signup|\\/pricing|\\/pro\\b/i.test(href)) score-=8;
          for(var w=0;w<words.length;w++){
            if(t.indexOf(words[w])!==-1) score+=2;
            if(href.indexOf(words[w])!==-1) score+=3;
          }
          // Prefer deeper paths over bare homepage.
          try {
            var path=(new URL(links[i].href)).pathname||'/';
            if(path.length>2) score+=1;
            if(path.split('/').filter(Boolean).length>=2) score+=2;
          } catch(e){}
          if(score>bestScore){ bestScore=score; best=links[i]; }
        }
        return {ok:true,href:best.href,title:best.title||'',count:links.length,score:bestScore};
      })()`,
      true,
    );
    if (result?.ok && result.href) {
      result.href = unwrapGoogleRedirect(result.href);
    }
    return result || { ok: false };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Read the first / best organic result URL from Google (or generic SERP) without clicking.
 * Used for "open X" magic — search in background, land on the destination.
 */
async function peekSearchResultHref(webContents, { hint = "", index = 0 } = {}) {
  if (!webContents || webContents.isDestroyed()) return { ok: false };
  const clean = {
    hint: String(hint || "").slice(0, 160),
    index: Math.max(0, Number(index) || 0),
  };
  const payload = Buffer.from(JSON.stringify(clean), "utf8").toString("base64");
  try {
    const result = await webContents.executeJavaScript(
      `(function(){
        var d=JSON.parse(new TextDecoder('utf-8').decode(Uint8Array.from(atob('${payload}'),function(c){return c.charCodeAt(0);})));
        function label(a){
          return String(a.getAttribute('title')||a.getAttribute('aria-label')||a.textContent||'')
            .replace(/\\s+/g,' ').trim();
        }
        function absHref(a){
          try { return a.href || ''; } catch (e) { return a.getAttribute('href') || ''; }
        }
        function unwrap(href){
          try {
            var u=new URL(href);
            if(/google\\./i.test(u.hostname) && u.pathname.indexOf('/url')===0){
              var q=u.searchParams.get('q')||u.searchParams.get('url');
              if(q && /^https?:\\/\\//i.test(q)) return q;
            }
          } catch(e){}
          return href;
        }
        var host=(location.hostname||'').replace(/^www\\./i,'').toLowerCase();
        var sels=[
          '#search a[href^="http"]',
          '#rso a[href^="http"]',
          'div.g a[href^="http"]',
          'a[jsname][href^="http"]',
          'main a[href^="http"]'
        ];
        var links=[], seen={};
        for(var s=0;s<sels.length;s++){
          document.querySelectorAll(sels[s]).forEach(function(a){
            var href=unwrap(absHref(a));
            if(!href||seen[href]) return;
            if(/^javascript:/i.test(href) || href==='#') return;
            var rh='';
            try { rh=new URL(href).hostname.replace(/^www\\./,'').toLowerCase(); } catch(e){ return; }
            if(rh==='accounts.google.com') return;
            if(rh==='google.com' || /^google\\.[a-z]{2,3}(\\.[a-z]{2})?$/.test(rh)) return;
            if(host.indexOf('google')!==-1 && /\\/(search|preferences|setprefs)/i.test(href)) return;
            seen[href]=1;
            links.push({href:href,title:label(a)});
          });
          if(links.length>=20) break;
        }
        if(!links.length) return {ok:false,error:'no_result_links'};
        var hint=String(d.hint||'').toLowerCase().replace(/[^a-z0-9\\s]/g,' ').replace(/\\s+/g,' ').trim();
        var pick=links[Math.min(d.index||0, links.length-1)];
        if(hint){
          var words=hint.split(' ').filter(function(w){return w.length>2;});
          var best=-1, bestScore=0;
          for(var i=0;i<links.length;i++){
            var t=String(links[i].title||'').toLowerCase().replace(/[^a-z0-9\\s]/g,' ');
            var hh=String(links[i].href||'').toLowerCase();
            if(!t && !hh) continue;
            if(t.indexOf(hint)!==-1 || hh.indexOf(hint.replace(/\\s+/g,''))!==-1){ pick=links[i]; best=-2; break; }
            var score=0;
            for(var w=0;w<words.length;w++){ if(t.indexOf(words[w])!==-1 || hh.indexOf(words[w])!==-1) score++; }
            if(score>bestScore){ bestScore=score; best=i; }
          }
          if(best>=0 && bestScore>=1) pick=links[best];
        }
        return {ok:true,href:pick.href,title:pick.title||'',count:links.length};
      })()`,
      true,
    );
    if (result?.ok && result.href) {
      result.href = unwrapGoogleRedirect(result.href);
    }
    return result || { ok: false };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** Read the first / best Spotify track (or album) URL from a search page. */
async function peekSpotifyResultHref(webContents, { hint = "", index = 0 } = {}) {
  if (!webContents || webContents.isDestroyed()) return { ok: false };
  const clean = {
    hint: String(hint || "").slice(0, 160),
    index: Math.max(0, Number(index) || 0),
  };
  const payload = Buffer.from(JSON.stringify(clean), "utf8").toString("base64");
  try {
    const result = await webContents.executeJavaScript(
      `(function(){
        var d=JSON.parse(new TextDecoder('utf-8').decode(Uint8Array.from(atob('${payload}'),function(c){return c.charCodeAt(0);})));
        function label(a){
          return String(a.getAttribute('title')||a.getAttribute('aria-label')||a.textContent||'')
            .replace(/\\s+/g,' ').trim();
        }
        function absHref(a){
          try { return a.href || ''; } catch (e) { return a.getAttribute('href') || ''; }
        }
        var sels=[
          'a[href*="/track/"]',
          'a[href*="/album/"]',
          'a[href*="/playlist/"]',
          'div[data-testid="tracklist-row"] a[href]',
          'div[data-testid="search-category-card"] a[href*="/track/"]'
        ];
        var links=[], seen={};
        for(var s=0;s<sels.length;s++){
          document.querySelectorAll(sels[s]).forEach(function(a){
            var href=absHref(a);
            if(!href||seen[href]) return;
            if(href.indexOf('/track/')===-1 && href.indexOf('/album/')===-1 && href.indexOf('/playlist/')===-1) return;
            if(/\\/search\\//i.test(href)) return;
            seen[href]=1;
            links.push({href:href,title:label(a),kind:href.indexOf('/track/')!==-1?3:1});
          });
          if(links.length>=20) break;
        }
        if(!links.length) return {ok:false,error:'no_result_links'};
        links.sort(function(a,b){return (b.kind||0)-(a.kind||0);});
        var hint=String(d.hint||'').toLowerCase().replace(/[^a-z0-9\\s]/g,' ').replace(/\\s+/g,' ').trim();
        var pick=links[Math.min(d.index||0, links.length-1)];
        if(hint){
          var words=hint.split(' ').filter(function(w){return w.length>2;});
          var best=-1, bestScore=0;
          for(var i=0;i<links.length;i++){
            var t=String(links[i].title||'').toLowerCase().replace(/[^a-z0-9\\s]/g,' ');
            var hh=String(links[i].href||'').toLowerCase();
            if(!t && !hh) continue;
            if(t.indexOf(hint)!==-1){ pick=links[i]; best=-2; break; }
            var score=(links[i].kind||0);
            for(var w=0;w<words.length;w++){ if(t.indexOf(words[w])!==-1 || hh.indexOf(words[w])!==-1) score+=2; }
            if(score>bestScore){ bestScore=score; best=i; }
          }
          if(best>=0 && bestScore>=1) pick=links[best];
        }
        return {ok:true,href:pick.href,title:pick.title||'',count:links.length};
      })()`,
      true,
    );
    return result || { ok: false };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** Read the first / best YouTube watch URL from a results page (no click). */
async function peekYoutubeResultHref(webContents, { hint = "", index = 0 } = {}) {
  if (!webContents || webContents.isDestroyed()) return { ok: false };
  const clean = {
    hint: String(hint || "").slice(0, 160),
    index: Math.max(0, Number(index) || 0),
  };
  const payload = Buffer.from(JSON.stringify(clean), "utf8").toString("base64");
  try {
    const result = await webContents.executeJavaScript(
      `(function(){
        var raw=atob('${payload}');
        var bytes=new Uint8Array(raw.length);
        for(var i=0;i<raw.length;i++) bytes[i]=raw.charCodeAt(i);
        var d=JSON.parse(new TextDecoder('utf-8').decode(bytes));
        function label(a){
          return String(a.getAttribute('title')||a.getAttribute('aria-label')||a.textContent||'')
            .replace(/\\s+/g,' ').trim();
        }
        function absHref(a){
          try { return a.href || ''; } catch (e) { return a.getAttribute('href') || ''; }
        }
        var sels=[
          'a#video-title-link','a#video-title',
          'ytd-video-renderer a[href*="/watch"]',
          'ytd-rich-item-renderer a[href*="/watch"]',
          'a[href*="/watch?v="]'
        ];
        var links=[], seen={};
        for(var s=0;s<sels.length;s++){
          document.querySelectorAll(sels[s]).forEach(function(a){
            var href=absHref(a);
            if(!href||seen[href]) return;
            if(href.indexOf('/watch')===-1 && href.indexOf('youtu.be/')===-1) return;
            seen[href]=1;
            links.push({href:href,title:label(a)});
          });
          if(links.length>=20) break;
        }
        if(!links.length) return {ok:false,error:'no_result_links'};
        var hint=String(d.hint||'').toLowerCase().replace(/[^a-z0-9\\s]/g,' ').replace(/\\s+/g,' ').trim();
        var pick=links[Math.min(d.index||0, links.length-1)];
        if(hint){
          var words=hint.split(' ').filter(function(w){return w.length>2;});
          var best=-1, bestScore=0;
          for(var i=0;i<links.length;i++){
            var t=String(links[i].title||'').toLowerCase().replace(/[^a-z0-9\\s]/g,' ');
            if(!t) continue;
            if(t.indexOf(hint)!==-1){ pick=links[i]; break; }
            var score=0;
            for(var w=0;w<words.length;w++){ if(t.indexOf(words[w])!==-1) score++; }
            if(score>bestScore){ bestScore=score; best=i; }
          }
          if(best>=0 && bestScore>=1) pick=links[best];
        }
        return {ok:true,href:pick.href,title:pick.title||'',count:links.length};
      })()`,
      true,
    );
    return result || { ok: false };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Click the best matching search result on the open page
 * (YouTube videos, Pinterest pins/boards, generic result links).
 */
async function clickSearchResultOnPage(webContents, { hint = "", index = 0 } = {}) {
  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, error: "no_webcontents" };
  }
  const clean = {
    hint: String(hint || "").slice(0, 160),
    index: Math.max(0, Number(index) || 0),
  };
  const payload = Buffer.from(JSON.stringify(clean), "utf8").toString("base64");
  try {
    const result = await webContents.executeJavaScript(
      `(async function(){
        var raw=atob('${payload}');
        var bytes=new Uint8Array(raw.length);
        for(var i=0;i<raw.length;i++) bytes[i]=raw.charCodeAt(i);
        var d=JSON.parse(new TextDecoder('utf-8').decode(bytes));
        function label(a){
          return String(a.getAttribute('title')||a.getAttribute('aria-label')||a.textContent||'')
            .replace(/\\s+/g,' ').trim();
        }
        function absHref(a){
          try { return a.href || ''; } catch (e) { return a.getAttribute('href') || ''; }
        }
        var host=(location.hostname||'').replace(/^www\\./i,'').toLowerCase();
        var sels=[];
        if(host.indexOf('youtube.com')!==-1 || host.indexOf('youtu.be')!==-1){
          sels=[
            'a#video-title-link',
            'a#video-title',
            'ytd-video-renderer a[href*="/watch"]',
            'ytd-rich-item-renderer a[href*="/watch"]',
            'a[href*="/watch?v="]',
            'a[href*="/watch/"]'
          ];
        } else if(host.indexOf('spotify.com')!==-1){
          sels=[
            'a[href*="/track/"]',
            'div[data-testid="tracklist-row"] a[href*="/track/"]',
            'a[href*="/album/"]',
            'a[href*="/playlist/"]'
          ];
        } else if(host.indexOf('pinterest.')!==-1){
          sels=[
            'a[href*="/pin/"]',
            'div[data-test-id="pin"] a[href]',
            'a[href*="/ideas/"]',
            'a[href*="/board/"]',
            '[data-test-id="search-pin"] a[href]',
            'a[href*="pinterest.com/pin/"]'
          ];
        } else {
          sels=[
            'a#video-title-link',
            'a#video-title',
            'ytd-video-renderer a[href*="/watch"]',
            'a[href*="/watch?v="]',
            '#search a[href^="http"]',
            '#rso a[href^="http"]',
            'a[href*="/pin/"]',
            'main a[href^="http"]'
          ];
        }
        var links=[], seen={};
        for(var s=0;s<sels.length;s++){
          document.querySelectorAll(sels[s]).forEach(function(a){
            var href=absHref(a);
            if(!href||seen[href]) return;
            if(/^javascript:/i.test(href) || href==='#' || href.indexOf('accounts.')!==-1) return;
            if(host.indexOf('youtube')!==-1){
              if(href.indexOf('/watch')===-1 && href.indexOf('youtu.be/')===-1) return;
            }
            if(host.indexOf('pinterest')!==-1){
              if(href.indexOf('/pin/')===-1 && href.indexOf('/ideas/')===-1 && href.indexOf('/board/')===-1) return;
            }
            // Skip Google Search chrome only — keep Docs/Sheets/Drive and other sites.
            if(host.indexOf('google.')!==-1){
              var rh='';
              try { rh=new URL(href).hostname.replace(/^www\\./,'').toLowerCase(); } catch(e){}
              if(rh==='accounts.google.com') return;
              if(rh==='google.com' || /^google\\.[a-z]{2,3}(\\.[a-z]{2})?$/.test(rh)){
                if(href.indexOf('/url?')===-1) return;
              }
            }
            seen[href]=1;
            links.push(a);
          });
          if(links.length>=24) break;
        }
        if(!links.length) return {ok:false,error:'no_result_links',count:0};
        var hint=String(d.hint||'').toLowerCase().replace(/[^a-z0-9\\s]/g,' ').replace(/\\s+/g,' ').trim();
        var pick=null;
        if(hint){
          var words=hint.split(' ').filter(function(w){return w.length>2;});
          var best=-1, bestScore=0;
          for(var i=0;i<links.length;i++){
            var t=label(links[i]).toLowerCase().replace(/[^a-z0-9\\s]/g,' ').replace(/\\s+/g,' ');
            if(!t) continue;
            if(t.indexOf(hint)!==-1 || hint.indexOf(t.slice(0,28))!==-1){ pick=links[i]; break; }
            var score=0;
            for(var w=0;w<words.length;w++){ if(t.indexOf(words[w])!==-1) score++; }
            if(score>bestScore){ bestScore=score; best=i; }
          }
          if(!pick && best>=0 && bestScore>=1) pick=links[best];
        }
        if(!pick){
          var idx=Math.min(d.index||0, links.length-1);
          pick=links[idx];
        }
        var href=absHref(pick);
        try {
          var u=new URL(href);
          if(/google\\./i.test(u.hostname) && u.pathname.indexOf('/url')===0){
            var q=u.searchParams.get('q')||u.searchParams.get('url');
            if(q && /^https?:\\/\\//i.test(q)) href=q;
          }
        } catch(e){}
        var title=label(pick);
        try{ pick.scrollIntoView({block:'center',inline:'center'}); }catch(e){}
        try{ pick.click(); }catch(e1){
          try{ pick.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window})); }catch(e2){}
        }
        return {ok:true,href:href,title:title,count:links.length};
      })()`,
      true,
    );
    if (result?.ok && result.href) {
      result.href = unwrapGoogleRedirect(result.href);
    }
    return result || { ok: false, error: "click_failed" };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** Compose / draft an email — stay on mail, don't chase domains in addresses. */
function looksLikeMailComposeTask(text) {
  const lower = String(text || "").toLowerCase();
  if (looksLikeMailReplyTask(text)) return true;
  if (
    /\b(compose|draft)\b/.test(lower) &&
    /\b(email|e-mail|mail|message|gmail)\b/.test(lower)
  ) {
    return true;
  }
  if (/\b(write|send)\b.{0,24}\b(an?\s+)?(email|e-mail|mail)\b/.test(lower)) return true;
  if (/\b(email|e-mail|mail)\s+to\s+\S+@\S+/i.test(lower)) return true;
  if (/\bdon'?t send\b/.test(lower) && /\b(draft|email|e-mail|mail|compose)\b/.test(lower)) {
    return true;
  }
  return false;
}

/**
 * Reply / "draft a response for that email" — stay on the open thread,
 * don't open a blank compose window.
 */
function looksLikeMailReplyTask(text) {
  const lower = String(text || "").toLowerCase();
  if (!lower.trim()) return false;
  if (
    /\b(reply|respond|response|answer)\b/.test(lower) &&
    /\b(email|e-mail|mail|message|thread|them|him|her|that|this|it)\b/.test(lower)
  ) {
    return true;
  }
  if (
    /\b(draft|write|compose)\b.{0,40}\b(reply|response|respond)\b/.test(lower)
  ) {
    return true;
  }
  if (
    /\b(draft|write)\b.{0,48}\b(response|reply)\b.{0,40}\b(to|for)\b.{0,24}\b(that|this|the|their)?\s*(email|message|one|it)?\b/.test(
      lower,
    )
  ) {
    return true;
  }
  return false;
}

/** Scrape sender / subject / body from an open Gmail thread. */
async function extractOpenMailThread(webContents) {
  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, error: "no_webcontents" };
  }
  try {
    const data = await webContents.executeJavaScript(
      `(function(){
        function clean(s){return ((s||'')+'').replace(/\\s+/g,' ').trim();}
        var subject='', from='', email='', body='';
        var subEl=document.querySelector('h2.hP, h2[data-thread-perm-id], [data-legacy-thread-id] h2, div[role="main"] h2');
        if(subEl) subject=clean(subEl.innerText||subEl.textContent);
        var fromEl=document.querySelector('span.gD[email], span[email].gD, span.gD, h3.iw span[email]');
        if(fromEl){
          from=clean(fromEl.getAttribute('name')||fromEl.innerText||'');
          email=clean(fromEl.getAttribute('email')||'');
        }
        if(!email){
          var any=document.querySelector('span[email], a[mailto]');
          if(any){
            email=clean(any.getAttribute('email')||(any.getAttribute('href')||'').replace(/^mailto:/i,''));
            if(!from) from=clean(any.getAttribute('name')||any.innerText||'');
          }
        }
        var bodyEl=document.querySelector('div.a3s.aiL, div.a3s, div[data-message-id] div.a3s, div.ii.gt div');
        if(bodyEl) body=clean(bodyEl.innerText||bodyEl.textContent).slice(0,5000);
        if(!body){
          var main=document.querySelector('div[role="main"]');
          if(main) body=clean(main.innerText||'').slice(0,5000);
        }
        var ok=!!(subject||from||email||(body&&body.length>40));
        return {ok:ok,subject:subject,from:from,email:email,body:body,url:location.href,title:document.title||''};
      })()`,
      true,
    );
    return data || { ok: false };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** Click Gmail's Reply (or Reply all) on the open thread. */
async function clickGmailReply(webContents, { replyAll = false } = {}) {
  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, error: "no_webcontents" };
  }
  const wantAll = !!replyAll;
  try {
    const pick = await webContents.executeJavaScript(
      `(function(){
        var wantAll=${wantAll ? "true" : "false"};
        function vis(el){if(!el)return false;var r=el.getBoundingClientRect();
          var st=getComputedStyle(el);return r.width>4&&r.height>4&&st.visibility!=='hidden'&&st.display!=='none';}
        function lab(el){return ((el.getAttribute('aria-label')||el.getAttribute('data-tooltip')||el.innerText||'')+'').replace(/\\s+/g,' ').trim();}
        var sels=[
          '[data-tooltip="Reply"]','[data-tooltip="Reply all"]',
          '[aria-label^="Reply"]','[aria-label^="Reply all"]',
          'div[role="button"][aria-label*="Reply"]','span[role="button"][aria-label*="Reply"]',
          'div.T-I.J-J5-Ji.T-I-Js-IF','div.T-I.J-J5-Ji.aaq'
        ];
        var buttons=[];
        for(var s=0;s<sels.length;s++){
          try{document.querySelectorAll(sels[s]).forEach(function(el){
            if(!vis(el)) return;
            var t=lab(el).toLowerCase();
            if(t.indexOf('reply')===-1 && s<6) return;
            buttons.push({el:el,lab:lab(el),all:/reply all/i.test(t)});
          });}catch(e){}
        }
        if(!buttons.length) return {ok:false,error:'no_reply_button'};
        var pick=null;
        for(var i=0;i<buttons.length;i++){
          if(wantAll ? buttons[i].all : !buttons[i].all){ pick=buttons[i]; break; }
        }
        if(!pick) pick=buttons[0];
        var r=pick.el.getBoundingClientRect();
        try{ pick.el.scrollIntoView({block:'center',inline:'nearest'}); }catch(e){}
        r=pick.el.getBoundingClientRect();
        try{ pick.el.click(); }catch(e1){}
        return {ok:true,label:pick.lab,clientX:Math.round(r.left+r.width/2),clientY:Math.round(r.top+r.height/2)};
      })()`,
      true,
    );
    if (!pick?.ok) return pick || { ok: false, error: "no_reply_button" };
    if (typeof pick.clientX === "number") {
      await clickAtClientPoint(webContents, pick.clientX, pick.clientY);
    }
    return { ok: true, label: pick.label || "Reply" };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function extractEmailAddress(text) {
  const m = String(text || "").match(/\b([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\b/i);
  return m ? m[1] : "";
}

/** "paste that into the email" / "put it in the draft" follow-ups. */
function looksLikePasteIntoCompose(text) {
  const lower = String(text || "").toLowerCase();
  return (
    /\b(paste|put|insert|fill|drop)\b.{0,48}\b(that|it|this|the (draft|email|text|message|body))\b/.test(
      lower,
    ) ||
    /\b(paste|put|insert)\b.{0,24}\b(into|in)\b.{0,24}\b(email|draft|compose|body|message|gmail)\b/.test(
      lower,
    ) ||
    /\binto the (email|draft|compose|body|message)\b/.test(lower)
  );
}

/** Tone / rewrite edits for an open or prior mail draft. */
/**
 * Tone / rewrite follow-up for an existing Gmail draft.
 * Without mail nouns, only matches when opts say we already have a mail draft
 * or are on Gmail — otherwise "edit that" / "make it shorter" steals Docs edits.
 */
function looksLikeMailDraftRevision(text, opts = {}) {
  const lower = String(text || "").toLowerCase();
  if (!lower.trim()) return false;

  // Explicit non-mail edit targets never route to Gmail.
  if (
    /\b(docs?|documents?|sheets?|spreadsheets?|slides?|decks?|presentations?|canva|figma|notion|quiz|forms?)\b/.test(
      lower,
    ) &&
    !/\b(email|e-mail|mail|gmail)\b/.test(lower)
  ) {
    return false;
  }

  const hasMailNoun =
    /\b(email|e-mail|mail|gmail|inbox|compose)\b/.test(lower) ||
    /\b(?:email|e-mail|mail)\s*drafts?\b|\bdrafts?\s+(?:of\s+)?(?:an?\s+)?(?:email|e-mail|mail|message)\b/.test(
      lower,
    ) ||
    (/\b(subject|recipient)\b/.test(lower) &&
      /\b(email|e-mail|mail|draft|message|gmail)\b/.test(lower));

  const toneWord =
    /\b(humou?rous|funny|funnier|witty|playful|casual|less serious|more serious|formal|professional|friendlier|shorter|longer|punchier|lighter|sillier)\b/.test(
      lower,
    ) || /\b(less|more)\s+(serious|formal|casual|fun)\b/.test(lower);

  const rewriteAsk =
    /\b(rewrite|rephrase|revise|edit|update|change|tweak|redo)\b/.test(lower) ||
    /\b(make it|make that|make the (email|draft|message)|make one)\b/.test(lower) ||
    /\b(try again|another (version|one|draft)|different (version|tone|draft)|new (version|draft))\b/.test(
      lower,
    );

  if (!toneWord && !rewriteAsk) return false;

  // Explicit mail wording → treat as mail revision.
  if (hasMailNoun) return true;

  // Tone-only / "make it X" / bare "edit that" only when already in mail context.
  if (opts.hasMailDraft || opts.onMail) return true;

  return false;
}

function isGmailComposeUrl(url) {
  const u = String(url || "");
  if (!/mail\.google\.com/i.test(u)) return false;
  return /[?&#](?:view=cm|compose=)|\/mail\/.*compose/i.test(u);
}

/** Plain ASCII-friendly email text — avoids curly quotes / dashes mojibake in Gmail. */
function toPlainEmailText(text) {
  return String(text || "")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014\u2015]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ");
}

function sanitizeMailDraft(draft) {
  const d = draft && typeof draft === "object" ? draft : {};
  return {
    to: String(d.to || "").trim(),
    subject: toPlainEmailText(d.subject || "").trim(),
    body: toPlainEmailText(d.body || ""),
    sender: String(d.sender || "").trim(),
  };
}

/** Recover a structured draft from a prior assistant "Draft ready" message. */
function parseMailDraftFromText(text) {
  const raw = String(text || "");
  if (!raw.trim()) return null;
  const to =
    (raw.match(/\bTo:\s*([^\s\n]+@[^\s\n]+)/i) || [])[1] ||
    extractEmailAddress(raw) ||
    "";
  const subject = ((raw.match(/\bSubject:\s*(.+)$/im) || [])[1] || "").trim();
  let body = "";
  const afterSubject = raw.split(/\bSubject:\s*.+$/im);
  if (afterSubject.length > 1) {
    body = afterSubject
      .slice(1)
      .join("\n")
      .replace(/^\s*/, "")
      .replace(/\n*(Best,?\s*\n.*)?$/i, (m) => m) // keep sign-off
      .trim();
  }
  if (!body) {
    const hi = raw.match(/\b(Hi\b[\s\S]+)$/i);
    if (hi) body = hi[1].trim();
  }
  // Strip leading labels / "Draft ready"
  body = body
    .replace(/^draft\s+ready:?\s*/i, "")
    .replace(/^to:\s*\S+\s*/i, "")
    .replace(/^subject:\s*.+\n*/i, "")
    .trim();
  if (!to && !subject && !body) return null;
  if (!body && !subject) return null;
  return { to, subject, body };
}

/**
 * Build To / Subject / Body from the user goal (and optional prior draft).
 * Used so Gmail compose is filled in-app instead of only dumping text in chat.
 * Revisions / new tone requests always regenerate the body (unless paste-only).
 */
function synthesizeMailDraft(text, priorDraft = null) {
  const raw = String(text || "");
  const prior = priorDraft && typeof priorDraft === "object" ? priorDraft : null;
  const pasteOnly = looksLikePasteIntoCompose(raw) && !looksLikeMailDraftRevision(raw);
  const to = extractEmailAddress(raw) || prior?.to || "";

  const senderMatch =
    raw.match(
      /\b(?:name\s+of\s+(?:the\s+)?sender|sender(?:'s)?\s+name|sign(?:ed|ing)?\s*(?:off\s*)?as|put\s+the\s+name\s+of\s+sender\s+as)\s*:?\s*([A-Za-z][A-Za-z' -]{0,40})/i,
    ) || raw.match(/\bas\s+([A-Z][a-z]{1,20})\b(?:\s*$|\s*[.!,])/);
  let sender = (senderMatch?.[1] || prior?.sender || "").replace(/\s+and\b.*$/i, "").trim();
  if (!sender && /\beli\b/i.test(raw)) sender = "Eli";
  if (!sender) sender = "Eli";

  let subject = pasteOnly ? String(prior?.subject || "").trim() : "";
  const su = raw.match(/\bsubject\s*[:=]\s*["']?([^"'\n]+)/i);
  if (su) subject = su[1].trim();
  else if (!subject) {
    if (/humou?rous|funny|witty|playful|less serious|casual/i.test(raw)) {
      subject = "Quick test from the new LYKN agent 🙂";
    } else if (/test\s+email/i.test(raw) && /lykn\s+agent/i.test(raw)) {
      subject = "Test Email — New LYKN Agent Feature";
    } else if (/test\s+email/i.test(raw)) {
      subject = "Test Email";
    } else if (prior?.subject) {
      subject = prior.subject;
    } else {
      subject = "Hello";
    }
  }

  let body = pasteOnly ? String(prior?.body || "").trim() : "";
  if (!pasteOnly || !body) {
    const first = to.includes("@") ? to.split("@")[0] : "there";
    const greet = first.charAt(0).toUpperCase() + first.slice(1);
    let topic = "This is a test email from the new LYKN agent feature.";
    if (/explaining\s+how\s+(.+?)(?:\s+and\s+put\s+|\s+don'?t\s+|\s*$)/i.test(raw)) {
      const m = raw.match(/explaining\s+how\s+(.+?)(?:\s+and\s+put\s+|\s+don'?t\s+|\s*$)/i);
      if (m?.[1]) {
        let clause = m[1].replace(/\s+just\s+a\s+draft.*$/i, "").trim();
        if (clause && !/\.$/.test(clause)) clause += ".";
        if (clause) topic = clause.charAt(0).toUpperCase() + clause.slice(1);
      }
    }
    if (/humou?rous|funny|funnier|witty|playful|sillier/i.test(raw)) {
      topic =
        "Consider this a friendly ping from the new LYKN agent feature — less boardroom, more \"did the robot actually email me?\" energy. " +
        "If you're reading this, the draft pipeline works. No suits were harmed in the making of this message.";
    } else if (/less serious|casual|lighter|friendlier/i.test(raw)) {
      topic =
        "Just a casual test email from the new LYKN agent feature — nothing formal, just checking that drafts land where they should.";
    } else if (/more serious|formal|professional/i.test(raw)) {
      topic =
        "This is a formal test message generated by the new LYKN agent feature to verify compose and draft workflows.";
    }
    body = `Hi ${greet},\n\n${topic}\n\nBest,\n${sender}`;
  }

  return { to, subject, body, sender };
}

function resolveGmailComposeUrl(text, draft = null) {
  const d = sanitizeMailDraft(
    draft && typeof draft === "object"
      ? draft
      : { to: extractEmailAddress(text), subject: "", body: "" },
  );
  const params = new URLSearchParams({ view: "cm", fs: "1", tf: "1" });
  if (d.to) params.set("to", d.to);
  if (d.subject) params.set("su", String(d.subject).slice(0, 200));
  // Gmail honors body= on the compose deep link (keep short for URL limits).
  if (d.body) params.set("body", String(d.body).slice(0, 1600));
  if (!d.to && !d.subject && !d.body) {
    return "https://mail.google.com/mail/u/0/#inbox?compose=new";
  }
  return `https://mail.google.com/mail/?${params.toString()}`;
}

/** Strip light markdown so a report pastes cleanly into Sheets (one line → one row). */
function markdownReportToSheetText(markdown, title = "") {
  let body = String(markdown || "")
    .replace(/\r\n/g, "\n")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/^\s*\d+\.\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const head = String(title || "").trim();
  if (head && !body.toLowerCase().startsWith(head.toLowerCase())) {
    body = `${head}\n\n${body}`;
  }
  // Cap so Sheets paste stays responsive.
  return body.slice(0, 48000);
}

function looksLikePasteIntoSheets(text) {
  const lower = String(text || "").toLowerCase();
  if (!lower.trim()) return false;
  if (
    /\b(paste|put|enter|fill|drop|write|insert|copy)\b.{0,48}\b(into|in|onto|to)\b.{0,32}\b(sheet|sheets|spreadsheet)\b/.test(
      lower,
    )
  ) {
    return true;
  }
  if (
    /\b(sheet|sheets|spreadsheet)\b.{0,32}\b(with|from)\b.{0,32}\b(report|research|findings?)\b/.test(
      lower,
    )
  ) {
    return true;
  }
  return false;
}

/** "organize the sheet" / "format this spreadsheet" / "clean up the data". */
function looksLikeOrganizeSheetAsk(text) {
  const lower = String(text || "").toLowerCase();
  if (!lower.trim()) return false;
  if (
    /\b(organize|organise|reorganize|reorganise|format|structure|clean\s*up|tidy|arrange|sort|layout|restructure|prettify)\b/.test(
      lower,
    ) &&
    /\b(sheet|sheets|spreadsheet|table|columns?|rows?|data|grid|this|it)\b/.test(lower)
  ) {
    return true;
  }
  if (
    /\b(make|set)\b.{0,24}\b(sheet|spreadsheet|table)\b.{0,24}\b(nicer|cleaner|readable|organized|organised|structured)\b/.test(
      lower,
    )
  ) {
    return true;
  }
  return false;
}

function looksLikeGoogleSheetsUrl(url) {
  return /docs\.google\.com\/spreadsheets/i.test(String(url || ""));
}

function looksLikeGoogleDocsUrl(url) {
  return /docs\.google\.com\/document/i.test(String(url || ""));
}

/**
 * Docs-suite editors sharing the docs chrome (filename box = .docs-title-input):
 * Docs AND Slides. Pastes here need title-field protection or the payload
 * lands in the filename — Slides used to get renamed with a blank canvas.
 * Sheets is separate (grid focus path).
 */
function looksLikeGoogleEditorUrl(url) {
  return /docs\.google\.com\/(document|presentation)/i.test(String(url || ""));
}

function looksLikeCanvasEditorUrl(url) {
  const u = String(url || "");
  return (
    /docs\.google\.com\/(document|spreadsheets|presentation)/i.test(u) ||
    /notion\.(so|site)\//i.test(u) ||
    /figma\.com\/(file|design|proto|board)/i.test(u) ||
    /canva\.com\/design\//i.test(u)
  );
}

/**
 * Click into the real editable surface (Docs page body, Sheets grid, etc.).
 * Avoids the Google Docs title field ("Untitled document").
 */
async function focusPageEditor(webContents) {
  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, error: "no_webcontents" };
  }
  const pageUrl = String(webContents.getURL?.() || "");
  const isGoogleDoc = looksLikeGoogleEditorUrl(pageUrl);
  const isSheets = looksLikeGoogleSheetsUrl(pageUrl);
  try {
    if (isSheets) {
      return focusGoogleSheetGrid(webContents);
    }
    const spot = await webContents.executeJavaScript(
      `(function(){
        var isDoc=${isGoogleDoc ? "true" : "false"};
        function vis(el){
          if(!el) return false;
          var r=el.getBoundingClientRect();
          var st=getComputedStyle(el);
          return r.width>40&&r.height>40&&st.visibility!=='hidden'&&st.display!=='none';
        }
        function isTitle(el){
          if(!el) return false;
          if(el.closest && (
            el.closest('.docs-title-input') ||
            el.closest('#docs-title-widget-container') ||
            el.closest('[aria-label*="Rename" i]') ||
            el.closest('[aria-label*="Document title" i]')
          )) return true;
          var al=((el.getAttribute('aria-label')||'')+(el.getAttribute('data-tooltip')||'')+'').toLowerCase();
          if(/rename|document name|document title/.test(al) && !/document body|document content/.test(al)) return true;
          return false;
        }
        var el=null;
        if(isDoc){
          // Prefer the white page (centered). Editor chrome is wider; left-biased
          // clicks miss the page body.
          var candidates=[
            document.querySelector('.kix-page-paginated .kix-page'),
            document.querySelector('.kix-page'),
            document.querySelector('.kix-page-paginated'),
            document.querySelector('.kix-appview-editor'),
            document.querySelector('.docs-editor-container'),
            document.querySelector('#docs-editor'),
            document.querySelector('.docs-texteventtarget-iframe')
          ];
          for(var i=0;i<candidates.length;i++){
            if(vis(candidates[i]) && !isTitle(candidates[i])){ el=candidates[i]; break; }
          }
        }
        if(!el){
          el=document.querySelector(
            '.punch-viewer-content, #WACViewPanel, [aria-label*="Document content" i], [aria-label*="Document body" i]'
          );
        }
        if(!el){
          var edits=document.querySelectorAll('[contenteditable="true"], div[role="textbox"]');
          for(var j=0;j<edits.length;j++){
            if(vis(edits[j]) && !isTitle(edits[j])){ el=edits[j]; break; }
          }
        }
        if(!el) el=document.querySelector('main')||document.body;
        var r=el.getBoundingClientRect();
        var yOff=isDoc
          ? Math.max(100, Math.min(Math.floor(r.height*0.28), 280))
          : Math.min(140, Math.floor(r.height/2));
        return {
          x: Math.max(24, Math.floor(r.left + r.width*0.5)),
          y: Math.max(isDoc ? 160 : 24, Math.floor(r.top + yOff)),
          w: Math.round(r.width||0),
          h: Math.round(r.height||0),
          foundEditor: !!el && el!==document.body
        };
      })()`,
      true,
    );
    if (spot && Number(spot.x) > 0) {
      // Click twice — Docs sometimes needs a second hit to focus the textevent iframe.
      await clickAtClientPoint(webContents, spot.x, spot.y).catch(() => {});
      await new Promise((r) => setTimeout(r, 120));
      await clickAtClientPoint(webContents, spot.x, Math.min(spot.y + 40, (spot.y || 200) + 80)).catch(
        () => {},
      );
    }
    if (isGoogleDoc) {
      try {
        await webContents.executeJavaScript(
          `(function(){
            var t=document.querySelector('.docs-title-input, input.docs-title-input');
            if(t){ try{ t.blur(); }catch(e){} }
            var iframe=document.querySelector('.docs-texteventtarget-iframe');
            if(iframe && iframe.contentWindow){
              try{
                var b=iframe.contentDocument && iframe.contentDocument.body;
                if(b){ b.focus(); }
              }catch(e2){}
            }
            return true;
          })()`,
          true,
        );
      } catch {
        /* ignore */
      }
    }
    await new Promise((r) => setTimeout(r, 100));
    let titleFocused = false;
    if (isGoogleDoc) {
      try {
        titleFocused = !!(await webContents.executeJavaScript(
          `(function(){
            var t=document.querySelector('.docs-title-input, input.docs-title-input');
            var ae=document.activeElement;
            return !!(t && ae && (ae===t || t.contains(ae)));
          })()`,
          true,
        ));
      } catch {
        titleFocused = false;
      }
    }
    return {
      ok: !titleFocused,
      ...(spot || {}),
      titleFocused,
      error: titleFocused ? "title_still_focused" : undefined,
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function editorTitleStillFocused(webContents) {
  if (!webContents || webContents.isDestroyed()) return false;
  if (!looksLikeGoogleEditorUrl(webContents.getURL?.() || "")) return false;
  try {
    return !!(await webContents.executeJavaScript(
      `(function(){
        var t=document.querySelector('.docs-title-input, input.docs-title-input');
        var ae=document.activeElement;
        return !!(t && ae && (ae===t || t.contains(ae)));
      })()`,
      true,
    ));
  } catch {
    return false;
  }
}

async function focusGoogleSheetGrid(webContents) {
  if (!webContents || webContents.isDestroyed()) return { ok: false };
  try {
    const spot = await webContents.executeJavaScript(
      `(function(){
        var el=document.querySelector('#waffle-grid-container, .grid-container, canvas.grid-canvas, div[role="main"] canvas, canvas');
        if(!el) el=document.body;
        var r=el.getBoundingClientRect();
        var x=Math.max(24, Math.floor(r.left+48));
        var y=Math.max(24, Math.floor(r.top+48));
        try { el.focus(); } catch(e){}
        return {x:x,y:y,w:r.width||0,h:r.height||0};
      })()`,
      true,
    );
    if (spot && Number(spot.x) > 0) {
      await clickAtClientPoint(webContents, spot.x, spot.y).catch(() => {});
    }
    return { ok: true, ...(spot || {}) };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function sendModKey(webContents, keyCode, mod) {
  try {
    webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers: [mod] });
    webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers: [mod] });
  } catch {
    /* ignore */
  }
}

/**
 * Paste report text into the open Google Sheet (A1 downward, one line per row).
 * Uses the system clipboard + Sheets keyboard paste — more reliable than DOM edits.
 * @param {{ text?: string, title?: string, replaceAll?: boolean }} [opts]
 */
async function fillGoogleSheetFromText(webContents, { text, title, replaceAll = false } = {}) {
  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, error: "no_webcontents" };
  }
  const payload = markdownReportToSheetText(text, title);
  if (!payload.trim()) return { ok: false, error: "empty" };

  let clipboard;
  try {
    ({ clipboard } = require("electron"));
  } catch (e) {
    return { ok: false, error: e?.message || "no_clipboard" };
  }
  try {
    clipboard.writeText(payload);
  } catch (e) {
    return { ok: false, error: e?.message || "clipboard_write_failed" };
  }

  await focusGoogleSheetGrid(webContents);
  await new Promise((r) => setTimeout(r, 180));

  const mod = process.platform === "darwin" ? "meta" : "control";
  // Ctrl/Cmd+Home → A1
  sendModKey(webContents, "Home", mod);
  await new Promise((r) => setTimeout(r, 100));

  if (replaceAll) {
    // Select all cells so paste replaces prior dump instead of stacking.
    sendModKey(webContents, "A", mod);
    await new Promise((r) => setTimeout(r, 100));
  }

  try {
    if (typeof webContents.paste === "function") {
      webContents.paste();
    } else {
      webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "V",
        modifiers: [mod],
      });
      webContents.sendInputEvent({
        type: "char",
        keyCode: "v",
        modifiers: [mod],
      });
      webContents.sendInputEvent({
        type: "keyUp",
        keyCode: "V",
        modifiers: [mod],
      });
    }
  } catch (e) {
    return { ok: false, error: e?.message || "paste_failed" };
  }

  await new Promise((r) => setTimeout(r, 450));
  return {
    ok: true,
    chars: payload.length,
    lines: payload.split("\n").length,
    text: payload,
  };
}

/**
 * Generic clipboard paste into the focused page (Docs, Slides, PowerPoint, etc.).
 * Clicks the content area, optionally select-all, then pastes.
 * For Google Docs, intentionally avoids the title field ("Untitled…").
 */
async function pasteTextIntoPage(webContents, { text, replaceAll = false } = {}) {
  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, error: "no_webcontents" };
  }
  const payload = String(text || "");
  if (!payload.trim()) return { ok: false, error: "empty" };

  let clipboard;
  try {
    ({ clipboard } = require("electron"));
  } catch (e) {
    return { ok: false, error: e?.message || "no_clipboard" };
  }
  try {
    clipboard.writeText(payload);
  } catch (e) {
    return { ok: false, error: e?.message || "clipboard_write_failed" };
  }

  const pageUrl = String(webContents.getURL?.() || "");
  const isGoogleDoc = looksLikeGoogleEditorUrl(pageUrl);
  const mod = process.platform === "darwin" ? "meta" : "control";

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const focused = await focusPageEditor(webContents);
    if (isGoogleDoc && focused?.titleFocused) {
      await new Promise((r) => setTimeout(r, 150));
      continue;
    }
    await new Promise((r) => setTimeout(r, 220));
    if (await editorTitleStillFocused(webContents)) {
      continue;
    }
    if (replaceAll) {
      sendModKey(webContents, "A", mod);
      await new Promise((r) => setTimeout(r, 120));
    }
    try {
      webContents.focus();
      if (typeof webContents.paste === "function") webContents.paste();
      else {
        webContents.sendInputEvent({ type: "keyDown", keyCode: "V", modifiers: [mod] });
        webContents.sendInputEvent({ type: "keyUp", keyCode: "V", modifiers: [mod] });
      }
    } catch (e) {
      if (attempt === 2) {
        return { ok: false, error: e?.message || "paste_failed" };
      }
      continue;
    }
    await new Promise((r) => setTimeout(r, 450));
    if (isGoogleDoc && (await editorTitleStillFocused(webContents))) {
      // Paste likely hit the title — undo and retry body focus.
      try {
        sendModKey(webContents, "Z", mod);
  } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 120));
      continue;
    }
    // Docs: if title field now contains our opening words, we missed the body.
  if (isGoogleDoc) {
    try {
        const titleLooksLikePaste = await webContents.executeJavaScript(
        `(function(){
          var t=document.querySelector('.docs-title-input, input.docs-title-input');
            var v=((t&&(t.value||t.textContent))||'').toLowerCase().replace(/\\s+/g,' ').trim();
            var head=${JSON.stringify(payload.slice(0, 48).toLowerCase())};
            return !!(v && head && v.indexOf(head.slice(0, 24))>-1 && v.length>20);
        })()`,
        true,
      );
        if (titleLooksLikePaste) {
          try {
            sendModKey(webContents, "Z", mod);
    } catch {
      /* ignore */
    }
          continue;
  }
      } catch {
        /* ignore */
  }
    }
  return {
    ok: true,
    chars: payload.length,
    lines: payload.split("\n").length,
      text: payload,
      attempts: attempt + 1,
    };
  }
  return {
    ok: false,
    error: "could_not_focus_document_body",
    chars: payload.length,
    text: payload,
  };
}

/**
 * Fill Gmail's compose To / Subject / Body fields in the open tab.
 * Replaces existing body text so revisions actually update the form.
 */
async function fillGmailComposeDraft(webContents, draft) {
  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, to: false, subject: false, body: false };
  }
  const clean = sanitizeMailDraft(draft);
  // UTF-8 → base64; page must TextDecoder — bare atob() Latin-1-mojibakes ’—…
  const payload = Buffer.from(JSON.stringify(clean), "utf8").toString("base64");
  try {
    const result = await webContents.executeJavaScript(
      `(async function(){
        var raw=atob('${payload}');
        var bytes=new Uint8Array(raw.length);
        for(var i=0;i<raw.length;i++) bytes[i]=raw.charCodeAt(i);
        var d=JSON.parse(new TextDecoder('utf-8').decode(bytes));
        function vis(el){
          if(!el)return false;
          var r=el.getBoundingClientRect();
          var st=getComputedStyle(el);
          return r.width>2&&r.height>2&&st.visibility!=='hidden'&&st.display!=='none';
        }
        function setNative(el,val){
          if(!el)return false;
          el.focus();
          var proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
          var desc=Object.getOwnPropertyDescriptor(proto,'value');
          if(desc&&desc.set)desc.set.call(el,val);else el.value=val;
          el.dispatchEvent(new Event('input',{bubbles:true}));
          el.dispatchEvent(new Event('change',{bubbles:true}));
          return true;
        }
        function setEditable(el,val){
          if(!el)return false;
          el.focus();
          try{ el.click(); }catch(e){}
          // Clear prior draft text, then insert the new body.
          try{
            var sel=window.getSelection();
            var range=document.createRange();
            range.selectNodeContents(el);
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand('delete',false,null);
            document.execCommand('insertText',false,val);
          }catch(e1){
            try{
              el.textContent='';
              el.innerText=val;
            }catch(e2){
              el.innerHTML=String(val||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\\n/g,'<br>');
            }
          }
          el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:val}));
          el.dispatchEvent(new Event('change',{bubbles:true}));
          return true;
        }
        var filled={ok:true,to:false,subject:false,body:false};
        // Prefer the frontmost compose dialog.
        var root=document.querySelector('div.M9, div.AD, div[role="dialog"]')||document;
        if(d.to){
          var toSelectors=['textarea[name="to"]','input[name="to"]','textarea[aria-label^="To"]','input[aria-label^="To"]','div[aria-label^="To"] input','div[aria-label^="To"] textarea','form[method="POST"] textarea[name="to"]'];
          for(var i=0;i<toSelectors.length&&!filled.to;i++){
            var els=root.querySelectorAll(toSelectors[i]);
            for(var j=0;j<els.length;j++){
              if(vis(els[j])&&setNative(els[j],d.to)){filled.to=true;break;}
            }
          }
        }
        if(d.subject){
          var sub=root.querySelector('input[name="subjectbox"], input[aria-label*="Subject"], input[name="subject"]');
          if(sub&&vis(sub)) filled.subject=setNative(sub,d.subject);
          if(!filled.subject){
            document.querySelectorAll('input[name="subjectbox"], input[aria-label*="Subject"]').forEach(function(el){
              if(!filled.subject&&vis(el)) filled.subject=setNative(el,d.subject);
            });
          }
        }
        if(d.body){
          var bodySelectors=[
            'div[role="textbox"][aria-label*="Message Body"]',
            'div[role="textbox"][aria-label*="Body"]',
            'div[aria-label="Message Body"]',
            'div.Am.Al[contenteditable="true"]',
            'div.editable[contenteditable="true"]',
            'div[contenteditable="true"][role="textbox"]',
            'div[g_editable="true"]',
            'div[contenteditable="true"]'
          ];
          for(var b=0;b<bodySelectors.length&&!filled.body;b++){
            var nodes=root.querySelectorAll(bodySelectors[b]);
            for(var k=0;k<nodes.length;k++){
              var n=nodes[k];
              if(!vis(n)) continue;
              // Skip tiny chrome / chip fields.
              var r=n.getBoundingClientRect();
              if(r.height<40&&bodySelectors[b].indexOf('contenteditable')>-1) continue;
              if(setEditable(n,d.body)){filled.body=true;break;}
            }
          }
        }
        return filled;
      })()`,
      true,
    );
    return result || { ok: false, to: false, subject: false, body: false };
  } catch (e) {
    return { ok: false, to: false, subject: false, body: false, error: e?.message || String(e) };
  }
}

/**
 * Attach a local file to the open Gmail compose via CDP setFileInputFiles.
 * Clicks "Attach files" first so Gmail's hidden file input exists.
 */
async function attachFileToGmailCompose(webContents, filePath) {
  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, error: "no_webcontents" };
  }
  const abs = pathMod.resolve(String(filePath || ""));
  if (!abs || !fsSync.existsSync(abs)) {
    return { ok: false, error: "missing_file" };
  }
  // Nudge Gmail to mount its file input.
  try {
    await clickInPageByHint(webContents, { hint: "Attach files" });
    await waitForDomSettle(webContents, 500).catch(() => {});
  } catch {
    /* input may already exist */
  }
  let attachedDebugger = false;
  try {
    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach("1.3");
      attachedDebugger = true;
    }
    const doc = await webContents.debugger.sendCommand("DOM.getDocument", {
      depth: 0,
    });
    const rootId = doc?.root?.nodeId;
    if (!rootId) return { ok: false, error: "no_dom" };
    const selectors = [
      'div.M9 input[type="file"]',
      'div.AD input[type="file"]',
      'div[role="dialog"] input[type="file"]',
      'input[type="file"][name="Filedata"]',
      'input[type="file"][accept]',
      'input[type="file"]',
    ];
    let nodeId = 0;
    for (const sel of selectors) {
      try {
        const q = await webContents.debugger.sendCommand("DOM.querySelector", {
          nodeId: rootId,
          selector: sel,
        });
        if (q?.nodeId) {
          nodeId = q.nodeId;
          break;
        }
      } catch {
        /* try next */
      }
    }
    if (!nodeId) {
      return { ok: false, error: "no_file_input" };
    }
    await webContents.debugger.sendCommand("DOM.setFileInputFiles", {
      nodeId,
      files: [abs],
    });
    await waitForDomSettle(webContents, 900).catch(() => {});
    return { ok: true, path: abs, name: pathMod.basename(abs) };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    if (attachedDebugger) {
      try {
        webContents.debugger.detach();
      } catch {
        /* ignore */
      }
    }
  }
}

/** Click Gmail's Send in the open compose dialog. */
async function clickGmailSend(webContents) {
  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, error: "no_webcontents" };
  }
  try {
    const hit = await webContents.executeJavaScript(
      `(function(){
        function vis(el){
          if(!el)return false;var r=el.getBoundingClientRect();
          if(r.width<8||r.height<8)return false;
          var st=getComputedStyle(el);
          return st.visibility!=='hidden'&&st.display!=='none'&&st.pointerEvents!=='none';
        }
        function lab(el){
          return ((el.getAttribute('aria-label')||el.getAttribute('data-tooltip')||
            el.getAttribute('title')||el.innerText||'')+'').replace(/\\s+/g,' ').trim();
        }
        var roots=[].slice.call(document.querySelectorAll(
          'div.M9, div.AD, div[role="dialog"], form'
        )).filter(vis);
        if(!roots.length) roots=[document.body];
        var best=null,bestScore=-1;
        for(var r=0;r<roots.length;r++){
          var nodes=[].slice.call(roots[r].querySelectorAll(
            'div[role="button"],button,[role="button"]'
          ));
          for(var i=0;i<nodes.length;i++){
            var n=nodes[i]; if(!vis(n)) continue;
            var L=lab(n); if(!L) continue;
            var sc=0;
            if(/^send$/i.test(L)) sc=120;
            else if(/^send\\b/i.test(L) && /⌘|ctrl|enter|\\(/i.test(L)) sc=110;
            else if(/^send\\b/i.test(L) && !/invite|share/i.test(L)) sc=100;
            if(sc<=bestScore) continue;
            bestScore=sc; best=n;
          }
        }
        if(!best||bestScore<100) return {ok:false,error:'send_not_found'};
        var box=best.getBoundingClientRect();
        try{best.scrollIntoView({block:'center'});}catch(e){}
        box=best.getBoundingClientRect();
        try{best.click();}catch(e){}
        return {ok:true,label:lab(best).slice(0,80),
          x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)};
      })()`,
      true,
    );
    if (!hit?.ok) return hit || { ok: false, error: "send_not_found" };
    if (hit.x && hit.y) {
      await clickAtClientPoint(webContents, hit.x, hit.y);
    }
    await waitForDomSettle(webContents, 1000).catch(() => {});
    return { ok: true, label: hit.label || "Send" };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** Known same-site destinations when the user is already on a host. */
function resolveInPageTargetUrl(text, currentUrl) {
  const lower = String(text || "").toLowerCase();
  if (!currentUrl || isPlaceholderAgentUrl(currentUrl)) return "";
  let host = "";
  try {
    host = new URL(currentUrl).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }

  // Replies must stay on the open thread — never bounce to blank compose=new.
  if (
    looksLikeMailComposeTask(text) &&
    !looksLikeMailReplyTask(text) &&
    (host === "mail.google.com" || host === "gmail.com")
  ) {
    return resolveGmailComposeUrl(text);
  }

  if (
    looksLikeMailDraftsReview(text) &&
    (host === "mail.google.com" ||
      host === "gmail.com" ||
      host === "google.com" ||
      host === "accounts.google.com")
  ) {
    return gmailDraftsUrl();
  }

  if (
    /\b(inbox)\b/.test(lower) &&
    /\b(go\s+to|open|show|check|see|pull\s+up)\b/.test(lower) &&
    (host === "mail.google.com" || host === "gmail.com")
  ) {
    return gmailInboxUrl();
  }

  const wantsSignIn = /\b(sign[- ]?in|log[- ]?in|login)\b/.test(lower);
  const wantsSignUp = /\b(sign[- ]?up|register|create account)\b/.test(lower);
  if (!wantsSignIn && !wantsSignUp) return "";

  // Prefer the shared resolver (Gmail continue=inbox, YouTube, etc.).
  const resolved = resolveSignInUrl(text, currentUrl);
  if (resolved) return resolved;

  // Unknown hosts: leave empty so the adaptive clicker can press "Sign in".
  return "";
}

function looksLikeSignedInMailUrl(url) {
  try {
    const u = new URL(String(url || ""));
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (looksLikeGmailPublicPage(u.href)) return false;
    if (host === "mail.google.com") {
      if (/accounts\.google|ServiceLogin|signin/i.test(u.href)) return false;
      // Require the app path so promo landings don't count as signed-in.
      if (!/\/mail\//i.test(u.pathname || "")) return false;
      return true;
    }
    if (host === "outlook.live.com" || host === "outlook.office.com") return true;
    return false;
  } catch {
    return false;
  }
}

function looksLikeSignInPageText(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  const hits = [
    /\bsign[- ]?in\b/,
    /\blog[- ]?in\b/,
    /\blog into\b/,
    /\bcreate (an )?account\b/,
    /\bforgot (email|password)\b/,
    /\buse your google account\b/,
    /\benter your (email|password)\b/,
    /\bcontinue with (google|apple|facebook|microsoft|github)\b/,
    /\bsign in to continue\b/,
    /\blog in to continue\b/,
    /\bemail or phone\b/,
    /\bnext\s*$/m,
  ].filter((re) => re.test(t)).length;
  // Strong sign-in chrome — avoid false positives from an email subject mentioning "sign in"
  return (
    hits >= 2 ||
    /\buse your google account\b/.test(t) ||
    /\b(sign|log)\s*in to continue\b/.test(t)
  );
}

/**
 * True when the open tab is blocked by auth (login host, /login path, or
 * soft wall / modal) so the agent should pause for the user to sign in.
 */
/**
 * Soft paywall / upgrade gate (Canva Pro, Notion paid, etc.).
 * Distinct from login — user may be signed in but blocked from the feature.
 */
function looksLikePaywall({ url, text, title } = {}) {
  const u = String(url || "").toLowerCase();
  const t = String(text || "").toLowerCase();
  const titleL = String(title || "").toLowerCase();
  if (/\/(pricing|upgrade|pro|premium|billing|checkout|subscribe)(\/|\?|#|$)/i.test(u)) {
    return true;
  }
  if (
    /\b(upgrade to (pro|premium|canva pro|business)|start (your )?free trial|unlock (with )?pro|pro (feature|only|members?)|premium (feature|only)|subscribe to (continue|unlock|pro)|paywall|members? only|go pro|get pro|buy pro)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(upgrade|pricing|subscribe)\b/i.test(titleL) &&
    /\b(pro|premium|trial|plan)\b/i.test(t)
  ) {
    return true;
  }
  // Dense upgrade chrome with little editor content.
  const upgradeHits = [
    /\bupgrade\b/,
    /\bpro\b/,
    /\bpremium\b/,
    /\bfree trial\b/,
    /\bsubscribe\b/,
  ].filter((re) => re.test(t)).length;
  const editorHints = (
    t.match(/\b(edit|templates?|your design|canvas|pages?|layers?|elements?)\b/g) || []
  ).length;
  return upgradeHits >= 3 && editorHints < 2;
}

function looksLikeSignInWall({ url, text, title } = {}) {
  const u = String(url || "").toLowerCase();
  const t = String(text || "").toLowerCase();
  const titleL = String(title || "").toLowerCase();

  // Marketing Gmail / signed-out interstitial — treat as needing sign-in.
  if (looksLikeGmailNeedsSignIn({ url, text, title })) return true;

  if (
    /accounts\.google\.|login\.microsoftonline\.|appleid\.apple\.com|auth0\.com|\.okta\.com|login\.yahoo\.|facebook\.com\/login|api\.twitter\.com\/oauth|x\.com\/i\/flow\/login/.test(
      u,
    )
  ) {
    return true;
  }

  // A login path, or a host that exists only to log people in. Mailchimp,
  // Constant Contact and AWS all put the login on their own subdomain and serve
  // it from "/", so a path-only test misses the real wall completely.
  if (
    looksLikeAuthUrl(u) ||
    /\/(login|log-in|signin|sign-in|sign_in|signup|sign-up|sign_up|register|oauth|sso|auth\/|session\/new)(\/|\?|#|$)/i.test(
      u,
    )
  ) {
    if (
      looksLikeSignInPageText(t) ||
      /\b(sign|log)[- ]?in\b/.test(titleL) ||
      /\b(sign|log)[- ]?up\b/.test(titleL)
    ) {
      return true;
    }
  }

  // Product marketing / home pages often have Log in + Sign up in the nav —
  // that is NOT a hard wall. Agent should click those CTAs (or park clearly),
  // not freeze in a 30-minute wait without acting.
  //
  // This has to outrank the phrase test below. A landing page frequently throws
  // a consent/promo/login *modal* over itself, and its copy ("log in to
  // continue") was enough to score the whole page as a wall — so a run that
  // only needed the popup closed parked and told an already-signed-in user to
  // sign in. A modal is dismissable; a wall is not. Landing page wins.
  if (looksLikeMarketingOrHomeUrl(url, text)) {
    return false;
  }

  if (
    /\b(log in to continue|sign in to continue|sign up to continue|create a free account to|join (pinterest|to see)|sign up to see more|log in to see more|you need to (sign|log) ?in)\b/.test(
      t,
    )
  ) {
    return true;
  }

  if (!looksLikeSignInPageText(t)) return false;

  // Soft modal on a content page: auth chrome dominates, little real content.
  const contentHints = (
    t.match(
      /\b(inbox|compose|pin ide|related pins|results for|watch later|home feed|dashboard|your boards)\b/g,
    ) || []
  ).length;
  const authHits = [
    /\bsign[- ]?in\b/,
    /\blog[- ]?in\b/,
    /\bpassword\b/,
    /\bcontinue with\b/,
    /\bcreate (an )?account\b/,
    /\bemail or phone\b/,
  ].filter((re) => re.test(t)).length;
  return authHits >= 3 && contentHints < 2;
}

/**
 * Poll until the sign-in wall clears (user finished auth) or timeout/abort.
 */
async function waitForSignInClear(
  webContents,
  { signal, timeoutMs = 5 * 60 * 1000, pollMs = 1600, onTick } = {},
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) return { ok: false, error: "aborted" };
    if (!webContents || webContents.isDestroyed()) {
      return { ok: false, error: "no_webcontents" };
    }
    try {
      await waitForDomSettle(webContents, 350);
    } catch {
      /* ignore */
    }
    let page = { url: "", text: "", title: "" };
    try {
      page = await getPageContext(webContents);
    } catch {
      /* ignore */
    }
    const pageUrl = page.url || webContents.getURL?.() || "";
    const wall = looksLikeSignInWall({
      url: pageUrl,
      text: page.text,
      title: page.title || webContents.getTitle?.() || "",
    });
    if (typeof onTick === "function") {
      try {
        onTick({
          waiting: wall,
          url: pageUrl,
          elapsedMs: Date.now() - start,
        });
      } catch {
        /* ignore */
      }
    }
    if (!wall) return { ok: true, url: pageUrl };
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { ok: false, error: "timeout" };
}

/** URL without the churn (tracking params, cache-busters) that changes on its own. */
function urlIdentity(url) {
  const raw = String(url || "");
  try {
    const u = new URL(raw);
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|_ga|fbclid|gclid|msclkid|ref|t|ts|_|cb|rand)/i.test(key)) {
        u.searchParams.delete(key);
      }
    }
    return `${u.origin}${u.pathname}${u.search}${u.hash}`;
  } catch {
    return raw;
  }
}

/**
 * Did the visible content change enough to mean a person did something, rather
 * than a clock ticking or an ad rotating?
 */
function pageBodyChangedMaterially(before, after) {
  const a = String(before || "");
  const b = String(after || "");
  if (!a && !b) return false;
  if (!a || !b) return true;
  const threshold = Math.max(140, Math.round(a.length * 0.08));
  return Math.abs(a.length - b.length) >= threshold;
}

/**
 * Watch the tab while the user does the one thing the agent cannot — sign in,
 * click a confirmation, clear a captcha — and resolve the moment they've acted
 * so the caller can pick the task back up.
 *
 * Polling the page is the only signal available: the user is driving the
 * browser directly, not through us. "Acted" means a sign-in wall cleared, the
 * URL moved, or the visible content changed materially. While a wall is still
 * up we keep waiting rather than reading a half-typed form as progress.
 */
async function waitForUserAssist(
  webContents,
  { signal, timeoutMs = 30 * 60 * 1000, pollMs = 1500, settleMs = 700, onTick } = {},
) {
  if (!webContents || webContents.isDestroyed?.()) {
    return { ok: false, error: "no_webcontents" };
  }
  const start = Date.now();
  const readPage = async () => {
    let page = {};
    try {
      await waitForDomSettle(webContents, settleMs);
      page = await getPageContext(webContents);
    } catch {
      page = {};
    }
    return {
      url: page.url || webContents.getURL?.() || "",
      title: page.title || webContents.getTitle?.() || "",
      body: String(page.text || "").replace(/\s+/g, " ").trim(),
    };
  };

  const base = await readPage();
  const startedOnWall = looksLikeSignInWall({
    url: base.url,
    text: base.body,
    title: base.title,
  });

  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) return { ok: false, error: "aborted" };
    await new Promise((r) => setTimeout(r, pollMs));
    if (!webContents || webContents.isDestroyed?.()) {
      return { ok: false, error: "no_webcontents" };
    }
    const now = await readPage();
    const onWall = looksLikeSignInWall({ url: now.url, text: now.body, title: now.title });
    const elapsedMs = Date.now() - start;

    if (startedOnWall) {
      // Only the wall clearing counts — everything else is the user typing.
      if (!onWall) return { ok: true, url: now.url, change: "signed_in", elapsedMs };
    } else if (onWall) {
      // A wall appeared mid-wait (session expired) — that's still news.
      return { ok: true, url: now.url, change: "sign_in_required", elapsedMs };
    } else if (urlIdentity(now.url) !== urlIdentity(base.url)) {
      return { ok: true, url: now.url, change: "navigated", elapsedMs };
    } else if (now.title !== base.title) {
      return { ok: true, url: now.url, change: "page_changed", elapsedMs };
    } else if (pageBodyChangedMaterially(base.body, now.body)) {
      return { ok: true, url: now.url, change: "page_changed", elapsedMs };
    }

    if (typeof onTick === "function") {
      try {
        onTick({ waiting: true, url: now.url, elapsedMs });
      } catch {
        /* ignore */
      }
    }
  }
  return { ok: false, error: "timeout", url: webContents.getURL?.() || "" };
}

/**
 * Watches the page for signs it is still working: DOM mutations, and fetch or
 * XHR requests in flight.
 *
 * `isLoading()` is false for every in-page interaction, so without this there
 * is nothing to wait ON after a click — only a fixed sleep, which is either too
 * short for the page or too long for the agent. A click that fires a request
 * and renders the response 400ms later needs to be waited out; a click on a
 * static page should not cost a millisecond more than it has to.
 *
 * Requests are kept by start time, not counted, because long-polling and SSE
 * connections never finish. A pending request stops mattering after
 * REQUEST_STALE_MS: past that it is a subscription, not this action's response.
 */
const ACTIVITY_MONITOR_JS =
  "(function(){try{" +
  "if(window.__lyknActivity&&window.__lyknActivity.v===1)return true;" +
  "var S=window.__lyknActivity={v:1,t:Date.now(),n:0,seq:0,reqs:Object.create(null)};" +
  "try{var mo=new MutationObserver(function(recs){S.t=Date.now();S.n+=recs.length;});" +
  "mo.observe(document.documentElement,{childList:true,subtree:true,attributes:true,characterData:true});" +
  "S.mo=mo;}catch(e){}" +
  "function open(){var id=++S.seq;S.reqs[id]=Date.now();S.t=Date.now();return id;}" +
  "function shut(id){delete S.reqs[id];S.t=Date.now();}" +
  "try{var of=window.fetch;if(typeof of==='function'&&!of.__lykn){" +
  "var nf=function(){var id=open(),p;" +
  "try{p=of.apply(this,arguments);}catch(e){shut(id);throw e;}" +
  "return Promise.resolve(p).then(function(r){shut(id);return r;},function(e){shut(id);throw e;});};" +
  "nf.__lykn=1;window.fetch=nf;}}catch(e){}" +
  "try{var XP=XMLHttpRequest.prototype,os=XP.send;if(typeof os==='function'&&!os.__lykn){" +
  "var ns=function(){var id=open(),self=this,done=function(){if(!self.__lyknDone){self.__lyknDone=1;shut(id);}};" +
  "try{this.addEventListener('loadend',done);}catch(e){}" +
  "try{return os.apply(this,arguments);}catch(e){done();throw e;}};" +
  "ns.__lykn=1;XP.send=ns;}}catch(e){}" +
  "return true;}catch(e){return false;}})()";

/** Pending requests are forgotten after this, so the map cannot grow forever. */
const REQUEST_STALE_MS = 30000;

/**
 * Only requests that started after `since` are worth waiting for.
 *
 * A mail client or a chat app holds a long-poll open for the whole session and
 * opens the next one the moment it returns, so "is anything in flight" is
 * permanently yes and waiting on it would spend the entire budget on every
 * action. What matters is whether THIS action started something.
 */
const readActivityJs = (since) =>
  "(function(){try{var S=window.__lyknActivity;if(!S||S.v!==1)return null;" +
  "var now=Date.now(),pending=0;" +
  `for(var k in S.reqs){var t=S.reqs[k];if(t>=${Math.round(since)})pending++;` +
  `else if(now-t>${REQUEST_STALE_MS})delete S.reqs[k];}` +
  "return {quietFor:now-S.t,pending:pending,mutations:S.n,loading:document.readyState!=='complete'};" +
  "}catch(e){return null;}})()";

/**
 * A page that mutates without pause — a carousel, a ticker, a live clock —
 * never goes quiet, and waiting for it to would cost the full budget on every
 * single action. Once there is nothing in flight, that is as settled as it gets.
 */
const ANIMATED_PAGE_MS = 600;

/**
 * Wait until the page stops changing, or until the budget runs out.
 *
 * `ms` stays a hard ceiling, so no existing caller can become slower than the
 * budget it already passes; on a page that is genuinely idle this now returns
 * sooner than the old fixed sleep did.
 */
async function waitForDomSettle(webContents, ms = 1200, { quietMs = 200, graceMs = 700 } = {}) {
  if (!webContents || webContents.isDestroyed()) return;
  const budget = Math.max(0, Number(ms) || 0);
  const started = Date.now();
  const deadline = started + budget;
  // Requests this old or newer are treated as the action's own. The window
  // covers the gap between dispatching the action and arriving here; anything
  // older was already running and is none of this action's business.
  const readJs = readActivityJs(started - Math.max(0, Number(graceMs) || 0));
  const paint = async () => {
    try {
      await webContents.executeJavaScript(
        "new Promise((resolve)=>{requestAnimationFrame(()=>requestAnimationFrame(resolve));})",
        true,
      );
    } catch {
      /* ignore */
    }
  };
  // A document being replaced has nothing worth observing until it arrives.
  try {
    if (webContents.isLoading()) await waitForLoad(webContents, budget);
  } catch {
    /* ignore */
  }
  const quiet = Math.max(60, Math.min(Number(quietMs) || 200, budget));
  let installed = false;
  let bestQuiet = 0;
  while (Date.now() < deadline) {
    let state = null;
    try {
      state = await webContents.executeJavaScript(readJs, true);
    } catch {
      break;
    }
    if (!state) {
      // Nothing is watching yet. Install, then measure from now — which costs
      // one quiet window on the first call in a document and nothing after.
      if (installed) break;
      installed = true;
      try {
        if (!(await webContents.executeJavaScript(ACTIVITY_MONITOR_JS, true))) break;
      } catch {
        break;
      }
      continue;
    }
    bestQuiet = Math.max(bestQuiet, Number(state.quietFor) || 0);
    if (!state.loading && !state.pending && (Number(state.quietFor) || 0) >= quiet) break;
    const elapsed = Date.now() - started;
    if (!state.pending && !state.loading && elapsed >= ANIMATED_PAGE_MS && bestQuiet < quiet) break;
    const left = deadline - Date.now();
    if (left <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(50, left)));
  }
  await paint();
}

/** Wait until the address bar stops bouncing (SPA redirects / theme refresh). */
async function waitForUrlStable(
  webContents,
  { stableMs = 700, timeoutMs = 4500, pollMs = 120 } = {},
) {
  if (!webContents || webContents.isDestroyed?.()) {
    return { ok: false, error: "no_webcontents", url: "" };
  }
  const deadline = Date.now() + Math.max(400, Number(timeoutMs) || 4500);
  const needStable = Math.max(250, Number(stableMs) || 700);
  const poll = Math.max(60, Number(pollMs) || 120);
  let last = "";
  let stableSince = 0;
  while (Date.now() < deadline) {
    if (webContents.isDestroyed?.()) {
      return { ok: false, error: "destroyed", url: last };
    }
    let url = "";
    try {
      url = webContents.getURL?.() || "";
    } catch {
      url = "";
    }
    if (url && url === last) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= needStable) {
        return { ok: true, url };
      }
    } else {
      last = url;
      stableSince = url ? Date.now() : 0;
    }
    await new Promise((r) => setTimeout(r, poll));
  }
  return { ok: !!last, url: last, timedOut: true };
}

/**
 * Poll until SERP / YouTube results expose a clickable destination (or timeout).
 * Faster than a fixed multi-second settle before auto-open.
 */
async function waitForSearchResultsReady(
  webContents,
  { hint = "", youtube = false, spotify = false, timeoutMs = 1600, pollMs = 180 } = {},
) {
  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, error: "no_webcontents" };
  }
  const start = Date.now();
  let last = { ok: false };
  while (Date.now() - start < timeoutMs) {
    last = spotify
      ? await peekSpotifyResultHref(webContents, { hint, index: 0 })
      : youtube
        ? await peekYoutubeResultHref(webContents, { hint, index: 0 })
        : await peekSearchResultHref(webContents, { hint, index: 0 });
    if (last?.ok && last.href) return last;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return last?.ok ? last : { ok: false, error: "timeout" };
}

/** URL looks like an auth host/path — worth scraping before assuming we're clear. */
function urlMaybeNeedsAuthCheck(url) {
  const u = String(url || "").toLowerCase();
  if (!u || isPlaceholderAgentUrl(u)) return true;
  if (looksLikeGmailPublicPage(u)) return true;
  if (/mail\.google\.com/i.test(u)) return true;
  if (/accounts\.|\/login|\/signin|\/sign-in|\/sign_in|servicelogin|oauth|\/sso|\/auth\b/i.test(u)) {
    return true;
  }
  // Known signed-in dashboards (ads.reddit.com, dashboard.stripe.com, …) often
  // render their wall in place with a clean URL — always scrape-check these.
  try {
    const host = new URL(u).hostname;
    for (const site of ACCOUNT_DASHBOARD_SITES) {
      if (site.url.includes("google.com/search")) continue;
      if (host === new URL(site.url).hostname) return true;
    }
  } catch {
    /* not a parseable URL */
  }
  return false;
}

/** Poll until Gmail inbox rows are readable (or timeout). */
async function waitForMailReady(webContents, { timeoutMs = 4500, pollMs = 350 } = {}) {
  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, rows: [], error: "no_webcontents" };
  }
  const start = Date.now();
  let last = { ok: false, rows: [] };
  while (Date.now() - start < timeoutMs) {
    last = await getPageContextRich(webContents);
    const rows = Array.isArray(last.rows) ? last.rows : [];
    const url = last.url || webContents.getURL?.() || "";
    if (rows.length > 0) return { ok: true, ...last, rows };
    // Thread already open — treat as ready.
    if (/[#&](?:inbox\/|all\/|label\/[^/]+\/)[a-zA-Z0-9]+/i.test(url)) {
      return { ok: true, ...last, rows, thread: true };
    }
    if (looksLikeGmailNeedsSignIn({ url, text: last.text, title: last.title })) {
      return { ok: false, ...last, rows, error: "sign_in_required" };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { ok: Array.isArray(last.rows) && last.rows.length > 0, ...last };
}

/**
 * Click an inbox row (first / Nth / hint match). Uses input-event clicks for Gmail SPA.
 */
async function clickGmailInboxRow(webContents, { index = 0, hint = "" } = {}) {
  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, error: "no_webcontents" };
  }
  const clean = {
    index: Math.max(0, Number(index) || 0),
    hint: String(hint || "").slice(0, 120),
  };
  const payload = Buffer.from(JSON.stringify(clean), "utf8").toString("base64");
  try {
    const pick = await webContents.executeJavaScript(
      `(function(){
        var d=JSON.parse(decodeURIComponent(escape(atob('${payload}'))));
        function clean(s){return ((s||'')+'').replace(/\\s+/g,' ').trim();}
        function vis(el){if(!el)return false;var r=el.getBoundingClientRect();
          return r.width>8&&r.height>8&&r.bottom>0&&r.top<(window.innerHeight||800);}
        var sels=['tr.zA','div.zA','table.F tbody tr','div[role="main"] tr.zA','div[gh="tl"] tr','div[data-legacy-thread-id]'];
        var nodes=[], seen=new Set();
        for(var s=0;s<sels.length;s++){
          try{document.querySelectorAll(sels[s]).forEach(function(n){
            if(!vis(n)||seen.has(n))return;seen.add(n);nodes.push(n);
          });}catch(e){}
          if(nodes.length>=20) break;
        }
        if(!nodes.length) return {ok:false,error:'no_mail_rows'};
        var hint=String(d.hint||'').toLowerCase().replace(/[^a-z0-9\\s]/g,' ').trim();
        var pick=nodes[Math.min(d.index||0, nodes.length-1)];
        if(hint){
          var words=hint.split(' ').filter(function(w){return w.length>2;});
          var best=-1,bestScore=0;
          for(var i=0;i<nodes.length;i++){
            var t=clean(nodes[i].getAttribute('aria-label')||nodes[i].innerText).toLowerCase();
            if(!t) continue;
            if(t.indexOf(hint)!==-1){ pick=nodes[i]; best=-2; break; }
            var score=0; for(var w=0;w<words.length;w++){ if(t.indexOf(words[w])!==-1) score++; }
            if(score>bestScore){ bestScore=score; best=i; }
          }
          if(best>=0 && bestScore>=1) pick=nodes[best];
        }
        var r=pick.getBoundingClientRect();
        var label=clean(pick.getAttribute('aria-label')||pick.innerText).slice(0,160);
        var threadId=String(pick.getAttribute('data-legacy-thread-id')||pick.getAttribute('data-thread-id')||'').trim();
        if(!threadId && pick.querySelector){
          var tidEl=pick.querySelector('[data-legacy-thread-id],[data-thread-id],[data-thread-perm-id]');
          if(tidEl) threadId=String(tidEl.getAttribute('data-legacy-thread-id')||tidEl.getAttribute('data-thread-id')||tidEl.getAttribute('data-thread-perm-id')||'').trim();
        }
        try{ pick.scrollIntoView({block:'center',inline:'nearest'}); }catch(e){}
        r=pick.getBoundingClientRect();
        return {ok:true,label:label,threadId:threadId,clientX:Math.round(r.left+r.width/2),clientY:Math.round(r.top+Math.min(r.height/2,22)),count:nodes.length};
      })()`,
      true,
    );
    if (!pick?.ok) return pick || { ok: false, error: "no_mail_rows" };
    // DOM click + real input event (Gmail often needs the latter).
    try {
      await webContents.executeJavaScript(
        `(function(){
          var x=${Number(pick.clientX)}, y=${Number(pick.clientY)};
          var el=document.elementFromPoint(x,y);
          var row=el && (el.closest('tr.zA, div.zA, tr, [role="row"], [data-legacy-thread-id]')||el);
          if(row){ try{row.click();}catch(e){}
            ['pointerdown','mousedown','mouseup','click'].forEach(function(ev){
              try{row.dispatchEvent(new MouseEvent(ev,{bubbles:true,cancelable:true,view:window,clientX:x,clientY:y}));}catch(x){}
            });
          }
          return true;
        })()`,
        true,
      );
    } catch {
      /* ignore */
    }
    const hit = await clickAtClientPoint(webContents, pick.clientX, pick.clientY);
    // Give Gmail a beat to update the hash before falling back to direct navigation.
    await waitForDomSettle(webContents, 450);
    // If the list click didn't navigate, open the thread by hash (Gmail SPA).
    const afterClick = String(webContents.getURL?.() || "");
    const threadOpen =
      /mail\.google\.com/i.test(afterClick) &&
      /(?:#|\/)(?:inbox|all|sent|drafts|starred|important|snoozed|label\/[^/]+)\/[A-Za-z0-9]+/i.test(
        afterClick,
      );
    if (!threadOpen && pick.threadId) {
      try {
        const base = afterClick.match(/^(https?:\/\/mail\.google\.com\/mail\/u\/\d+)/i);
        const root = (base && base[1]) || "https://mail.google.com/mail/u/0";
        const target = `${root}/#inbox/${encodeURIComponent(pick.threadId)}`;
        await navigate(webContents, target);
        await waitForDomSettle(webContents, 600);
      } catch {
        /* keep click result */
      }
    }
    const finalUrl = String(webContents.getURL?.() || "");
    const opened =
      /mail\.google\.com/i.test(finalUrl) &&
      /(?:#|\/)(?:inbox|all|sent|drafts|starred|important|snoozed|label\/[^/]+)\/[A-Za-z0-9]+/i.test(
        finalUrl,
      );
    return {
      ok: !!(hit.ok || opened),
      label: pick.label || "",
      count: pick.count,
      threadId: pick.threadId || "",
      via: opened && !hit.ok ? "hash" : hit.via || "dom",
      error: hit.ok || opened ? undefined : hit.error,
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** Click a visible in-page link/button by hint (email body links, nav, etc.). */
async function clickInPageByHint(webContents, { hint = "", index = 0 } = {}) {
  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, error: "no_webcontents" };
  }
  const clean = {
    hint: String(hint || "").slice(0, 160),
    index: Math.max(0, Number(index) || 0),
  };
  const payload = Buffer.from(JSON.stringify(clean), "utf8").toString("base64");
  try {
    const pick = await webContents.executeJavaScript(
      `(function(){
        var d=JSON.parse(decodeURIComponent(escape(atob('${payload}'))));
        function clean(s){return ((s||'')+'').replace(/\\s+/g,' ').trim();}
        function vis(el){if(!el)return false;var r=el.getBoundingClientRect();
          if(r.width<4||r.height<4)return false;
          var st=getComputedStyle(el);return st.visibility!=='hidden'&&st.display!=='none'&&st.pointerEvents!=='none';}
        var root=document.documentElement||document.body;
        var nodes=[].slice.call(root.querySelectorAll(
          'a[href],button,[role="button"],[role="link"],[role="tab"],[role="menuitem"],div[role="button"],span[role="button"]'
        ));
        var items=[];
        for(var i=0;i<nodes.length;i++){
          var n=nodes[i]; if(!vis(n)) continue;
          var lab=clean(
            n.getAttribute('aria-label')||n.getAttribute('data-tooltip')||
            n.getAttribute('title')||n.innerText||''
          );
          var href=''; try{href=n.href||'';}catch(e){}
          if(!lab && !href) continue;
          if(/accounts\\.google|javascript:/i.test(href||'')) continue;
          items.push({el:n,lab:lab,href:href});
          if(items.length>=80) break;
        }
        if(!items.length) return {ok:false,error:'no_targets'};
        var hint=String(d.hint||'').toLowerCase().replace(/[^a-z0-9\\s]/g,' ').trim();
        // Require a real hint from the agent — never click the first visible control.
        if(!hint) return {ok:false,error:'empty_hint'};
          var words=hint.split(' ').filter(function(w){return w.length>2;});
          var best=-1,bestScore=-1;
          for(var j=0;j<items.length;j++){
            var lab=(items[j].lab||'').toLowerCase().replace(/\\s+/g,' ').trim();
            var t=lab+' '+(items[j].href||'').toLowerCase();
            var score=0;
            if(lab===hint) score=100;
            else if(lab.indexOf(hint)===0) score=80;
            else if((' '+lab+' ').indexOf(' '+hint+' ')!==-1) score=70;
            else if(t.indexOf(hint)!==-1) score=40;
            else {
            for(var w=0;w<words.length;w++){ if(t.indexOf(words[w])!==-1) score+=12; }
            }
            if(score>bestScore){ bestScore=score; best=j; }
          }
        if(best<0 || bestScore<24) return {ok:false,error:'no_hint_match',bestScore:bestScore};
        var pick=items[best];
        var r=pick.el.getBoundingClientRect();
        try{ pick.el.scrollIntoView({block:'center',inline:'nearest'}); }catch(e){}
        r=pick.el.getBoundingClientRect();
        return {ok:true,label:pick.lab.slice(0,160),href:pick.href||'',clientX:Math.round(r.left+r.width/2),clientY:Math.round(r.top+r.height/2),score:bestScore};
      })()`,
      true,
    );
    if (!pick?.ok) return pick || { ok: false };
    try {
      await webContents.executeJavaScript(
        `(function(){var x=${Number(pick.clientX)},y=${Number(pick.clientY)};var el=document.elementFromPoint(x,y);
          var t=el&&(el.closest('a,button,[role=button],[role=link]')||el); if(t){try{t.click();}catch(e){}} return true;})()`,
        true,
      );
    } catch {
      /* ignore */
    }
    const hit = await clickAtClientPoint(webContents, pick.clientX, pick.clientY);
    return {
      ok: !!hit.ok,
      label: pick.label || "",
      href: pick.href || "",
      via: hit.via || "dom",
      score: Number(pick.score) || 0,
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * DOM-level check for an entered share recipient. Google's chips usually show
 * the person's NAME (not the raw email), so page-text checks miss them — the
 * email survives only in chip attributes (data-hovercard-id / aria-label /
 * data-tooltip). Only inspects open dialogs so doc-body emails can't match.
 */
async function shareDialogHasRecipientChip(webContents, email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || !webContents || webContents.isDestroyed?.()) return false;
  try {
    const payload = Buffer.from(JSON.stringify({ email: e }), "utf8").toString(
      "base64",
    );
    const res = await webContents.executeJavaScript(
      `(function(){try{
        var d=JSON.parse(decodeURIComponent(escape(atob('${payload}'))));var e=String(d.email||'').toLowerCase();
        if(!e) return false;
        var roots=[].slice.call(document.querySelectorAll('[role="dialog"],[aria-modal="true"]'));
        if(!roots.length) return false;
        for(var r=0;r<roots.length;r++){
          var root=roots[r];
          var nodes=root.querySelectorAll('[data-hovercard-id],[data-email],[data-tooltip],[aria-label]');
          for(var i=0;i<nodes.length;i++){
            var n=nodes[i];
            var v=((n.getAttribute('data-hovercard-id')||'')+' '+(n.getAttribute('data-email')||'')+' '+(n.getAttribute('data-tooltip')||'')+' '+(n.getAttribute('aria-label')||'')).toLowerCase();
            if(v.indexOf(e)!==-1) return true;
          }
          if(((root.innerText||'')+'').toLowerCase().indexOf(e)!==-1) return true;
        }
        return false;
      }catch(err){return false;}})()`,
      true,
    );
    return !!res;
  } catch {
    return false;
  }
}

/**
 * Focus the Share dialog's Add-people field and type the recipient email.
 * Does not click Share/Cancel — safe to call while the dialog is already open.
 */
async function typeEmailIntoShareDialog(webContents, email) {
  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, error: "no_webcontents" };
  }
  const primary = String(email || "").trim();
  if (!/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/.test(primary)) {
    return { ok: false, error: "bad_email" };
  }
  try {
    const field = await webContents.executeJavaScript(
      `(function(){
        function vis(el){if(!el)return false;var r=el.getBoundingClientRect();
          if(r.width<20||r.height<10)return false;
          var st=getComputedStyle(el);return st.visibility!=='hidden'&&st.display!=='none';}
        var roots=[].slice.call(document.querySelectorAll(
          '[role="dialog"], [aria-modal="true"]'
        ));
        if(!roots.length) roots=[document.body];
        var sels=[
          'input[aria-label*="people" i]','input[aria-label*="email" i]',
          'input[aria-label*="Add" i]','input[placeholder*="email" i]',
          'input[placeholder*="people" i]','input[placeholder*="Add" i]',
          'textarea[aria-label*="people" i]','div[role="combobox"] input',
          'input[type="email"]','input[autocomplete="email"]',
          '[contenteditable="true"][aria-label*="people" i]',
          '[contenteditable="true"][aria-label*="Add" i]'
        ];
        for(var r=0;r<roots.length;r++){
          var root=roots[r];
          for(var s=0;s<sels.length;s++){
            var nodes=[].slice.call(root.querySelectorAll(sels[s]));
            for(var i=0;i<nodes.length;i++){
              var n=nodes[i]; if(!vis(n)) continue;
              try{n.scrollIntoView({block:'center'});}catch(e){}
              var box=n.getBoundingClientRect();
              try{n.focus(); n.click();}catch(e2){}
              return {ok:true,x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)};
            }
          }
        }
        return {ok:false,error:'people_field_not_found'};
      })()`,
      true,
    );
    let entered = false;
    let lastFocus = field;
    for (let attempt = 0; attempt < 3 && !entered; attempt += 1) {
      // A prior attempt or round may have landed the chip even when
      // verification missed it (chips show the person's NAME, not the email,
      // so page text misses them) — never type the same email twice.
      try {
        if (await shareDialogHasRecipientChip(webContents, primary)) {
          entered = true;
          break;
        }
        const pre = await getPageContext(webContents);
        if (
          pageShowsShareEmailEntered(
            `${pre.title || ""}\n${pre.text || ""}`,
            primary,
          )
        ) {
          entered = true;
          break;
        }
      } catch {
        /* ignore */
      }
      // Always (re)click the people field before typing — first click often misses.
      if (field?.ok && typeof field.x === "number" && attempt === 0) {
        await clickAtClientPoint(webContents, field.x, field.y);
      } else {
        // Re-resolve live coords each retry.
        const again = await webContents.executeJavaScript(
          `(function(){
            function vis(el){if(!el)return false;var r=el.getBoundingClientRect();
              if(r.width<20||r.height<10)return false;
              var st=getComputedStyle(el);return st.visibility!=='hidden'&&st.display!=='none';}
            var root=document.querySelector('[role="dialog"],[aria-modal="true"]')||document.body;
            var sels=['input[aria-label*="people" i]','input[aria-label*="Add" i]','input[placeholder*="Add" i]','div[role="combobox"] input','input[type="email"]'];
            for(var s=0;s<sels.length;s++){
              var nodes=root.querySelectorAll(sels[s]);
              for(var i=0;i<nodes.length;i++){
                if(!vis(nodes[i])) continue;
                var r=nodes[i].getBoundingClientRect();
                try{nodes[i].click();nodes[i].focus();}catch(e){}
                return {ok:true,x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
              }
            }
            return {ok:false};
          })()`,
          true,
        );
        lastFocus = again;
        if (again?.ok) {
          await clickAtClientPoint(webContents, again.x, again.y);
        } else {
          const inviteClick = await clickInPageByHint(webContents, {
            hint: "Add people",
            index: 0,
          });
          if (!inviteClick?.ok && attempt === 2) {
            return { ok: false, error: field?.error || "people_field_not_found" };
          }
        }
      }
      await new Promise((r) => setTimeout(r, 180));
      try {
        webContents.focus();
        await sendShortcut(webContents, "meta+a").catch(() => {});
        await new Promise((r) => setTimeout(r, 60));
        await webContents.insertText(primary);
      } catch (e) {
        if (attempt === 2) return { ok: false, error: e?.message || "type_failed" };
        continue;
      }
      await new Promise((r) => setTimeout(r, 260));
      await sendRealKey(webContents, "Enter");
      await waitForDomSettle(webContents, 650).catch(() => {});
      let text = "";
      try {
        const p = await getPageContext(webContents);
        text = `${p.title || ""}\n${p.text || ""}`;
      } catch {
        /* ignore */
      }
      entered =
        pageShowsShareEmailEntered(text, primary) ||
        (await shareDialogHasRecipientChip(webContents, primary));
    }
    return {
      ok: entered || !!lastFocus?.ok,
      typed: true,
      email: primary,
      verified: entered,
      via: entered ? "share_type_email" : "share_type_unverified",
      error: entered ? undefined : "email_not_visible_after_type",
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Deterministic share flow for Docs / Sheets / Notion / Drive-style UIs.
 * Does not ask the LLM — finds Share, types the email, clicks Send/Done,
 * then verifies the page shows progress. Returns { ok, stuck, step, message }.
 */
async function sharePageWithEmail(webContents, { emails = [], ask = "" } = {}) {
  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, stuck: true, step: "init", error: "no_webcontents" };
  }
  const recipients = (Array.isArray(emails) ? emails : [])
    .map((e) => String(e || "").trim())
    .filter((e) => /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/.test(e));
  const fromAsk = String(ask || "").match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || [];
  const list = [...new Set([...recipients, ...fromAsk])];
  if (!list.length) {
    return { ok: false, stuck: true, step: "init", error: "no_email" };
  }
  const primary = list[0];

  async function pageText() {
    try {
      const p = await getPageContext(webContents);
      return `${p.title || ""}\n${p.text || ""}`.toLowerCase();
    } catch {
      return "";
    }
  }

  function looksLikeShareDialog(t) {
    return (
      /\b(add people|people and groups|share with people|invite|enter (names|email)|who do you want to share|send invite|notify people)\b/i.test(
        t,
      ) ||
      (/\b(editor|viewer|commenter)\b/i.test(t) &&
        /\b(share|people|access)\b/i.test(t))
    );
  }

  function looksLikeShareDone(t) {
    // Strict: dialog chrome ("People with access") is NOT completion.
    return pageShowsShareInviteComplete(t, primary);
  }

  // 1) Open Share UI if it isn't already open.
  // CRITICAL: Share is a toggle — never click it again once the dialog is open.
  let text = await pageText();
  if (!looksLikeShareDialog(text)) {
    const shareHints = [
      "Share",
      "Share document",
      "Share & export",
      "Share or publish",
      "Invite",
      "Share file",
    ];
    let opened = false;
    for (const hint of shareHints) {
      // Re-check each attempt — a prior hint may have opened the dialog.
      text = await pageText();
      if (looksLikeShareDialog(text)) {
        opened = true;
        break;
      }
      const clicked = await clickInPageByHint(webContents, { hint, index: 0 });
      if (clicked?.ok) {
        await waitForDomSettle(webContents, 1000).catch(() => {});
        text = await pageText();
        // Require real dialog chrome — label "Share" alone is NOT enough
        // (and a second Share click would close an already-open dialog).
        if (looksLikeShareDialog(text)) {
          opened = true;
          break;
        }
      }
    }
    // Google Docs often exposes Share via a blue button; try a broader scan.
    if (!opened) {
      try {
        const hit = await webContents.executeJavaScript(
          `(function(){
            function vis(el){if(!el)return false;var r=el.getBoundingClientRect();
              if(r.width<8||r.height<8)return false;
              var st=getComputedStyle(el);return st.visibility!=='hidden'&&st.display!=='none';}
            var nodes=[].slice.call(document.querySelectorAll('button,[role=button],div[role=button],span[role=button]'));
            for(var i=0;i<nodes.length;i++){
              var n=nodes[i]; if(!vis(n)) continue;
              var lab=((n.getAttribute('aria-label')||n.innerText||n.getAttribute('data-tooltip')||'')+'').replace(/\\s+/g,' ').trim();
              if(/^share\\b/i.test(lab) || /^share$/i.test(lab) || /\\bshare (document|file|this)\\b/i.test(lab)){
                var r=n.getBoundingClientRect();
                try{n.scrollIntoView({block:'center'});}catch(e){}
                r=n.getBoundingClientRect();
                return {ok:true,label:lab.slice(0,80),x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
              }
            }
            return {ok:false};
          })()`,
          true,
        );
        if (hit?.ok) {
          try {
            await webContents.executeJavaScript(
              `(function(){var el=document.elementFromPoint(${hit.x},${hit.y});
                var t=el&&(el.closest('button,[role=button]')||el); if(t){try{t.click();}catch(e){}} return true;})()`,
              true,
            );
          } catch {
            /* ignore */
          }
          await clickAtClientPoint(webContents, hit.x, hit.y);
          await waitForDomSettle(webContents, 1000).catch(() => {});
          text = await pageText();
          opened = looksLikeShareDialog(text);
        }
      } catch {
        /* ignore */
      }
    }
    if (!opened && !looksLikeShareDialog(text)) {
      return {
        ok: false,
        stuck: true,
        step: "open_share",
        error: "share_button_not_found",
        message: "Couldn't find the Share button on this page.",
      };
    }
  }

  // 2) Focus the people / invite field and type the email (never re-click Share).
  let emailEntered =
    pageShowsShareEmailEntered(await pageText(), primary) ||
    (await shareDialogHasRecipientChip(webContents, primary));
  for (let attempt = 0; attempt < 3 && !emailEntered; attempt += 1) {
    const typed = await typeEmailIntoShareDialog(webContents, primary);
    text = await pageText();
    emailEntered =
      pageShowsShareEmailEntered(text, primary) ||
      !!typed?.verified ||
      (await shareDialogHasRecipientChip(webContents, primary));
    if (!emailEntered && attempt === 2) {
      return {
        ok: false,
        stuck: true,
        step: "type_email",
        email: primary,
        error: typed?.error || "email_not_visible",
        message:
          `Opened Share but **${primary}** never appeared in the invite field. ` +
          `The Share dialog may still be open — tell me to continue and I'll try again.`,
      };
    }
  }
  if (!emailEntered) {
    return {
      ok: false,
      stuck: true,
      step: "type_email",
      email: primary,
      error: "email_not_visible",
      message:
        `Opened Share but **${primary}** never appeared in the invite field. ` +
        `The Share dialog may still be open — tell me to continue and I'll try again.`,
    };
  }

  // 3) Click ONLY the dialog's Send / Send invite / Invite — never toolbar Share,
  // Cancel, Done, or Close (those dismiss the dialog and discard the pending invite).
  let sendClick = await clickSendInShareDialog(webContents);
  let clickedSend = !!sendClick?.ok;
  if (clickedSend) {
    await waitForDomSettle(webContents, 1200).catch(() => {});
  }
  text = await pageText();
  let verified = looksLikeShareDone(text);
  let emailStillThere = pageShowsShareEmailEntered(text, primary);
  let dialogStillOpen = looksLikeShareDialog(text);

  // Retry Send once if the dialog is still open after the first click.
  if (!verified && dialogStillOpen && emailEntered) {
    sendClick = await clickSendInShareDialog(webContents);
    if (sendClick?.ok) {
      clickedSend = true;
      await waitForDomSettle(webContents, 1400).catch(() => {});
      text = await pageText();
      verified = looksLikeShareDone(text);
      emailStillThere = pageShowsShareEmailEntered(text, primary);
      dialogStillOpen = looksLikeShareDialog(text);
    }
  }

  if (verified) {
    return {
      ok: true,
      stuck: false,
      step: "done",
      email: primary,
      verified: true,
      message: `Shared with **${primary}** from this page.`,
    };
  }

  // Soft success: we typed the email and clicked Send/Invite, and the invite
  // dialog closed (toast often isn't scrapeable). Treat as done so the agent
  // doesn't loop for minutes claiming send_not_confirmed.
  if (clickedSend && emailEntered && (!dialogStillOpen || !emailStillThere)) {
    return {
      ok: true,
      stuck: false,
      step: "done",
      email: primary,
      verified: false,
      softVerified: true,
      message:
        `Shared with **${primary}** from this page` +
        ` (Send clicked — glance at the tab if you want to double-check).`,
    };
  }

  return {
    ok: false,
    stuck: true,
    step: "send",
    email: primary,
    error: dialogStillOpen
      ? "send_not_confirmed"
      : clickedSend
        ? "send_not_confirmed"
        : "send_button_missed",
    typed: true,
    clickedSend,
    dialogStillOpen,
    message:
      !clickedSend
        ? `I entered **${primary}** in Share but couldn't find the Send/Invite button in the dialog (won't click Done/Cancel — that discards the invite). Tell me to continue.`
        : emailStillThere || dialogStillOpen
          ? `I entered **${primary}** and clicked Send in the share dialog, but couldn't confirm the invite went through. Check the tab — tell me to continue.`
          : `I entered **${primary}** and clicked Send, but couldn't confirm it was sent. Check the tab — tell me to continue.`,
  };
}

/** True when a "Discard changes?" confirmation is blocking the share flow. */
function pageShowsDiscardChangesDialog(text) {
  const t = String(text || "").toLowerCase();
  // Strict — do NOT match a normal Share dialog (it has Cancel + page "changes").
  return (
    /\bdiscard changes\b/.test(t) ||
    /\byour changes won'?t be saved\b/.test(t) ||
    /\bdo you want to discard\b/.test(t)
  );
}

/**
 * Close a Discard-changes confirmation WITHOUT discarding.
 * Click Cancel / Keep / Stay — never the Discard button.
 */
async function dismissDiscardChangesDialog(webContents) {
  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, error: "no_webcontents" };
  }
  try {
    const hit = await webContents.executeJavaScript(
      `(function(){
        function vis(el){
          if(!el)return false;var r=el.getBoundingClientRect();
          if(r.width<6||r.height<6)return false;
          var st=getComputedStyle(el);
          return st.visibility!=='hidden'&&st.display!=='none'&&st.pointerEvents!=='none';
        }
        function shortLab(el){
          var a=(el.getAttribute('aria-label')||el.getAttribute('data-tooltip')||
            el.getAttribute('title')||'').replace(/\\s+/g,' ').trim();
          if(a && a.length<=40) return a;
          var t='';
          try{
            var kids=el.childNodes;
            for(var i=0;i<kids.length;i++){
              if(kids[i].nodeType===3) t+=kids[i].textContent||'';
            }
            t=t.replace(/\\s+/g,' ').trim();
          }catch(e){}
          if(t && t.length<=40) return t;
          return ((el.innerText||'')+'').replace(/\\s+/g,' ').trim().slice(0,40);
        }
        function isDiscardConfirm(s){
          return /^discard(\\s+changes)?$/i.test(s) || /^don't save$/i.test(s) || /^dont save$/i.test(s);
        }
        function isKeep(s){
          if(!s||isDiscardConfirm(s)) return false;
          if(/^(cancel|keep|keep editing|stay|go back|never ?mind|no)$/i.test(s)) return true;
          if(/\\b(keep editing|go back)\\b/i.test(s)) return true;
          return false;
        }
        var roots=[].slice.call(document.querySelectorAll(
          '[role="dialog"], [aria-modal="true"], [role="alertdialog"]'
        ));
        if(!roots.length) roots=[document.body];
        var best=null,bestScore=-1,bestLab='';
        for(var r=0;r<roots.length;r++){
          var root=roots[r];
          if(!root||!vis(root)) continue;
          var rootText=((root.innerText||'')+'').toLowerCase();
          if(!/discard/.test(rootText) && root!==document.body) continue;
          if(root===document.body && !/discard changes|won't be saved|wont be saved/.test(rootText)) continue;
          var nodes=[].slice.call(root.querySelectorAll(
            'button,[role="button"],div[role="button"],span[role="button"],input[type="button"]'
          ));
          for(var i=0;i<nodes.length;i++){
            var n=nodes[i]; if(!vis(n)) continue;
            var L=shortLab(n); if(!L||L.length>40) continue;
            if(isDiscardConfirm(L)) continue;
            if(!isKeep(L)) continue;
            var sc=/^cancel$/i.test(L)?100:/keep/i.test(L)?90:70;
            if(sc>bestScore){ bestScore=sc; best=n; bestLab=L; }
          }
        }
        if(!best) return {ok:false,error:'discard_keep_not_found'};
        try{best.focus();best.click();}catch(e){}
        var rect=best.getBoundingClientRect();
        return {
          ok:true,
          label:bestLab.slice(0,80),
          x:Math.round(rect.left+rect.width/2),
          y:Math.round(rect.top+rect.height/2)
        };
      })()`,
      true,
    );
    if (!hit?.ok) return hit || { ok: false, error: "discard_keep_not_found" };
    await clickAtClientPoint(webContents, hit.x, hit.y);
    return { ok: true, label: hit.label || "Cancel", via: "discard_keep" };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Click the Send / Send invite button INSIDE the open share/invite dialog.
 * Never the toolbar Share toggle, Cancel, Done, or Discard.
 */
async function clickSendInShareDialog(webContents) {
  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, error: "no_webcontents" };
  }
  try {
    const hit = await webContents.executeJavaScript(
      `(function(){
        function vis(el){
          if(!el)return false;var r=el.getBoundingClientRect();
          if(r.width<8||r.height<8)return false;
          var st=getComputedStyle(el);
          return st.visibility!=='hidden'&&st.display!=='none'&&st.pointerEvents!=='none';
        }
        // Prefer aria-label / own text node — NOT deep innerText (avoids
        // containers that concatenate "Cancel" + "Send").
        function shortLab(el){
          var a=(el.getAttribute('aria-label')||el.getAttribute('data-tooltip')||
            el.getAttribute('title')||'').replace(/\\s+/g,' ').trim();
          if(a && a.length<=48) return a;
          var t='';
          try{
            var kids=el.childNodes;
            for(var i=0;i<kids.length;i++){
              if(kids[i].nodeType===3) t+=kids[i].textContent||'';
            }
            t=t.replace(/\\s+/g,' ').trim();
          }catch(e){}
          if(t && t.length<=48) return t;
          // Last resort: single-line innerText only if short (leaf button).
          var deep=((el.innerText||'')+'').replace(/\\s+/g,' ').trim();
          if(deep && deep.length<=24) return deep;
          return '';
        }
        function isDismiss(s){
          if(!s) return true;
          if(/^(cancel|close|discard|dismiss|not now|no thanks|clear|done|\\u00d7|x)$/i.test(s)) return true;
          if(/\\b(cancel|close|discard|dismiss)\\b/i.test(s)) return true;
          return false;
        }
        function scoreSend(s){
          if(!s||isDismiss(s)) return 0;
          // Exact Send wins — never confuse with Cancel.
          if(/^send$/i.test(s)) return 120;
          if(/^send(\\s+invite)?$/i.test(s)) return 115;
          if(/\\bsend\\s+invite\\b/i.test(s)) return 110;
          if(/^invite$/i.test(s)) return 108;
          if(/^invite\\s+people$/i.test(s)) return 105;
          if(/^share$/i.test(s)) return 80; // dialog primary sometimes says Share
          if(/^share\\s+anyway$/i.test(s)) return 75;
          if(/\\bnotify\\b/i.test(s) && /\\bsend\\b/i.test(s)) return 60;
          if(/\\b(invite|send)\\b/i.test(s) && !/\\b(cancel|don't|dont)\\b/i.test(s)) return 50;
          return 0;
        }
        function looksLikeShareDialogRoot(el){
          if(!el||el===document.body) return false;
          if(el.getAttribute('role')==='dialog'||el.getAttribute('aria-modal')==='true') return true;
          var t=((el.innerText||'')+'').toLowerCase().slice(0,800);
          return /\\b(add people|people and groups|share with people|who do you want to share|send invite|notify people)\\b/.test(t);
        }
        // ONLY real dialogs — never toolbar buttons as roots (that was clicking
        // top-bar Share which closes the dialog = looks like Cancel).
        var roots=[].slice.call(document.querySelectorAll(
          '[role="dialog"], [aria-modal="true"], [role="alertdialog"]'
        )).filter(vis);
        if(!roots.length){
          // Content-based: largest visible node that looks like the share sheet.
          var all=document.querySelectorAll('div,section,form');
          var cand=null,candArea=0;
          for(var i=0;i<all.length;i++){
            var el=all[i]; if(!vis(el)) continue;
            if(!looksLikeShareDialogRoot(el)) continue;
            var r=el.getBoundingClientRect();
            var area=r.width*r.height;
            if(area>candArea && area>20000){ cand=el; candArea=area; }
          }
          if(cand) roots=[cand];
        }
        if(!roots.length) return {ok:false,error:'share_dialog_not_found'};

        var best=null,bestScore=-1,bestLab='';
        for(var r=0;r<roots.length;r++){
          var root=roots[r];
          if(!looksLikeShareDialogRoot(root) && root.getAttribute('role')!=='dialog' &&
             root.getAttribute('aria-modal')!=='true') continue;
          var nodes=[].slice.call(root.querySelectorAll(
            'button,[role="button"],div[role="button"],span[role="button"],input[type="button"],input[type="submit"]'
          ));
          for(var i=0;i<nodes.length;i++){
            var n=nodes[i]; if(!vis(n)) continue;
            // Skip anything inside a nested alertdialog (discard confirm).
            if(n.closest && n.closest('[role="alertdialog"]') && root.getAttribute('role')!=='alertdialog') continue;
            var L=shortLab(n); if(!L) continue;
            if(isDismiss(L)) continue;
            var sc=scoreSend(L);
            if(!sc) continue;
            var box=n.getBoundingClientRect();
            // Prefer primary (filled) buttons on the right inside the dialog.
            try{
              var bg=getComputedStyle(n).backgroundColor||'';
              if(/rgba?\\(\\s*\\d+/.test(bg) && !/rgba?\\(\\s*0\\s*,\\s*0\\s*,\\s*0\\s*,\\s*0\\s*\\)/.test(bg) &&
                 !/^rgb\\(\\s*255\\s*,\\s*255\\s*,\\s*255\\s*\\)$/.test(bg)) sc+=20;
            }catch(e){}
            sc+=Math.min(12, Math.floor(box.left/100));
            if(sc>bestScore){ bestScore=sc; best=n; bestLab=L; }
          }
        }
        if(!best||bestScore<50) return {ok:false,error:'send_not_found',bestScore:bestScore};
        // Final safety: never click if the label is dismissive.
        if(isDismiss(bestLab)) return {ok:false,error:'refused_dismiss_label',label:bestLab};
        try{best.scrollIntoView({block:'center',inline:'nearest'});}catch(e){}
        var rect=best.getBoundingClientRect();
        var x=Math.round(rect.left+rect.width/2);
        var y=Math.round(rect.top+rect.height/2);
        // Verify elementFromPoint is still a Send/Share control, not Cancel.
        var top=document.elementFromPoint(x,y);
        var topBtn=top&&top.closest?top.closest('button,[role="button"],div[role="button"]'):top;
        var topLab=topBtn?shortLab(topBtn):'';
        if(topLab && isDismiss(topLab)){
          return {ok:false,error:'point_hits_dismiss',label:topLab};
        }
        try{best.focus();}catch(e2){}
        try{best.click();}catch(e3){}
        return {
          ok:true,
          label:bestLab.slice(0,80),
          x:x,
          y:y,
          score:bestScore
        };
      })()`,
      true,
    );
    if (!hit?.ok) return hit || { ok: false, error: "send_not_found" };
    // Real mouse events — Docs sometimes ignores element.click() alone.
    await clickAtClientPoint(webContents, hit.x, hit.y);
    // Confirm we did not land on Cancel after the click.
    let verifyLab = "";
    try {
      verifyLab = await webContents.executeJavaScript(
        `(function(){
          var el=document.elementFromPoint(${Number(hit.x)},${Number(hit.y)});
          var b=el&&el.closest&&el.closest('button,[role="button"],div[role="button"]');
          if(!b) return '';
          return ((b.getAttribute('aria-label')||b.innerText||'')+'').replace(/\\s+/g,' ').trim().slice(0,40);
        })()`,
        true,
      );
    } catch {
      /* ignore */
    }
    if (verifyLab && /^(cancel|close|discard)$/i.test(verifyLab)) {
      return { ok: false, error: "clicked_dismiss_by_mistake", label: verifyLab };
    }
    return { ok: true, label: hit.label || "Send", via: "share_dialog_send", score: hit.score };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** True when a planned action would dismiss an open share dialog. */
function looksLikeShareDismissAction(action, goal) {
  if (!isShareInviteGoal(goal)) {
    return false;
  }
  const a = action || {};
  const label = String(a.label || a.element || a.target || "").toLowerCase();
  const type = String(a.type || "").toLowerCase();
  if (type === "press" || type === "key" || type === "press_key") {
    const key = String(a.key || a.value || "").toLowerCase();
    if (key === "escape" || key === "esc") return true;
  }
  if (/^(cancel|close|discard|dismiss|not now|no thanks)$/i.test(label.trim())) return true;
  if (/\b(cancel|close|discard|dismiss)\b/i.test(label) && !/\bsend\b/i.test(label)) {
    return true;
  }
  // Bare "Done" closes Docs share without sending a pending invite.
  if (/^done$/i.test(label.trim())) return true;
  // Re-clicking toolbar Share while the dialog is open toggles it closed.
  if (/^share$/i.test(label.trim()) && !/\bsend\b/i.test(label)) return true;
  // Clicking empty backdrop / "outside" dismisses the modal.
  if (/\b(outside|backdrop|overlay|dismiss)\b/i.test(label)) return true;
  return false;
}

/** "open the first email" / "open that message from Kevin" */
function looksLikeOpenMailItem(text) {
  const lower = String(text || "").toLowerCase();
  // Composing a NEW mail ("open gmail and draft an email to X") is never an
  // open-existing-message ask, even though it contains open + email. Only an
  // explicit "open the first/that email …" alongside the compose verb keeps
  // this an open ask (e.g. "open the first email and send a reply").
  if (
    /\b(draft|compose|write|send)\b[^.!?]{0,48}\b(?:new\s+)?(email|e-mail|mail|message)\b/.test(lower) &&
    !/\b(open|read|view|click|show|pull\s+up)\b[^.!?]{0,32}\b(first|second|third|top|latest|newest|recent|\d+(?:st|nd|rd|th)|that|this)\b[^.!?]{0,24}\b(email|e-mail|mail|message|thread|one)\b/.test(
      lower,
    )
  ) {
    return false;
  }
  if (!/\b(email|e-mail|mail|message|thread|inbox)\b/.test(lower) && !/\bgmail\b/.test(lower)) {
    // Still allow "open the first one" when already on mail (caller checks URL).
    if (!/\b(open|read|view|click|pull\s+up|show)\b.{0,24}\b(first|second|third|top|\d+(st|nd|rd|th))\b/.test(lower)) {
      return false;
    }
  }
  if (
    /\b(open|read|view|click|pull\s+up|show)\b.{0,40}\b(first|second|third|top|\d+(st|nd|rd|th)|that|this|the)\b.{0,24}\b(email|e-mail|mail|message|thread|one)\b/.test(
      lower,
    )
  ) {
    return true;
  }
  if (/\b(open|read)\b.{0,24}\b(email|message|mail)\b.{0,24}\b(from|about|re:)\b/.test(lower)) {
    return true;
  }
  // "identify/find the first email … and open it" / "… first email from X and open it"
  if (
    /\b(first|second|third|top|\d+(?:st|nd|rd|th))\b.{0,48}\b(email|e-mail|mail|message|thread)\b/.test(
      lower,
    ) &&
    /\b(open|read|view|click|show|pull\s+up)\b/.test(lower)
  ) {
    return true;
  }
  // "click on the email to open it" / "open that email"
  if (
    /\b(click|open|read|view|tap)\b.{0,32}\b(email|e-mail|mail|message|thread)\b/.test(lower) &&
    /\b(open|read|view|click)\b/.test(lower)
  ) {
    return true;
  }
  return false;
}

function extractMailOpenIndex(text) {
  const lower = String(text || "").toLowerCase();
  if (/\bsecond\b/.test(lower)) return 1;
  if (/\bthird\b/.test(lower)) return 2;
  const nth = lower.match(/\b(\d+)(st|nd|rd|th)\b/);
  if (nth) return Math.max(0, parseInt(nth[1], 10) - 1);
  return 0;
}

/**
 * Richer scrape for inbox-style pages (Gmail list rows, subjects, senders).
 * Email rows are placed FIRST so short LLM prompts don't only see chrome/"Sign in".
 */
async function getPageContextRich(webContents) {
  const basic = await getPageContext(webContents);
  if (!webContents || webContents.isDestroyed()) return basic;
  try {
    const rich = await webContents.executeJavaScript(
      `(function(){
        function clean(s){return ((s||'')+'').replace(/\\s+/g,' ').trim();}
        function rowFrom(el){
          if(!el) return '';
          var sender='', subject='', snippet='', time='';
          var yP=el.querySelector('span.yP, span.zF, span[email]');
          if(yP) sender=clean(yP.getAttribute('name')||yP.getAttribute('email')||yP.innerText);
          var bog=el.querySelector('span.bog, .bqe, .a4W span[data-thread-id]');
          if(bog) subject=clean(bog.innerText);
          var subAlt=el.querySelector('[data-legacy-thread-id] span.bqe, div.y6 span');
          if(!subject && subAlt) subject=clean(subAlt.innerText);
          var y2=el.querySelector('span.y2');
          if(y2) snippet=clean((y2.innerText||'').replace(/^[\\-–—]\\s*/,''));
          var xW=el.querySelector('span.xW span, td.xW span, span.xY');
          if(xW) time=clean(xW.getAttribute('title')||xW.innerText);
          var aria=clean(el.getAttribute('aria-label'));
          if(sender||subject){
            return [sender, subject, snippet, time].filter(Boolean).join(' — ');
          }
          if(aria && aria.length>12 && aria.length<280) return aria;
          var t=clean(el.innerText||el.textContent);
          if(t.length>12 && t.length<400) return t;
          return '';
        }
        var rows=[], seen={};
        var sels=[
          'tr.zA',
          'div.zA',
          'table.F tbody tr',
          'div[role="main"] tr.zA',
          'div[role="main"] div[role="listitem"]',
          'div[data-legacy-thread-id]',
          'div.ae4 tr',
          'div[gh="tl"] tr',
          '[aria-label="Mail"] tr'
        ];
        var nodes=[];
        for (var s=0;s<sels.length && nodes.length<50;s++){
          try{
            document.querySelectorAll(sels[s]).forEach(function(n){
              if(nodes.length<50) nodes.push(n);
            });
          }catch(e){}
        }
        for (var i=0;i<nodes.length && rows.length<12;i++){
          var line=rowFrom(nodes[i]);
          if(!line || seen[line]) continue;
          seen[line]=1;
          rows.push(line);
        }
        var title=document.title||'';
        return {
          rows: rows,
          url: location.href,
          title: title,
          inboxTitle: /inbox/i.test(title) || /#inbox\\b/i.test(location.hash||'')
        };
      })()`,
      true,
    );
    const rows = Array.isArray(rich?.rows) ? rich.rows : [];
    if (rows.length) {
      const rowBlock = [
        "Top visible emails:",
        ...rows.map((r, i) => `${i + 1}. ${r}`),
      ].join("\n");
      // Rows first — browse-summary prompts used to truncate chrome-only text.
      const text = [rowBlock, "", "Other visible page text:", String(basic.text || "").slice(0, 2500)]
        .filter(Boolean)
        .join("\n")
        .slice(0, 12000);
      return {
        ok: true,
        url: rich.url || basic.url,
        title: rich.title || basic.title,
        text,
        rows,
        inboxTitle: !!rich.inboxTitle,
      };
    }
    return {
      ...basic,
      rows: [],
      inboxTitle: !!rich?.inboxTitle,
    };
  } catch {
    /* fall through */
  }
  return { ...basic, rows: [] };
}

/**
 * Strip chat filler from an extracted search topic.
 * "cats now" / "dogs for me please" → "cats" / "dogs"
 */
function stripBrowseFiller(q) {
  let s = String(q || "").trim();
  if (!s) return "";
  s = s
    // Leading politeness / intent wrappers still stuck on the topic
    .replace(
      /^(?:hey\s+|ok(?:ay)?[,.]?\s+|please\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+)*/i,
      "",
    )
    .replace(/^(?:a|an|the|some|any|my|me)\s+/i, "")
    // Trailing chatter people tack onto search asks
    .replace(
      /\s+(?:please|thanks|thank\s+you|thx|for\s+me|for\s+us|now|right\s+now|asap|real\s*quick|quickly|today|tonight|just|really|somehow|kinda|kind\s+of|sort\s+of|lol|thanks!)\s*$/i,
      "",
    )
    // Same fillers mid-phrase (keep topic nouns intact)
    .replace(
      /\b(?:please|thanks|thank\s+you|for\s+me|for\s+us|right\s+now|asap|real\s*quick|quickly|somehow|kinda|kind\s+of|sort\s+of)\b/gi,
      " ",
    )
    // Trailing bare "now" / "just" after a topic word ("cats now")
    .replace(/\s+\b(?:now|just|really)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  // Drop leading articles again after mid-phrase cleanup
  s = s.replace(/^(?:a|an|the|some|any|my|me)\s+/i, "").trim();
  // "the song thunderstruck" / "song thunderstruck" → "thunderstruck"
  s = s.replace(/^(?:(?:the|a|an)\s+)?(?:song|track|tracks|album|artist)\s+/i, "").trim();
  return s;
}

/** Strip chat fluff so we can search / lookup from a natural-language goal. */
function cleanBrowseQuery(text) {
  return stripBrowseFiller(
    String(text || "")
      .replace(
        /^(hey\s+)?(lykn[,:]?\s+)?(please\s+|can you\s+|could you\s+|would you\s+|i need you to\s+|i want you to\s+|i(?:'m|\s+am)\s+looking\s+for\s+|looking\s+for\s+|i need\s+|i want\s+)/i,
        "",
      )
      .replace(
        /\b(open up|open|visit|go into|go to|navigate to|browse(?:\s+to)?|pull up|look up|look for|search up|search for|search|find me|find|show me|show|take me to|load|bring up|some sort of)\b/gi,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/** Vague visual / design inspo asks — do something (usually Pinterest), don't chat-stall. */
function looksLikeInspoBrowseIntent(text) {
  const lower = String(text || "").toLowerCase();
  if (!lower.trim()) return false;
  if (/\b(inspo|inspiration|mood\s*boards?|aesthetics?)\b/.test(lower)) return true;
  if (
    /\b(looking\s+for|need|want|find(?:\s+me)?|show(?:\s+me)?|get(?:\s+me)?|look(?:ing)?\s+at)\b/.test(
      lower,
    ) &&
    /\b(ideas?|examples?|references?|samples?|mockups?|designs?)\b/.test(lower)
  ) {
    return true;
  }
  if (/\b(design|ui|ux|landing\s*page|website|web\s*page|presentation|deck)\s+ideas?\b/.test(lower)) {
    return true;
  }
  // "… UI design ideas for that on pinterest"
  if (
    /\bon\s+(pinterest|dribbble|behance)\b/.test(lower) &&
    /\b(ideas?|inspo|inspiration|design|ui|ux|mockups?|references?|aesthetics?)\b/.test(lower)
  ) {
    return true;
  }
  return false;
}

/**
 * "inspo ideas for a landing page" → "landing page inspiration"
 * Keeps the search useful instead of Googling the whole sentence.
 */
function extractInspoSearchQuery(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";

  const stripSiteTail = (s) =>
    String(s || "")
      .replace(/\s+(?:for\s+)?(?:that|this|it)\s*$/i, "")
      .replace(/\s+on\s+(?:pinterest|dribbble|behance)\b.*$/i, "")
      .trim();

  // "look at some UI design ideas for that on pinterest"
  let m = raw.match(
    /\blook(?:ing)?\s+at\s+(?:some\s+|any\s+|a\s+few\s+)?(.+?)\s+(?:for\s+(?:that|this|it)\s+)?(?:on|via|using)\s+(?:pinterest|dribbble|behance)\b/i,
  );
  if (m && m[1]) {
    let topic = stripBrowseFiller(stripSiteTail(m[1]));
    if (topic && /\blykn\b/i.test(raw) && !/\blykn\b/i.test(topic)) {
      topic = `LYKN ${topic}`;
    }
    if (topic) return topic.replace(/\s+/g, " ").trim().slice(0, 160);
  }

  // "UI design ideas on pinterest" / "design inspo on dribbble"
  m = raw.match(
    /\b((?:ui|ux|app|web|software|browser|glass|product)?[\s-]*(?:design|interface)?[\s-]*(?:ideas?|inspo|inspiration|references?|examples?|mood\s*boards?))\s+(?:for\s+\S+\s+)?on\s+(?:pinterest|dribbble|behance)\b/i,
  );
  if (m && m[1]) {
    let topic = stripBrowseFiller(m[1]);
    if (topic && /\blykn\b/i.test(raw) && !/\blykn\b/i.test(topic)) {
      topic = `LYKN ${topic}`;
    }
    if (topic) return topic.replace(/\s+/g, " ").trim().slice(0, 160);
  }

  m = raw.match(
    /\b(?:inspo|inspiration|ideas?|examples?|references?|samples?)\s+(?:ideas?\s+)?(?:for|on|about)\s+(.+?)(?:\s+on\s+(?:pinterest|dribbble|behance)\b|$)/i,
  );
  if (m && m[1]) {
    const topic = stripBrowseFiller(stripSiteTail(m[1]));
    if (topic && topic.length >= 3 && !/^(?:that|this|it)$/i.test(topic)) {
      return `${topic} inspiration`.replace(/\s+/g, " ").trim().slice(0, 160);
    }
  }

  m = raw.match(
    /\b(?:looking\s+for|need|want|find(?:\s+me)?|show(?:\s+me)?|get(?:\s+me)?)\s+(?:some\s+|any\s+)?(?:inspo|inspiration|ideas?|examples?|references?)\s+(?:ideas?\s+)?(?:for|on|about)\s+(.+?)(?:\s+on\s+(?:pinterest|dribbble|behance)\b|$)/i,
  );
  if (m && m[1]) {
    const topic = stripBrowseFiller(stripSiteTail(m[1]));
    if (topic && topic.length >= 3 && !/^(?:that|this|it)$/i.test(topic)) {
      return `${topic} inspiration`.replace(/\s+/g, " ").trim().slice(0, 160);
    }
  }

  m = raw.match(
    /\b(.+?)\s+(?:inspo|inspiration|mood\s*board|design\s+ideas?|ui\s+ideas?)\b/i,
  );
  if (m && m[1]) {
    const topic = stripBrowseFiller(
      m[1]
        .replace(
          /^(?:i(?:'m|\s+am)\s+)?(?:looking\s+for|need|want|find(?:\s+me)?|show(?:\s+me)?)\s+(?:some\s+|any\s+)?/i,
          "",
        )
        .replace(/\b(?:inspo|inspiration|ideas?|examples?)\b/gi, " "),
    );
    if (topic && topic.length >= 2) {
      return `${topic} inspiration`.replace(/\s+/g, " ").trim().slice(0, 160);
    }
  }

  const cleaned = cleanBrowseQuery(raw)
    .replace(/\b(inspo|inspiration)\b/gi, "inspiration")
    .replace(/\s+/g, " ")
    .trim();
  return stripBrowseFiller(cleaned).slice(0, 160);
}

/**
 * When the user doesn't name a site, assume a sensible destination
 * (stock → Yahoo/TradingView deep link, otherwise Google the ask).
 */
function assumeBrowseSearchUrl(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  const lower = t.toLowerCase();
  if (
    /\b(deep research|research report|build me|code me|generate an? image|compose an? email|monitor|watch for)\b/.test(
      lower,
    )
  ) {
    return "";
  }
  // Never Google "sign in page" / "have it go to the sign in page".
  if (looksLikeSignInNavigation(t)) {
    return resolveSignInUrl(t, "") || "";
  }
  const stockUrl = resolveStockBrowseUrl(t);
  if (stockUrl) return stockUrl;

  const browseVerb =
    /\b(open|visit|go to|navigate|browse|pull up|look up|look for|looking for|search(?:\s+(?:up|for))?|find(?:\s+me)?|show(?:\s+me)?|watch|play|take me|load|bring up)\b/.test(
      lower,
    );
  const browseNoun =
    /\b(website|web ?page|site|stock|ticker|shares|quote|chart|diagram|graph|map|weather|news|wikipedia|recipe|video|videos|vids?|clip|inspo|inspiration|ideas?|examples?|references?)\b/.test(
      lower,
    );
  const videoIntent = looksLikeVideoBrowseIntent(t);
  const inspoIntent = looksLikeInspoBrowseIntent(t);
  if (!browseVerb && !browseNoun && !videoIntent && !inspoIntent) return "";

  // Vague video asks → YouTube (sorted by date when they say latest/newest).
  if (videoIntent) {
    const vq = extractVideoSearchQuery(t) || cleanBrowseQuery(t);
    const yt = youtubeSearchUrl(vq, { sortByDate: wantsLatestVideo(t) });
    if (yt) return yt;
  }

  // Visual inspo → Pinterest with a cleaned topic (not the whole sentence).
  if (inspoIntent) {
    const iq = extractInspoSearchQuery(t) || extractSearchQuery(t) || cleanBrowseQuery(t);
    if (iq && iq.length >= 2) {
      return `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(iq.slice(0, 160))}`;
    }
  }

  const q = extractSearchQuery(t) || cleanBrowseQuery(t);
  if (!q || q.length < 2) return "";

  // Stock-ish but no ticker mapped yet — lookup, don't ask the user for TSLA.
  if (
    /\b(stock|ticker|shares|quote|nasdaq|nyse|candlestick|equity)\b/.test(lower) ||
    /\b(live\s*(time)?\s*(chart|feed|price)|stock\s+(chart|diagram|graph)|livetime)\b/.test(lower)
  ) {
    return `https://finance.yahoo.com/lookup?s=${encodeURIComponent(q.slice(0, 80))}`;
  }

  return `https://www.google.com/search?q=${encodeURIComponent(q.slice(0, 160))}`;
}

/**
 * Prefer a deep link when the goal is "go to SITE and search QUERY"
 * (YouTube/Google etc.), so we don't depend on fragile click/type loops.
 * If no site is named, assume a search/lookup — users shouldn't need domains.
 * @param {string} text
 * @param {{ currentUrl?: string, priorGoal?: string, priorAssistant?: string, recentUserGoals?: string[] }} [ctx]
 */
/** Known "my <service> account/dashboard" destinations — signed-in surfaces. */
const ACCOUNT_DASHBOARD_SITES = [
  {
    re: /\breddit\s+(?:ads?|advertising|promoted|ads?\s*manager)\b|\b(?:ads?|advertising)\s+(?:on\s+)?reddit\b/i,
    url: "https://ads.reddit.com",
  },
  { re: /\bnotion\b/i, url: "https://www.notion.so/" },
  { re: /\bgoogle\s+(?:ads?|adwords|advertising|ads?\s*manager)\b|\badwords\b/i, url: "https://ads.google.com" },
  { re: /\bgoogle\s+analytics\b|\bga4\b/i, url: "https://analytics.google.com" },
  { re: /\bsearch\s+console\b/i, url: "https://search.google.com/search-console" },
  {
    re: /\b(?:meta|facebook)\s+business(?:\s+(?:suite|manager))?\b|\bbusiness\s+suite\b/i,
    url: "https://business.facebook.com",
  },
  {
    re: /\b(?:facebook|meta)\s+(?:ads?|advertising|ads?\s*manager)\b|\bads?\s+manager\b/i,
    url: "https://adsmanager.facebook.com",
  },
  { re: /\btik\s?tok\s+(?:ads?|advertising|ads?\s*manager)\b/i, url: "https://ads.tiktok.com" },
  { re: /\blinkedin\s+(?:ads?|campaign|advertising)/i, url: "https://www.linkedin.com/campaignmanager/" },
  { re: /\b(?:x|twitter)\s+(?:ads?|advertising)\b/i, url: "https://ads.x.com" },
  { re: /\byoutube\s+(?:studio|channel|analytics)\b/i, url: "https://studio.youtube.com" },
  { re: /\bstripe\b/i, url: "https://dashboard.stripe.com" },
  { re: /\bshopify\b/i, url: "https://admin.shopify.com" },
  { re: /\bamazon\s+seller\b|\bseller\s+central\b/i, url: "https://sellercentral.amazon.com" },
  { re: /\betsy\b/i, url: "https://www.etsy.com/your/shops/me/dashboard" },
  { re: /\bpaypal\b/i, url: "https://www.paypal.com/mep/dashboard" },
  { re: /\bquickbooks\b/i, url: "https://qbo.intuit.com" },
  { re: /\bhubspot\b/i, url: "https://app.hubspot.com" },
  { re: /\bmailchimp\b/i, url: "https://admin.mailchimp.com" },
  // Email/newsletter platforms. Without an entry here a named product resolves
  // to nothing, and "make a flyer in Klaviyo" reads as a plain image request.
  { re: /\bklaviyo\b/i, url: "https://www.klaviyo.com/dashboard" },
  { re: /\bbrevo\b|\bsendinblue\b/i, url: "https://app.brevo.com" },
  { re: /\bconstant\s?contact\b/i, url: "https://login.constantcontact.com" },
  { re: /\bactive\s?campaign\b/i, url: "https://www.activecampaign.com/login" },
  { re: /\bconvert\s?kit\b/i, url: "https://app.kit.com" },
  { re: /\bbeehiiv\b/i, url: "https://app.beehiiv.com" },
  { re: /\bmailerlite\b/i, url: "https://dashboard.mailerlite.com" },
  { re: /\bsubstack\b/i, url: "https://substack.com/home" },
  { re: /\bsquarespace\b/i, url: "https://account.squarespace.com" },
  { re: /\bwix\b/i, url: "https://manage.wix.com" },
  { re: /\bwordpress\b/i, url: "https://wordpress.com/home" },
  { re: /\bgodaddy\b/i, url: "https://account.godaddy.com" },
  { re: /\bcloudflare\b/i, url: "https://dash.cloudflare.com" },
  { re: /\bvercel\b/i, url: "https://vercel.com/dashboard" },
  { re: /\bnetlify\b/i, url: "https://app.netlify.com" },
  { re: /\bsupabase\b/i, url: "https://supabase.com/dashboard" },
  { re: /\baws\b|\bamazon\s+web\s+services\b/i, url: "https://console.aws.amazon.com" },
  { re: /\bopenai\b/i, url: "https://platform.openai.com" },
  { re: /\bgithub\b/i, url: "https://github.com" },
];

const ACCOUNT_SURFACE_NOUN_RE =
  /\b(account|dashboard|admin|console|analytics|ads?|advertising|store|shop|channel|billing|campaigns?|profile|settings|seller|studio|workspace|portal|manager)\b/i;

/**
 * "check my reddit ads account" / "log into my shopify admin" → the real
 * signed-in dashboard URL, so account asks route to browse instead of dying
 * in chat with "connect your account". Unknown services fall back to a
 * Google search so the browse loop can still find the login page.
 */
function resolveAccountDashboardUrl(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 300) return "";
  if (!ACCOUNT_SURFACE_NOUN_RE.test(t)) return "";
  const verbish =
    /\b(?:check|open|go\s+(?:to|into)|log\s*in(?:\s*to)?|sign\s*in(?:\s*to)?|pull\s+up|review|look\s+at|visit|show\s+me|see)\b/i.test(t);
  const accountish =
    (verbish && /\bmy\b/i.test(t)) ||
    /\bmy\s+[\w .-]{2,40}\s+(?:account|dashboard|admin|console|analytics|ads?\s+account)\b/i.test(t);
  // Known service + browse verb maps even without "my" ("open stripe dashboard").
  if (accountish || verbish) {
    for (const site of ACCOUNT_DASHBOARD_SITES) {
      if (site.re.test(t)) return site.url;
    }
  }
  if (!accountish) return "";
  // Unknown service: search "<service words> <surface>" — lands on/near the login.
  const m = t.match(
    /\bmy\s+([\w .&'-]{2,40}?)\s+(account|dashboard|admin|console|analytics|ads?|store|shop|channel|billing|campaigns?|seller|studio|portal)\b/i,
  );
  if (m && m[1]) {
    const q = `${m[1].trim()} ${m[2].trim()}`.replace(/\s+/g, " ").trim();
    if (q.length >= 4) {
      return `https://www.google.com/search?q=${encodeURIComponent(q.slice(0, 120))}`;
    }
  }
  return "";
}

// "in mailchimp", "on hubspot", "using notion" — the user naming WHERE the
// work happens. This is the most explicit routing signal there is, so it wins
// over every other heuristic: a task told to happen in a named product must
// never be relocated to a different one just because the wording also
// mentions "email", "calendar" or "docs".
const WORK_VENUE_PHRASE_RE =
  /\b(?:in|into|on|onto|via|using|use|with|inside|through|from|(?:go|head|hop|jump|switch|navigate|log\s*in|sign\s*in)\s+(?:on\s+)?(?:to|into|over\s+to)|over\s+(?:in|on|to)|open(?:\s+up)?|pull\s+up|to)\s+(?:my\s+|our\s+|the\s+|a\s+)?([a-z0-9][a-z0-9.&'-]*(?:\s+[a-z0-9][a-z0-9.&'-]*)?)/gi;

const MAIL_VENUE_URL_RE =
  /mail\.google\.com|google\.com\/gmail|outlook\.(?:live|office|com)|mail\.yahoo|proton\.me|zoho\.com\/mail|icloud\.com\/mail|mail\.aol/i;

/** Is this destination an email client (vs. any other product)? */
function isMailVenueUrl(url) {
  return MAIL_VENUE_URL_RE.test(String(url || ""));
}

/** Known destination for a bare venue name, or "" when unrecognized. */
function venueUrlForName(name) {
  const n = String(name || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!n || n.length < 2 || n.length > 40) return "";
  // People space product names however they like ("mail chimp", "square
  // space"), so try the spelling as typed and then with spaces closed up.
  const squashed = n.replace(/\s+/g, "");
  const candidates = squashed === n ? [n] : [n, squashed];
  for (const cand of candidates) {
    for (const [re, url] of SITE_ALIAS_PHRASES) {
      if (re.test(cand)) return url;
    }
    if (SITE_ALIASES[cand]) return SITE_ALIASES[cand];
    for (const site of ACCOUNT_DASHBOARD_SITES) {
      if (site.re.test(cand)) return site.url;
    }
  }
  return "";
}

/**
 * The product the user named as the place to do the work. Returns "" when no
 * venue is named or the name is unfamiliar — unfamiliar names are left to the
 * intent interpreter, which can search for the product instead of guessing.
 */
function resolveNamedWorkVenueUrl(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 400) return "";
  for (const m of t.matchAll(WORK_VENUE_PHRASE_RE)) {
    const raw = String(m[1] || "").trim();
    // Two-word phrases first ("google sheets"), then the leading word.
    const url = venueUrlForName(raw) || venueUrlForName(raw.split(/\s+/)[0]);
    if (url) return url;
  }
  return "";
}

/**
 * The ask names a specific product that is NOT an email client. Callers use
 * this to keep email-shaped wording ("draft an email in Mailchimp") from being
 * hijacked into Gmail.
 */
function namesNonMailVenue(text) {
  const url = resolveNamedWorkVenueUrl(text);
  return !!url && !isMailVenueUrl(url);
}

/** Object of an "open/click/play/select …" ask — the thing the user wants opened. */
function extractOpenTargetName(text) {
  const t = String(text || "").trim();
  const m = t.match(
    /\b(?:open|click(?:\s+on)?|pull\s+up|play|select|show\s+me|go\s+into)\s+(?:up\s+)?(.+)$/i,
  );
  if (!m || !m[1]) return "";
  return m[1]
    .replace(/^(?:the|my|that|this|a|an|on)\s+/i, "")
    .replace(/\s+(?:for\s+me|please|now|real\s+quick|right\s+now)\s*[.!?]?\s*$/i, "")
    .replace(/[.!?]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

// Product/app names that mean "navigate there", never an item on the page.
const KNOWN_APP_NAME_RE =
  /^(?:google\s+)?(?:drive|docs?|sheets?|slides?|forms?|calendar|meet|maps|photos|keep)$|^(?:gmail|youtube|yt|google|bing|spotify|netflix|hulu|notion|figma|canva|github|amazon|ebay|etsy|reddit|twitter|x|instagram|facebook|tiktok|linkedin|pinterest|twitch|discord|slack|zoom|stripe|shopify|wikipedia|chatgpt|claude)$/i;

/** Is this name a site/app destination (vs. an item on the current page)? */
function isKnownSiteName(name) {
  const n = String(name || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!n || n.length > 48) return false;
  if (SITE_ALIASES[n]) return true;
  if (KNOWN_APP_NAME_RE.test(n)) return true;
  // Domain-shaped ("lykn.io", "example.com/path")
  if (/^(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+(?:\/\S*)?$/i.test(n)) return true;
  for (const site of ACCOUNT_DASHBOARD_SITES) {
    if (site.re.test(n)) return true;
  }
  return false;
}

/**
 * Is this name visible on the current page (an interactable's label or the
 * page text)? Used to keep "open the LYKN ad" on the open Drive tab instead
 * of Googling the phrase and wandering off.
 */
async function findNameOnPage(webContents, name) {
  const want = String(name || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!want || want.length < 2 || !webContents || webContents.isDestroyed?.()) return false;
  try {
    const catalog = await getDOMCatalog(webContents);
    const items = Array.isArray(catalog?.items) ? catalog.items : [];
    const labels = items.map((it) => String(it.label || "").toLowerCase().replace(/\s+/g, " "));
    if (labels.some((lab) => lab.includes(want))) return true;
    // All words of a multi-word name inside one label ("LYKN ad" vs "LYKN — ad draft v2").
    const words = want.split(" ").filter((w) => w.length >= 2);
    if (words.length >= 2 && labels.some((lab) => words.every((w) => lab.includes(w)))) {
      return true;
    }
    const page = await getPageContext(webContents);
    if (String(page?.text || "").toLowerCase().replace(/\s+/g, " ").includes(want)) {
      return true;
    }
  } catch {
    /* best-effort */
  }
  return false;
}

/** "https://finance.yahoo.com/quote/TSLA" → "yahoo.com" */
function registrableDomain(url) {
  try {
    const parts = new URL(String(url || "")).hostname.replace(/^www\./i, "").split(".");
    return parts.slice(-2).join(".").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Where a browse ask should land.
 *
 * Naming a product settles WHICH product, and nothing inferred from the wording
 * may override that — "draft an email in Mailchimp" is Mailchimp work, and the
 * email deep-links must not drag it to Gmail. But naming a product does not
 * settle WHERE INSIDE IT: "open Reddit and search for mechanical keyboards"
 * names Reddit and also says where to land, and answering with the Reddit
 * homepage throws the actual request away. So the specific destination wins
 * whenever it agrees with the named product, and the product wins whenever the
 * specific destination would leave it.
 */
function resolveBrowseTargetUrl(text, ctx = {}) {
  const venueUrl = resolveNamedWorkVenueUrl(text);
  const resolved = resolveBrowseTargetUrlIgnoringVenue(text, ctx);
  if (!venueUrl) return resolved;
  if (!resolved) return venueUrl;
  return registrableDomain(resolved) === registrableDomain(venueUrl) ? resolved : venueUrl;
}

function resolveBrowseTargetUrlIgnoringVenue(text, ctx = {}) {
  // Stock intents first — "yahoo stocks + tesla" / "live tesla chart" with no domain.
  const stockUrl = resolveStockBrowseUrl(text);
  if (stockUrl) return stockUrl;

  // "check my reddit ads account" → real dashboard, not chat / generic search.
  const accountUrl = resolveAccountDashboardUrl(text);
  if (accountUrl) return accountUrl;

  // Sign-in / login page asks → real auth URL, never a Google search of the phrase.
  if (looksLikeSignInNavigation(text)) {
    const signUrl = resolveSignInUrl(text, "");
    if (signUrl) return signUrl;
  }

  // Drafts folder — deep-link when signed in; otherwise login→drafts via continue.
  if (looksLikeMailDraftsReview(text)) {
    return gmailDraftsUrl();
  }

  // Open/check Gmail → auth with continue=inbox (signed-in users land in inbox;
  // signed-out users get the real login form instead of the public about page).
  if (looksLikeGmailOpenOrReview(text)) {
    return gmailSignInUrl();
  }

  // Chat/tab-aware follow-ups: blank workspace, deictic "play/do/open it", etc.
  const contextual = resolveContextualBrowseUrl(text, ctx);
  if (contextual) return contextual;

  // "open google sheets" / "open figma" — product deep link or search→auto-open.
  if (looksLikeOpenDestinationAsk(text)) {
    const dest = resolveOpenDestinationUrl(text, ctx);
    if (dest) return dest;
  }

  const base = extractUrlFromText(text);
  const videoIntent = looksLikeVideoBrowseIntent(text);
  const inspoIntent = looksLikeInspoBrowseIntent(text);
  const query = videoIntent
    ? extractVideoSearchQuery(text) || extractSearchQuery(text)
    : extractSearchQuery(text);
  // No named site: never dump the whole prompt into Google — use a clean query,
  // keep video on YouTube and visual inspo on Pinterest.
  // Pronoun / deictic follow-ups need ctx via resolveContextualBrowseUrl above.
  if (!base) {
    if (looksLikePlayMediaFollowUp(text) || looksLikeDeicticFollowUp(text)) return "";
    if (videoIntent || inspoIntent) return assumeBrowseSearchUrl(text);
    if (query && query.length >= 2) {
      return `https://www.google.com/search?q=${encodeURIComponent(query.slice(0, 160))}`;
    }
    return assumeBrowseSearchUrl(text);
  }
  // Gmail alias alone ("open gmail") → sign-in→inbox, not bare inbox / about bounce.
  if (
    looksLikeGmailPublicPage(base) ||
    /mail\.google\.com/i.test(base) ||
    /\/gmail/i.test(base)
  ) {
    if (looksLikeSignInNavigation(text) || looksLikeGmailOpenOrReview(text) || !query) {
      return gmailSignInUrl();
    }
  }
  if (!query) return base;
  return (
    searchDeepLinkForUrl(base, query, {
      sortByDate: videoIntent && wantsLatestVideo(text),
    }) || base
  );
}

module.exports = {
  readTargetFieldValue,
  looksLikeSendApprovalFollowUp,
  navigate,
  getDOMCatalog,
  dismissOverlays,
  REF_STORE_JS,
  getPageContext,
  getPageContextRich,
  waitForDomSettle,
  waitForMailReady,
  waitForSearchResultsReady,
  urlMaybeNeedsAuthCheck,
  looksLikeBareOpenBrowseGoal,
  looksLikeAccountDashboardAsk,
  accountDashboardLooksSignedIn,
  askStillNeedsAdaptiveWork,
  looksLikeInspectOrReviewAsk,
  asksAboutAppState,
  looksLikeOwnAppContentAsk,
  unmetBrowseAskRequirements,
  pageShowsSubstantialDocBody,
  remainingAskGoal,
  planStepAlreadySatisfied,
  userAskSatisfiedOnPage,
  extractBrowseGoalPhases,
  browseGoalPhasesEvidence,
  taskPlanBlocksDone,
  waitForUrlStable,
  runAction,
  clickAtClientPoint,
  sendRealKey,
  sendShortcut,
  // The live viewport, and the screenshot-space mapper. Exported so the
  // browser-agent controller can notice a resize between observe and act, and
  // so the mapper's stale-capture refusal is testable outside Electron.
  getViewportMetrics,
  mapNormCoordToClient,
  // The no-coordinate route into a dialog's field — exported so its page-side
  // script can be exercised directly.
  buildFocusDialogFieldJs,
  focusOpenDialogField,
  resolveAccountDashboardUrl,
  resolveNamedWorkVenueUrl,
  namesNonMailVenue,
  isMailVenueUrl,
  extractOpenTargetName,
  isKnownSiteName,
  findNameOnPage,
  clickGmailInboxRow,
  clickInPageByHint,
  screenshotDataUrl,
  waitForChange,
  waitForLoad,
  executeOwnedAdaptiveTask,
  looksBrowseGoalSatisfied,
  looksLikeMultiStepBrowseGoal,
  seedProgressiveTaskPlan,
  progressivePlanNowLine,
  formatStuckNeedsHelp,
  pageShowsExerciseComplete,
  pageShowsShareInviteComplete,
  pageShowsShareEmailEntered,
  pageShowsShareDialogOpen,
  historyShowsShareSendDone,
  extractUrlFromText,
  extractSearchQuery,
  composeBrowseSearchQuery,
  looksLikePickOneBrowseIntent,
  extractVideoSearchQuery,
  extractStockTicker,
  resolveBrowseTargetUrl,
  resolveStockBrowseUrl,
  assumeBrowseSearchUrl,
  cleanBrowseQuery,
  stripBrowseFiller,
  looksLikeInspoBrowseIntent,
  extractInspoSearchQuery,
  searchDeepLinkForUrl,
  youtubeSearchUrl,
  looksLikeVideoBrowseIntent,
  wantsLatestVideo,
  looksLikeSameTabSearch,
  looksLikeRetargetSearchToSite,
  resolveSiteClarificationUrl,
  looksLikeBrowseSiteClarification,
  priorAskedForSiteClarification,
  isStockBrowseIntent,
  isPlaceholderAgentUrl,
  looksLikeCurrentTabTask,
  looksLikePageQuestionAsk,
  looksLikeCasualConversation,
  looksLikeBrowseActAsk,
  looksLikeInPageAction,
  looksLikeShareCurrentPageAsk,
  isShareInviteGoal,
  stripShareSendInstructions,
  sanitizeDraftedDocBody,
  sharePageWithEmail,
  looksLikeOpenSearchResult,
  looksLikeOpenMailItem,
  extractMailOpenIndex,
  extractQuotedTitle,
  clickSearchResultOnPage,
  peekSearchResultHref,
  peekYoutubeResultHref,
  unwrapGoogleRedirect,
  looksLikeOpenDestinationAsk,
  looksLikeWrongOpenDestinationAsk,
  extractOpenDestinationName,
  resolveOpenDestinationUrl,
  resolveWellKnownBrandUrl,
  looksLikeNewBlankWorkspaceAsk,
  resolveNewBlankWorkspaceUrl,
  resolveContextualBrowseUrl,
  inferGoogleCreateProduct,
  setUserSiteAliases,
  getUserSiteAliases,
  resolveUserSavedUrl,
  looksLikeMailComposeTask,
  looksLikeMailReplyTask,
  looksLikePasteIntoCompose,
  looksLikeMailDraftRevision,
  extractOpenMailThread,
  clickGmailReply,
  isGmailComposeUrl,
  extractEmailAddress,
  parseMailDraftFromText,
  synthesizeMailDraft,
  toPlainEmailText,
  sanitizeMailDraft,
  resolveGmailComposeUrl,
  fillGmailComposeDraft,
  attachFileToGmailCompose,
  clickGmailSend,
  looksLikeSendDeliverableAsk,
  looksLikeExplicitMailSendAsk,
  markdownReportToSheetText,
  looksLikePasteIntoSheets,
  looksLikeOrganizeSheetAsk,
  looksLikeGoogleSheetsUrl,
  focusGoogleSheetGrid,
  fillGoogleSheetFromText,
  pasteTextIntoPage,
  focusPageEditor,
  looksLikeGoogleDocsUrl,
  looksLikeCanvasEditorUrl,
  clickSendInShareDialog,
  typeEmailIntoShareDialog,
  typeWithFocusRetry,
  focusTypeTarget,
  readActiveEditableState,
  dismissDiscardChangesDialog,
  pageShowsDiscardChangesDialog,
  looksLikeShareDismissAction,
  resolveInPageTargetUrl,
  looksLikeSignedInMailUrl,
  looksLikeGmailPublicPage,
  looksLikeGmailPublicContent,
  looksLikeGmailNeedsSignIn,
  looksLikeMailInboxReview,
  looksLikeMailDraftsReview,
  looksLikeGmailOpenOrReview,
  looksLikeSignInNavigation,
  gmailInboxUrl,
  gmailDraftsUrl,
  gmailSignInUrl,
  resolveSignInUrl,
  looksLikeSignInPageText,
  looksLikeSignInWall,
  looksLikeMarketingOrHomeUrl,
  looksLikePaywall,
  detectBrowseBlocker,
  advanceTowardUserGate,
  formatUserHelpBrief,
  frameByRoutingId,
  buildFrameOffsets,
  readFrameElementValue,
  dragByInput,
  resolveDragEndpoint,
  describeSignInUserAction,
  signInPageThirdPartyNote,
  describeStuckUserAction,
  deliverableContentReady,
  waitForSignInClear,
  waitForUserAssist,
  peekVenueDeepLinkFromSerp,
  peekSpotifyResultHref,
  looksLikePlayMediaAsk,
  looksLikePlayMediaFollowUp,
  looksLikeDeicticFollowUp,
  expandDeicticFollowUp,
  resolveFollowUpReferent,
  composeAdaptiveBrowseGoal,
  isWeakPickQuery,
  SITE_ALIASES,
};
