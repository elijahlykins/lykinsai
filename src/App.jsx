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
import MindMap from "./pages/MindMap";
import AppSidebar from "./components/AppSidebar";
import VaultNew from "./pages/new/VaultNew";
import VaultChatNew from "./pages/new/VaultChatNew";
import TagManagementNew from "./pages/new/TagManagementNew";
import BillingNew from "./pages/new/BillingNew";


const legacyEnabled = String(import.meta.env.VITE_ENABLE_LEGACY_NOTES || "").toLowerCase() === "true";
const LegacyVaultChat = React.lazy(() => import("./pages/VaultChat"));
const LegacyTagManagement = React.lazy(() => import("./pages/TagManagement"));
const LegacyBilling = React.lazy(() => import("./pages/Billing"));
const loadingFallback = <LoadingScreen isLoading={true} />;

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return null;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
}

function AppShell() {
  const { user, loading } = useAuth();
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  const isEmbeddedVault = location.pathname === "/vault" && search.get("embedded") === "1";
  const isLoginPage = location.pathname === "/login";

  useEffect(() => {
    document.documentElement.classList.toggle("embedded-vault-mode", isEmbeddedVault);
    document.body.classList.toggle("embedded-vault-mode", isEmbeddedVault);
    return () => {
      document.documentElement.classList.remove("embedded-vault-mode");
      document.body.classList.remove("embedded-vault-mode");
    };
  }, [isEmbeddedVault]);

  if (!loading && !user && !isLoginPage) {
    return (
      <Routes>
        <Route path="*" element={<Navigate to="/login" state={{ from: location }} replace />} />
      </Routes>
    );
  }

  return (
    <>
      {!isEmbeddedVault && !isLoginPage && <AppSidebar />}
      {!isEmbeddedVault && !isLoginPage && user && <IntakeModal />}
      <div className={isLoginPage ? "" : "app-content"}>
        <RouteErrorBoundary>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<ProtectedRoute><OmniaGrid /></ProtectedRoute>} />
            <Route path="/dashboard" element={<Navigate to="/" replace />} />
            <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
            <Route path="/grid/:boardId" element={<ProtectedRoute><OmniaGrid /></ProtectedRoute>} />
            <Route path="/project/:projectId" element={<ProtectedRoute><ProjectPlaceholder /></ProtectedRoute>} />
            <Route path="/omnia" element={<ProtectedRoute><OmniaGrid /></ProtectedRoute>} />
            <Route path="/vault" element={<ProtectedRoute><VaultNew /></ProtectedRoute>} />
            <Route path="/mindmap" element={<ProtectedRoute><MindMap /></ProtectedRoute>} />
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
                  {legacyEnabled ? (
                    <Suspense fallback={loadingFallback}>
                      <LegacyBilling />
                    </Suspense>
                  ) : (
                    <BillingNew />
                  )}
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
