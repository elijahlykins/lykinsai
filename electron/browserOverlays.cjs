/**
 * Getting past the things a page puts in front of its own content.
 *
 * Cookie walls, consent managers, newsletter modals, "open in app"
 * interstitials and notification nags belong to no task, and they are one of
 * the most common ways an otherwise correct plan stalls: the control the agent
 * wants is right there in the element list, the click lands on a backdrop
 * instead, and the round is spent proving the page is unresponsive.
 *
 * The scan runs in the page and only REPORTS — which overlays are up, what is
 * inside them, and where each control sits. Every judgement about what may be
 * clicked is made here in Node, where it can be read and tested, and the click
 * itself goes out through the actuator's real input events like any other.
 *
 * Two rules keep this from doing damage:
 *
 *   - It only ever clicks a control that dismisses. Anything that signs in,
 *     spends, subscribes, deletes, sends, or opens a preferences panel is
 *     refused outright, as is any link that would navigate away.
 *   - On a consent wall it takes the exit that agrees to nothing — "Reject
 *     all", "Only essential" — and falls back to accepting only when refusing
 *     would cost more than one click. Being stuck is worse than a cookie, but
 *     consenting on someone's behalf is not ours to do by default.
 *
 * Deciding WHEN to sweep belongs to the controller (browser/controller.cjs): a
 * dialog that opened because the agent just clicked something is one it asked
 * for, and closing that would be the agent undoing its own work.
 */

/** Overlays reported per frame. Past this a page is not showing a banner. */
const MAX_CANDIDATES = 10;

/** Controls reported per overlay. Consent walls ship a dozen at most. */
const MAX_CONTROLS = 24;

/** Dismissals attempted in one sweep, each followed by a fresh scan. */
const MAX_DISMISSALS_PER_SWEEP = 3;

/**
 * Containers belonging to a consent-management platform. Matching one of these
 * is on its own enough to classify: these products exist for nothing else, and
 * several of them render a wall with no cookie vocabulary in it at all.
 */
const CMP_SELECTORS = [
  "#onetrust-banner-sdk",
  "#onetrust-consent-sdk",
  "#onetrust-pc-sdk",
  "#CybotCookiebotDialog",
  "#truste-consent-track",
  "#consent_blackbar",
  ".qc-cmp2-container",
  "#qc-cmp2-ui",
  "#didomi-notice",
  ".didomi-popup-container",
  ".osano-cm-window",
  ".osano-cm-dialog",
  "#usercentrics-root",
  "#uc-center-container",
  "#cookiescript_injected",
  "#cookie-law-info-bar",
  "#cmpbox",
  "#cmpwrapper",
  ".sp_message_container",
  "#sp-cc",
  ".cc-window",
  "#cookie-notice",
  ".cookie-notice-container",
  ".cmplz-cookiebanner",
  "#hs-eu-cookie-confirmation",
  "#ketch-consent-banner",
  "#termly-code-snippet-support",
  "#gdpr-cookie-message",
  "#iubenda-cs-banner",
  ".iubenda-cs-container",
  "#tarteaucitronRoot",
  "#axeptio_overlay",
  ".klaro",
  '[class*="cookie-consent"]',
  '[class*="cookie-banner"]',
  '[class*="CookieConsent"]',
  '[id*="cookie-banner"]',
  '[id*="cookieConsent"]',
  '[aria-label*="cookie" i]',
  '[aria-label*="consent" i]',
];

/**
 * A coarse page-side filter: an overlay is only worth reporting if something
 * inside it might close it. Without this every sticky navigation bar on every
 * site arrives here as a candidate and crowds the real banner out of the
 * report.
 */
const DISMISS_HINT_SOURCE =
  "accept|agree|allow|reject|decline|deny|disagree|consent|essential|necessary|" +
  "got it|understood|ok|okay|close|dismiss|no thanks|no, thanks|not now|maybe later|" +
  "later|skip|continue|hide|got_it|×|✕|✖|✗";

// --- what the overlay is ----------------------------------------------------

const CONSENT_RE =
  /\b(cookies?|consent|gdpr|ccpa|tracking technolog|your privacy|privacy (?:choices|preferences|settings)|legitimate interest|store (?:and\/or )?access information on a device|we (?:and our partners|use) )/i;

const NOTIFY_RE =
  /\b(allow notifications|enable notifications|turn on notifications|get notified|push notifications|browser notifications|show notifications)\b/i;

const APP_RE =
  /\b(open in (?:the )?app|continue in (?:the )?app|get the app|use the app|download (?:the|our) app|switch to the app|view in app)\b/i;

const SURVEY_RE =
  /\b(take (?:a|our|this) (?:quick |short |brief )?survey|(?:share|give) (?:your |us )?feedback|rate your (?:experience|visit)|how (?:was|is) your (?:experience|visit)|help us improve)\b/i;

const PROMO_RE =
  /\b(newsletter|mailing list|email list|subscribe (?:to|for)|sign up (?:for|to) (?:our|the)|join (?:our|the) (?:list|club|community)|\d+% off|percent off|discount code|promo code|coupon|free shipping|exclusive (?:offer|deal|access)|don'?t miss|first order|be the first|spin to win)\b/i;

/**
 * Classification order matters where an overlay speaks two languages at once.
 * A cookie wall that also plugs the newsletter is still a cookie wall, and
 * only the consent branch knows to prefer the exit that agrees to nothing.
 */
function classifyOverlay(overlay) {
  if (!overlay) return "";
  if (overlay.cmp === true) return "consent";
  const text = String(overlay.text || "");
  const idClass = String(overlay.idClass || "");
  if (CONSENT_RE.test(text) || CONSENT_RE.test(idClass)) return "consent";
  if (NOTIFY_RE.test(text)) return "notify";
  if (APP_RE.test(text)) return "app";
  if (SURVEY_RE.test(text)) return "survey";
  if (PROMO_RE.test(text)) return "promo";
  return "";
}

/**
 * The long tail: an overlay that says nothing recognisable but sits over the
 * whole page with an X in the corner.
 *
 * The conditions are what keep the agent's own work safe. A compose window, a
 * share sheet, a sign-in modal and a checkout step all carry fields to fill;
 * a confirmation dialog ("Discard changes?", "Are you sure?") offers Discard /
 * Cancel / Save and nothing this module will click. What is left is a page
 * covering itself with something the user never asked for.
 */
function isBlockingOverlay(overlay) {
  if (!overlay) return false;
  if (overlay.coversViewport !== true) return false;
  if (overlay.fields === true) return false;
  return String(overlay.text || "").length <= 1200;
}

// --- what may be clicked ----------------------------------------------------

/**
 * Never clicked, in any overlay, whatever tier it would otherwise match.
 *
 * Two kinds of label are in here. The first commits something — signing in,
 * spending, subscribing, sending, deleting — and no dismissal is worth any of
 * those. The second only looks like an exit: "Manage preferences", "Show
 * purposes", "More options" and "Learn more" all replace one wall with a
 * deeper one, which leaves the page just as blocked and the agent one screen
 * further from where it was.
 */
const NEVER_CLICK_RE = new RegExp(
  [
    "\\bsign ?in\\b",
    "\\blog ?in\\b",
    "\\bsign ?up\\b",
    "\\bregister\\b",
    "\\bcreate (?:an )?account\\b",
    "\\bsubscribe\\b",
    "\\bcheck ?out\\b",
    "\\bbuy\\b",
    "\\bpurchase\\b",
    "\\bpay\\b",
    "\\border\\b",
    "\\bdonate\\b",
    "\\bupgrade\\b",
    "\\bstart (?:free )?trial\\b",
    "\\bdelete\\b",
    "\\bremove\\b",
    "\\berase\\b",
    "\\bsend\\b",
    "\\bshare\\b",
    "\\bpublish\\b",
    "\\bpost\\b",
    "\\breply\\b",
    "\\binvite\\b",
    "\\bsubmit\\b",
    "\\bsave\\b",
    "\\bapply\\b",
    "\\bcontinue with\\b",
    "\\bmanage\\b",
    "\\bcustomi[sz]e\\b",
    "\\bpreferences\\b",
    "\\bsettings\\b",
    "\\bmore (?:options|info|information|choices)\\b",
    "\\blearn more\\b",
    "\\bread more\\b",
    "\\bshow purposes\\b",
    "\\b(?:view|our) (?:vendors|partners)\\b",
    "\\bprivacy policy\\b",
    "\\bcookie policy\\b",
    "\\bterms\\b",
  ].join("|"),
  "i",
);

/**
 * A consent exit that agrees to nothing, best first. Every one of these is a
 * single click in the products that ship them — the multi-screen route out
 * ("Manage preferences" then "Save") is refused above, so nothing here can
 * strand the agent inside a preferences panel.
 */
const CONSENT_REFUSE = [
  /^reject all\b/,
  /^decline all\b/,
  /^deny all\b/,
  /^refuse all\b/,
  /^(?:use |allow |accept |keep )?(?:only )?(?:strictly )?(?:necessary|essential|required)(?: cookies)?(?: only)?$/,
  /^(?:necessary|essential|required) (?:cookies )?only$/,
  /^continue without (?:accepting|agreeing|cookies)/,
  /^reject(?: cookies)?$/,
  /^decline(?: cookies)?$/,
  /^disagree$/,
  /^do not (?:accept|consent|agree|sell)/,
  /^no,? thanks?$/,
];

/** Agreeing dismisses too, and a blocked page helps nobody. */
const CONSENT_ACCEPT = [
  /^accept all\b/,
  /^allow all\b/,
  /^agree(?: to)? all\b/,
  /^(?:i )?accept(?: all)?(?: cookies)?$/,
  /^(?:i )?agree$/,
  /^(?:i )?understand$/,
  /^yes,? i agree$/,
  /^got it$/,
  /^okay?$/,
  /^ok,? got it$/,
  /^allow(?: cookies)?$/,
  /^acknowledge$/,
  /^understood$/,
  /^continue$/,
  /^close$/,
  /^dismiss$/,
];

/** Everything that is not a consent wall closes the same handful of ways. */
const CLOSE_CONTROL = [
  /^(?:close|dismiss|hide|close dialog|close modal|close popup|close banner)$/,
  /^no,? thanks?(?: you)?$/,
  /^not (?:now|today|right now|interested)$/,
  /^(?:maybe )?later$/,
  /^skip(?: for now| this| ad)?$/,
  /^don'?t allow$/,
  /^(?:continue|stay) (?:to|on) (?:the )?(?:site|web|website|mobile (?:web|site))$/,
  /^(?:×|✕|✖|✗|╳|✖️|x)$/,
  /^(?:no|nope)$/,
];

function normLabel(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "");
}

/** A link with a real destination is a route out of the page, not a dismissal. */
function navigatesAway(control) {
  const href = String(control?.href || "").trim();
  if (!href) return false;
  return !/^(?:#|javascript:)/i.test(href);
}

/**
 * Pick the control that closes this overlay, or nothing.
 *
 * Hit-testable controls come first: the click goes out as a real mouse event
 * at a point, so a control something else is covering would land on the
 * coverer. A control that fails the hit test is still worth returning — the
 * caller can reach it through the element instead — but only once nothing
 * better exists.
 */
function pickDismissControl(overlay, kind) {
  const controls = Array.isArray(overlay?.controls) ? overlay.controls : [];
  const allowed = controls.filter((c) => {
    if (!c) return false;
    if (navigatesAway(c)) return false;
    const label = normLabel(c.label);
    const aria = normLabel(c.aria);
    if (!label && !aria) return false;
    return !NEVER_CLICK_RE.test(label) && !NEVER_CLICK_RE.test(aria);
  });
  if (!allowed.length) return null;
  const tiers = kind === "consent" ? [CONSENT_REFUSE, CONSENT_ACCEPT, CLOSE_CONTROL] : [CLOSE_CONTROL];
  for (const pool of [allowed.filter((c) => c.hit !== false), allowed]) {
    for (const tier of tiers) {
      for (const re of tier) {
        const hit = pool.find((c) => re.test(normLabel(c.label)) || re.test(normLabel(c.aria)));
        if (hit) return hit;
      }
    }
  }
  return null;
}

/**
 * A name for "this overlay, dismissed this way", stable across re-scans.
 *
 * The caller remembers these so a wall that survives being clicked is handed
 * to the model rather than clicked again every round for the rest of the run.
 */
function dismissalSignature(kind, overlay, control) {
  const where = String(overlay?.idClass || overlay?.selector || overlay?.tag || "?")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return `${kind}|${where}|${normLabel(control?.label) || normLabel(control?.aria)}`;
}

/**
 * What to do about one reported overlay, if anything.
 * @returns {{kind: string, control: object, signature: string}|null}
 */
function chooseDismissal(overlay, { allowGeneric = true } = {}) {
  let kind = classifyOverlay(overlay);
  if (!kind && allowGeneric && isBlockingOverlay(overlay)) kind = "blocking";
  if (!kind) return null;
  const control = pickDismissControl(overlay, kind);
  if (!control) return null;
  return { kind, control, signature: dismissalSignature(kind, overlay, control) };
}

/** How a dismissal reads in the agent's history. */
function describeDismissal({ kind, control }) {
  const what =
    kind === "consent"
      ? "cookie/consent wall"
      : kind === "promo"
        ? "promotional popup"
        : kind === "notify"
          ? "notification prompt"
          : kind === "app"
            ? "\u201copen in app\u201d interstitial"
            : kind === "survey"
              ? "survey invitation"
              : "overlay covering the page";
  const label = String(control?.label || control?.aria || "").replace(/\s+/g, " ").trim();
  return label ? `${what} (clicked \u201c${label.slice(0, 40)}\u201d)` : what;
}

// --- the page-side scan -----------------------------------------------------

/**
 * Script that reports the overlays currently up, and nothing else. Runs in the
 * main frame and in every sub-frame — Sourcepoint and Quantcast render their
 * wall inside an iframe, where a main-frame-only scan sees a blank rectangle.
 */
function buildScanJs({
  maxCandidates = MAX_CANDIDATES,
  maxControls = MAX_CONTROLS,
  cmpSelectors = CMP_SELECTORS,
  dismissHint = DISMISS_HINT_SOURCE,
} = {}) {
  const b64 = Buffer.from(
    JSON.stringify({ maxCandidates, maxControls, cmpSelectors, dismissHint }),
    "utf8",
  ).toString("base64");
  return (
    "/*lykn-overlay-scan*/(function(){try{" +
    `var CFG=JSON.parse(decodeURIComponent(escape(atob('${b64}'))));` +
    "var HINT=new RegExp(CFG.dismissHint,'i');" +
    "var vw=window.innerWidth||1200,vh=window.innerHeight||800,VIEW=Math.max(1,vw*vh);" +
    "function st(el){try{return getComputedStyle(el);}catch(e){return null;}}" +
    "function txt(el){try{return ((el.innerText||el.textContent||'')+'').replace(/\\s+/g,' ').trim();}catch(e){return '';}}" +
    "function shown(el,s,r){if(!s||s.visibility==='hidden'||s.display==='none')return false;" +
    "if(parseFloat(s.opacity||'1')<0.05)return false;" +
    "if(r.width<8||r.height<8)return false;" +
    "if(r.bottom<=0||r.top>=vh||r.right<=0||r.left>=vw)return false;return true;}" +
    // Same selector shape the element catalog builds, so a fallback click on a
    // reported control resolves the way every other action does.
    "function sel(el){if(!el||el.nodeType!==1)return '';if(el.id)return '#'+CSS.escape(el.id);" +
    "var a=[],n=el;while(n&&n.nodeType===1&&a.length<6){var t=n.nodeName.toLowerCase();" +
    "if(n.id){a.unshift('#'+CSS.escape(n.id));break;}var p=n,x=1;" +
    "while(p=p.previousElementSibling){if(p.nodeName===n.nodeName)x++;}" +
    "a.unshift(t+(x>1?':nth-of-type('+x+')':''));n=n.parentElement;}return a.join(' > ');}" +
    "var roots=[],claimedEls=[];" +
    "function claimed(el){for(var i=0;i<claimedEls.length;i++){var c=claimedEls[i];" +
    "if(c===el||c.contains(el)||el.contains(c))return true;}return false;}" +
    "function consider(el,cmp){if(!el||el.nodeType!==1)return;" +
    "if(el===document.body||el===document.documentElement)return;" +
    "if(roots.length>=CFG.maxCandidates||claimed(el))return;" +
    "var r=el.getBoundingClientRect(),s=st(el);if(!shown(el,s,r))return;" +
    "claimedEls.push(el);roots.push({el:el,cmp:!!cmp,rect:r,style:s});}" +
    // 1. Known consent managers. Specific enough to trust on sight.
    "for(var i=0;i<CFG.cmpSelectors.length;i++){var list=[];" +
    "try{list=document.querySelectorAll(CFG.cmpSelectors[i]);}catch(e){}" +
    "for(var j=0;j<list.length&&j<4;j++)consider(list[j],true);}" +
    // 2. Anything declaring itself a dialog.
    "var dlgs=[];try{dlgs=document.querySelectorAll('dialog[open],[role=dialog],[role=alertdialog],[aria-modal=\"true\"]');}catch(e){}" +
    "for(var d=0;d<dlgs.length&&d<8;d++)consider(dlgs[d],false);" +
    // 3. Anything the page pinned over itself. offsetParent is null for
    //    position:fixed, which cheaply finds the OUTERMOST fixed container
    //    without measuring every node on the page.
    "var nodes=[];try{nodes=document.body.querySelectorAll('div,section,aside,header,footer,form,dialog,ins,nav');}catch(e){}" +
    "for(var k=0;k<nodes.length&&k<3500&&roots.length<CFG.maxCandidates;k++){var el=nodes[k];" +
    "if(el.offsetParent!==null)continue;if(!el.getClientRects().length)continue;" +
    "var s3=st(el);if(!s3||s3.position!=='fixed')continue;consider(el,false);}" +
    // 4. Sticky bars, which keep an offsetParent. Only near the body root,
    //    which is where a page that pins a bar puts it.
    "var shallow=[];try{shallow=document.body.querySelectorAll(':scope > *, :scope > * > *, :scope > * > * > *');}catch(e){}" +
    "for(var m=0;m<shallow.length&&m<600&&roots.length<CFG.maxCandidates;m++){var el2=shallow[m];" +
    "var s4=st(el2);if(!s4||s4.position!=='sticky')continue;consider(el2,false);}" +
    "function controlsOf(root){var out=[],list=[];" +
    "try{list=root.querySelectorAll('button,a,input[type=button],input[type=submit],input[type=reset],[role=button],[role=link],[onclick],[tabindex]');}catch(e){}" +
    "for(var i=0;i<list.length&&i<300&&out.length<CFG.maxControls;i++){var el=list[i],s=st(el);" +
    "if(!s||s.pointerEvents==='none')continue;var r=el.getBoundingClientRect();if(!shown(el,s,r))continue;" +
    "if(el.disabled===true||el.getAttribute('aria-disabled')==='true')continue;" +
    "var aria=((el.getAttribute('aria-label')||el.getAttribute('title')||'')+'').replace(/\\s+/g,' ').trim();" +
    "var label=(txt(el)||aria||((el.value||'')+'')).replace(/\\s+/g,' ').trim();" +
    // A control whose text runs to a paragraph is prose wrapping a link, not a
    // button, and its label would match anything.
    "if(!label||label.length>90)continue;" +
    "var x=Math.max(1,Math.min(Math.round(r.left+r.width/2),vw-1));" +
    "var y=Math.max(1,Math.min(Math.round(r.top+r.height/2),vh-1));" +
    "var hit=false;try{var h=document.elementFromPoint(x,y);hit=!!(h&&(h===el||el.contains(h)||h.contains(el)));}catch(e){}" +
    "out.push({label:label,aria:aria.slice(0,90),tag:el.tagName.toLowerCase()," +
    "href:((el.getAttribute('href')||'')+'').slice(0,200),selector:sel(el),x:x,y:y,hit:hit});}" +
    "return out;}" +
    // Fields are how an overlay says it is part of the work: composers, share
    // sheets, sign-in forms and checkout steps all have them.
    "function hasFields(root){try{return !!root.querySelector('input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=checkbox]):not([type=radio]),textarea,select,[contenteditable=\"true\"]');}catch(e){return false;}}" +
    "var docKey=window.__lyknOverlayDoc||(window.__lyknOverlayDoc=String(Date.now())+'-'+Math.random().toString(36).slice(2));" +
    "var out=[];" +
    "for(var q=0;q<roots.length;q++){var root=roots[q],el=root.el,r=root.rect,s=root.style;" +
    "var controls=controlsOf(el);if(!controls.length)continue;" +
    "var any=false;for(var c=0;c<controls.length;c++){if(HINT.test(controls[c].label)||HINT.test(controls[c].aria)){any=true;break;}}" +
    "if(!any&&!root.cmp)continue;" +
    "var area=(r.width*r.height)/VIEW;" +
    "out.push({cmp:root.cmp,tag:el.tagName.toLowerCase()," +
    "idClass:((el.id?'#'+el.id+' ':'')+(typeof el.className==='string'?el.className:'')).slice(0,120)," +
    "selector:sel(el),position:s.position,zIndex:s.zIndex," +
    "area:Math.round(area*1000)/1000," +
    "coversViewport:(r.width>=vw*0.85&&r.height>=vh*0.85)||(s.position==='fixed'&&area>=0.45)," +
    "fields:hasFields(el),text:txt(el).slice(0,700),controls:controls});}" +
    "return {ok:true,url:location.href,docKey:docKey,overlays:out};" +
    "}catch(e){return {ok:false,error:String(e&&e.message||e),overlays:[]};}})()"
  );
}

// --- the sweep ---------------------------------------------------------------

/**
 * Clear what can be cleared, one overlay at a time.
 *
 * Every click is followed by a fresh scan, because dismissing one wall
 * routinely reveals the next (consent, then the newsletter, then the app nag)
 * and because the coordinates of everything still up have just moved.
 *
 * @param {object} deps
 * @param {() => Promise<Array>} deps.scanFrames resolves to one entry per
 *   frame: { frameId, offsetX, offsetY, offsetKnown, docKey, overlays }
 * @param {(req: object) => Promise<{ok: boolean}>} deps.click performs one click
 * @param {(ms: number) => Promise<void>} [deps.settle] wait for the page to catch up
 * @param {boolean} [deps.allowGeneric] may dismiss unclassifiable full-page overlays
 * @param {string[]} [deps.skipSignatures] dismissals already tried on this page
 * @returns {Promise<{ok: boolean, dismissed: Array, remaining: Array, tried: string[], docKey: string}>}
 */
async function sweepOverlays({
  scanFrames,
  click,
  settle = async () => {},
  allowGeneric = true,
  skipSignatures = [],
  maxDismissals = MAX_DISMISSALS_PER_SWEEP,
}) {
  const dismissed = [];
  const tried = new Set(skipSignatures);
  const attemptedHere = [];
  let remaining = [];
  let docKey = "";
  const budget = Math.max(0, Math.min(Number(maxDismissals) || 0, MAX_DISMISSALS_PER_SWEEP));

  for (let pass = 0; pass < budget; pass += 1) {
    let frames = [];
    try {
      frames = (await scanFrames()) || [];
    } catch {
      break;
    }
    if (!docKey) docKey = String(frames.find((f) => f?.docKey)?.docKey || "");
    const skipped = [];
    let choice = null;
    let frame = null;
    for (const f of frames) {
      for (const overlay of Array.isArray(f?.overlays) ? f.overlays : []) {
        const candidate = chooseDismissal(overlay, { allowGeneric });
        if (!candidate) continue;
        if (tried.has(candidate.signature)) {
          skipped.push({ kind: candidate.kind, what: describeDismissal(candidate) });
          continue;
        }
        choice = candidate;
        frame = f;
        break;
      }
      if (choice) break;
    }
    // Nothing left that we have not already tried. Whatever is still up is the
    // model's problem now, and it is told so rather than left to wonder why the
    // page ignores it.
    if (!choice) {
      remaining = skipped;
      break;
    }
    tried.add(choice.signature);
    attemptedHere.push(choice.signature);
    const point =
      frame?.offsetKnown === false
        ? null
        : {
            x: Number(choice.control.x) + (Number(frame?.offsetX) || 0),
            y: Number(choice.control.y) + (Number(frame?.offsetY) || 0),
          };
    let result = null;
    try {
      result = await click({
        point: choice.control.hit === false ? null : point,
        control: choice.control,
        frameId: frame?.frameId ?? null,
        kind: choice.kind,
      });
    } catch (e) {
      result = { ok: false, error: e?.message || String(e) };
    }
    if (result?.ok === false) {
      remaining = [{ kind: choice.kind, what: describeDismissal(choice) }];
      break;
    }
    dismissed.push({
      kind: choice.kind,
      label: String(choice.control.label || choice.control.aria || "").slice(0, 60),
      what: describeDismissal(choice),
      signature: choice.signature,
    });
    await settle(450).catch(() => {});
  }

  return { ok: true, dismissed, remaining, tried: attemptedHere, docKey };
}

module.exports = {
  buildScanJs,
  sweepOverlays,
  classifyOverlay,
  isBlockingOverlay,
  pickDismissControl,
  chooseDismissal,
  describeDismissal,
  dismissalSignature,
  navigatesAway,
  CMP_SELECTORS,
  MAX_DISMISSALS_PER_SWEEP,
  NEVER_CLICK_RE,
};
