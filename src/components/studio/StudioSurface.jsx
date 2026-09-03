/* ── In-document product surfaces ──────────────────────────────────────────
   Each tab hosts the REAL routed page inside its own MemoryRouter: internal
   navigation (opening a chat, drilling into a project) happens inside the
   panel while the window URL stays /studio. Every surface router carries all
   the product routes so cross-surface links keep working in place, exactly
   like the old same-origin iframes did. A new deep-link (`entry`) remounts
   the router at that path — same behavior as reloading an iframe src. */
import {
  MemoryRouter,
  Route,
  Routes,
  UNSAFE_LocationContext,
  UNSAFE_RouteContext,
} from "react-router-dom";
import LyknChat from "@/pages/LyknChat";
import VaultConnectionsShell from "@/pages/VaultConnectionsShell";
import ProjectsPage from "@/pages/ProjectsPage";
import ProjectDetailPage from "@/pages/ProjectDetailPage";
import SettingsPage from "@/pages/Settings";
import LyknCalendarPage from "@/components/calendar/LyknCalendarPage";
import LyknTodosPage from "@/components/todos/LyknTodosPage";
import BotsPage from "@/components/bots/BotsPage";
import BotDetailPage from "@/components/bots/BotDetailPage";
import ActivityPanel from "@/components/activity/ActivityPanel";
import HomeChatBar from "@/components/macdesktop/HomeChatBar";

export default function StudioSurface({ entry, windowed = false }) {
  // The app already renders inside a BrowserRouter, and react-router v6
  // refuses to mount a <Router> inside another one. Resetting the location
  // and route contexts makes this subtree a clean slate so the MemoryRouter
  // mounts as if it were the root router (the standard nested-router escape
  // hatch — the surfaces genuinely need independent navigation).
  return (
    <div className="h-full min-h-0 overflow-hidden">
      <UNSAFE_RouteContext.Provider
        value={{ outlet: null, matches: [], isDataRoute: false }}
      >
        <UNSAFE_LocationContext.Provider value={null}>
          <MemoryRouter key={entry} initialEntries={[entry || "/"]}>
            <Routes>
              <Route path="/app" element={<LyknChat studioSurface />} />
              <Route path="/chat/:chatId" element={<LyknChat studioSurface />} />
              <Route path="/vault" element={<VaultConnectionsShell studioSurface />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route
                path="/projects/:projectId"
                element={<ProjectDetailPage windowed={windowed} />}
              />
              {/* In a floating window the frame supplies the card chrome, so
                  these render bare (no centered frost card of their own). */}
              <Route path="/calendar" element={<LyknCalendarPage windowed={windowed} />} />
              <Route path="/todos" element={<LyknTodosPage windowed={windowed} />} />
              <Route path="/bots/:botId" element={<BotDetailPage />} />
              <Route path="/bots" element={<BotsPage />} />
              <Route path="/activity" element={<ActivityPanel />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={null} />
            </Routes>
          </MemoryRouter>
        </UNSAFE_LocationContext.Provider>
      </UNSAFE_RouteContext.Provider>
    </div>
  );
}

export function StudioChatPane({ entry, live, view, onOpen, name }) {
  return (
    <div
      className="lykn-home-chat-host relative h-full min-h-0 overflow-hidden"
      style={{ "--mobile-tabbar-clear": "5.5rem" }}
    >
      <StudioSurface entry={entry} />
      <HomeChatBar
        contained
        active
        live={live}
        surfaceView={view}
        onOpen={onOpen}
        name={name}
      />
    </div>
  );
}
