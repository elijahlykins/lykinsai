import '@/lib/installAuthFetch';
import React, { Suspense, useEffect } from "react";
import { Toaster } from "@/components/ui/toaster";
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { queryClientInstance } from '@/lib/query-client';
import { API_BASE_URL } from '@/lib/api-config';
import { hasAppAccess, isSubscriptionGateExempt } from '@/lib/billingAccess';
import { canUseWebApp } from '@/lib/webAppAccess';
import { BrowserRouter as Router, Route, Routes, useLocation, Navigate } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { SupabaseAuthProvider, useAuth } from '@/lib/SupabaseAuth';
import { supabase } from '@/lib/supabase';
import { IntakeProvider } from '@/context/IntakeContext';
import LoadingScreen from "@/components/LoadingScreen";
import RouteErrorBoundary from '@/lib/RouteErrorBoundary';
import CookieConsentBanner from '@/components/CookieConsentBanner';
import { initAnalyticsConsent, trackPageview } from '@/lib/analytics';

import Login from "./pages/Login";
import DesktopAuth from "./pages/DesktopAuth";
import ResetPassword from "./pages/ResetPassword";
import StartTrial from "./pages/StartTrial";
import GlassLanding from "./pages/GlassLanding";
import LyknChat from "./pages/LyknChat";
import Settings from "./pages/Settings";
// SynthesisLayer pulls in three.js + react-three-fiber + drei + the
// Bloom postprocessing pipeline (via its own internal lazy import of
// the 3D scene). Lazy-loading the route module itself shaves the
// remaining ~4.7k-line page component (DetailPanel, NeuronCreationModal,
// belief / fact / concept sections, the layout-engine wrapper) out of
// the initial bundle too, so first-paint on every other route gets
// faster — not just first-paint on /synthesis-layer.
const SynthesisLayer = React.lazy(() => import("./pages/SynthesisLayer"));
import AppSidebar from "./components/AppSidebar";
import MobileTabBar from "./components/MobileTabBar";
import MobileExperienceNotice from "./components/MobileExperienceNotice";
import VaultConnectionsShell from "./pages/VaultConnectionsShell";
import TagManagement from "./pages/TagManagement";
import Billing from "./pages/Billing";
import SignInPill from "./components/SignInPill";
import {
  isEmbeddedSurfacePath,
  readEmbeddedPreviewParams,
} from "@/lib/embeddedPreview";
import {
  SYNTHESIS_LAYER_UI_ENABLED,
  SYNTHESIS_LAYER_FALLBACK_PATH,
} from "@/lib/synthesisLayerUi";
import ShareReceiver from "./pages/ShareReceiver";
import Onboarding from "./pages/Onboarding";
import Pricing from "./pages/Pricing";
import DownloadLykn from "./pages/DownloadLykn";
import CapabilityPage from "./pages/CapabilityPage";
import News, { NewsArticle } from "./pages/News";
import AdminUsage from "./pages/AdminUsage";
import AdminBilling from "./pages/AdminBilling";
import OAuthConsent from "./pages/OAuthConsent";
import AppsChatGPT from "./pages/AppsChatGPT";
import AppsClaude from "./pages/AppsClaude";
import Privacy from "./pages/Privacy";
import Terms from "./pages/Terms";
import CookiePolicy from "./pages/CookiePolicy";
import DPA from "./pages/DPA";
import Support from "./pages/Support";
import { useIsMobile } from "@/hooks/useViewportTier";
import ProjectsPage from "./pages/ProjectsPage";
import ProjectDetailPage from "./pages/ProjectDetailPage";


const loadingFallback = <LoadingScreen isLoading={true} />;

/** Browser users hit /download; Electron (`window.lykn.desktop`) passes through. */
function DesktopProductOnly({ children }) {
  if (!canUseWebApp()) {
    return <Navigate to="/download" replace />;
  }
  return children;
}

function ProtectedRoute({ children }) {
  const { user, loading, signingOut } = useAuth();
  const location = useLocation();
  // Product UI is desktop-only while the web app is unplugged.
  if (!canUseWebApp()) {
    return <Navigate to="/download" replace />;
  }
  if (loading) return null;
  // During an explicit logout the user clears before the hard reload to `/`
  // (the walkthrough) completes. Render blank instead of bouncing to /login,
  // otherwise the legacy login page flashes for a frame mid-logout.
  if (signingOut) return null;
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return children;
}

// Admin-only wrapper: silently 404s for everyone whose email is not on the
// allowlist. The server enforces the same rule on /api/admin/* — this is just
// UX so non-admins don't even see the dashboard exists.
function AdminOnly({ children }) {
  const { user, loading } = useAuth();
  if (!canUseWebApp()) return <Navigate to="/download" replace />;
  if (loading) return null;
  const allowed = (import.meta.env.VITE_ADMIN_EMAILS || "admin@lykn.io")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const email = String(user?.email || "").toLowerCase();
  if (!email || !allowed.includes(email)) return <PageNotFound />;
  return children;
}

// Guest-only route wrapper. Used to gate the wake landing so signed-in
// users never see it — they always bounce into the app (or whatever path is
// passed in). Returns null while auth is still resolving so we don't flash the
// landing UI to a user who's about to be redirected.
function GuestOnly({ children, to = "/app" }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return null;
  if (user) {
    // Legacy: returning from a canceled Stripe checkout could land on
    // `/?resume=account`. Keep honoring it so those links don't loop.
    if (new URLSearchParams(location.search).get("resume") === "account") {
      return children;
    }
    // Web app unplugged: keep marketing pages (/ , /pricing, …) visible for
    // signed-in browsers. Sending them to /download trapped people who
    // abandoned Stripe checkout (still authed) and couldn't get back home.
    // Product routes still use ProtectedRoute → /download.
    if (!canUseWebApp()) {
      return children;
    }
    return <Navigate to={to} replace />;
  }
  // Inside the desktop shell the marketing landing makes no sense — the user
  // already downloaded the app. Signed-out desktop users go straight to login.
  if (typeof window !== "undefined" && window.lykn?.desktop) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

async function fetchBillingMeForGate() {
  // Wait for a real JWT before hitting the gate. After a local server /
  // Electron restart, useAuth can report `user` a tick before the fetch
  // interceptor has a cached token — bare /api/billing/me then 401s and the
  // fail-closed screen locks the whole app.
  let token = (await supabase.auth.getSession())?.data?.session?.access_token;
  if (!token) {
    token = (await supabase.auth.refreshSession())?.data?.session?.access_token;
  }
  if (!token) throw new Error("billing/me: no session token");

  const res = await fetch(`${API_BASE_URL}/api/billing/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`billing/me ${res.status}`);
  return res.json();
}

// Every signed-in user must have passed trial checkout (card on file) before
// using the app. Marketing/legal/auth routes are exempt; everyone else gets
// bounced to the /start-trial plan picker until the server says they have
// access. The server enforces the same rule on metered endpoints
// (requireAppAccess), so this is UX, not the security boundary.
function useSubscriptionGate() {
  const { user, loading: authLoading } = useAuth();
  const location = useLocation();
  const exempt = isSubscriptionGateExempt(location.pathname);

  const { data, isLoading, isError, refetch, isFetching, error } = useQuery({
    queryKey: ["billing-me", user?.id || "guest"],
    queryFn: fetchBillingMeForGate,
    enabled: Boolean(user?.id) && !exempt,
    staleTime: 5_000,
    retry: 2,
    retryDelay: (n) => Math.min(1000 * 2 ** n, 4000),
  });

  if (authLoading || !user || exempt) {
    return { redirect: null, loading: false, error: false, retry: null };
  }
  if (isLoading) {
    return { redirect: null, loading: true, error: false, retry: null };
  }
  // Fail closed on billing errors in production — never admit unpaid users
  // when we can't verify access. In local DEV, a server restart / JWT race
  // should not hard-lock the overlay; allow through and let metered routes
  // enforce access on the server.
  if (isError) {
    if (import.meta.env.DEV) {
      console.warn("[subscription-gate] billing/me failed in DEV — allowing through", error);
      return { redirect: null, loading: false, error: false, retry: null };
    }
    return {
      redirect: null,
      loading: false,
      error: true,
      retry: () => {
        void refetch();
      },
      retrying: isFetching,
    };
  }
  if (data && !hasAppAccess(data)) {
    if (location.pathname === "/start-trial") {
      return { redirect: null, loading: false, error: false, retry: null };
    }
    return { redirect: "/start-trial", loading: false, error: false, retry: null };
  }
  return { redirect: null, loading: false, error: false, retry: null };
}

function AppShell() {
  const location = useLocation();
  const subscriptionGate = useSubscriptionGate();
  const isMobile = useIsMobile();
  const { isEmbedded: isEmbeddedSurface } = readEmbeddedPreviewParams(
    location.search,
  );
  const isEmbeddedRoute =
    isEmbeddedSurface && isEmbeddedSurfacePath(location.pathname);
  const isLoginPage =
    location.pathname === "/login" ||
    location.pathname === "/reset-password" ||
    location.pathname === "/desktop-auth";
  const isStartTrialPage = location.pathname === "/start-trial";
  const isLandingPage =
    location.pathname === "/" ||
    location.pathname === "/landing" ||
    location.pathname === "/glass" ||
    location.pathname === "/pricing" ||
    location.pathname === "/download" ||
    location.pathname === "/privacy" ||
    location.pathname === "/terms" ||
    location.pathname === "/cookies" ||
    location.pathname === "/dpa" ||
    location.pathname === "/news" ||
    location.pathname.startsWith("/news/") ||
    location.pathname.startsWith("/product/") ||
    location.pathname === "/support" ||
    location.pathname.startsWith("/apps/");
  const isSharePage = location.pathname === "/share";

  useEffect(() => {
    initAnalyticsConsent();
  }, []);

  useEffect(() => {
    if (isEmbeddedRoute) return;
    trackPageview(
      `${location.pathname}${location.search}${location.hash}`,
    );
  }, [location.pathname, location.search, location.hash, isEmbeddedRoute]);

  useEffect(() => {
    document.documentElement.classList.toggle("embedded-vault-mode", isEmbeddedRoute);
    document.body.classList.toggle("embedded-vault-mode", isEmbeddedRoute);
    return () => {
      document.documentElement.classList.remove("embedded-vault-mode");
      document.body.classList.remove("embedded-vault-mode");
    };
  }, [isEmbeddedRoute]);

  const isStandalone =
    isLoginPage || isStartTrialPage || isLandingPage || isSharePage;
  const chromeHidden = isEmbeddedRoute || isStandalone;
  // The marketing landing page has its own header with a Sign in button, so
  // the floating top-left pill is redundant there. The legal/docs pages reached
  // from the landing header should stay clean too.
  const isMarketingLanding =
    location.pathname === "/" ||
    location.pathname === "/landing" ||
    location.pathname === "/glass" ||
    location.pathname === "/pricing" ||
    location.pathname === "/download" ||
    location.pathname === "/privacy" ||
    location.pathname === "/terms" ||
    location.pathname === "/cookies" ||
    location.pathname === "/dpa" ||
    location.pathname === "/support" ||
    location.pathname === "/news" ||
    location.pathname.startsWith("/news/") ||
    location.pathname.startsWith("/product/");
  // On mobile the account lives in the More menu (MobileTabBar), so the
  // floating top-left pill is only needed on chrome-less standalone pages.
  const showSignInPillGlobally =
    !isLoginPage &&
    !isStartTrialPage &&
    !isEmbeddedRoute &&
    !isMarketingLanding &&
    chromeHidden;

  if (subscriptionGate.loading) {
    return loadingFallback;
  }

  if (subscriptionGate.error) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--app-background,#ececeb)] px-6">
        <div className="w-full max-w-sm text-center">
          <p className="text-base font-semibold text-black/90 dark:text-white/90">
            Couldn&apos;t verify your subscription
          </p>
          <p className="mt-2 text-sm text-black/50 dark:text-white/50">
            Check your connection and try again. LYKN won&apos;t open until billing status is confirmed.
          </p>
          <button
            type="button"
            onClick={() => subscriptionGate.retry?.()}
            disabled={subscriptionGate.retrying}
            className="mt-5 inline-flex items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {subscriptionGate.retrying ? "Retrying…" : "Retry"}
          </button>
        </div>
      </div>
    );
  }

  if (subscriptionGate.redirect && location.pathname !== subscriptionGate.redirect) {
    return <Navigate to={subscriptionGate.redirect} replace />;
  }

  return (
    <>
      {!chromeHidden && !isMobile && <AppSidebar />}
      {!chromeHidden && isMobile && <MobileTabBar />}
      {!chromeHidden && isMobile && <MobileExperienceNotice />}
      {!isEmbeddedRoute && <CookieConsentBanner />}

      {showSignInPillGlobally && (
        <div className="fixed left-4 top-4 z-[9995] flex items-center gap-3 pointer-events-auto">
          <SignInPill className="lykn-wake-signin-fade" />
        </div>
      )}
      <div className={isStandalone ? "" : "app-content"}>
        <RouteErrorBoundary>
          <Routes>
            {/* Login stays available on the website for share-target / email
                confirm / password flows. Product routes remain desktop-gated;
                Login's post-auth router sends web users to /download (or
                /share when that was the intent). Desktop Google OAuth still
                uses /desktop-auth in the system browser. */}
            <Route path="/login" element={<Login />} />
            {/* Browser-side half of the Mac app's Google sign-in: runs the
                OAuth round-trip in the real browser, then deep-links the
                session back into the app (lykn://auth). Not protected — it
                manages its own auth states. Always reachable on the website. */}
            <Route path="/desktop-auth" element={<DesktopAuth />} />
            {/* Password-recovery landing (email link target). Handles its own
                auth state: a recovery session means "may set a new password". */}
            <Route path="/reset-password" element={<ResetPassword />} />
            {/* Post-signup paywall: every new account picks a plan here and
                starts a card-on-file trial before entering the app. */}
            <Route
              path="/start-trial"
              element={
                <DesktopProductOnly>
                  <StartTrial />
                </DesktopProductOnly>
              }
            />
            {/* OAuth consent screen — reached via 302 from API's /oauth/authorize.
                Intentionally NOT wrapped in ProtectedRoute: the page handles its
                own auth-gate inline so OAuth params survive the sign-in round-trip
                (react-router's `from` doesn't preserve query strings). */}
            <Route path="/oauth/consent" element={<OAuthConsent />} />
            <Route path="/apps/chatgpt" element={<AppsChatGPT />} />
            <Route path="/apps/claude" element={<AppsClaude />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/terms" element={<Terms />} />
            <Route path="/cookies" element={<CookiePolicy />} />
            <Route path="/dpa" element={<DPA />} />
            <Route path="/support" element={<Support />} />
            <Route path="/pricing" element={<Pricing />} />
            <Route path="/download" element={<DownloadLykn />} />
            {/* Capability product pages: Chat / Build / Imagine / Voice. */}
            <Route path="/product/:capId" element={<CapabilityPage />} />
            <Route path="/news" element={<News />} />
            <Route path="/news/:slug" element={<NewsArticle />} />
            {/* LYKN Glass is now the primary landing page. "/glass" stays as an
                alias; "/" and "/landing" serve the same page so every home /
                logo link lands on the Glass hero. */}
            <Route path="/glass" element={<GuestOnly><GlassLanding /></GuestOnly>} />
            <Route path="/" element={<GuestOnly><GlassLanding /></GuestOnly>} />
            <Route path="/landing" element={<GuestOnly><GlassLanding /></GuestOnly>} />
            <Route path="/app" element={<ProtectedRoute><LyknChat /></ProtectedRoute>} />
            <Route path="/dashboard" element={<Navigate to="/app" replace />} />
            <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
            <Route path="/chat/:chatId" element={<ProtectedRoute><LyknChat /></ProtectedRoute>} />
            <Route path="/omnia" element={<Navigate to="/app" replace />} />
            <Route
              element={
                <ProtectedRoute>
                  <VaultConnectionsShell />
                </ProtectedRoute>
              }
            >
              <Route path="/vault" element={null} />
            </Route>
            {/* Connections moved into Settings → Connections. Redirect any
                lingering /connections links (load-in greeting, bookmarks)
                straight to the connect surface. */}
            <Route path="/connections" element={<Navigate to="/settings?section=connections" replace />} />
            <Route path="/connections/*" element={<Navigate to="/settings?section=connections" replace />} />
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
                SYNTHESIS_LAYER_UI_ENABLED ? (
                  <ProtectedRoute>
                    <Suspense fallback={loadingFallback}>
                      <SynthesisLayer />
                    </Suspense>
                  </ProtectedRoute>
                ) : (
                  <Navigate to={SYNTHESIS_LAYER_FALLBACK_PATH} replace />
                )
              }
            />
            <Route
              path="/projects"
              element={
                <ProtectedRoute>
                  <ProjectsPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/projects/:projectId"
              element={
                <ProtectedRoute>
                  <ProjectDetailPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/tag-management"
              element={
                <ProtectedRoute>
                  <TagManagement />
                </ProtectedRoute>
              }
            />
            <Route path="/vaultchat" element={<Navigate to="/vault" replace />} />
            <Route path="/vault-chat" element={<Navigate to="/vault" replace />} />
            <Route
              path="/billing"
              element={
                <ProtectedRoute>
                  <Billing />
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
            <Route
              path="/admin/billing"
              element={
                <AdminOnly>
                  <AdminBilling />
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
