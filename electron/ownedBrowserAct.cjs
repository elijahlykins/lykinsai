/**
 * Actuator for LYKN-owned agent browser sessions (Electron webContents).
 * Parallel-safe: no global lock; each agent owns its own webContents.
 */

const COLLECT_INTERACTABLES_JS =
  "(function(){function p(el){if(!el||el.nodeType!==1)return'';if(el.id)return '#'+CSS.escape(el.id);" +
  "var a=[],n=el;while(n&&n.nodeType===1&&a.length<6){var t=n.nodeName.toLowerCase();" +
  "if(n.id){a.unshift('#'+CSS.escape(n.id));break;}var s=n,x=1;" +
  "while(s=s.previousElementSibling){if(s.nodeName===n.nodeName)x++;}" +
  "a.unshift(t+(x>1?':nth-of-type('+x+')':''));n=n.parentElement;}return a.join(' > ');}" +
  "var items=[],q='input,textarea,select,button,a[href],img[alt],img[title],picture,canvas,[role=button],[role=link],[role=searchbox],[role=combobox],[role=radio],[role=option],[role=tab],[role=img],[role=row],[role=listitem],[role=gridcell],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=treeitem],[role=checkbox],[role=switch],tr,li,figure,label,input[type=radio],input[type=checkbox],[tabindex],[onclick]';" +
  "var vw=window.innerWidth||1200,vh=window.innerHeight||800;" +
  "document.querySelectorAll(q).forEach(function(el,i){if(items.length>=170||i>2000)return;var r=el.getBoundingClientRect();" +
  "if(r.width<2||r.height<2)return;var st=getComputedStyle(el);" +
  "if(st.visibility==='hidden'||st.display==='none'||st.pointerEvents==='none')return;" +
  "var ti=el.getAttribute('tabindex');if(ti!==null&&parseInt(ti,10)<0)return;var tag=el.tagName.toLowerCase()," +
  "type=el.getAttribute('type')||'',role=el.getAttribute('role')||''," +
  "lab=(el.getAttribute('aria-label')||el.getAttribute('alt')||el.getAttribute('title')||el.innerText||el.placeholder||el.name||el.id||'').trim().slice(0,120);" +
  "if(!lab&&tag==='img')lab='image';" +
  "if(!lab&&tag!=='input'&&tag!=='textarea'&&role!=='searchbox'&&tag!=='img'&&tag!=='canvas')return;" +
  "var inView=r.bottom>0&&r.top<vh&&r.right>0&&r.left<vw;" +
  "items.push({id:'el'+items.length,tag:tag,type:type,role:role,selector:p(el),label:lab,value:(el.value||'').slice(0,80),checked:el.checked===true,href:(el.href||'').slice(0,200),clientX:Math.round(r.left+r.width/2),clientY:Math.round(r.top+r.height/2),inView:inView});});" +
  "return {url:location.href,title:document.title,items:items};})()";

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

function buildActionJs(action) {
  const payload = Buffer.from(JSON.stringify(action || {}), "utf8").toString("base64");
  return (
    "(function(){try{var a=JSON.parse(atob('" +
    payload +
    "'));" +
    "function vis(el){if(!el)return false;var r=el.getBoundingClientRect();if(r.width<2||r.height<2)return false;" +
    "var st=getComputedStyle(el);return st.visibility!=='hidden'&&st.display!=='none'&&st.pointerEvents!=='none';}" +
    "function findEl(a){var el=null;try{el=document.querySelector(a.selector);}catch(e){}if(el&&vis(el))return el;" +
    "var want=(a.label||'').toLowerCase().trim();if(!want)return null;" +
    "var nodes=document.querySelectorAll('input,textarea,select,button,a,img,tr,li,[role=button],[role=link],[role=radio],[role=option],[role=row],[role=listitem],[role=tab],[role=menuitem],label,[tabindex],div.zA,tr.zA');" +
    "for(var i=0;i<nodes.length;i++){var n=nodes[i],lab=((n.getAttribute('aria-label')||n.innerText||n.placeholder||'')+'').toLowerCase().replace(/\\s+/g,' ').trim();" +
    "if(lab&&(lab.indexOf(want)>-1||want.indexOf(lab.slice(0,40))>-1)&&vis(n))return n;}return null;}" +
    "function setVal(el,v){" +
    "try{el.scrollIntoView({block:'center',inline:'nearest'});}catch(e){}" +
    "try{el.click();}catch(e1){} try{el.focus();}catch(e2){}" +
    "var p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;" +
    "var d=Object.getOwnPropertyDescriptor(p,'value');if(d&&d.set)d.set.call(el,v);else el.value=v;" +
    "el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}" +
    "var el=findEl(a);if(!el)return {ok:false,error:'Element not found'};" +
    "if(a.type==='type'||a.type==='fill'){" +
    "var before=((el.value!=null?el.value:el.innerText)||'')+'';" +
    "setVal(el,a.text||a.value||'');" +
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
  const modMap = {
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
    mod: process.platform === "darwin" ? "meta" : "control",
  };
  const modifiers = parts.slice(0, -1).map((m) => modMap[m] || m);
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
function mapNormCoordToClient(nx, ny, metrics, shotMeta) {
  const m = metrics || {};
  const viewportW = Number(m.w) || Number(m.cw) || 1200;
  const viewportH = Number(m.h) || Number(m.ch) || 800;
  const captureW = Number(shotMeta?.captureCssW) || Number(shotMeta?.cssW) || 0;
  const captureH = Number(shotMeta?.captureCssH) || Number(shotMeta?.cssH) || 0;
  let w = viewportW;
  let h = viewportH;
  if (captureW > 0) {
    const drift = Math.abs(captureW - viewportW) / Math.max(viewportW, 1);
    // Near match → trust capture (what the model saw). Large mismatch → blend
    // so a wider capture doesn't push every click toward the right edge.
    w = drift <= 0.03 ? captureW : Math.round((captureW + viewportW) / 2);
  }
  if (captureH > 0) {
    const driftH = Math.abs(captureH - viewportH) / Math.max(viewportH, 1);
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

/** Real mouse events into the owned tab — SPAs (Gmail/YouTube) often ignore el.click(). */
async function clickAtClientPoint(webContents, clientX, clientY) {
  if (!webContents || webContents.isDestroyed?.()) return { ok: false, error: "no_webcontents" };
  const x = Math.round(Number(clientX));
  const y = Math.round(Number(clientY));
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
        var d=JSON.parse(atob('${hintPayload}'));
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

/**
 * Click into a field, type, verify the value/page changed; re-click and retry
 * if typing had no effect.
 */
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
  } = {},
) {
  const value = String(text ?? "");
  if (!value) return { ok: false, error: "empty_text" };
  const needle = String(verifyNeedle || value)
    .trim()
    .slice(0, 48)
    .toLowerCase();
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
    if (needle && !canvas) {
      try {
        const p = await getPageContext(webContents);
        pageHit = String(p?.text || "")
          .toLowerCase()
          .includes(needle);
      } catch {
        /* ignore */
      }
    }
    const valueHit =
      !!needle &&
      String(after?.value || "")
        .toLowerCase()
        .includes(needle);
    const grew =
      Number(after?.valueLen || 0) > Number(before?.valueLen || 0) + Math.min(2, value.length - 1);
    const activeOk = !!after?.activeOk && !after?.titleish;

    if (valueHit || pageHit || (grew && activeOk)) {
      return {
        ok: true,
        type: "os_write",
        via: attempt === 0 ? "insert" : "insert_retry",
        chars: value.length,
        attempts: attempt + 1,
        verified: valueHit || pageHit,
      };
    }

    lastErr = activeOk ? "type_no_effect" : "field_not_focused";
    // Re-click path continues loop.
  }

  return { ok: false, error: lastErr || "type_no_effect", chars: value.length, attempts: maxAttempts };
}

/**
 * Fresh, exact click point for an action's target. Finds the element LIVE
 * (selector first, then label), scrolls it into view, re-measures, and
 * hit-tests the point so the click lands on the intended element — not
 * wherever it sat when the catalog was scraped.
 */
async function resolveElementPoint(webContents, action) {
  if (!webContents || webContents.isDestroyed?.()) return null;
  const payload = Buffer.from(JSON.stringify(action || {}), "utf8").toString("base64");
  try {
    const pt = await webContents.executeJavaScript(
      `(function(){try{var a=JSON.parse(atob('${payload}'));` +
        `function visEl(el){if(!el)return null;var r=el.getBoundingClientRect();if(r.width<2||r.height<2)return null;` +
        `var st=getComputedStyle(el);if(st.visibility==='hidden'||st.display==='none')return null;return el;}` +
        `function point(el){try{el.scrollIntoView({block:'center',inline:'center'});}catch(e){}` +
        `var r=el.getBoundingClientRect();` +
        `var x=Math.round(r.left+r.width/2),y=Math.round(r.top+Math.min(r.height/2,120));` +
        `x=Math.max(1,Math.min(x,(window.innerWidth||1200)-1));y=Math.max(1,Math.min(y,(window.innerHeight||800)-1));` +
        `var hitOk=false;try{var hit=document.elementFromPoint(x,y);hitOk=!!(hit&&(hit===el||el.contains(hit)||hit.contains(el)));}catch(e){}` +
        `return {x:x,y:y,hit:hitOk};}` +
        `var el=null;try{el=document.querySelector(a.selector);}catch(e){}el=visEl(el);` +
        `if(el)return point(el);` +
        `var want=(a.label||'').toLowerCase().replace(/\\s+/g,' ').trim();if(!want)return null;` +
        `var nodes=document.querySelectorAll('a,button,input,select,textarea,tr,li,img,[role=button],[role=link],[role=row],[role=listitem],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=combobox],[role=switch],label,div.zA,tr.zA,[tabindex],[onclick]');` +
        `var best=null,bestScore=0;` +
        `for(var i=0;i<nodes.length;i++){var n=nodes[i],lab=((n.getAttribute('aria-label')||n.getAttribute('alt')||n.getAttribute('title')||n.innerText||n.placeholder||'')+'').toLowerCase().replace(/\\s+/g,' ').trim();` +
        `if(!lab||!visEl(n))continue;` +
        `var score=0;if(lab===want)score=100;else if(lab.indexOf(want)===0)score=80;` +
        `else if(lab.indexOf(want)>-1)score=60-Math.min(40,Math.abs(lab.length-want.length));` +
        `else if(want.indexOf(lab)>-1&&lab.length>=4)score=40;` +
        `if(score>bestScore){bestScore=score;best=n;if(score>=100)break;}}` +
        `if(best)return point(best);return null;}catch(e){return null;}})()`,
      true,
    );
    if (pt && typeof pt.x === "number" && typeof pt.y === "number") return pt;
  } catch {
    /* ignore */
  }
  return null;
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

async function getDOMCatalog(webContents) {
  if (!webContents || webContents.isDestroyed()) return { ok: false, error: "no_webcontents" };
  try {
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
    return { ok: true, ...(data || {}), url, items };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
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
      await webContents.executeJavaScript(
        `window.scrollBy(0, ${Number(enriched.dy) || 400}); true`,
        true,
      );
      return { ok: true, type: "scroll" };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
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
      if (sent?.ok) return { ...sent, type: "click", resolved: "share_send_before_coord" };
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

    // Prefer explicit client pixels, else map 0–1000 screenshot coords.
    let clickPoint = null;
    if (
      typeof enriched.clientX === "number" &&
      typeof enriched.clientY === "number" &&
      Number.isFinite(enriched.clientX) &&
      Number.isFinite(enriched.clientY)
    ) {
      clickPoint = { x: enriched.clientX, y: enriched.clientY };
    } else {
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

    return typeWithFocusRetry(webContents, {
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
    });
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
    return sendRealKey(webContents, enriched.key || "Enter", enriched.modifiers);
  }
  // Hover: real mouseMove at the element's center (reveals menus/tooltips).
  if (type === "hover" || type === "mouseover") {
    const pt =
      (await resolveElementPoint(webContents, enriched)) ||
      (typeof enriched.clientX === "number" && {
        x: enriched.clientX,
        y: enriched.clientY,
      });
    if (!pt) return { ok: false, error: "Element not found" };
    try {
      webContents.sendInputEvent({ type: "mouseMove", x: pt.x, y: pt.y });
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
    if (pt) {
      const hit = await clickAtClientPoint(webContents, pt.x, pt.y);
      if (hit.ok) return { ...hit, resolved: "live", hitTest: pt.hit !== false };
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
 * True when the ask still needs in-page work after landing on a URL —
 * find/complete/fill/share/etc. Used to block "Opened X. What next?" early exits.
 */
function askStillNeedsAdaptiveWork(text) {
  const g = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!g) return false;
  if (looksLikeMultiStepBrowseGoal(g)) return true;
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
      )
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
  if (
    !/\b(check|review|look\s+(?:at|over)|see|inspect|status|how\s+(?:is|are)|show\s+me|pull\s+up|open)\b/.test(
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
    // ads.reddit.com ↔ reddit.com/ads paths
    const wBase = wh.split(".").slice(-2).join(".");
    const hBase = hh.split(".").slice(-2).join(".");
    if (wBase && wBase === hBase) {
      if (/^ads\./i.test(wh)) return /^ads\./i.test(hh) || /\/ads\b/i.test(have.pathname || "");
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function historyHasTypedContent(history) {
  const hist = Array.isArray(history) ? history : [];
  return hist.some((h) => {
    const t = String(h?.action?.type || "").toLowerCase();
    const val = String(h?.action?.value || h?.action?.text || "").trim();
    return (
      h?.result?.ok &&
      /^(?:os_write|write|type|fill|paste|click_type|input)$/i.test(t) &&
      (val.length >= 2 || t === "paste" || t === "os_write" || t === "write")
    );
  });
}

/**
 * True when the open editor already has real body content (not just Docs chrome).
 * Lets us skip re-writing when history was lost between plan steps.
 */
function pageShowsSubstantialDocBody(pageText = "", url = "") {
  const u = String(url || "");
  const onEditor =
    /docs\.google\.com\/document\//i.test(u) ||
    /docs\.google\.com\/spreadsheets\//i.test(u) ||
    /docs\.google\.com\/presentation\//i.test(u) ||
    /notion\.(so|site)\//i.test(u) ||
    looksLikeCanvasEditorUrl(u);
  if (!onEditor && !String(pageText || "").trim()) return false;
  const body = String(pageText || "")
    .replace(
      /\b(File|Edit|View|Insert|Format|Tools|Extensions|Help|Share|Comment|Comments|Editing|Suggesting|Viewing|Untitled document|Untitled spreadsheet|Untitled presentation|Last edit was|Document tabs|Menus|Toolbar|Search the menus|Normal text|Arial|Courier)\b/gi,
      " ",
    )
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  { url = "", pageText = "", title = "", history = [], sawScreenChange = false } = {},
) {
  const rawGoal = String(goal || "");
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
  if (
    looksLikeSignInWall({
      url: u,
      text,
      title,
    })
  ) {
    return ["sign in so the page is usable"];
  }

  // Inspect/review: landing on the right surface with content is enough.
  if (looksLikeInspectOrReviewAsk(goal)) {
    if (/google\.com\/search|bing\.com\/search|duckduckgo\.com\/\?|youtube\.com\/results/i.test(u)) {
      return ["open the requested page (still on search results)"];
    }
    const accountUrl = resolveAccountDashboardUrl(goal);
    if (accountUrl && !/google\.com\/search/i.test(accountUrl)) {
      if (!hostsMatchForAsk(accountUrl, u)) return ["open the requested dashboard/account"];
      if (text.trim().length < 40 && !/ads\.|dashboard|campaign|analytics|admin/i.test(u)) {
        return ["wait for the dashboard content to load"];
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

  if (
    /google\.com\/search|bing\.com\/search|duckduckgo\.com\/\?|youtube\.com\/results/i.test(u) &&
    askStillNeedsAdaptiveWork(g)
  ) {
    unmet.push("leave search results and open the target");
  }

  const wantsWrite =
    /\b(write|draft|compose|essay|author|paper)\b/.test(g) ||
    /\bwrite\s+out\b/.test(g) ||
    (/\bfill\b/.test(g) && /\b(form|doc|document|sheet|field|out|in)\b/.test(g)) ||
    (/\btype\b/.test(g) &&
      !/\b(type of|prototype)\b/.test(g) &&
      /\b(essay|doc|document|content|text|reply|response|message|email|notes?|body|paper)\b/.test(g));
  const writeDone = typedOk || pageShowsSubstantialDocBody(text, u);
  if (wantsWrite && !writeDone) {
    unmet.push("write/type the requested content");
  }

  const wantsShare = isShareInviteGoal(goal);
  if (wantsShare && !shareInviteSatisfied(goal, text, hist)) {
    unmet.push("share/send the doc to the recipient");
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
    looksLikeOpenMailItem(goal) ||
    /\b(open|read|view)\b.{0,48}\b(email|e-mail|mail|message|thread)\b/.test(g)
  ) {
    const threadOpen =
      /mail\.google\.com/i.test(u) &&
      /(?:#|\/)(?:inbox|all|sent|drafts|label\/[^/]+)\/[A-Za-z0-9]+/i.test(u);
    if (!threadOpen) unmet.push("open the email/message");
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
  { url = "", pageText = "", title = "", history = [] } = {},
) {
  const step = String(stepText || "").trim();
  if (!step) return false;
  const ctx = { url, pageText, title, history };
  const fullGaps = unmetBrowseAskRequirements(fullAsk || step, ctx);
  if (!fullGaps.length) return true;

  const shareOnlyStep =
    isShareInviteGoal(step) &&
    !/\b(write|draft|compose|essay|author|paper|write\s+out)\b/i.test(step);
  if (shareOnlyStep) {
    return !fullGaps.some((g) => /share|send/i.test(g));
  }

  const writeOnlyStep =
    /\b(write|draft|compose|essay|author|paper|write\s+out)\b/i.test(step) &&
    !isShareInviteGoal(step);
  if (writeOnlyStep) {
    return !fullGaps.some((g) => /write|type/i.test(g));
  }

  // Open-only step while we're already on a real page for the ask.
  if (
    /^(?:please\s+|can\s+you\s+)?(?:open|go\s+to|visit|pull\s+up)\b/i.test(step) &&
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

function looksLikeMarketingOrHomeUrl(url, pageText = "") {
  const u = String(url || "");
  const t = String(pageText || "").toLowerCase();
  try {
    const parsed = new URL(u);
    const path = (parsed.pathname || "/").replace(/\/+$/, "") || "/";
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    if (path === "/" || path === "/home" || path === "/en" || path === "/us") {
      if (
        /\b(get started|sign up|create account|learn more|watch demo|for business|pricing)\b/.test(t) ||
        /^(google\.com|microsoft\.com|apple\.com|amazon\.com)$/i.test(host)
      ) {
        return true;
      }
    }
  } catch {
    /* ignore */
  }
  return /google\.com\/search|youtube\.com\/results|bing\.com\/search/i.test(u);
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
      if (writeGoal) {
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
  maxRounds = 14,
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
  const multiStepGoal = looksLikeMultiStepBrowseGoal(goal);
  const effectiveMaxRounds = multiStepGoal
    ? Math.max(maxRounds, 22)
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
    const catalog = await getDOMCatalog(webContents);
    const page = await getPageContext(webContents);
    const pageText = String(page.text || "").slice(0, 6000);
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
          answer:
            answer ||
            "I kept retrying the same click without progress on this editor screen — couldn't finish here.",
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
        answer:
          answer ||
          "The page stopped responding to my actions — I couldn't finish this on the current screen.",
        history,
        url: pageUrl,
      };
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
          answer:
            askGaps.length
              ? `I got partway there, but still need to: ${askGaps.slice(0, 4).join("; ")}.`
              : answer ||
                (shareGoal
                  ? "I opened Share but could not verify the invite was sent to the email — still incomplete."
                  : "I could not verify this was finished on the page — the task is still incomplete."),
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
    answer: answer || "Reached step limit without finishing the task.",
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
 * Per-user starred links (agent browser bookmarks). Longer keys preferred.
 * Populated via setUserSiteAliases() from main process.
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
  if (!t || t.length > 100) return false;
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
  if (
    /^(?:do\s+it|go\s+ahead|continue|keep\s+going|finish\s+(?:it|that|this)|try\s+(?:it|that|this)|use\s+(?:it|that|this)|open\s+(?:it|that|this|one)|click\s+(?:it|that|this)|press\s+(?:it|that|play)|pick\s+(?:it|that|this|one)|choose\s+(?:it|that|this|one)|select\s+(?:it|that|this|one)|start\s+(?:it|that)|submit\s+(?:it|that)|send\s+(?:it|that)|download\s+(?:it|that)|save\s+(?:it|that)|watch\s+(?:it|that)|the\s+first\s+one|that\s+one|this\s+one)$/i.test(
      bare,
    )
  ) {
    return true;
  }
  return (
    /\b(do|open|play|click|press|try|use|pick|choose|select|start|finish|complete|send|submit|download|save|watch|listen|resume)\b/.test(
      bare,
    ) &&
    /\b(it|that|this|them|those|one|the\s+one|the\s+first|the\s+top|the\s+song|the\s+track|the\s+video)\b/.test(
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
 */
function composeAdaptiveBrowseGoal(text, ctx = {}) {
  const t = String(text || "").trim();
  if (!t) return "";
  const expanded = expandDeicticFollowUp(t, ctx);
  if (expanded) return expanded.slice(0, 500);
  const needsCtx =
    t.length < 100 &&
    /\b(it|that|this|them|those|one)\b/i.test(t) &&
    (ctx.priorGoal || ctx.lastBrowseQuery || ctx.currentUrl);
  if (!needsCtx) return t.slice(0, 500);
  const priorGoal = String(ctx.priorGoal || "").trim();
  const lastQ = String(ctx.lastBrowseQuery || "").trim();
  const url = String(ctx.currentUrl || ctx.priorUrl || "").trim();
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    host = "";
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

/** Follow-ups about the already-open tab ("here", inbox, emails…). */
function looksLikeCurrentTabTask(text) {
  const lower = String(text || "").toLowerCase();
  if (/\b(here|this page|this tab|on this (page|tab|screen)|on the (page|tab))\b/.test(lower)) {
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
    )
  ) {
    return true;
  }
  if (/\b(what('s| is) on (this|the) (page|tab|screen))\b/.test(lower)) return true;
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
 * Question / explain / summarize about what's already on screen — scrape + answer,
 * not a multi-step click plan.
 */
function looksLikePageQuestionAsk(text) {
  const t = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return false;
  // Navigate / mutate elsewhere → not a pure page question.
  if (looksLikeBrowseActAsk(t)) return false;
  if (
    /\b(what(?:'s| is| are)|how much|how many|how (?:is|are|does|do)|why|when|where|which|who)\b/.test(
      t,
    ) ||
    /\b(tell me|explain|summarize|summarise|describe|break down|analyse|analyze|walk me through)\b/.test(
      t,
    ) ||
    /\bbased on (this|the page|the data|the screen|my|what(?:'s| is) (?:on|here))\b/.test(t)
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
  if (/\b(what('s| is) on (this|the) (page|tab|screen)|what do you see)\b/.test(t)) {
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
  const hasEmailAddr = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/.test(lower);
  const deictic =
    /\b(this|that|it)\b/.test(lower) ||
    /\bthe\s+(doc|document|page|file|sheet|spreadsheet|slides?|deck|presentation|notes?|report|essay|paper|draft)\b/.test(
      lower,
    );
  if (
    /\b(share|send|email|forward)\b/.test(lower) &&
    deictic &&
    (hasEmailAddr || /\b(?:with|to)\s+\S+/.test(lower))
  ) {
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

/** True for Docs/Sheets share OR "send/share it to email@…". */
function isShareInviteGoal(text) {
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
  const isGoogleDoc = looksLikeGoogleDocsUrl(pageUrl);
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
  if (!looksLikeGoogleDocsUrl(webContents.getURL?.() || "")) return false;
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
  const isGoogleDoc = looksLikeGoogleDocsUrl(pageUrl);
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

  if (
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

async function waitForDomSettle(webContents, ms = 1200) {
  if (!webContents || webContents.isDestroyed()) return;
  const budget = Math.max(0, Number(ms) || 0);
  const start = Date.now();
  // If the document already finished loading, don't burn the full settle budget.
  try {
    if (!webContents.isLoading()) {
      await new Promise((r) => setTimeout(r, Math.min(budget, 180)));
      try {
        await webContents.executeJavaScript(
          "new Promise((resolve)=>{requestAnimationFrame(()=>requestAnimationFrame(resolve));})",
          true,
        );
      } catch {
        /* ignore */
      }
      return;
    }
  } catch {
    /* ignore */
  }
  const remaining = Math.max(0, budget - (Date.now() - start));
  if (remaining > 0) await waitForLoad(webContents, remaining);
  try {
    await webContents.executeJavaScript(
      "new Promise((resolve)=>{requestAnimationFrame(()=>requestAnimationFrame(resolve));})",
      true,
    );
  } catch {
    /* ignore */
  }
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
        var d=JSON.parse(atob('${payload}'));
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
        try{ pick.scrollIntoView({block:'center',inline:'nearest'}); }catch(e){}
        r=pick.getBoundingClientRect();
        return {ok:true,label:label,clientX:Math.round(r.left+r.width/2),clientY:Math.round(r.top+Math.min(r.height/2,22)),count:nodes.length};
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
    return {
      ok: !!hit.ok,
      label: pick.label || "",
      count: pick.count,
      via: hit.via || "dom",
      error: hit.ok ? undefined : hit.error,
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
        var d=JSON.parse(atob('${payload}'));
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
      entered = pageShowsShareEmailEntered(text, primary);
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
  let emailEntered = pageShowsShareEmailEntered(await pageText(), primary);
  for (let attempt = 0; attempt < 3 && !emailEntered; attempt += 1) {
    const typed = await typeEmailIntoShareDialog(webContents, primary);
    text = await pageText();
    emailEntered = pageShowsShareEmailEntered(text, primary) || !!typed?.verified;
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

  // 3) Click ONLY the dialog's Send / Send invite — never toolbar Share, Done,
  // Cancel, or Close (those dismiss the dialog and discard the pending invite).
  const sendClick = await clickSendInShareDialog(webContents);
  const clickedSend = !!sendClick?.ok;
  if (clickedSend) {
    await waitForDomSettle(webContents, 1200).catch(() => {});
  }
  text = await pageText();
  const verified = looksLikeShareDone(text);
  const emailStillThere = pageShowsShareEmailEntered(text, primary);
  const dialogStillOpen = looksLikeShareDialog(text);
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
  // Typed + clicked Send but toast/copy wasn't scrapeable — still incomplete.
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
        ? `I entered **${primary}** in Share but couldn't find the Send button in the dialog (won't click Done/Cancel — that discards the invite). Tell me to continue.`
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
          if(/^share$/i.test(s)) return 80; // dialog primary sometimes says Share
          if(/^share\\s+anyway$/i.test(s)) return 75;
          if(/\\bnotify\\b/i.test(s) && /\\bsend\\b/i.test(s)) return 60;
          if(/\\bsend\\b/i.test(s) && !/\\b(cancel|don't|dont)\\b/i.test(s)) return 50;
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
  { re: /\bgoogle\s+(?:ads?|adwords|advertising|ads?\s*manager)\b|\badwords\b/i, url: "https://ads.google.com" },
  { re: /\bgoogle\s+analytics\b|\bga4\b/i, url: "https://analytics.google.com" },
  { re: /\bsearch\s+console\b/i, url: "https://search.google.com/search-console" },
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

function resolveBrowseTargetUrl(text, ctx = {}) {
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
  navigate,
  getDOMCatalog,
  getPageContext,
  getPageContextRich,
  waitForDomSettle,
  waitForMailReady,
  waitForSearchResultsReady,
  urlMaybeNeedsAuthCheck,
  looksLikeBareOpenBrowseGoal,
  askStillNeedsAdaptiveWork,
  looksLikeInspectOrReviewAsk,
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
  resolveAccountDashboardUrl,
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
  looksLikePaywall,
  waitForSignInClear,
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
