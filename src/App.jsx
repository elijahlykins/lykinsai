import '@/lib/installAuthFetch';
import React, { Suspense, useEffect } from "react";
import { Toaster } from "@/components/ui/toaster";
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClientInstance } from '@/lib/query-client';
import { BrowserRouter as Router, Route, Routes, useLocation, Navigate } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { SupabaseAuthProvider, useAuth } from '@/lib/SupabaseAuth';
import { IntakeProvider } from '@/context/IntakeContext';
import IntakeModal from '@/components/intake/IntakeModal';
import LoadingScreen from "@/components/LoadingScreen";
import RouteErrorBoundary from '@/lib/RouteErrorBoundary';

import Login from "./pages/Login";
import LandingPrototype from "./pages/LandingPrototype";
import Why from "./pages/Why";
import Synthesis from "./pages/Synthesis";
import OmniaGrid from "./pages/OmniaGrid";
import ProjectPlaceholder from "./pages/ProjectPlaceholder";
import Settings from "./pages/Settings";
import SynthesisLayer from "./pages/SynthesisLayer";
import Discover from "./pages/Discover";
import SharedGrid from "./pages/SharedGrid";
import AppSidebar from "./components/AppSidebar";
import MobileTabBar from "./components/MobileTabBar";
import MobileExperienceNotice from "./components/MobileExperienceNotice";
import VaultNew from "./pages/new/VaultNew";
import VaultChatNew from "./pages/new/VaultChatNew";
import TagManagementNew from "./pages/new/TagManagementNew";
import BillingNew from "./pages/new/BillingNew";
import VaultUploadToast from "./components/files/VaultUploadToast";
import GuestSignInPrompt from "./components/GuestSignInPrompt";
import ShareReceiver from "./pages/ShareReceiver";
import Connections from "./pages/Connections";
import AdminUsage from "./pages/AdminUsage";
import OAuthConsent from "./pages/OAuthConsent";
import AppsChatGPT from "./pages/AppsChatGPT";
import AppsClaude from "./pages/AppsClaude";
import Privacy from "./pages/Privacy";
import Terms from "./pages/Terms";
import { useIsMobile } from "@/hooks/useViewportTier";


const legacyEnabled = String(import.meta.env.VITE_ENABLE_LEGACY_NOTES || "").toLowerCase() === "true";
const LegacyVaultChat = React.lazy(() => import("./pages/VaultChat"));
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

function MobileRedirect({ children, to = "/app" }) {
  const isMobile = useIsMobile();
  if (isMobile) return <Navigate to={to} replace />;
  return children;
}

// Guest-only route wrapper. Used to gate the LandingPrototype + the old
// marketing landing so signed-in users never see them — they always
// bounce to `/app` (or whatever path is passed in). Returns null while
// auth is still resolving so we don't flash the landing UI to a user
// who's about to be redirected.
function GuestOnly({ children, to = "/app" }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (user) return <Navigate to={to} replace />;
  return children;
}

function AppShell() {
  const { user, loading } = useAuth();
  const location = useLocation();
  const isMobile = useIsMobile();
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

  const isGuest = !loading && !user;
  const isStandalone = isLoginPage || isLandingPage || isSharedGridView || isSharePage;

  return (
    <>
      {!isEmbeddedVault && !isStandalone && !isMobile && <AppSidebar />}
      {!isEmbeddedVault && !isStandalone && isMobile && <MobileTabBar />}
      {!isEmbeddedVault && !isStandalone && isMobile && <MobileExperienceNotice />}
      {!isEmbeddedVault && !isStandalone && user && <IntakeModal />}
      {!isEmbeddedVault && !isSharedGridView && user && <VaultUploadToast />}
      {!isEmbeddedVault && !isStandalone && !user && <GuestSignInPrompt />}
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
                to via /connections#claude-web. Anthropic's reviewers
                visit this URL during directory review. */}
            <Route path="/apps/claude" element={<AppsClaude />} />
            {/* Public privacy + terms — required by ChatGPT Apps catalog,
                Anthropic Connectors Directory, Stripe, and consumer-
                protection law (GDPR/CCPA). */}
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/terms" element={<Terms />} />
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
            <Route
              path="/project/:projectId"
              element={
                <MobileRedirect to="/app">
                  <ProjectPlaceholder />
                </MobileRedirect>
              }
            />
            <Route path="/omnia" element={<ProtectedRoute><OmniaGrid /></ProtectedRoute>} />
            <Route path="/vault" element={<VaultNew />} />
            <Route path="/discover" element={<ProtectedRoute><Discover /></ProtectedRoute>} />
            <Route path="/share" element={<ShareReceiver />} />
            <Route
              path="/connections"
              element={
                <ProtectedRoute>
                  <Connections />
                </ProtectedRoute>
              }
            />
            <Route
              path="/synthesis-layer"
              element={<SynthesisLayer />}
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
            <Route
              path="/vaultchat"
              element={
                <ProtectedRoute>
                  {legacyEnabled ? (
                    <Suspense fallback={loadingFallback}>
                      <LegacyVaultChat />
                    </Suspense>
                  ) : (
                    <VaultChatNew />
                  )}
                </ProtectedRoute>
              }
            />
            <Route
              path="/vault-chat"
              element={
                <ProtectedRoute>
                  {legacyEnabled ? (
                    <Suspense fallback={loadingFallback}>
                      <LegacyVaultChat />
                    </Suspense>
                  ) : (
                    <VaultChatNew />
                  )}
                </ProtectedRoute>
              }
            />
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
