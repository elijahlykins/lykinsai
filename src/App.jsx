import React, { Suspense, useEffect } from "react";
import { Toaster } from "@/components/ui/toaster";
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClientInstance } from '@/lib/query-client';
import { BrowserRouter as Router, Route, Routes, useLocation } from 'react-router-dom';
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
import ChatPage from "./pages/Chat";
import CalendarPage from "./pages/CalendarPage";
import TeamSpaces from "./pages/TeamSpaces";

const legacyEnabled = String(import.meta.env.VITE_ENABLE_LEGACY_NOTES || "").toLowerCase() === "true";
const LegacyMemoryChat = React.lazy(() => import("./pages/MemoryChat"));
const LegacyTagManagement = React.lazy(() => import("./pages/TagManagement"));
const LegacyTrash = React.lazy(() => import("./pages/Trash"));
const LegacyBilling = React.lazy(() => import("./pages/Billing"));
const LegacyReminders = React.lazy(() => import("./pages/Reminders"));
const loadingFallback = <LoadingScreen isLoading={true} />;

function AppShell() {
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  const isEmbeddedMemory = location.pathname === "/memory" && search.get("embedded") === "1";

  useEffect(() => {
    document.documentElement.classList.toggle("embedded-memory-mode", isEmbeddedMemory);
    document.body.classList.toggle("embedded-memory-mode", isEmbeddedMemory);
    return () => {
      document.documentElement.classList.remove("embedded-memory-mode");
      document.body.classList.remove("embedded-memory-mode");
    };
  }, [isEmbeddedMemory]);

  return (
    <>
      {!isEmbeddedMemory && <AppSidebar />}
      <div className="app-content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/login" element={<Login />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/canvas/:boardId" element={<OmniaCanvas />} />
          <Route path="/project/:projectId" element={<ProjectPlaceholder />} />
          <Route path="/omnia" element={<OmniaCanvas />} />
          <Route
            path="/memory"
            element={<MemoryNew />}
          />
          <Route
            path="/tag-management"
            element={
              legacyEnabled ? (
                <Suspense fallback={loadingFallback}>
                  <LegacyTagManagement />
                </Suspense>
              ) : (
                <TagManagementNew />
              )
            }
          />
          <Route
            path="/trash"
            element={
              legacyEnabled ? (
                <Suspense fallback={loadingFallback}>
                  <LegacyTrash />
                </Suspense>
              ) : (
                <TrashNew />
              )
            }
          />
          <Route
            path="/memorychat"
            element={
              legacyEnabled ? (
                <Suspense fallback={loadingFallback}>
                  <LegacyMemoryChat />
                </Suspense>
              ) : (
                <MemoryChatNew />
              )
            }
          />
          <Route
            path="/memory-chat"
            element={
              legacyEnabled ? (
                <Suspense fallback={loadingFallback}>
                  <LegacyMemoryChat />
                </Suspense>
              ) : (
                <MemoryChatNew />
              )
            }
          />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/teamspaces" element={<TeamSpaces />} />
          <Route
            path="/reminders"
            element={
              legacyEnabled ? (
                <Suspense fallback={loadingFallback}>
                  <LegacyReminders />
                </Suspense>
              ) : (
                <RemindersNew />
              )
            }
          />
          <Route
            path="/billing"
            element={
              legacyEnabled ? (
                <Suspense fallback={loadingFallback}>
                  <LegacyBilling />
                </Suspense>
              ) : (
                <BillingNew />
              )
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
