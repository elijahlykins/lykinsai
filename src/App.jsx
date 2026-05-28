import '@/lib/installAuthFetch';
import React, { Suspense, useEffect } from "react";
import { Toaster } from "@/components/ui/toaster";
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClientInstance } from '@/lib/query-client';
import { BrowserRouter as Router, Route, Routes, useLocation, Navigate } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { SupabaseAuthProvider, useAuth } from '@/lib/SupabaseAuth';
import { IntakeProvider } from '@/context/IntakeContext';
import LoadingScreen from "@/components/LoadingScreen";
import RouteErrorBoundary from '@/lib/RouteErrorBoundary';
import {
  readPrototypeStep,
  PROTOTYPE_STEP_EVENT,
  isWalkthroughLockActive,
  isConnectOnboardingDone,
} from '@/lib/prototypeHandoff';

import Login from "./pages/Login";
import LandingPrototype from "./pages/LandingPrototype";
import Why from "./pages/Why";
import Synthesis from "./pages/Synthesis";
import OmniaGrid from "./pages/OmniaGrid";
import Settings from "./pages/Settings";
// SynthesisLayer pulls in three.js + react-three-fiber + drei + the
// Bloom postprocessing pipeline (via its own internal lazy import of
// the 3D scene). Lazy-loading the route module itself shaves the
// remaining ~4.7k-line page component (DetailPanel, NeuronCreationModal,
// belief / fact / concept sections, the layout-engine wrapper) out of
// the initial bundle too, so first-paint on every other route gets
// faster — not just first-paint on /synthesis-layer.
const SynthesisLayer = React.lazy(() => import("./pages/SynthesisLayer"));
import SharedGrid from "./pages/SharedGrid";
import AppSidebar from "./components/AppSidebar";
import MobileTabBar from "./components/MobileTabBar";
import MobileExperienceNotice from "./components/MobileExperienceNotice";
import VaultConnectionsShell from "./pages/VaultConnectionsShell";
import TagManagementNew from "./pages/new/TagManagementNew";
import BillingNew from "./pages/new/BillingNew";
import GuestSignInPrompt from "./components/GuestSignInPrompt";
import GuestSignInGate from "./components/GuestSignInGate";
import ShareReceiver from "./pages/ShareReceiver";
import Onboarding from "./pages/Onboarding";
import AdminUsage from "./pages/AdminUsage";
import OAuthConsent from "./pages/OAuthConsent";
import AppsChatGPT from "./pages/AppsChatGPT";
import AppsClaude from "./pages/AppsClaude";
import Privacy from "./pages/Privacy";
import Terms from "./pages/Terms";
import CookiePolicy from "./pages/CookiePolicy";
import DPA from "./pages/DPA";
import { useIsMobile } from "@/hooks/useViewportTier";


const legacyEnabled = String(import.meta.env.VITE_ENABLE_LEGACY_NOTES || "").toLowerCase() === "true";
const LegacyTagManagement = React.lazy(() => import("./pages/TagManagement"));
const loadingFallback = <LoadingScreen isLoading={true} />;

function ProtectedRoute({ children }) {
  const { loading } = useAuth();
  if (loading) return null;
  return children;
}

// Admin-only wrapper: silently 404s for everyone whose email is not on the
// allowlist. The server enforces the same rule on /api/admin/* — this is just
// UX so non-admins don't even see the dashboard exists.
function AdminOnly({ children }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  const allowed = (import.meta.env.VITE_ADMIN_EMAILS || "admin@lykn.io")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const email = String(user?.email || "").toLowerCase();
  if (!email || !allowed.includes(email)) return <PageNotFound />;
  return children;
}

// Guest-only route wrapper. Used to gate the LandingPrototype + the old
// marketing landing so signed-in users never see them — they always
// bounce to `/app` (or whatever path is passed in). Returns null while
// auth is still resolving so we don't flash the landing UI to a user
// who's about to be redirected.
//
// Newly-created users (account age < 10 minutes) get routed to
// `/onboarding/connect` instead of `/app` so they actually see the
// "Connect your AI tools" cards. This handles the email-confirmation
// path specifically: Supabase's confirmation link redirects to
// `window.location.origin` (i.e. `/`), and without this branch those
// users would skip onboarding entirely. Google-OAuth signups also land
// on `/` after the OAuth callback, so they're covered too. After 10
// minutes the heuristic flips off and returning users get the normal
// `/app` destination.
const NEW_USER_WINDOW_MS = 10 * 60 * 1000;
function isFreshlyCreatedUser(user) {
  if (!user?.created_at) return false;
  const createdMs = Date.parse(user.created_at);
  if (!Number.isFinite(createdMs)) return false;
  return Date.now() - createdMs < NEW_USER_WINDOW_MS;
}

// Walkthrough guard. Once a guest has entered the linear synthesis →
// vault → connections → chat tour (i.e. `lykn_prototype_step` is set
// to anything other than null or "done"), we trap them inside the four
// walkthrough surfaces until they either click Finish on the chat
// card (which flips step to "done") or sign in (auth resolves and
// `user` flips truthy, short-circuiting the guard).
//
// Without this trap, testers consistently bailed mid-tour by hitting
// the back button, typing a different URL, or clicking a sidebar
// entry that hadn't been locked yet, and never saw the rest of the
// guided experience. Sidebar locks already silence the in-app clicks
// for synthesis/vault/grid steps, but the URL bar + browser nav + any
// stray `<Link>` in the chrome were still escape hatches. This guard
// is the belt-and-suspenders layer that covers all of them.
//
// `EXEMPT_PREFIXES` covers public surfaces the visitor MUST be able
// to reach mid-tour: the sign-in flow (so they can opt out of the
// trap by creating an account), the legal pages (privacy / terms /
// cookies / DPA — required to be reachable from anywhere by law),
// the OAuth consent screen (for inbound integrations the guest may
// have arrived from), and the public app-store landing pages.
const WALKTHROUGH_ALLOWED_PATHS = new Set([
  "/synthesis-layer",
  "/vault",
  "/connections",
  "/app",
]);
const WALKTHROUGH_EXEMPT_PREFIXES = [
  "/login",
  "/oauth",
  "/privacy",
  "/terms",
  "/cookies",
  "/dpa",
  "/apps/",
  "/s/",
  "/share",
];
// Landing-page paths that should never be redirected away from, even
// while a walkthrough step is set in localStorage. Without this, a
// guest in the middle of the tour who manually navigates back to "/"
// or "/landing-prototype" would silently bounce to whatever step
// they were on — with no way to actually see the wake-screen opening
// again (i.e. they can never restart the tour from the beginning).
// Treating these as exempt means the trap leaves them alone on the
// landing surface; clicking Get Started from there re-stamps fresh
// walkthrough state and re-enters the tour cleanly.
const WALKTHROUGH_RESET_PATHS = new Set(["/", "/landing-prototype"]);
const STEP_TO_DEFAULT_PATH = {
  synthesis: "/synthesis-layer",
  vault: "/vault",
  grid: "/app",
};

function useWalkthroughTrap() {
  const { user, loading } = useAuth();
  const location = useLocation();
  const [step, setStep] = React.useState(() => readPrototypeStep());

  // Listen for same-tab step changes (writePrototypeStep dispatches
  // PROTOTYPE_STEP_EVENT) and cross-tab `storage` changes so the trap
  // releases the visitor the moment they hit Finish — without needing
  // a hard reload.
  useEffect(() => {
    const sync = () => setStep(readPrototypeStep());
    window.addEventListener(PROTOTYPE_STEP_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(PROTOTYPE_STEP_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  // Auth still resolving → don't redirect (would flash the wrong page),
  // and don't claim the visitor is locked yet either.
  if (loading) return { redirect: null, locked: false };
  const stateLocked = isWalkthroughLockActive(user?.id ?? null, step);
  if (!stateLocked) return { redirect: null, locked: false };

  const pathname = location.pathname;

  // Landing-page reset surfaces: if the visitor explicitly navigates
  // back to "/" or "/landing-prototype", treat that as "restart the
  // tour". The lock fully releases (no chrome hiding, no click
  // blocker, no redirect) and the visitor sees the wake screen
  // normally. They can choose to click Get Started again, which re-
  // stamps the step + tour-mode flags and re-enters the walkthrough
  // cleanly. Without this branch the trap silently bounces guests
  // who manually URL-edit back to "/" — they'd never be able to see
  // the opening again without DevTools.
  if (WALKTHROUGH_RESET_PATHS.has(pathname)) {
    return { redirect: null, locked: false };
  }

  let redirect = null;
  if (!WALKTHROUGH_ALLOWED_PATHS.has(pathname)) {
    const isExempt = WALKTHROUGH_EXEMPT_PREFIXES.some((prefix) =>
      pathname.startsWith(prefix),
    );
    if (!isExempt) {
      const dest = STEP_TO_DEFAULT_PATH[step] ?? "/synthesis-layer";
      if (pathname !== dest) redirect = dest;
    } else {
      // Exempt paths (login, legal, OAuth, etc.) let the visitor
      // through and ALSO unlock the chrome — otherwise a guest who
      // navigated to /login mid-tour would still have the click-
      // blocker overlay smothering the sign-in form.
      return { redirect: null, locked: false };
    }
  }
  return { redirect, locked: stateLocked };
}

function shouldRouteFreshUserToConnectOnboarding(user) {
  return isFreshlyCreatedUser(user) && !isConnectOnboardingDone();
}

function GuestOnly({ children, to = "/app" }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (user) {
    const dest = shouldRouteFreshUserToConnectOnboarding(user)
      ? "/onboarding/connect"
      : to;
    return <Navigate to={dest} replace />;
  }
  return children;
}

function AppShell() {
  const { user, loading, signInWithOAuth } = useAuth();
  const location = useLocation();
  const isMobile = useIsMobile();
  const walkthroughRedirect = useWalkthroughTrap();
  const search = new URLSearchParams(location.search);
  const isEmbeddedVault = location.pathname === "/vault" && search.get("embedded") === "1";
  const isLoginPage = location.pathname === "/login";
  const isLandingPage =
    location.pathname === "/" ||
    location.pathname === "/why" ||
    location.pathname === "/synthesis" ||
    location.pathname === "/landing-prototype" ||
    location.pathname === "/privacy" ||
    location.pathname === "/terms" ||
    location.pathname === "/cookies" ||
    location.pathname === "/dpa" ||
    location.pathname.startsWith("/apps/");
  const isSharedGridView = location.pathname.startsWith("/s/");
  const isSharePage = location.pathname === "/share";

  useEffect(() => {
    document.documentElement.classList.toggle("embedded-vault-mode", isEmbeddedVault);
    document.body.classList.toggle("embedded-vault-mode", isEmbeddedVault);
    return () => {
      document.documentElement.classList.remove("embedded-vault-mode");
      document.body.classList.remove("embedded-vault-mode");
    };
  }, [isEmbeddedVault]);

  // Walkthrough lockdown via CSS pointer-events. Toggling a body class
  // is the only reliable way to neutralize the page during the tour:
  // an overlay <div> gets demoted under any position-fixed sibling's
  // stacking context (and the synthesis layer, vault, and OmniaGrid
  // pages all use fixed-position outer containers). pointer-events
  // inherits, so `body.lykn-walkthrough-locked { pointer-events:
  // none }` turns the entire DOM tree inert in one shot — and each
  // walkthrough card + the sign-in prompt re-enables itself with an
  // explicit `pointer-events: auto`, which always wins regardless
  // of stacking. See src/index.css for the matching selectors.
  useEffect(() => {
    document.body.classList.toggle(
      "lykn-walkthrough-locked",
      Boolean(walkthroughRedirect.locked),
    );
    return () => {
      document.body.classList.remove("lykn-walkthrough-locked");
    };
  }, [walkthroughRedirect.locked]);

  const isGuest = !loading && !user;
  const isStandalone = isLoginPage || isLandingPage || isSharedGridView || isSharePage;
  const isWalkthroughLocked = walkthroughRedirect.locked;

  // Mid-walkthrough trap: when the guard hook says "redirect to X",
  // unmount whatever chrome was about to render and bounce the visitor
  // back to their current walkthrough step. We do this above the
  // Routes tree (rather than wrapping each route) so it can't be
  // bypassed by typing a URL that doesn't have a guard wrapper.
  if (walkthroughRedirect.redirect && location.pathname !== walkthroughRedirect.redirect) {
    return <Navigate to={walkthroughRedirect.redirect} replace />;
  }

  // Walkthrough lockdown: while the visitor is inside the guided tour
  // (guest + step in {synthesis, vault, grid}), strip every piece of
  // app chrome that could let them escape. The sidebar, mobile tab
  // bar, mobile-only experience notice, and (further down) the
  // VaultConnectionsToggle + VaultAppDock all become invisible. The
  // only paths forward are the typewriter cards' forward arrows or
  // signing in via the GuestSignInPrompt (which we deliberately keep
  // mounted — the prompt is the explicit escape valve the user
  // promised in copy: "unless they sign in").
  const chromeHidden = isEmbeddedVault || isStandalone || isWalkthroughLocked;

  return (
    <>
      {/* Walkthrough lockdown is CSS-driven (see the body class
          toggle effect above and `body.lykn-walkthrough-locked` in
          src/index.css). No overlay <div> is rendered here. */}
      {!chromeHidden && !isMobile && <AppSidebar />}
      {!chromeHidden && isMobile && <MobileTabBar />}
      {!chromeHidden && isMobile && <MobileExperienceNotice />}

      {/* Walkthrough sign-in pill: while the visitor is locked into the
          guided tour the rest of the app chrome (sidebar, mobile tab
          bar) is unmounted, which strips out the usual "Sign in" entry
          point. Returning users shouldn't have to crank through the
          whole tour just to get to a login screen — so we mount a
          standalone pill in the top-left for the duration of the
          lockdown. Same visual treatment as the AppSidebar /
          LandingPrototype pill (avatar circle + label), so it reads
          as the canonical sign-in affordance rather than a stray
          new control. Click → Google OAuth via SupabaseAuth; on
          success the auth listener flips `user` to truthy, which
          unwinds the walkthrough lock (`isWalkthroughLockActive`
          short-circuits on userId) and drops them straight onto the
          chat surface they were headed for. `pointer-events-auto`
          is the explicit re-enable that escapes the body-level
          `pointer-events: none` we apply during the lock. */}
      {isWalkthroughLocked && (
        <div className="fixed left-4 top-4 z-[9995] flex items-center gap-3 pointer-events-auto">
          <button
            type="button"
            onClick={() =>
              signInWithOAuth("google", { redirectTo: window.location.href })
            }
            className="flex items-center gap-1.5 rounded-full bg-white/45 dark:bg-[rgba(60,60,60,0.14)] backdrop-blur-sm border border-black/6 dark:border-white/10 pl-1 pr-3 py-1 text-[0.6875rem] text-black/70 dark:text-white/70 hover:bg-white/60 dark:hover:bg-white/15 shadow-sm transition-colors"
            title="Sign in"
            aria-label="Sign in"
          >
            <div className="h-6 w-6 rounded-full bg-blue-500/15 dark:bg-blue-400/20 text-[0.6875rem] font-semibold text-blue-600 dark:text-blue-400 flex items-center justify-center flex-shrink-0">
              ?
            </div>
            <span>Sign in</span>
          </button>
        </div>
      )}
      {/* The upload-progress toast was intentionally removed in favor of
          the silent ghost-card pipeline — dropped/uploaded files appear
          immediately in the vault grid via optimistic ghost cards
          (`ghostCards` in `VaultNew.jsx`), and any failures are surfaced
          via the global `toast()` notification raised from
          `uploadPipeline.ts`. So there's no longer a persistent
          upload-progress UI to render. */}
      {!isEmbeddedVault && !isStandalone && !user && !isWalkthroughLocked && (
        <GuestSignInPrompt />
      )}
      {!isEmbeddedVault && !isStandalone && !user && <GuestSignInGate />}
      <div className={isStandalone ? "" : (isGuest ? "app-content guest-mode" : "app-content")}>
        <RouteErrorBoundary>
          <Routes>
            <Route path="/login" element={<Login />} />
            {/* OAuth consent screen — reached via 302 from API's /oauth/authorize.
                Intentionally NOT wrapped in ProtectedRoute: the page handles its
                own auth-gate inline so OAuth params survive the sign-in round-trip
                (react-router's `from` doesn't preserve query strings). */}
            <Route path="/oauth/consent" element={<OAuthConsent />} />
            {/* Public app-store landing page for the LYKN ChatGPT App.
                Linked from the OpenAI Apps catalog listing once approved;
                serves double duty as the marketing page for the connector
                today. Intentionally not gated — OpenAI's reviewers visit
                this URL during app submission. */}
            <Route path="/apps/chatgpt" element={<AppsChatGPT />} />
            {/* Sister page for the Anthropic Connectors Directory listing.
                Same dual purpose: directory submission gate + marketing
                page that the existing Connect button already deep-links
                to via /connections#claude. Anthropic's reviewers
                visit this URL during directory review. */}
            <Route path="/apps/claude" element={<AppsClaude />} />
            {/* Public legal surface — required by ChatGPT Apps catalog,
                Anthropic Connectors Directory, Stripe, and consumer-
                protection law (GDPR/CCPA/ePrivacy). The DPA is the
                Article 28 controller↔processor agreement self-serve
                customers accept by reference via the Terms click-through. */}
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/terms" element={<Terms />} />
            <Route path="/cookies" element={<CookiePolicy />} />
            <Route path="/dpa" element={<DPA />} />
            <Route path="/s/:token" element={<SharedGrid />} />
            {/* The prototype landing experience IS the canonical home page —
                visitors landing on `/` get the synthetic-intelligence
                onboarding chat. `/landing-prototype` is kept as an alias for
                any inbound links to the prototype-only URL. */}
            <Route path="/" element={<GuestOnly><LandingPrototype /></GuestOnly>} />
            <Route path="/landing-prototype" element={<GuestOnly><LandingPrototype /></GuestOnly>} />
            <Route path="/why" element={<Why />} />
            <Route path="/synthesis" element={<Synthesis />} />
            <Route path="/app" element={<OmniaGrid />} />
            <Route path="/dashboard" element={<Navigate to="/app" replace />} />
            <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
            {/* `__prototype_first_chat__` is treated as a demo-grid id by
                `demoGrids.js`, so it flows through OmniaGrid + the
                useBoardPersistence demo path (no auth, no Supabase, chat
                hydrated from localStorage). The dynamic route below picks
                it up just like a real grid. */}
            <Route path="/grid/:boardId" element={<ProtectedRoute><OmniaGrid /></ProtectedRoute>} />
            <Route path="/omnia" element={<ProtectedRoute><OmniaGrid /></ProtectedRoute>} />
            {/* Vault + Connections share a single layout route so the
                shell (which keeps both surfaces mounted side-by-side)
                survives navigation between `/vault` ↔ `/connections`,
                making the in-page toggle feel instant. */}
            <Route element={<VaultConnectionsShell />}>
              <Route path="/vault" element={null} />
              <Route path="/connections" element={null} />
            </Route>
            <Route path="/share" element={<ShareReceiver />} />
            <Route
              path="/onboarding/connect"
              element={
                <ProtectedRoute>
                  <Onboarding />
                </ProtectedRoute>
              }
            />
            <Route
              path="/synthesis-layer"
              element={
                <Suspense fallback={loadingFallback}>
                  <SynthesisLayer />
                </Suspense>
              }
            />
            <Route
              path="/tag-management"
              element={
                <ProtectedRoute>
                  {legacyEnabled ? (
                    <Suspense fallback={loadingFallback}>
                      <LegacyTagManagement />
                    </Suspense>
                  ) : (
                    <TagManagementNew />
                  )}
                </ProtectedRoute>
              }
            />
            {/* Legacy `/vaultchat` + `/vault-chat` paths now redirect to the
                unified `/vault` surface so old bookmarks, sidebar links, and
                onboarding deep-links don't dead-end. The standalone vault-chat
                surface is gone. */}
            <Route path="/vaultchat" element={<Navigate to="/vault" replace />} />
            <Route path="/vault-chat" element={<Navigate to="/vault" replace />} />
            <Route
              path="/billing"
              element={
                <ProtectedRoute>
                  <BillingNew />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/usage"
              element={
                <AdminOnly>
                  <AdminUsage />
                </AdminOnly>
              }
            />
            <Route
              path="/admin/usage/:userId"
              element={
                <AdminOnly>
                  <AdminUsage />
                </AdminOnly>
              }
            />
            <Route path="*" element={<PageNotFound />} />
          </Routes>
        </RouteErrorBoundary>
      </div>
    </>
  );
}

function AppRoutes() {
  const { loading } = useAuth();

  return (
    <LoadingScreen isLoading={loading}>
      <Router>
        <AppShell />
      </Router>
    </LoadingScreen>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClientInstance}>
      <SupabaseAuthProvider>
        <IntakeProvider>
          <AppRoutes />
          <Toaster />
        </IntakeProvider>
      </SupabaseAuthProvider>
    </QueryClientProvider>
  );
}

export default App;
