import React, { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Home,
  LifeBuoy,
  Link as LinkIcon,
  Image as ImageIcon,
  LogIn,
  LogOut,
  MessageSquare,
  Plus,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Trash2,
  Users,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";

const projectColors = [
  "rgba(219,234,254,0.6)",
  "rgba(220,252,231,0.55)",
  "rgba(237,233,254,0.55)",
  "rgba(254,249,195,0.55)",
  "rgba(224,231,255,0.55)",
  "rgba(240,253,250,0.55)",
];

export default function AppSidebar() {
  const nav = useNavigate();
  const location = useLocation();
  const { user, signInWithOAuth, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState([]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!user?.id) {
        setProjects([]);
        return;
      }
      const { data } = await supabase
        .from("omnia_projects")
        .select("id, name, created_at, updated_at")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false });
      if (active) setProjects(data || []);
    };
    load();
    return () => {
      active = false;
    };
  }, [user?.id]);

  useEffect(() => {
    const updatePushState = () => {
      const appContent = document.querySelector(".app-content");
      if (!appContent) {
        document.body.classList.remove("sidebar-push");
        return;
      }

      const sidebarWidth = 190;
      const detectionEdge = sidebarWidth + 16;
      const candidates = appContent.querySelectorAll(
        "main, section, article, h1, h2, h3, p, .rounded-2xl, .rounded-xl"
      );

      let shouldPush = false;
      candidates.forEach((el) => {
        if (shouldPush) return;
        if (!(el instanceof HTMLElement)) return;
        if (el.offsetParent === null) return;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        if (rect.left < detectionEdge && rect.right > 0) {
          shouldPush = true;
        }
      });

      document.body.classList.toggle("sidebar-push", shouldPush);
    };

    if (!open) {
      document.body.classList.remove("sidebar-open");
      document.body.classList.remove("sidebar-push");
      return () => {
        document.body.classList.remove("sidebar-open");
        document.body.classList.remove("sidebar-push");
      };
    }

    document.body.classList.add("sidebar-open");
    updatePushState();
    window.addEventListener("resize", updatePushState);

    return () => {
      window.removeEventListener("resize", updatePushState);
      document.body.classList.remove("sidebar-open");
      document.body.classList.remove("sidebar-push");
    };
  }, [location.pathname, open]);

  return (
    <>
      <div className="fixed left-4 top-4 z-[80] flex items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded-full w-8 h-8 glass-control hover:opacity-90 flex items-center justify-center"
          title={open ? "Hide panel" : "Show panel"}
        >
          {open ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <button
          type="button"
          onClick={() => {
            if (user) {
              const ok = window.confirm("Sign out of your account?");
              if (ok) signOut();
            } else {
              signInWithOAuth("google");
            }
          }}
          className="flex items-center gap-2 rounded-full glass-text-card px-2 py-1 text-[11px] text-black/70 hover:opacity-90"
          title={user ? "Sign out" : "Sign in"}
        >
          <div className="h-6 w-6 rounded-full glass-text-card text-[11px] font-semibold text-black/70 flex items-center justify-center">
            {user?.email ? user.email.charAt(0).toUpperCase() : "?"}
          </div>
          <span className="pr-1">{user ? "Signed in" : "Sign in"}</span>
        </button>
      </div>

      <div
        className={`fixed top-0 left-0 z-[70] h-[100svh] w-[190px] bg-transparent backdrop-blur-md p-3 pt-12 transition-transform duration-200 flex flex-col ${
          open ? "translate-x-0" : "-translate-x-[120%]"
        }`}
      >
        <div className="absolute right-0 top-0 bottom-0 w-px bg-white/60 pointer-events-none" />
        <div className="mt-5 flex items-center justify-between px-2 py-1">
          <div className="text-[11px] font-semibold text-black/70">Navigation</div>
        </div>

        <div className="px-2 pt-2">
          <div className="flex items-center gap-2 rounded-xl border border-white/50 bg-white/60 backdrop-blur-md px-2 py-1.5 text-[11px] text-black/60">
            <SearchIcon className="w-3.5 h-3.5" />
            <input
              placeholder="Search"
              className="w-full bg-transparent outline-none placeholder:text-black/40 text-black/70"
            />
          </div>
        </div>

        <div className="mt-2 flex flex-col gap-1">
          <button
            type="button"
            onClick={() => nav("/")}
            className="w-full text-left text-[11px] px-2.5 py-1.5 hover:opacity-80 flex items-center gap-2"
          >
            <Home className="w-3.5 h-3.5 text-black/60" />
            Home
          </button>
          <button
            type="button"
            onClick={async () => {
              if (!user?.id) {
                signInWithOAuth("google");
                return;
              }
              const { data } = await supabase
                .from("omnia_boards")
                .insert({ user_id: user.id, title: "New Board" })
                .select("id")
                .single();
              const id = data?.id;
              if (id) {
                localStorage.setItem("omnia_board_id", id);
                nav(`/canvas/${id}`);
              }
            }}
            className="w-full text-left text-[11px] px-2.5 py-1.5 hover:opacity-80 flex items-center gap-2"
          >
            <Plus className="w-3.5 h-3.5 text-black/60" />
            Create
          </button>
          <button
            type="button"
            onClick={() => nav("/chat")}
            className="w-full text-left text-[11px] px-2.5 py-1.5 hover:opacity-80 flex items-center gap-2"
          >
            <MessageSquare className="w-3.5 h-3.5 text-black/60" />
            Chat
          </button>
          <button
            type="button"
            onClick={() => nav("/memory")}
            className="w-full text-left text-[11px] px-2.5 py-1.5 hover:opacity-80 flex items-center gap-2"
          >
            <ImageIcon className="w-3.5 h-3.5 text-black/60" />
            Memory
          </button>
        </div>

        <div className="mt-5 text-[11px] font-semibold text-black/70 px-2 py-1">Projects</div>
        <div className="flex flex-col gap-1 max-h-[28vh] overflow-y-auto pr-1">
          {projects.length === 0 ? (
            <div className="text-[11px] text-black/50 px-2.5 py-1.5">No projects yet.</div>
          ) : (
            projects.map((project, idx) => (
              <button
                key={project.id}
                type="button"
                onClick={() => nav(`/project/${project.id}`)}
                className="w-full text-left text-[11px] px-2.5 py-1.5 hover:opacity-80 flex items-center gap-2"
              >
                <span className="inline-block h-1 w-1 rounded-full bg-black/70" />
                <span className="truncate">{project.name}</span>
              </button>
            ))
          )}
        </div>

        <div className="mt-5 text-[11px] font-semibold text-black/70 px-2 py-1">Workspace</div>
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => nav("/teamspaces")}
            className="w-full text-left text-[11px] px-2.5 py-1.5 hover:opacity-80 flex items-center gap-2"
          >
            <Users className="w-3.5 h-3.5 text-black/60" />
            Teamspaces
          </button>
          <button
            type="button"
            onClick={() => nav("/calendar")}
            className="w-full text-left text-[11px] px-2.5 py-1.5 hover:opacity-80 flex items-center gap-2"
          >
            <Calendar className="w-3.5 h-3.5 text-black/60" />
            Calendar
          </button>
        </div>

        <div className="mt-5 text-[11px] font-semibold text-black/70 px-2 py-1">Account</div>
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => nav("/settings")}
            className="w-full text-left text-[11px] px-2.5 py-1.5 hover:opacity-80 flex items-center gap-2"
          >
            <SettingsIcon className="w-3.5 h-3.5 text-black/60" />
            Settings
          </button>
          <button
            type="button"
            onClick={() => nav("/connections")}
            className="w-full text-left text-[11px] px-2.5 py-1.5 hover:opacity-80 flex items-center gap-2"
          >
            <LinkIcon className="w-3.5 h-3.5 text-black/60" />
            Connections
          </button>
          <button
            type="button"
            onClick={() => nav("/trash")}
            className="w-full text-left text-[11px] px-2.5 py-1.5 hover:opacity-80 flex items-center gap-2"
          >
            <Trash2 className="w-3.5 h-3.5 text-black/60" />
            Trash
          </button>
          <button
            type="button"
            onClick={() => nav("/billing")}
            className="w-full text-left text-[11px] px-2.5 py-1.5 hover:opacity-80 flex items-center gap-2"
          >
            <CreditCard className="w-3.5 h-3.5 text-black/60" />
            Billing
          </button>
        </div>

        <div className="mt-auto pt-4">
          <button
            type="button"
            onClick={() => nav("/support")}
            className="w-full text-left text-[11px] px-2.5 py-1.5 hover:opacity-80 flex items-center gap-2"
          >
            <LifeBuoy className="w-3.5 h-3.5 text-black/60" />
            Get support
          </button>

          {user && (
            <button
              type="button"
              onClick={() => signOut()}
              className="mt-2 w-full text-left text-[11px] px-2.5 py-1.5 hover:opacity-80 flex items-center gap-2"
            >
              <LogOut className="w-3.5 h-3.5 text-black/60" />
              Log out
            </button>
          )}
        </div>
      </div>
    </>
  );
}
