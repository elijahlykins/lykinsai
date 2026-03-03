import React, { Suspense, useEffect } from "react";
import { Toaster } from "@/components/ui/toaster";
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClientInstance } from '@/lib/query-client';
import { BrowserRouter as Router, Route, Routes, useLocation, Navigate } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { SupabaseAuthProvider, useAuth } from '@/lib/SupabaseAuth';
import LoadingScreen from "@/components/LoadingScreen";

// ✅ CORRECT IMPORTS (no spaces, match your filenames)
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";
import OmniaCanvas from "./pages/OmniaCanvas";
import ProjectPlaceholder from "./pages/ProjectPlaceholder";
import Settings from "./pages/Settings";
import AppSidebar from "./components/AppSidebar";
import MemoryNew from "./pages/new/MemoryNew";
import MemoryChatNew from "./pages/new/MemoryChatNew";
import TagManagementNew from "./pages/new/TagManagementNew";
import TrashNew from "./pages/new/TrashNew";
import BillingNew from "./pages/new/BillingNew";
import RemindersNew from "./pages/new/RemindersNew";

import CalendarPage from "./pages/CalendarPage";
import TeamSpaces from "./pages/TeamSpaces";

const legacyEnabled = String(import.meta.env.VITE_ENABLE_LEGACY_NOTES || "").toLowerCase() === "true";
const LegacyMemoryChat = React.lazy(() => import("./pages/MemoryChat"));
const LegacyTagManagement = React.lazy(() => import("./pages/TagManagement"));
const LegacyTrash = React.lazy(() => import("./pages/Trash"));
const LegacyBilling = React.lazy(() => import("./pages/Billing"));
const LegacyReminders = React.lazy(() => import("./pages/Reminders"));
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
  const isEmbeddedMemory = location.pathname === "/memory" && search.get("embedded") === "1";
  const isLoginPage = location.pathname === "/login";

  useEffect(() => {
    document.documentElement.classList.toggle("embedded-memory-mode", isEmbeddedMemory);
    document.body.classList.toggle("embedded-memory-mode", isEmbeddedMemory);
    return () => {
      document.documentElement.classList.remove("embedded-memory-mode");
      document.body.classList.remove("embedded-memory-mode");
    };
  }, [isEmbeddedMemory]);

  if (!loading && !user && !isLoginPage) {
    return (
      <Routes>
        <Route path="*" element={<Navigate to="/login" state={{ from: location }} replace />} />
      </Routes>
    );
  }

  return (
    <>
      {!isEmbeddedMemory && !isLoginPage && <AppSidebar />}
      <div className={isLoginPage ? "" : "app-content"}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
          <Route path="/canvas/:boardId" element={<ProtectedRoute><OmniaCanvas /></ProtectedRoute>} />
          <Route path="/project/:projectId" element={<ProtectedRoute><ProjectPlaceholder /></ProtectedRoute>} />
          <Route path="/omnia" element={<ProtectedRoute><OmniaCanvas /></ProtectedRoute>} />
          <Route path="/memory" element={<ProtectedRoute><MemoryNew /></ProtectedRoute>} />
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
            path="/trash"
            element={
              <ProtectedRoute>
                {legacyEnabled ? (
                  <Suspense fallback={loadingFallback}>
                    <LegacyTrash />
                  </Suspense>
                ) : (
                  <TrashNew />
                )}
              </ProtectedRoute>
            }
          />
          <Route
            path="/memorychat"
            element={
              <ProtectedRoute>
                {legacyEnabled ? (
                  <Suspense fallback={loadingFallback}>
                    <LegacyMemoryChat />
                  </Suspense>
                ) : (
                  <MemoryChatNew />
                )}
              </ProtectedRoute>
            }
          />
          <Route
            path="/memory-chat"
            element={
              <ProtectedRoute>
                {legacyEnabled ? (
                  <Suspense fallback={loadingFallback}>
                    <LegacyMemoryChat />
                  </Suspense>
                ) : (
                  <MemoryChatNew />
                )}
              </ProtectedRoute>
            }
          />
          {/* Chat is now an inline mode on the canvas — no separate route */}
          <Route path="/calendar" element={<ProtectedRoute><CalendarPage /></ProtectedRoute>} />
          <Route path="/teamspaces" element={<ProtectedRoute><TeamSpaces /></ProtectedRoute>} />
          <Route
            path="/reminders"
            element={
              <ProtectedRoute>
                {legacyEnabled ? (
                  <Suspense fallback={loadingFallback}>
                    <LegacyReminders />
                  </Suspense>
                ) : (
                  <RemindersNew />
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
        <AppRoutes />
        <Toaster />
      </SupabaseAuthProvider>
    </QueryClientProvider>
  );
}

export default App;
