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

import Login from "./pages/Login";
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
import { useIsMobile } from "@/hooks/useViewportTier";
import ProjectsPage from "./pages/ProjectsPage";
import ProjectDetailPage from "./pages/ProjectDetailPage";


const loadingFallback = <LoadingScreen isLoading={true} />;

function ProtectedRoute({ children }) {
  const { user, loading, signingOut } = useAuth();
  const location = useLocation();
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
    return <Navigate to={to} replace />;
  }
  // Inside the desktop shell the marketing landing makes no sense — the user
  // already downloaded the app. Signed-out desktop users go straight to login.
  if (typeof window !== "undefined" && window.lykn?.desktop) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

function AppShell() {
  const location = useLocation();
  const isMobile = useIsMobile();
  const { isEmbedded: isEmbeddedSurface } = readEmbeddedPreviewParams(
    location.search,
  );
  const isEmbeddedRoute =
    isEmbeddedSurface && isEmbeddedSurfacePath(location.pathname);
  const isLoginPage = location.pathname === "/login";
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
    location.pathname.startsWith("/apps/");
  const isSharePage = location.pathname === "/share";

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

  return (
    <>
      {!chromeHidden && !isMobile && <AppSidebar />}
      {!chromeHidden && isMobile && <MobileTabBar />}
      {!chromeHidden && isMobile && <MobileExperienceNotice />}

      {showSignInPillGlobally && (
        <div className="fixed left-4 top-4 z-[9995] flex items-center gap-3 pointer-events-auto">
          <SignInPill className="lykn-wake-signin-fade" />
        </div>
      )}
      <div className={isStandalone ? "" : "app-content"}>
        <RouteErrorBoundary>
          <Routes>
            <Route path="/login" element={<Login />} />
            {/* Trials were retired in favor of a free tier. Any lingering link
                to /start-trial just drops the user into the app. */}
            <Route path="/start-trial" element={<Navigate to="/app" replace />} />
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
                <ProtectedRoute>
                  <Suspense fallback={loadingFallback}>
                    <SynthesisLayer />
                  </Suspense>
                </ProtectedRoute>
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
