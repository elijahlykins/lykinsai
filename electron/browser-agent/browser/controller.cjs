/**
 * Deterministic browser controller.
 *
 * The LLM decides WHAT should happen; this layer decides HOW the browser
 * operation is executed. It exposes a small, predictable action API on top of
 * the existing Electron actuators in electron/ownedBrowserAct.cjs and rejects
 * stale element references so the agent can never act on an outdated view.
 */

const { buildSnapshot, diffSnapshots } = require("./snapshot.cjs");

/**
 * @param {object} deps
 * @param {Electron.WebContents} deps.webContents active agent tab
 * @param {object} deps.actuator ownedBrowserAct module (injected for testability)
 * @param {object} [deps.tabs] optional multi-tab adapter:
 *   { list(), open(url), close(tabId), activate(tabId) } — when absent the
 *   controller runs in single-tab mode (openTab falls back to navigate).
 */
function createBrowserController({ webContents, actuator, tabs = null }) {
  let currentSnapshot = null;
  let snapshotStale = true;

  function wc() {
    const live = tabs?.getActiveWebContents?.() || webContents;
    if (!live || live.isDestroyed?.()) throw new Error("browser_gone");
    return live;
  }

  function invalidate() {
    snapshotStale = true;
  }

  function resolveRef(ref) {
    const wanted = String(ref || "").trim();
    if (!wanted) return { error: "missing_target" };
    if (!currentSnapshot || snapshotStale) return { error: "stale_reference" };
    const el = currentSnapshot.byRef.get(wanted);
    if (!el) return { error: "unknown_reference" };
    return { el };
  }

  async function listTabs() {
    if (tabs?.list) {
      try {
        const out = await tabs.list();
        if (Array.isArray(out) && out.length) return out;
      } catch {
        /* fall through to single-tab */
      }
    }
    const w = wc();
    return [
      {
        id: "tab-1",
        url: w.getURL?.() || "",
        title: w.getTitle?.() || "",
        active: true,
      },
    ];
  }

  /**
   * Capture a fresh structured snapshot. This is the ONLY way the agent sees
   * the page; element refs are minted here and die on the next navigation.
   */
  async function getPageState() {
    const w = wc();
    const [catalogRes, contextRes, tabList] = await Promise.all([
      actuator.getDOMCatalog(w),
      actuator.getPageContext(w),
      listTabs(),
    ]);
    currentSnapshot = buildSnapshot({
      url: contextRes?.url || catalogRes?.url || w.getURL?.() || "",
      title: contextRes?.title || w.getTitle?.() || "",
      catalog: Array.isArray(catalogRes?.items) ? catalogRes.items : [],
      text: contextRes?.text || "",
      tabs: tabList,
    });
    snapshotStale = false;
    return currentSnapshot;
  }

  function getCurrentSnapshot() {
    return snapshotStale ? null : currentSnapshot;
  }

  async function settle(timeoutMs = 8000) {
    const w = wc();
    try {
      await actuator.waitForLoad(w, timeoutMs);
    } catch {
      /* settle is best-effort */
    }
    if (typeof actuator.waitForDomSettle === "function") {
      try {
        await actuator.waitForDomSettle(w, Math.min(timeoutMs, 3500));
      } catch {
        /* best-effort */
      }
    }
  }

  // --- deterministic actions -------------------------------------------------

  async function navigate(url) {
    const res = await actuator.navigate(wc(), url);
    invalidate();
    return res;
  }

  async function goBack() {
    const res = await actuator.runAction(wc(), { type: "back" }, []);
    invalidate();
    return res;
  }

  async function goForward() {
    const res = await actuator.runAction(wc(), { type: "forward" }, []);
    invalidate();
    return res;
  }

  async function click(ref) {
    const { el, error } = resolveRef(ref);
    if (error) return { ok: false, error };
    const res = await actuator.runAction(
      wc(),
      {
        type: "click",
        id: el.raw.id,
        selector: el.raw.selector,
        label: el.label,
        frameId: el.raw.frameId,
        clientX: el.raw.clientX,
        clientY: el.raw.clientY,
        // Never guess: fail (and re-observe) instead of fuzzy-matching a
        // similar label or clicking through an overlay.
        strictTarget: true,
        minLabelScore: 80,
      },
      catalogItems(),
    );
    // Clicks routinely change the page (navigation, dialogs, menus) — force a
    // re-observe before the next element interaction.
    invalidate();
    return res;
  }

  async function type(ref, text, { pressEnter = false, mode = "append" } = {}) {
    const { el, error } = resolveRef(ref);
    if (error) return { ok: false, error };
    // mode "replace": set the field's whole value deterministically (inputs /
    // textareas). Rich-text bodies should use replaceText for targeted edits
    // instead of wiping and retyping.
    if (mode === "replace") {
      const tag = String(el.raw.tag || "").toLowerCase();
      if (tag === "input" || tag === "textarea") {
        const res = await actuator.runAction(
          wc(),
          {
            type: "fill",
            id: el.raw.id,
            selector: el.raw.selector,
            label: el.label,
            frameId: el.raw.frameId,
            clientX: el.raw.clientX,
            clientY: el.raw.clientY,
            text: String(text ?? ""),
            strictTarget: true,
            minLabelScore: 80,
          },
          catalogItems(),
        );
        invalidate();
        return res;
      }
      // An EMPTY rich-text field has nothing to replace — "replace" and
      // "append" are the same action, so just type instead of burning a round
      // on an error the model has to reinterpret.
      if (!String(el.raw.value || "").trim()) {
        mode = "append";
      } else {
        return {
          ok: false,
          error: "replace_mode_unsupported",
          hint: "This is a rich-text area with content — use replace_text to edit the specific passage instead of replacing everything.",
        };
      }
    }
    const res = await actuator.runAction(
      wc(),
      {
        type: "click_type",
        id: el.raw.id,
        selector: el.raw.selector,
        label: el.label,
        frameId: el.raw.frameId,
        clientX: el.raw.clientX,
        clientY: el.raw.clientY,
        text: String(text ?? ""),
        pressEnter: !!pressEnter,
        strictTarget: true,
        minLabelScore: 80,
      },
      catalogItems(),
    );
    // Typing changes field values that the catalog now displays — decide the
    // next step from a fresh snapshot, or the model sees pre-typing "empty"
    // fields and fills them again (duplicated email bodies).
    invalidate();
    return res;
  }

  /**
   * Targeted in-place edit: find `findText` inside the element and replace
   * only that occurrence, preserving everything else. Works on inputs,
   * textareas and rich-text (contenteditable) fields. This is the right tool
   * for revisions — never retype a whole document to change one passage.
   */
  async function replaceText(ref, findText, replaceWith) {
    const { el, error } = resolveRef(ref);
    if (error) return { ok: false, error };
    const needle = String(findText ?? "");
    if (!needle.trim()) return { ok: false, error: "missing_find_text" };
    const evaluate = evaluatorFor(el);
    if (!evaluate) return { ok: false, error: "frame_gone" };
    try {
      const res = await evaluate(
        buildReplaceTextJs({
          selector: el.raw.selector || "",
          find: needle,
          replace: String(replaceWith ?? ""),
        }),
      );
      if (res?.ok) invalidate();
      return res || { ok: false, error: "replace_failed" };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  async function select(ref, value) {
    const { el, error } = resolveRef(ref);
    if (error) return { ok: false, error };
    const res = await actuator.runAction(
      wc(),
      {
        type: "select",
        id: el.raw.id,
        selector: el.raw.selector,
        label: el.label,
        frameId: el.raw.frameId,
        value: String(value ?? ""),
      },
      catalogItems(),
    );
    invalidate();
    return res;
  }

  /**
   * Run page JS where the element actually lives. Elements cataloged from an
   * embedded editor's iframe are absent from the main document, so reading or
   * editing them from there always misses.
   */
  function evaluatorFor(el) {
    const frameId = el?.raw?.frameId;
    if (frameId == null || typeof actuator.frameByRoutingId !== "function") {
      return (js) => wc().executeJavaScript(js, true);
    }
    const frame = actuator.frameByRoutingId(wc(), frameId);
    if (!frame) return null;
    return (js) => frame.executeJavaScript(js, true);
  }

  async function scroll(direction = "down", amount = 600, ref = "") {
    const dir = direction === "up" ? "up" : "down";
    // A ref means "scroll inside this thing" — editor palettes, block lists and
    // side panels scroll internally and ignore window scrolling entirely.
    if (ref) {
      const { el, error } = resolveRef(ref);
      if (error) return { ok: false, error };
      return actuator.runAction(
        wc(),
        {
          type: "scroll_element",
          selector: el.raw.selector,
          frameId: el.raw.frameId,
          direction: dir,
          amount,
        },
        catalogItems(),
      );
    }
    return actuator.runAction(wc(), { type: "scroll", direction: dir, amount }, []);
  }

  /**
   * Drag one element onto another. Both ends may be element refs or 0–1000
   * screenshot coordinates, so this works on canvas editors where the drop
   * target has no DOM presence at all.
   */
  async function drag(from, to, { mode = "" } = {}) {
    const action = { type: "drag", mode };
    if (from && typeof from === "object" && from.x != null) {
      action.x = Number(from.x);
      action.y = Number(from.y);
    } else {
      const { el, error } = resolveRef(from);
      if (error) return { ok: false, error: `drag source: ${error}` };
      action.selector = el.raw.selector;
      action.label = el.label;
      action.clientX = el.raw.clientX;
      action.clientY = el.raw.clientY;
      action.frameId = el.raw.frameId;
    }
    if (to && typeof to === "object" && to.x != null) {
      action.toX = Number(to.x);
      action.toY = Number(to.y);
    } else {
      const { el, error } = resolveRef(to);
      if (error) return { ok: false, error: `drop target: ${error}` };
      action.toSelector = el.raw.selector;
      action.toLabel = el.label;
      action.toClientX = el.raw.clientX;
      action.toClientY = el.raw.clientY;
      action.toFrameId = el.raw.frameId;
    }
    const res = await actuator.runAction(wc(), action, catalogItems());
    invalidate();
    return res;
  }

  /**
   * Click a point read off the screenshot (0–1000 in each axis). The escape
   * hatch for anything the DOM cannot describe: canvas editors, image maps,
   * custom-drawn controls.
   */
  async function clickCoord(x, y, label = "") {
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
      return { ok: false, error: "bad_coords" };
    }
    const res = await actuator.runAction(
      wc(),
      { type: "click_coord", x: nx, y: ny, label: String(label || "") },
      catalogItems(),
    );
    invalidate();
    return res;
  }

  async function pressKey(key = "Enter", modifiers = null) {
    const mods = Array.isArray(modifiers) ? modifiers.filter(Boolean).map(String) : [];
    const res = await actuator.runAction(
      wc(),
      { type: "press_key", key, modifiers: mods },
      catalogItems(),
    );
    // Shortcuts are how design and editor tools are really driven, and most of
    // them change the page as much as a click does.
    if (/^enter$/i.test(String(key)) || mods.length) invalidate();
    return res;
  }

  /** Read an element's live value/text — the evidence for form verification. */
  async function extract(ref) {
    const { el, error } = resolveRef(ref);
    if (error) return { ok: false, error };
    const evaluate = evaluatorFor(el);
    if (!evaluate) return { ok: false, error: "frame_gone" };
    try {
      const value = await evaluate(
        `(function(){try{var el=document.querySelector(${JSON.stringify(el.raw.selector || "")});` +
          `if(!el)return null;return {value:(el.value!=null?el.value:el.innerText||'').slice(0,2000),` +
          `checked:el.checked===true};}catch(e){return null;}})()`,
      );
      if (!value) return { ok: false, error: "element_not_found" };
      return { ok: true, ref, label: el.label, ...value };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  async function wait(ms = 800) {
    const clamped = Math.min(Math.max(Number(ms) || 800, 100), 10000);
    await new Promise((r) => setTimeout(r, clamped));
    return { ok: true, type: "wait", ms: clamped };
  }

  async function screenshot() {
    try {
      const dataUrl = await actuator.screenshotDataUrl(wc(), {
        maxWidth: 1200,
        jpegQuality: 70,
      });
      return dataUrl ? { ok: true, dataUrl } : { ok: false, error: "screenshot_failed" };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  async function openTab(url) {
    if (tabs?.open) {
      const res = await tabs.open(url);
      invalidate();
      return res?.ok === false ? res : { ok: true, ...res };
    }
    // Single-tab mode: opening a tab degrades to navigation.
    return navigate(url);
  }

  async function closeTab(tabId) {
    if (tabs?.close) {
      const res = await tabs.close(tabId);
      invalidate();
      return res?.ok === false ? res : { ok: true, ...res };
    }
    return { ok: false, error: "single_tab_mode" };
  }

  async function switchTab(tabId) {
    if (tabs?.activate) {
      const res = await tabs.activate(tabId);
      invalidate();
      return res?.ok === false ? res : { ok: true, ...res };
    }
    return { ok: false, error: "single_tab_mode" };
  }

  function catalogItems() {
    if (!currentSnapshot) return [];
    return currentSnapshot.elements.map((e) => e.raw);
  }

  /**
   * In-page find-and-replace. Inputs/textareas: replace inside .value via the
   * prototype setter (frameworks see a real input event). Contenteditable:
   * replace within the text node containing the match. Payload travels as
   * base64 JSON (same pattern as ownedBrowserAct.buildActionJs).
   */
  function buildReplaceTextJs(payload) {
    const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    return (
      "/*lykn-replace-text*/(function(){try{var a=JSON.parse(decodeURIComponent(escape(atob('" +
      b64 +
      "'))));" +
      "var el=null;try{el=document.querySelector(a.selector);}catch(e){}" +
      "if(!el)return {ok:false,error:'element_not_found'};" +
      "var find=a.find,rep=a.replace;" +
      "if(el.tagName==='INPUT'||el.tagName==='TEXTAREA'){" +
      "var v=el.value||'';var i=v.indexOf(find);" +
      "if(i<0)return {ok:false,error:'text_not_found'};" +
      "var nv=v.slice(0,i)+rep+v.slice(i+find.length);" +
      "var p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;" +
      "var d=Object.getOwnPropertyDescriptor(p,'value');if(d&&d.set)d.set.call(el,nv);else el.value=nv;" +
      "el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));" +
      "return {ok:true,replaced:true,valueLen:nv.length,preview:nv.slice(Math.max(0,i-40),i+rep.length+40)};}" +
      "var root=el.isContentEditable?el:(el.querySelector&&el.querySelector('[contenteditable=\"true\"]'))||el;" +
      "if(!root||!(root.isContentEditable||root.getAttribute&&root.getAttribute('contenteditable')==='true')){" +
      "return {ok:false,error:'not_editable'};}" +
      // Fast path: match within a single text node (preserves formatting).
      "var w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),n;" +
      "while((n=w.nextNode())){var idx=n.nodeValue.indexOf(find);" +
      "if(idx>-1){n.nodeValue=n.nodeValue.slice(0,idx)+rep+n.nodeValue.slice(idx+find.length);" +
      "root.dispatchEvent(new Event('input',{bubbles:true}));" +
      "return {ok:true,replaced:true,preview:n.nodeValue.slice(Math.max(0,idx-40),idx+rep.length+40)};}}" +
      // Cross-node path: editors split lines into separate elements (Gmail's
      // body is one <div> per line), so any passage crossing a line break
      // never sits in one text node. Match with whitespace collapsed across
      // ALL text nodes (a virtual break separates adjacent nodes), then
      // delete the exact range and insert the replacement (newlines → <br>).
      "var tnodes=[];var w2=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),t;" +
      "while((t=w2.nextNode())){tnodes.push(t);}" +
      "var chars=[],raw=[];" +
      "for(var k=0;k<tnodes.length;k++){if(k){chars.push('\\n');raw.push(null);}" +
      "var v=tnodes[k].nodeValue;for(var c=0;c<v.length;c++){chars.push(v[c]);raw.push({k:k,off:c});}}" +
      "var ns='',nmap=[];" +
      "for(var i=0;i<chars.length;i++){var ch=chars[i];" +
      "if(/\\s/.test(ch)){if(ns&&ns[ns.length-1]===' ')continue;ns+=' ';nmap.push(i);}" +
      "else{ns+=ch;nmap.push(i);}}" +
      "var needle=String(find).replace(/\\s+/g,' ').trim();" +
      "if(!needle)return {ok:false,error:'text_not_found'};" +
      "var pos=ns.indexOf(needle);" +
      "if(pos<0)return {ok:false,error:'text_not_found',hint:'That exact passage is not in the field — re-read the content and copy the snippet verbatim.'};" +
      "var si=nmap[pos],ei=nmap[pos+needle.length-1];" +
      "while(si<raw.length&&raw[si]==null)si++;" +
      "while(ei>=0&&raw[ei]==null)ei--;" +
      "if(si>=raw.length||ei<0||si>ei)return {ok:false,error:'text_not_found'};" +
      "var st=raw[si],en=raw[ei];" +
      "var range=document.createRange();" +
      "range.setStart(tnodes[st.k],st.off);range.setEnd(tnodes[en.k],en.off+1);" +
      "range.deleteContents();" +
      "if(rep){var frag=document.createDocumentFragment();var parts=String(rep).split('\\n');" +
      "for(var q2=0;q2<parts.length;q2++){if(q2)frag.appendChild(document.createElement('br'));" +
      "if(parts[q2])frag.appendChild(document.createTextNode(parts[q2]));}" +
      "range.insertNode(frag);}" +
      "root.dispatchEvent(new Event('input',{bubbles:true}));" +
      "return {ok:true,replaced:true,crossNode:true,preview:(rep||'').slice(0,80)};" +
      "}catch(e){return {ok:false,error:String(e&&e.message||e)};}})()"
    );
  }

  function currentUrl() {
    try {
      return wc().getURL?.() || "";
    } catch {
      return "";
    }
  }

  return {
    getPageState,
    getCurrentSnapshot,
    settle,
    invalidate,
    navigate,
    goBack,
    goForward,
    click,
    clickCoord,
    drag,
    type,
    replaceText,
    select,
    scroll,
    pressKey,
    extract,
    wait,
    screenshot,
    openTab,
    closeTab,
    switchTab,
    listTabs,
    currentUrl,
    diffSnapshots,
  };
}

module.exports = { createBrowserController };
