/**
 * Smoke test for the overlay sweeper against a real DOM.
 *
 * The policy in browserOverlays.cjs is unit-tested against reported overlays;
 * what no unit test can cover is the half that runs in the page — whether the
 * scan actually finds a fixed banner, measures a control, hit-tests it, and
 * whether a real mouse event at that point dismisses it. This boots a hidden
 * Electron window over a handful of pages shaped like the ones that block the
 * agent in the wild and reports what the sweeper did to each.
 *
 * Run: npx electron electron/eval/overlay-smoke.cjs
 */

const { app, BrowserWindow } = require("electron");
const ownedBrowserAct = require("../ownedBrowserAct.cjs");

const page = (title, body, style = "") => `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html><html><head><title>${title}</title><style>
  body{font:16px system-ui;margin:0;padding:24px}
  .bar{position:fixed;left:0;right:0;bottom:0;background:#222;color:#fff;padding:16px;z-index:9999}
  .modal{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999}
  .card{background:#fff;padding:24px;border-radius:8px}
  button{font:inherit;padding:8px 14px;margin:4px}
  ${style}
</style></head><body>
<h1>${title}</h1>
<p id="content">The article the agent came here to read.</p>
<button id="goal">Add to cart</button>
${body}
<script>
  function kill(id){var el=document.getElementById(id);if(el)el.remove();}
</script>
</body></html>`)}`;

const CASES = [
  {
    name: "OneTrust-shaped bar, reject available",
    expect: { kind: "consent", label: /reject all/i },
    url: page(
      "News",
      `<div id="onetrust-banner-sdk" class="bar">
         We use cookies and similar technologies to personalise content.
         <a href="/privacy">Privacy Policy</a>
         <button onclick="kill('onetrust-banner-sdk')">Accept All Cookies</button>
         <button onclick="kill('onetrust-banner-sdk')">Reject All</button>
         <button>Manage Preferences</button>
       </div>`,
    ),
  },
  {
    name: "consent bar with accept only",
    expect: { kind: "consent", label: /accept all/i },
    url: page(
      "Shop",
      `<div id="cookiebar" class="bar">
         This site uses cookies to improve your experience.
         <button onclick="kill('cookiebar')">Accept all</button>
         <button>Cookie settings</button>
       </div>`,
    ),
  },
  {
    name: "consent wall whose only exit is a deeper wall",
    expect: null,
    url: page(
      "Paper",
      `<div id="cmp" class="bar">
         We and our partners store and/or access information on a device.
         <button>Manage preferences</button>
         <button>Show purposes</button>
       </div>`,
    ),
  },
  {
    name: "newsletter modal with an X",
    expect: { kind: "promo", label: /^\u00d7$/ },
    url: page(
      "Store",
      `<div id="promo" class="modal"><div class="card">
         Join our mailing list for 15% off your first order
         <input type="email" placeholder="you@example.com">
         <button>Subscribe</button>
         <button aria-label="Close dialog" onclick="kill('promo')">\u00d7</button>
       </div></div>`,
    ),
  },
  {
    name: "notification prompt",
    expect: { kind: "notify", label: /don.?t allow|not now/i },
    url: page(
      "Feed",
      `<div id="notif" class="modal"><div class="card">
         Allow notifications from this site?
         <button>Allow</button>
         <button onclick="kill('notif')">Don't allow</button>
       </div></div>`,
    ),
  },
  {
    name: "open-in-app interstitial",
    expect: { kind: "app", label: /continue to (the )?(site|web)/i },
    url: page(
      "Social",
      `<div id="appnag" class="modal"><div class="card">
         Open in the app for a better experience
         <button>Open in app</button>
         <button onclick="kill('appnag')">Continue to site</button>
       </div></div>`,
    ),
  },
  {
    name: "a share dialog is the agent's own work, not a popup",
    expect: null,
    url: page(
      "Design",
      `<div role="dialog" aria-modal="true" class="modal"><div class="card">
         Share this design
         <input type="email" placeholder="Add people">
         <button>Send</button>
         <button>Cancel</button>
       </div></div>`,
    ),
  },
  {
    name: "a discard-changes confirmation is left alone",
    expect: null,
    url: page(
      "Editor",
      `<div role="dialog" aria-modal="true" class="modal"><div class="card">
         Discard changes? Your draft will not be saved.
         <button>Discard</button>
         <button>Cancel</button>
         <button>Save draft</button>
       </div></div>`,
    ),
  },
  {
    // Sourcepoint and Quantcast both work like this: the wall is a same-size
    // iframe, and the button inside it messages the host page to tear the frame
    // down. A main-frame-only scan sees an empty rectangle.
    name: "a consent wall inside an iframe",
    expect: { kind: "consent", label: /reject all/i },
    url: page(
      "Broadsheet",
      `<iframe id="cmpframe" class="sp_message_container" style="position:fixed;inset:0;width:100%;height:100%;border:0;z-index:9999" src="${page(
        "Consent",
        `<div id="cmpbox" class="modal"><div class="card">
           We value your privacy. We and our partners use cookies.
           <button onclick="parent.postMessage('consent-done','*')">Accept all</button>
           <button onclick="parent.postMessage('consent-done','*')">Reject all</button>
         </div></div>`,
      )}"></iframe>
       <script>addEventListener('message',function(e){if(e.data==='consent-done')kill('cmpframe');});</script>`,
    ),
  },
  {
    name: "an ordinary page with nothing in the way",
    expect: null,
    url: page("Docs", ""),
  },
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 800, show: false });
  let failures = 0;
  for (const testCase of CASES) {
    await win.loadURL(testCase.url).catch(() => {});
    await new Promise((r) => setTimeout(r, 350));
    const res = await ownedBrowserAct.dismissOverlays(win.webContents, {});
    const got = res.dismissed[0] || null;
    const want = testCase.expect;
    let ok;
    if (!want) ok = !got;
    else ok = !!got && got.kind === want.kind && want.label.test(got.label || "");
    // Where a dismissal was expected, the page itself has the last word: the
    // control the agent came for has to be clickable afterwards. A refusal is
    // supposed to leave the overlay standing, so it is not held to this.
    const covered = await win.webContents
      .executeJavaScript(
        "(function(){var el=document.getElementById('goal');if(!el)return 'no-target';" +
          "var r=el.getBoundingClientRect();var h=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);" +
          "return h&&(h===el||el.contains(h))?'':'covered';})()",
        true,
      )
      .catch(() => "");
    if (want && covered === "covered") ok = false;
    if (!ok) failures += 1;
    const summary = got ? `${got.kind} via "${got.label}"` : "nothing dismissed";
    console.log(
      `${ok ? "ok  " : "FAIL"}  ${testCase.name}\n      ${summary}` +
        (res.remaining.length ? `; still up: ${res.remaining.map((o) => o.what).join(", ")}` : "") +
        (covered === "covered" ? `; target still covered${want ? "" : " (expected)"}` : ""),
    );
  }
  console.log(failures ? `\n${failures} case(s) failed` : "\nall cases behaved as intended");
  app.exit(failures ? 1 : 0);
});
