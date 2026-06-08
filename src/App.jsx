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
  hasAppAccess,
  isSubscriptionGateExempt,
} from '@/lib/billingAccess';
import { API_BASE_URL } from '@/lib/api-config';
import { useQuery } from '@tanstack/react-query';

import Login from "./pages/Login";
import LandingPrototype from "./pages/LandingPrototype";
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
import SignInPill from "./components/SignInPill";
import {
  isEmbeddedSurfacePath,
  readEmbeddedPreviewParams,
} from "@/lib/embeddedPreview";
import ShareReceiver from "./pages/ShareReceiver";
import Onboarding from "./pages/Onboarding";
import StartTrial from "./pages/StartTrial";
import AdminUsage from "./pages/AdminUsage";
import OAuthConsent from "./pages/OAuthConsent";
import AppsChatGPT from "./pages/AppsChatGPT";
import AppsClaude from "./pages/AppsClaude";
import Privacy from "./pages/Privacy";
import Terms from "./pages/Terms";
import CookiePolicy from "./pages/CookiePolicy";
import DPA from "./pages/DPA";
import { useIsMobile } from "@/hooks/useViewportTier";
import ModelBuilder from "./pages/ModelBuilder";


const legacyEnabled = String(import.meta.env.VITE_ENABLE_LEGACY_NOTES || "").toLowerCase() === "true";
const LegacyTagManagement = React.lazy(() => import("./pages/TagManagement"));
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
// users never see it — they always bounce to `/start-trial` (or whatever
// path is passed in). Returns null while auth is still resolving so we
// don't flash the landing UI to a user who's about to be redirected.
function GuestOnly({ children, to = "/start-trial" }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return null;
  if (user) {
    // Returning from a canceled Stripe checkout: StartTrial signs out
    // locally and sends them to `/?resume=account`. Don't immediately
    // bounce back into /start-trial → Stripe or they get stuck in a loop.
    if (new URLSearchParams(location.search).get("resume") === "account") {
      return children;
    }
    return <Navigate to={to} replace />;
  }
  return children;
}

async function fetchBillingMeForGate() {
  const res = await fetch(`${API_BASE_URL}/api/billing/me`);
  if (!res.ok) throw new Error(`billing/me ${res.status}`);
  return res.json();
}

function useSubscriptionGate() {
  const { user, loading: authLoading } = useAuth();
  const location = useLocation();
  const exempt = isSubscriptionGateExempt(location.pathname);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["billing-me", user?.id || "guest"],
    queryFn: fetchBillingMeForGate,
    enabled: Boolean(user?.id) && !exempt,
    staleTime: 5_000,
    retry: 1,
  });

  if (authLoading || !user || exempt) {
    return { redirect: null, loading: false };
  }
  if (isLoading) {
    return { redirect: null, loading: true };
  }
  if (!isError && data && !hasAppAccess(data)) {
    if (location.pathname === "/start-trial") {
      return { redirect: null, loading: false };
    }
    return { redirect: "/start-trial", loading: false };
  }
  return { redirect: null, loading: false };
}

function AppShell() {
  const { user, loading } = useAuth();
  const location = useLocation();
  const isMobile = useIsMobile();
  const subscriptionGate = useSubscriptionGate();
  const { isEmbedded: isEmbeddedSurface } = readEmbeddedPreviewParams(
    location.search,
  );
  const isEmbeddedRoute =
    isEmbeddedSurface && isEmbeddedSurfacePath(location.pathname);
  const isLoginPage = location.pathname === "/login";
  const isStartTrialPage = location.pathname === "/start-trial";
  const isLandingPage =
    location.pathname === "/" ||
    location.pathname === "/landing-prototype" ||
    location.pathname === "/privacy" ||
    location.pathname === "/terms" ||
    location.pathname === "/cookies" ||
    location.pathname === "/dpa" ||
    location.pathname.startsWith("/apps/");
  const isSharedGridView = location.pathname.startsWith("/s/");
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
    isLoginPage || isStartTrialPage || isLandingPage || isSharedGridView || isSharePage;
  const chromeHidden = isEmbeddedRoute || isStandalone;
  // On mobile the account lives in the More menu (MobileTabBar), so the
  // floating top-left pill is only needed on chrome-less standalone pages.
  const showSignInPillGlobally =
    !isLoginPage && !isEmbeddedRoute && chromeHidden;

  if (subscriptionGate.loading) {
    return null;
  }

  if (subscriptionGate.redirect && location.pathname !== subscriptionGate.redirect) {
    return <Navigate to={subscriptionGate.redirect} replace />;
  }

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
            <Route path="/start-trial" element={<StartTrial />} />
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
            <Route path="/s/:token" element={<SharedGrid />} />
            <Route path="/" element={<GuestOnly><LandingPrototype /></GuestOnly>} />
            <Route path="/landing-prototype" element={<GuestOnly><LandingPrototype /></GuestOnly>} />
            <Route path="/app" element={<ProtectedRoute><OmniaGrid /></ProtectedRoute>} />
            <Route path="/dashboard" element={<Navigate to="/app" replace />} />
            <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
            <Route path="/grid/:boardId" element={<ProtectedRoute><OmniaGrid /></ProtectedRoute>} />
            <Route path="/omnia" element={<ProtectedRoute><OmniaGrid /></ProtectedRoute>} />
            <Route
              element={
                <ProtectedRoute>
                  <VaultConnectionsShell />
                </ProtectedRoute>
              }
            >
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
                <ProtectedRoute>
                  <Suspense fallback={loadingFallback}>
                    <SynthesisLayer />
                  </Suspense>
                </ProtectedRoute>
              }
            />
            <Route
              path="/builder"
              element={
                <ProtectedRoute>
                  <ModelBuilder />
                </ProtectedRoute>
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
