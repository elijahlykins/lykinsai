import React, { useState } from "react";
import ReactDOM from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Brain,
  Bug,
  Compass,
  CreditCard,
  Lock,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  Plug,
  Settings as SettingsIcon,
  X,
} from "lucide-react";
import { useAuth } from "@/lib/SupabaseAuth";
import FeedbackModal from "@/components/FeedbackModal";

const flushAndNavigate = (nav, path) => {
  window.dispatchEvent(new Event("omnia_flush_save"));
  setTimeout(() => nav(path), 60);
};

function TabButton({ active, label, onClick, icon: Icon }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-2 transition-colors ${
        active
          ? "text-blue-600 dark:text-blue-400"
          : "text-black/55 dark:text-white/55 hover:text-black/80 dark:hover:text-white/80"
      }`}
      aria-label={label}
    >
      <Icon className={`w-5 h-5 ${active ? "" : "opacity-90"}`} strokeWidth={active ? 2.25 : 1.75} />
      <span className="text-[0.625rem] font-medium tracking-wide">{label}</span>
    </button>
  );
}

export default function MobileTabBar() {
  const location = useLocation();
  const nav = useNavigate();
  const { user, signInWithOAuth, signOut } = useAuth();
  const [moreOpen, setMoreOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const isChatActive =
    location.pathname === "/app" ||
    location.pathname === "/dashboard" ||
    location.pathname === "/omnia" ||
    location.pathname.startsWith("/grid/") ||
    location.pathname.startsWith("/project/");
  const isVaultActive =
    location.pathname === "/vault" || location.pathname === "/vaultchat" || location.pathname === "/vault-chat";

  React.useEffect(() => {
    document.body.classList.add("has-mobile-tabbar");
    return () => document.body.classList.remove("has-mobile-tabbar");
  }, []);

  return (
    <>
      <nav
        className="fixed inset-x-0 bottom-0 z-[75] pb-safe border-t border-black/8 dark:border-white/8 bg-white/85 dark:bg-[rgba(20,20,24,0.92)] backdrop-blur-xl"
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      >
        <div className="flex items-stretch">
          <TabButton
            active={isChatActive}
            label="Chat"
            icon={MessageSquare}
            onClick={() => flushAndNavigate(nav, "/app")}
          />
          <TabButton
            active={isVaultActive}
            label="Vault"
            icon={Lock}
            onClick={() => flushAndNavigate(nav, "/vault")}
          />
          <TabButton
            active={moreOpen}
            label="More"
            icon={MoreHorizontal}
            onClick={() => setMoreOpen(true)}
          />
        </div>
      </nav>

      {moreOpen &&
        ReactDOM.createPortal(
          <div
            className="fixed inset-0 z-[90] bg-black/40 backdrop-blur-sm flex items-end"
            onClick={() => setMoreOpen(false)}
          >
            <div
              className="w-full rounded-t-2xl bg-white dark:bg-[#1c1c1e] border-t border-black/8 dark:border-white/10 shadow-2xl pb-safe"
              style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-5 pt-4 pb-2">
                <h2 className="text-base font-semibold text-black dark:text-white">More</h2>
                <button
                  type="button"
                  onClick={() => setMoreOpen(false)}
                  className="w-9 h-9 rounded-full hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center"
                  aria-label="Close menu"
                >
                  <X className="w-4 h-4 text-black/70 dark:text-white/70" />
                </button>
              </div>

              {user ? (
                <div className="px-5 py-2 border-b border-black/5 dark:border-white/5 mb-1">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-full bg-blue-500/15 dark:bg-blue-400/20 text-sm font-semibold text-blue-600 dark:text-blue-400 flex items-center justify-center">
                      {user?.email ? user.email.charAt(0).toUpperCase() : "?"}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-black/85 dark:text-white/85 truncate">{user.email}</p>
                      <p className="text-[0.6875rem] text-black/50 dark:text-white/50">Signed in</p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="px-5 py-3 border-b border-black/5 dark:border-white/5 mb-1">
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      signInWithOAuth("google");
                    }}
                    className="w-full rounded-xl bg-blue-500 text-white text-sm font-medium py-2.5 hover:bg-blue-600 transition-colors"
                  >
                    Sign in
                  </button>
                </div>
              )}

              <div className="py-1">
                <MoreItem
                  icon={Brain}
                  label="Synthesis Layer"
                  onClick={() => {
                    setMoreOpen(false);
                    flushAndNavigate(nav, "/synthesis-layer");
                  }}
                />
                <MoreItem
                  icon={Compass}
                  label="Discover"
                  onClick={() => {
                    setMoreOpen(false);
                    flushAndNavigate(nav, "/discover");
                  }}
                />
                <MoreItem
                  icon={Plug}
                  label="Connections"
                  onClick={() => {
                    setMoreOpen(false);
                    flushAndNavigate(nav, "/connections");
                  }}
                />
                <MoreItem
                  icon={SettingsIcon}
                  label="Settings"
                  onClick={() => {
                    setMoreOpen(false);
                    flushAndNavigate(nav, "/settings");
                  }}
                />
                <MoreItem
                  icon={CreditCard}
                  label="Billing"
                  onClick={() => {
                    setMoreOpen(false);
                    flushAndNavigate(nav, "/billing");
                  }}
                />
                <MoreItem
                  icon={Bug}
                  label="Report a bug"
                  onClick={() => {
                    setMoreOpen(false);
                    setFeedbackOpen(true);
                  }}
                />
                {user && (
                  <MoreItem
                    icon={LogOut}
                    label="Sign out"
                    danger
                    onClick={() => {
                      setMoreOpen(false);
                      const ok = window.confirm("Sign out of your account?");
                      if (ok) signOut();
                    }}
                  />
                )}
              </div>
            </div>
          </div>,
          document.body
        )}

      <FeedbackModal open={feedbackOpen} onOpenChange={setFeedbackOpen} defaultType="bug" />
    </>
  );
}

function MoreItem({ icon: Icon, label, onClick, danger, trailing }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-5 py-3 text-left transition-colors ${
        danger
          ? "text-red-600 dark:text-red-400 hover:bg-red-500/10"
          : "text-black/85 dark:text-white/85 hover:bg-black/5 dark:hover:bg-white/8"
      }`}
    >
      <Icon className="w-4 h-4 opacity-80" />
      <span className="flex-1 text-sm font-medium">{label}</span>
      {trailing}
    </button>
  );
}
