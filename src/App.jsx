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
import OmniaGrid from "./pages/OmniaGrid";
import ProjectPlaceholder from "./pages/ProjectPlaceholder";
import Settings from "./pages/Settings";
import SynthesisLayer from "./pages/SynthesisLayer";
import Discover from "./pages/Discover";
import SharedGrid from "./pages/SharedGrid";
import PlanGate from "./components/PlanGate";
import AppSidebar from "./components/AppSidebar";
import VaultNew from "./pages/new/VaultNew";
import VaultChatNew from "./pages/new/VaultChatNew";
import TagManagementNew from "./pages/new/TagManagementNew";
import BillingNew from "./pages/new/BillingNew";
import VaultUploadToast from "./components/files/VaultUploadToast";
import GuestSignInPrompt from "./components/GuestSignInPrompt";
import ShareReceiver from "./pages/ShareReceiver";
import Connections from "./pages/Connections";


const legacyEnabled = String(import.meta.env.VITE_ENABLE_LEGACY_NOTES || "").toLowerCase() === "true";
const LegacyVaultChat = React.lazy(() => import("./pages/VaultChat"));
const LegacyTagManagement = React.lazy(() => import("./pages/TagManagement"));
const loadingFallback = <LoadingScreen isLoading={true} />;

function ProtectedRoute({ children }) {
  const { loading } = useAuth();
  if (loading) return null;
  return children;
}

function AppShell() {
  const { user, loading } = useAuth();
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  const isEmbeddedVault = location.pathname === "/vault" && search.get("embedded") === "1";
  const isLoginPage = location.pathname === "/login";
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
  const isStandalone = isLoginPage || isSharedGridView || isSharePage;

  return (
    <>
      {!isEmbeddedVault && !isStandalone && <AppSidebar />}
      {!isEmbeddedVault && !isStandalone && user && <IntakeModal />}
      {!isEmbeddedVault && !isSharedGridView && user && <VaultUploadToast />}
      {!isEmbeddedVault && !isStandalone && !user && <GuestSignInPrompt />}
      <div className={isStandalone ? "" : (isGuest ? "app-content guest-mode" : "app-content")}>
        <RouteErrorBoundary>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/s/:token" element={<SharedGrid />} />
            <Route path="/" element={<OmniaGrid />} />
            <Route path="/dashboard" element={<Navigate to="/" replace />} />
            <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
            <Route path="/grid/:boardId" element={<ProtectedRoute><OmniaGrid /></ProtectedRoute>} />
            <Route path="/project/:projectId" element={<ProjectPlaceholder />} />
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
              element={
                user ? (
                  <PlanGate
                    minPlan="studio"
                    feature="Mind Map"
                    description="The synthesis layer visualises every grid, project, and vault item as a live mind map. Upgrade to Studio to explore it."
                  >
                    <SynthesisLayer />
                  </PlanGate>
                ) : (
                  <SynthesisLayer />
                )
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
