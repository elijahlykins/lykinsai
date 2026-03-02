import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Calendar,
  ChevronDown,
  ChevronUp,
  Copy,
  Edit2,
  FolderOpen,
  Layout,
  Link2,
  LogOut,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Send,
  Settings,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { useAuth } from "@/lib/SupabaseAuth";
import { supabase } from "@/lib/supabase";


const TEAM_COLORS = [
  "rgba(59,130,246,0.14)",
  "rgba(16,185,129,0.14)",
  "rgba(245,158,11,0.14)",
  "rgba(139,92,246,0.14)",
  "rgba(236,72,153,0.14)",
  "rgba(6,182,212,0.14)",
];
const TEAM_BORDER_COLORS = [
  "rgba(59,130,246,0.45)",
  "rgba(16,185,129,0.45)",
  "rgba(245,158,11,0.45)",
  "rgba(139,92,246,0.45)",
  "rgba(236,72,153,0.45)",
  "rgba(6,182,212,0.45)",
];
const TEAM_ACCENT_COLORS = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
];

const STORAGE_KEY = "lykinsai_teamspaces";

function loadLocalTeams() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveLocalTeams(teams) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(teams));
  } catch {}
}

function getInitials(name) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("");
}

function timeAgo(dateStr) {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

// ─── Create / Edit Team Modal ────────────────────────────────────────────────

function TeamModal({ team, onClose, onSave }) {
  const isEdit = !!team;
  const [name, setName] = useState(team?.name ?? "");
  const [description, setDescription] = useState(team?.description ?? "");
  const [saving, setSaving] = useState(false);
  const nameRef = useRef(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    await onSave({ id: team?.id, name: name.trim(), description: description.trim() });
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[420px] max-w-[90vw] rounded-2xl glass-control border border-white/25 dark:border-white/10 shadow-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-black/80 dark:text-white/80">
            {isEdit ? "Edit Team" : "Create New Team"}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full w-7 h-7 hover:bg-black/10 dark:hover:bg-white/10 flex items-center justify-center transition-colors"
          >
            <X className="w-3.5 h-3.5 text-black/50 dark:text-white/50" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div>
            <label className="text-[10px] font-semibold text-black/45 dark:text-white/45 uppercase tracking-wider mb-1.5 block">
              Team Name
            </label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Marketing, Engineering, Design..."
              className="w-full rounded-xl border border-black/10 dark:border-white/10 bg-white/20 dark:bg-white/5 px-3 py-2 text-[13px] text-black/80 dark:text-white/80 placeholder:text-black/35 dark:placeholder:text-white/35 outline-none focus:border-black/20 dark:focus:border-white/20 transition-colors"
            />
          </div>

          <div>
            <label className="text-[10px] font-semibold text-black/45 dark:text-white/45 uppercase tracking-wider mb-1.5 block">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this team work on? (optional)"
              rows={2}
              className="w-full rounded-xl border border-black/10 dark:border-white/10 bg-white/20 dark:bg-white/5 px-3 py-2 text-[13px] text-black/80 dark:text-white/80 placeholder:text-black/35 dark:placeholder:text-white/35 outline-none focus:border-black/20 dark:focus:border-white/20 transition-colors resize-none"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="text-[11px] font-medium px-3 py-1.5 rounded-full hover:bg-black/[0.06] dark:hover:bg-white/[0.08] text-black/50 dark:text-white/50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim() || saving}
              className="text-[11px] font-medium px-4 py-1.5 rounded-full glass-control hover:opacity-90 transition-all disabled:opacity-40"
            >
              {saving ? "Saving..." : isEdit ? "Save Changes" : "Create Team"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Invite Members Modal ────────────────────────────────────────────────────

function InviteModal({ team, onClose, onInvite }) {
  const [emails, setEmails] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const addEmail = () => {
    const email = input.trim().toLowerCase();
    if (email && email.includes("@") && !emails.includes(email)) {
      setEmails((prev) => [...prev, email]);
    }
    setInput("");
    inputRef.current?.focus();
  };

  const removeEmail = (email) => {
    setEmails((prev) => prev.filter((e) => e !== email));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (input.trim()) addEmail();
    if (emails.length === 0 && !input.trim()) return;

    const finalEmails = input.trim() && input.includes("@")
      ? [...emails, input.trim().toLowerCase()]
      : emails;

    if (finalEmails.length === 0) return;
    setSending(true);
    await onInvite(finalEmails);
    setSending(false);
    setSent(true);
    setTimeout(() => onClose(), 1200);
  };

  const colorIdx = (team?.id?.charCodeAt?.(0) ?? 0) % TEAM_ACCENT_COLORS.length;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[440px] max-w-[90vw] rounded-2xl glass-control border border-white/25 dark:border-white/10 shadow-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center text-[11px] font-bold text-white"
              style={{ background: TEAM_ACCENT_COLORS[colorIdx] }}
            >
              {getInitials(team?.name || "T")}
            </div>
            <div>
              <h3 className="text-sm font-semibold text-black/80 dark:text-white/80">
                Invite to {team?.name}
              </h3>
              <p className="text-[10px] text-black/40 dark:text-white/40">
                Send invites to Google accounts
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full w-7 h-7 hover:bg-black/10 dark:hover:bg-white/10 flex items-center justify-center transition-colors"
          >
            <X className="w-3.5 h-3.5 text-black/50 dark:text-white/50" />
          </button>
        </div>

        {sent ? (
          <div className="text-center py-8">
            <div className="w-12 h-12 rounded-full bg-green-500/15 flex items-center justify-center mx-auto mb-3">
              <Mail className="w-5 h-5 text-green-600 dark:text-green-400" />
            </div>
            <p className="text-[13px] font-medium text-black/70 dark:text-white/70">
              Invites sent!
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            {emails.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {emails.map((email) => (
                  <span
                    key={email}
                    className="inline-flex items-center gap-1 rounded-full bg-black/[0.06] dark:bg-white/[0.08] px-2.5 py-1 text-[10px] text-black/65 dark:text-white/65"
                  >
                    <Mail className="w-2.5 h-2.5" />
                    {email}
                    <button
                      type="button"
                      onClick={() => removeEmail(email)}
                      className="hover:text-red-500 transition-colors ml-0.5"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type="email"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addEmail();
                  }
                  if (e.key === "," || e.key === " ") {
                    e.preventDefault();
                    addEmail();
                  }
                }}
                placeholder="name@gmail.com"
                className="flex-1 rounded-xl border border-black/10 dark:border-white/10 bg-white/20 dark:bg-white/5 px-3 py-2 text-[13px] text-black/80 dark:text-white/80 placeholder:text-black/35 dark:placeholder:text-white/35 outline-none focus:border-black/20 dark:focus:border-white/20 transition-colors"
              />
              <button
                type="button"
                onClick={addEmail}
                className="rounded-lg glass-control px-3 py-2 text-[11px] font-medium hover:opacity-90"
              >
                Add
              </button>
            </div>

            <p className="text-[10px] text-black/35 dark:text-white/35">
              Press Enter, comma, or space to add multiple emails
            </p>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="text-[11px] font-medium px-3 py-1.5 rounded-full hover:bg-black/[0.06] dark:hover:bg-white/[0.08] text-black/50 dark:text-white/50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={emails.length === 0 && !input.trim() || sending}
                className="text-[11px] font-medium px-4 py-1.5 rounded-full glass-control hover:opacity-90 transition-all disabled:opacity-40 flex items-center gap-1.5"
              >
                <Mail className="w-3 h-3" />
                {sending ? "Sending..." : `Send Invite${emails.length > 1 ? "s" : ""}`}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// ─── Delete Confirm Modal ────────────────────────────────────────────────────

function DeleteConfirmModal({ team, onClose, onConfirm }) {
  const [deleting, setDeleting] = useState(false);

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[360px] max-w-[90vw] rounded-2xl glass-control border border-white/25 dark:border-white/10 shadow-2xl p-5">
        <h3 className="text-sm font-semibold text-black/80 dark:text-white/80 mb-2">
          Delete "{team?.name}"?
        </h3>
        <p className="text-[12px] text-black/50 dark:text-white/50 mb-4 leading-relaxed">
          This will permanently remove the team and all its data. Members will lose access to shared boards and calendar events.
        </p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-[11px] font-medium px-3 py-1.5 rounded-full hover:bg-black/[0.06] dark:hover:bg-white/[0.08] text-black/50 dark:text-white/50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={async () => {
              setDeleting(true);
              await onConfirm();
            }}
            disabled={deleting}
            className="text-[11px] font-medium px-4 py-1.5 rounded-full bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25 transition-all disabled:opacity-40 flex items-center gap-1.5"
          >
            <Trash2 className="w-3 h-3" />
            {deleting ? "Deleting..." : "Delete Team"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Team Card ───────────────────────────────────────────────────────────────

function TeamCard({ team, index, onClick, onInvite, onEdit, onDelete }) {
  const colorIdx = (team.id?.charCodeAt?.(0) ?? index) % TEAM_COLORS.length;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const memberCount = team.members?.length || 0;
  const boardCount = team.boards?.length || 0;

  return (
    <div
      className="group relative rounded-2xl border border-black/[0.06] dark:border-white/[0.06] hover:border-black/[0.12] dark:hover:border-white/[0.12] transition-all cursor-pointer overflow-hidden"
      style={{ background: TEAM_COLORS[colorIdx] }}
      onClick={() => onClick(team)}
    >
      <div className="p-4">
        <div className="flex items-start justify-between mb-3">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center text-[13px] font-bold text-white shadow-sm"
            style={{ background: TEAM_ACCENT_COLORS[colorIdx] }}
          >
            {getInitials(team.name)}
          </div>
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
              className="rounded-full w-7 h-7 hover:bg-black/10 dark:hover:bg-white/10 flex items-center justify-center transition-colors opacity-0 group-hover:opacity-100"
            >
              <MoreHorizontal className="w-3.5 h-3.5 text-black/50 dark:text-white/50" />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 w-40 rounded-xl glass-control border border-white/25 dark:border-white/10 bg-white/80 dark:bg-black/60 backdrop-blur-xl shadow-lg overflow-hidden z-50">
                <div className="py-1">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpen(false);
                      onInvite(team);
                    }}
                    className="w-full text-left text-[11px] px-3 py-2 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors text-black/65 dark:text-white/65 flex items-center gap-2"
                  >
                    <UserPlus className="w-3 h-3" /> Invite Members
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpen(false);
                      onEdit(team);
                    }}
                    className="w-full text-left text-[11px] px-3 py-2 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors text-black/65 dark:text-white/65 flex items-center gap-2"
                  >
                    <Edit2 className="w-3 h-3" /> Edit Team
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpen(false);
                      onDelete(team);
                    }}
                    className="w-full text-left text-[11px] px-3 py-2 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors text-red-500/70 flex items-center gap-2"
                  >
                    <Trash2 className="w-3 h-3" /> Delete Team
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <h3 className="text-[14px] font-semibold text-black/80 dark:text-white/80 mb-0.5 truncate">
          {team.name}
        </h3>
        {team.description && (
          <p className="text-[11px] text-black/45 dark:text-white/45 mb-3 line-clamp-2 leading-relaxed">
            {team.description}
          </p>
        )}

        <div className="flex items-center justify-between mt-3 pt-3 border-t border-black/[0.06] dark:border-white/[0.06]">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 text-[10px] text-black/45 dark:text-white/45">
              <Users className="w-3 h-3" />
              <span>{memberCount} member{memberCount !== 1 ? "s" : ""}</span>
            </div>
            <div className="flex items-center gap-1 text-[10px] text-black/45 dark:text-white/45">
              <Layout className="w-3 h-3" />
              <span>{boardCount} board{boardCount !== 1 ? "s" : ""}</span>
            </div>
          </div>
          {team.members?.length > 0 && (
            <div className="flex -space-x-1.5">
              {team.members.slice(0, 4).map((m, i) => (
                <div
                  key={i}
                  className="w-5 h-5 rounded-full bg-black/10 dark:bg-white/10 text-[8px] font-bold flex items-center justify-center text-black/60 dark:text-white/60 border border-white/50 dark:border-black/30"
                  title={m.email || m}
                >
                  {(m.email || m).charAt(0).toUpperCase()}
                </div>
              ))}
              {team.members.length > 4 && (
                <div className="w-5 h-5 rounded-full bg-black/[0.06] dark:bg-white/[0.06] text-[8px] font-bold flex items-center justify-center text-black/40 dark:text-white/40 border border-white/50 dark:border-black/30">
                  +{team.members.length - 4}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Team Detail View ────────────────────────────────────────────────────────

function TeamDetail({ team, onBack, onInvite, onEdit, onNavigateCalendar, onNavigateProject, onRemoveMember, onCreateProject, onLinkProject, onUpdateTeam }) {
  const [activeTab, setActiveTab] = useState("projects");
  const colorIdx = (team.id?.charCodeAt?.(0) ?? 0) % TEAM_COLORS.length;

  const tabs = [
    { id: "projects", label: "Projects", icon: FolderOpen },
    { id: "calendar", label: "Calendar", icon: Calendar },
    { id: "chat", label: "Members Chat", icon: MessageSquare },
    { id: "members", label: "Members", icon: Users },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 pb-4">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-[11px] text-black/50 dark:text-white/50 hover:text-black/70 dark:hover:text-white/70 transition-colors mb-4"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          All Teams
        </button>

        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center text-[15px] font-bold text-white shadow-sm"
              style={{ background: TEAM_ACCENT_COLORS[colorIdx] }}
            >
              {getInitials(team.name)}
            </div>
            <div>
              <h1 className="text-xl font-semibold text-black/85 dark:text-white/85">
                {team.name}
              </h1>
              {team.description && (
                <p className="text-[12px] text-black/45 dark:text-white/45 mt-0.5">
                  {team.description}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => onInvite(team)}
              className="flex items-center gap-1.5 text-[11px] font-medium px-3 py-1.5 rounded-full glass-control hover:opacity-90 transition-all"
            >
              <UserPlus className="w-3 h-3" />
              Invite
            </button>
            <button
              type="button"
              onClick={() => onEdit(team)}
              className="rounded-full w-8 h-8 glass-control hover:opacity-90 flex items-center justify-center"
            >
              <Settings className="w-3.5 h-3.5 text-black/50 dark:text-white/50" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 mt-5">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 text-[11px] font-medium px-3 py-1.5 rounded-full transition-all ${
                  isActive
                    ? "glass-control shadow-sm text-black/80 dark:text-white/80"
                    : "text-black/45 dark:text-white/45 hover:text-black/65 dark:hover:text-white/65 hover:bg-black/[0.04] dark:hover:bg-white/[0.04]"
                }`}
              >
                <Icon className="w-3 h-3" />
                {tab.label}
                {tab.id === "members" && team.members?.length > 0 && (
                  <span className="ml-0.5 text-[9px] bg-black/[0.06] dark:bg-white/[0.06] px-1.5 py-0.5 rounded-full">
                    {team.members.length}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab Content */}
      <div className={`flex-1 ${activeTab === "chat" ? "flex flex-col overflow-hidden" : "overflow-y-auto"} px-6 pb-8`}>
        {activeTab === "projects" && (
          <ProjectsTab
            team={team}
            onCreateProject={onCreateProject}
            onLinkProject={onLinkProject}
            onNavigateProject={onNavigateProject}
            colorIdx={colorIdx}
          />
        )}
        {activeTab === "calendar" && (
          <CalendarTab
            team={team}
            onNavigateCalendar={onNavigateCalendar}
          />
        )}
        {activeTab === "chat" && (
          <MembersChatTab
            team={team}
            onUpdateTeam={onUpdateTeam}
          />
        )}
        {activeTab === "members" && (
          <MembersTab
            team={team}
            onInvite={() => onInvite(team)}
            onRemoveMember={onRemoveMember}
          />
        )}
      </div>
    </div>
  );
}

// ─── Link Project Modal ──────────────────────────────────────────────────────

function LinkProjectModal({ team, existingProjects, linkedIds, onClose, onLink }) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [linking, setLinking] = useState(false);

  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const available = useMemo(() => {
    const linked = new Set(linkedIds);
    return existingProjects.filter((p) => !linked.has(p.id));
  }, [existingProjects, linkedIds]);

  const filtered = useMemo(() => {
    if (!search.trim()) return available;
    const q = search.toLowerCase();
    return available.filter((p) => p.name?.toLowerCase().includes(q));
  }, [available, search]);

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSubmit = async () => {
    if (selected.size === 0) return;
    setLinking(true);
    const projectsToLink = existingProjects.filter((p) => selected.has(p.id));
    await onLink(projectsToLink);
    setLinking(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[440px] max-w-[90vw] rounded-2xl glass-control border border-white/25 dark:border-white/10 shadow-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-black/80 dark:text-white/80">
              Link Existing Project
            </h3>
            <p className="text-[10px] text-black/40 dark:text-white/40 mt-0.5">
              Add your existing projects to {team?.name}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full w-7 h-7 hover:bg-black/10 dark:hover:bg-white/10 flex items-center justify-center transition-colors"
          >
            <X className="w-3.5 h-3.5 text-black/50 dark:text-white/50" />
          </button>
        </div>

        <div className="flex items-center gap-2 rounded-xl border border-black/10 dark:border-white/10 bg-white/20 dark:bg-white/5 px-2.5 py-1.5 mb-3">
          <Search className="w-3.5 h-3.5 text-black/35 dark:text-white/35" />
          <input
            type="text"
            placeholder="Search your projects..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 bg-transparent outline-none text-[12px] text-black/70 dark:text-white/70 placeholder:text-black/35 dark:placeholder:text-white/35"
            autoFocus
          />
        </div>

        <div className="max-h-[280px] overflow-y-auto -mx-1 px-1">
          {filtered.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-[12px] text-black/40 dark:text-white/40">
                {available.length === 0
                  ? "All your projects are already linked"
                  : "No projects match your search"}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {filtered.map((project) => {
                const isSelected = selected.has(project.id);
                return (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => toggleSelect(project.id)}
                    className={`w-full text-left rounded-xl px-3 py-2.5 flex items-center gap-3 transition-all ${
                      isSelected
                        ? "glass-control shadow-sm"
                        : "hover:bg-black/[0.03] dark:hover:bg-white/[0.03]"
                    }`}
                  >
                    <div
                      className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all shrink-0 ${
                        isSelected
                          ? "border-blue-500 bg-blue-500"
                          : "border-black/20 dark:border-white/20"
                      }`}
                    >
                      {isSelected && (
                        <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] font-medium text-black/70 dark:text-white/70 truncate">
                        {project.name || "Untitled Project"}
                      </p>
                      <p className="text-[10px] text-black/35 dark:text-white/35">
                        {timeAgo(project.updated_at || project.created_at)}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between pt-3 mt-3 border-t border-black/[0.06] dark:border-white/[0.06]">
          <span className="text-[10px] text-black/40 dark:text-white/40">
            {selected.size > 0 ? `${selected.size} selected` : ""}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="text-[11px] font-medium px-3 py-1.5 rounded-full hover:bg-black/[0.06] dark:hover:bg-white/[0.08] text-black/50 dark:text-white/50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={selected.size === 0 || linking}
              className="text-[11px] font-medium px-4 py-1.5 rounded-full glass-control hover:opacity-90 transition-all disabled:opacity-40 flex items-center gap-1.5"
            >
              <Link2 className="w-3 h-3" />
              {linking ? "Linking..." : `Link ${selected.size > 0 ? selected.size : ""} Project${selected.size !== 1 ? "s" : ""}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Projects Tab ────────────────────────────────────────────────────────────

function formatProjectDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function readProjectCardImages() {
  try {
    const raw = localStorage.getItem("omnia_project_card_images");
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function ProjectsTab({ team, onCreateProject, onLinkProject, onNavigateProject, colorIdx }) {
  const projects = team.projects || [];
  const [imageMap] = useState(() => readProjectCardImages());

  return (
    <div>
      <div className="flex items-center gap-2 mb-6">
        <button
          type="button"
          onClick={() => onCreateProject(team)}
          className="inline-flex items-center gap-2 rounded-xl glass-control px-4 py-2 text-sm font-semibold text-black/80 dark:text-white/80 hover:opacity-90 transition-all"
          style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}
        >
          <Plus className="w-4 h-4" />
          Create New Project
        </button>
        <button
          type="button"
          onClick={() => onLinkProject(team)}
          className="inline-flex items-center gap-2 rounded-xl glass-control px-4 py-2 text-sm font-semibold text-black/80 dark:text-white/80 hover:opacity-90 transition-all"
          style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}
        >
          <Link2 className="w-4 h-4" />
          Link Existing Project
        </button>
      </div>

      {projects.length === 0 ? (
        <div className="text-center py-12">
          <div className="w-14 h-14 rounded-2xl bg-black/[0.04] dark:bg-white/[0.04] flex items-center justify-center mx-auto mb-3">
            <FolderOpen className="w-6 h-6 text-black/25 dark:text-white/25" />
          </div>
          <p className="text-[13px] text-black/45 dark:text-white/45 mb-1">No projects yet</p>
          <p className="text-[11px] text-black/30 dark:text-white/30">
            Create a new project or link an existing one using the buttons above
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {projects.map((project, i) => {
            const localImg = imageMap[project.id];
            const imageSrc = localImg === "__removed__" ? "" : (localImg || project.cover_image_url || project.image_url || project.thumbnail_url || project.image || "");
            return (
              <div
                key={project.id || i}
                onClick={() => onNavigateProject(project.id)}
                className="group relative min-h-[210px] rounded-2xl border border-white/30 bg-[rgba(160,160,170,0.25)] backdrop-blur-[30px] backdrop-saturate-[1.4] p-4 text-black transition-transform hover:scale-[1.02] flex items-center justify-center text-center overflow-hidden cursor-pointer"
              >
                <div className="relative z-20 w-full flex flex-col items-center px-1 pt-1 pb-2">
                  <div className="h-24 w-full rounded-xl border border-white/60 bg-white/25 backdrop-blur-md overflow-hidden flex items-center justify-center">
                    {imageSrc ? (
                      <img src={imageSrc} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="text-xl font-semibold text-black/70">
                        {getInitials(project.name || "P")}
                      </span>
                    )}
                  </div>

                  <div className="mt-4 w-full px-1 text-left min-h-[44px] flex flex-col justify-between">
                    <h3 className="text-sm font-semibold drop-shadow-[0_0_8px_rgba(255,255,255,0.55)] leading-tight line-clamp-1">
                      {project.name || "Untitled Project"}
                    </h3>
                    <div className="mt-1 text-[11px] text-black/55 leading-tight">
                      Last modified: {formatProjectDate(project.updated_at || project.created_at)}
                    </div>
                  </div>
                </div>
                <div className="absolute inset-0 rounded-2xl ring-1 ring-white/40 pointer-events-none" />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Boards Tab ──────────────────────────────────────────────────────────────

function BoardsTab({ team, onCreateBoard, onNavigateBoard, colorIdx }) {
  const boards = team.boards || [];

  return (
    <div>
      {boards.length === 0 ? (
        <div className="text-center py-16">
          <div className="w-14 h-14 rounded-2xl bg-black/[0.04] dark:bg-white/[0.04] flex items-center justify-center mx-auto mb-3">
            <Layout className="w-6 h-6 text-black/25 dark:text-white/25" />
          </div>
          <p className="text-[13px] text-black/45 dark:text-white/45 mb-1">No boards yet</p>
          <p className="text-[11px] text-black/30 dark:text-white/30 mb-4">
            Create a shared board for your team to collaborate on
          </p>
          <button
            type="button"
            onClick={() => onCreateBoard(team)}
            className="inline-flex items-center gap-1.5 text-[11px] font-medium px-4 py-2 rounded-full glass-control hover:opacity-90 transition-all"
          >
            <Plus className="w-3 h-3" />
            Create Board
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <button
            type="button"
            onClick={() => onCreateBoard(team)}
            className="rounded-xl border-2 border-dashed border-black/[0.08] dark:border-white/[0.08] hover:border-black/[0.15] dark:hover:border-white/[0.15] transition-all p-6 flex flex-col items-center justify-center gap-2 min-h-[120px]"
          >
            <Plus className="w-5 h-5 text-black/25 dark:text-white/25" />
            <span className="text-[11px] text-black/40 dark:text-white/40 font-medium">New Board</span>
          </button>
          {boards.map((board, i) => (
            <div
              key={board.id || i}
              onClick={() => onNavigateBoard(board.id)}
              className="rounded-xl border border-black/[0.06] dark:border-white/[0.06] hover:border-black/[0.12] dark:hover:border-white/[0.12] transition-all cursor-pointer p-4 min-h-[120px] flex flex-col justify-between"
              style={{ background: TEAM_COLORS[colorIdx] }}
            >
              <div>
                <h4 className="text-[13px] font-semibold text-black/75 dark:text-white/75 truncate">
                  {board.title || "Untitled Board"}
                </h4>
                <p className="text-[10px] text-black/40 dark:text-white/40 mt-0.5">
                  {timeAgo(board.updated_at || board.created_at)}
                </p>
              </div>
              <div className="flex items-center gap-1 mt-3">
                <Layout className="w-3 h-3 text-black/30 dark:text-white/30" />
                <span className="text-[10px] text-black/35 dark:text-white/35">
                  Canvas Board
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Calendar Tab ────────────────────────────────────────────────────────────

function CalendarTab({ team, onNavigateCalendar }) {
  const [events, setEvents] = useState([]);

  useEffect(() => {
    const loadLinkedEvents = () => {
      try {
        const raw = localStorage.getItem("lykinsai_calendar_events");
        const allEvents = raw ? JSON.parse(raw) : [];
        const linked = allEvents.filter(
          (e) => Array.isArray(e.team_space_ids) && e.team_space_ids.includes(team.id)
        );
        setEvents(linked);
      } catch {
        setEvents([]);
      }
    };

    loadLinkedEvents();

    const handler = () => loadLinkedEvents();
    window.addEventListener("calendar_events_changed", handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener("calendar_events_changed", handler);
      window.removeEventListener("storage", handler);
    };
  }, [team.id]);

  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const upcomingEvents = events
    .filter((e) => e.date_key >= todayKey)
    .sort((a, b) => (a.date_key + a.start_hour).localeCompare(b.date_key + b.start_hour))
    .slice(0, 10);
  const pastEvents = events
    .filter((e) => e.date_key < todayKey)
    .sort((a, b) => (b.date_key + b.start_hour).localeCompare(a.date_key + a.start_hour))
    .slice(0, 5);

  const formatTime = (t) => {
    const h = Math.floor(t);
    const m = t % 1 === 0.5 ? "30" : "00";
    if (h === 0) return `12:${m} AM`;
    if (h < 12) return `${h}:${m} AM`;
    if (h === 12) return `12:${m} PM`;
    return `${h - 12}:${m} PM`;
  };

  const renderEventList = (list) => (
    <div className="flex flex-col gap-2">
      {list.map((evt, i) => (
        <div
          key={evt.id || i}
          className="rounded-xl border border-black/[0.06] dark:border-white/[0.06] p-3 flex items-center gap-3 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
        >
          <div className="w-10 text-center shrink-0">
            <div className="text-[10px] text-black/40 dark:text-white/40 uppercase">
              {new Date(evt.date_key + "T00:00:00").toLocaleDateString("en-US", { month: "short" })}
            </div>
            <div className="text-[16px] font-semibold text-black/70 dark:text-white/70">
              {new Date(evt.date_key + "T00:00:00").getDate()}
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="text-[12px] font-semibold text-black/70 dark:text-white/70 truncate">
              {evt.title}
            </h4>
            <p className="text-[10px] text-black/40 dark:text-white/40 mt-0.5">
              {formatTime(evt.start_hour)} — {formatTime(evt.end_hour)}
            </p>
          </div>
          {evt.members?.length > 0 && (
            <div className="flex -space-x-1">
              {evt.members.slice(0, 3).map((m, j) => (
                <div
                  key={j}
                  className="w-5 h-5 rounded-full bg-black/10 dark:bg-white/10 text-[8px] font-bold flex items-center justify-center text-black/60 dark:text-white/60 border border-white/50 dark:border-black/30"
                  title={m}
                >
                  {m.charAt(0).toUpperCase()}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-[13px] font-semibold text-black/70 dark:text-white/70">
            Team Calendar
          </h3>
          <p className="text-[11px] text-black/40 dark:text-white/40 mt-0.5">
            Events linked to this team space from the calendar
          </p>
        </div>
        <button
          type="button"
          onClick={onNavigateCalendar}
          className="flex items-center gap-1.5 text-[11px] font-medium px-3 py-1.5 rounded-full glass-control hover:opacity-90 transition-all"
        >
          <Calendar className="w-3 h-3" />
          Open Calendar
        </button>
      </div>

      {events.length === 0 ? (
        <div className="text-center py-12">
          <div className="w-14 h-14 rounded-2xl bg-black/[0.04] dark:bg-white/[0.04] flex items-center justify-center mx-auto mb-3">
            <Calendar className="w-6 h-6 text-black/25 dark:text-white/25" />
          </div>
          <p className="text-[13px] text-black/45 dark:text-white/45 mb-1">No linked events</p>
          <p className="text-[11px] text-black/30 dark:text-white/30">
            Link events to this team space from the calendar to see them here
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {upcomingEvents.length > 0 && (
            <div>
              <h4 className="text-[11px] font-semibold text-black/40 dark:text-white/40 uppercase tracking-wider mb-2">
                Upcoming
              </h4>
              {renderEventList(upcomingEvents)}
            </div>
          )}
          {pastEvents.length > 0 && (
            <div>
              <h4 className="text-[11px] font-semibold text-black/40 dark:text-white/40 uppercase tracking-wider mb-2">
                Past
              </h4>
              {renderEventList(pastEvents)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Members Chat Tab ────────────────────────────────────────────────────────

const CHAT_STORAGE_PREFIX = "lykinsai_team_chat_";

function loadTeamChat(teamId) {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_PREFIX + teamId);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveTeamChat(teamId, messages) {
  try {
    localStorage.setItem(CHAT_STORAGE_PREFIX + teamId, JSON.stringify(messages));
  } catch {}
}

function MembersChatTab({ team, onUpdateTeam }) {
  const { user } = useAuth();
  const [messages, setMessages] = useState(() => loadTeamChat(team.id));
  const [input, setInput] = useState("");
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const senderEmail = user?.email || "You";
  const senderName = user?.user_metadata?.full_name || user?.user_metadata?.name || senderEmail.split("@")[0];

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;

    const newMessage = {
      id: crypto.randomUUID(),
      text,
      sender: senderEmail,
      senderName,
      timestamp: new Date().toISOString(),
    };

    const updated = [...messages, newMessage];
    setMessages(updated);
    saveTeamChat(team.id, updated);
    setInput("");
    inputRef.current?.focus();
  };

  const formatChatTime = (ts) => {
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = d.toDateString() === yesterday.toDateString();

    const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    if (isToday) return time;
    if (isYesterday) return `Yesterday ${time}`;
    return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
  };

  const groupedMessages = useMemo(() => {
    const groups = [];
    let lastSender = null;
    let lastGroup = null;

    for (const msg of messages) {
      const isSame = msg.sender === lastSender;
      const timeDiff = lastGroup
        ? new Date(msg.timestamp).getTime() - new Date(lastGroup.messages[lastGroup.messages.length - 1].timestamp).getTime()
        : Infinity;
      const withinWindow = timeDiff < 120000;

      if (isSame && withinWindow && lastGroup) {
        lastGroup.messages.push(msg);
      } else {
        lastGroup = {
          sender: msg.sender,
          senderName: msg.senderName,
          messages: [msg],
        };
        groups.push(lastGroup);
      }
      lastSender = msg.sender;
    }
    return groups;
  }, [messages]);

  const members = team.members || [];

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto min-h-0 -mx-2 px-2">
        {messages.length === 0 ? (
          <div className="text-center py-16">
            <div className="w-14 h-14 rounded-2xl bg-black/[0.04] dark:bg-white/[0.04] flex items-center justify-center mx-auto mb-3">
              <MessageSquare className="w-6 h-6 text-black/25 dark:text-white/25" />
            </div>
            <p className="text-[13px] text-black/45 dark:text-white/45 mb-1">No messages yet</p>
            <p className="text-[11px] text-black/30 dark:text-white/30">
              Start a conversation with your team
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 py-3">
            {groupedMessages.map((group, gi) => {
              const isMe = group.sender === senderEmail;
              const colorIdx = (group.sender?.charCodeAt?.(0) ?? gi) % TEAM_ACCENT_COLORS.length;

              return (
                <div key={gi} className={`flex gap-2.5 ${isMe ? "flex-row-reverse" : ""}`}>
                  {!isMe && (
                    <div
                      className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0 mt-0.5"
                      style={{ background: TEAM_ACCENT_COLORS[colorIdx] }}
                    >
                      {(group.senderName || group.sender).charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className={`flex flex-col gap-0.5 max-w-[75%] ${isMe ? "items-end" : "items-start"}`}>
                    {!isMe && (
                      <span className="text-[10px] font-medium text-black/45 dark:text-white/45 px-1">
                        {group.senderName || group.sender.split("@")[0]}
                      </span>
                    )}
                    {group.messages.map((msg) => (
                      <div
                        key={msg.id}
                        className={`rounded-2xl px-3 py-2 text-[13px] leading-relaxed ${
                          isMe
                            ? "bg-blue-500/15 text-black/80 dark:text-white/80 rounded-tr-md"
                            : "bg-black/[0.05] dark:bg-white/[0.08] text-black/75 dark:text-white/75 rounded-tl-md"
                        }`}
                      >
                        {msg.text}
                      </div>
                    ))}
                    <span className="text-[9px] text-black/30 dark:text-white/30 px-1">
                      {formatChatTime(group.messages[group.messages.length - 1].timestamp)}
                    </span>
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="pt-3 mt-auto border-t border-black/[0.06] dark:border-white/[0.06]">
        {members.length === 0 && (
          <p className="text-[10px] text-black/35 dark:text-white/35 mb-2 text-center">
            Invite team members to start chatting together
          </p>
        )}
        <div className="flex items-end gap-2">
          <div className="flex-1 rounded-xl border border-black/10 dark:border-white/10 bg-white/20 dark:bg-white/5 px-3 py-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Type a message..."
              rows={1}
              className="w-full bg-transparent outline-none text-[13px] text-black/80 dark:text-white/80 placeholder:text-black/35 dark:placeholder:text-white/35 resize-none max-h-[120px]"
              style={{ minHeight: "20px" }}
            />
          </div>
          <button
            type="button"
            onClick={handleSend}
            disabled={!input.trim()}
            className="rounded-xl glass-control w-9 h-9 flex items-center justify-center hover:opacity-90 transition-all disabled:opacity-30 shrink-0"
            style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}
          >
            <Send className="w-4 h-4 text-black/60 dark:text-white/60" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Members Tab ─────────────────────────────────────────────────────────────

function MembersTab({ team, onInvite, onRemoveMember }) {
  const members = team.members || [];

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-[13px] font-semibold text-black/70 dark:text-white/70">
            Team Members
          </h3>
          <p className="text-[11px] text-black/40 dark:text-white/40 mt-0.5">
            {members.length} member{members.length !== 1 ? "s" : ""} in this team
          </p>
        </div>
        <button
          type="button"
          onClick={onInvite}
          className="flex items-center gap-1.5 text-[11px] font-medium px-3 py-1.5 rounded-full glass-control hover:opacity-90 transition-all"
        >
          <UserPlus className="w-3 h-3" />
          Invite
        </button>
      </div>

      {members.length === 0 ? (
        <div className="text-center py-12">
          <div className="w-14 h-14 rounded-2xl bg-black/[0.04] dark:bg-white/[0.04] flex items-center justify-center mx-auto mb-3">
            <Users className="w-6 h-6 text-black/25 dark:text-white/25" />
          </div>
          <p className="text-[13px] text-black/45 dark:text-white/45 mb-1">No members yet</p>
          <p className="text-[11px] text-black/30 dark:text-white/30 mb-4">
            Invite team members via their Google account
          </p>
          <button
            type="button"
            onClick={onInvite}
            className="inline-flex items-center gap-1.5 text-[11px] font-medium px-4 py-2 rounded-full glass-control hover:opacity-90 transition-all"
          >
            <UserPlus className="w-3 h-3" />
            Send Invites
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {members.map((member, i) => {
            const email = typeof member === "string" ? member : member.email;
            const role = typeof member === "string" ? (i === 0 ? "owner" : "member") : (member.role || "member");
            const joined = typeof member === "object" ? member.joined_at : null;

            return (
              <div
                key={email || i}
                className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors group"
              >
                <div className="w-8 h-8 rounded-full bg-black/[0.06] dark:bg-white/[0.06] text-[12px] font-bold flex items-center justify-center text-black/55 dark:text-white/55">
                  {email?.charAt(0).toUpperCase() || "?"}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] font-medium text-black/70 dark:text-white/70 truncate">
                      {email}
                    </span>
                    {role === "owner" && (
                      <span className="text-[9px] font-semibold bg-black/[0.06] dark:bg-white/[0.06] px-1.5 py-0.5 rounded-full text-black/45 dark:text-white/45 uppercase tracking-wider">
                        Owner
                      </span>
                    )}
                  </div>
                  {joined && (
                    <p className="text-[10px] text-black/35 dark:text-white/35">
                      Joined {timeAgo(joined)}
                    </p>
                  )}
                </div>
                {role !== "owner" && (
                  <button
                    type="button"
                    onClick={() => onRemoveMember(team.id, email)}
                    className="rounded-full w-7 h-7 hover:bg-red-500/10 flex items-center justify-center transition-colors opacity-0 group-hover:opacity-100"
                    title="Remove member"
                  >
                    <X className="w-3 h-3 text-red-500/60" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Main TeamSpaces Page ────────────────────────────────────────────────────

export default function TeamSpaces() {
  const nav = useNavigate();
  const { user, signInWithOAuth } = useAuth();
  const [teams, setTeams] = useState(() => loadLocalTeams());
  const [userProjects, setUserProjects] = useState([]);
  const [topPanelOpen, setTopPanelOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTeam, setSelectedTeam] = useState(null);
  const [modal, setModal] = useState(null);

  // Load teams from Supabase
  useEffect(() => {
    if (!user?.id) return;
    let active = true;
    (async () => {
      try {
        const { data } = await supabase
          .from("team_spaces")
          .select("*")
          .eq("owner_id", user.id)
          .order("created_at", { ascending: false });
        if (active && data) {
          setTeams(data);
          saveLocalTeams(data);
        }
      } catch {
        // fall back to localStorage
      }
    })();
    return () => { active = false; };
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    let active = true;
    (async () => {
      try {
        const { data } = await supabase
          .from("omnia_projects")
          .select("id, name, created_at, updated_at")
          .eq("user_id", user.id)
          .order("updated_at", { ascending: false });
        if (active && data) setUserProjects(data);
      } catch {}
    })();
    return () => { active = false; };
  }, [user?.id]);

  const filteredTeams = useMemo(() => {
    if (!searchQuery.trim()) return teams;
    const q = searchQuery.toLowerCase();
    return teams.filter(
      (t) =>
        t.name?.toLowerCase().includes(q) ||
        t.description?.toLowerCase().includes(q)
    );
  }, [teams, searchQuery]);

  const handleCreateOrEditTeam = async (data) => {
    const isEdit = !!data.id;

    if (isEdit) {
      setTeams((prev) => {
        const next = prev.map((t) =>
          t.id === data.id ? { ...t, name: data.name, description: data.description, updated_at: new Date().toISOString() } : t
        );
        saveLocalTeams(next);
        return next;
      });
      if (selectedTeam?.id === data.id) {
        setSelectedTeam((prev) => ({ ...prev, name: data.name, description: data.description }));
      }
      setModal(null);

      if (user?.id) {
        try {
          await supabase
            .from("team_spaces")
            .update({ name: data.name, description: data.description, updated_at: new Date().toISOString() })
            .eq("id", data.id)
            .eq("owner_id", user.id);
        } catch {}
      }
    } else {
      const newTeam = {
        id: crypto.randomUUID(),
        name: data.name,
        description: data.description,
        owner_id: user?.id || "local",
        owner_email: user?.email || "",
        members: user?.email ? [{ email: user.email, role: "owner", joined_at: new Date().toISOString() }] : [],
        boards: [],
        events: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      setTeams((prev) => {
        const next = [newTeam, ...prev];
        saveLocalTeams(next);
        return next;
      });
      setModal(null);

      if (user?.id) {
        try {
          await supabase.from("team_spaces").insert(newTeam);
        } catch {}
      }
    }
  };

  const handleDeleteTeam = async (teamId) => {
    setTeams((prev) => {
      const next = prev.filter((t) => t.id !== teamId);
      saveLocalTeams(next);
      return next;
    });
    setSelectedTeam(null);
    setModal(null);

    if (user?.id) {
      try {
        await supabase.from("team_spaces").delete().eq("id", teamId).eq("owner_id", user.id);
      } catch {}
    }
  };

  const handleInviteMembers = async (emails) => {
    const team = modal?.team;
    if (!team) return;

    const newMembers = emails.map((email) => ({
      email,
      role: "member",
      joined_at: new Date().toISOString(),
    }));

    setTeams((prev) => {
      const next = prev.map((t) => {
        if (t.id !== team.id) return t;
        const existingEmails = new Set((t.members || []).map((m) => (typeof m === "string" ? m : m.email)));
        const toAdd = newMembers.filter((m) => !existingEmails.has(m.email));
        return {
          ...t,
          members: [...(t.members || []), ...toAdd],
          updated_at: new Date().toISOString(),
        };
      });
      saveLocalTeams(next);
      return next;
    });

    if (selectedTeam?.id === team.id) {
      setSelectedTeam((prev) => {
        const existingEmails = new Set((prev.members || []).map((m) => (typeof m === "string" ? m : m.email)));
        const toAdd = newMembers.filter((m) => !existingEmails.has(m.email));
        return { ...prev, members: [...(prev.members || []), ...toAdd] };
      });
    }

    if (user?.id) {
      try {
        const updatedTeam = teams.find((t) => t.id === team.id);
        if (updatedTeam) {
          const existingEmails = new Set((updatedTeam.members || []).map((m) => (typeof m === "string" ? m : m.email)));
          const toAdd = newMembers.filter((m) => !existingEmails.has(m.email));
          await supabase
            .from("team_spaces")
            .update({ members: [...(updatedTeam.members || []), ...toAdd] })
            .eq("id", team.id)
            .eq("owner_id", user.id);
        }
      } catch {}
    }
  };

  const handleRemoveMember = async (teamId, email) => {
    setTeams((prev) => {
      const next = prev.map((t) => {
        if (t.id !== teamId) return t;
        return {
          ...t,
          members: (t.members || []).filter((m) => (typeof m === "string" ? m : m.email) !== email),
        };
      });
      saveLocalTeams(next);
      return next;
    });

    if (selectedTeam?.id === teamId) {
      setSelectedTeam((prev) => ({
        ...prev,
        members: (prev.members || []).filter((m) => (typeof m === "string" ? m : m.email) !== email),
      }));
    }

    if (user?.id) {
      try {
        const team = teams.find((t) => t.id === teamId);
        if (team) {
          const updated = (team.members || []).filter((m) => (typeof m === "string" ? m : m.email) !== email);
          await supabase.from("team_spaces").update({ members: updated }).eq("id", teamId).eq("owner_id", user.id);
        }
      } catch {}
    }
  };

  const handleCreateBoard = async (team) => {
    if (!user?.id) {
      signInWithOAuth("google");
      return;
    }

    try {
      const { data } = await supabase
        .from("omnia_boards")
        .insert({ user_id: user.id, title: `${team.name} Board` })
        .select("id, title, created_at")
        .single();

      if (data) {
        const newBoard = { id: data.id, title: data.title, created_at: data.created_at };
        setTeams((prev) => {
          const next = prev.map((t) => {
            if (t.id !== team.id) return t;
            return { ...t, boards: [...(t.boards || []), newBoard] };
          });
          saveLocalTeams(next);
          return next;
        });

        if (selectedTeam?.id === team.id) {
          setSelectedTeam((prev) => ({ ...prev, boards: [...(prev.boards || []), newBoard] }));
        }

        try {
          await supabase
            .from("team_spaces")
            .update({ boards: [...(team.boards || []), newBoard] })
            .eq("id", team.id)
            .eq("owner_id", user.id);
        } catch {}

        nav(`/canvas/${data.id}`);
      }
    } catch {
      // Fallback: just navigate to create a board
      const { data } = await supabase
        .from("omnia_boards")
        .insert({ user_id: user.id, title: "New Board" })
        .select("id")
        .single();
      if (data?.id) nav(`/canvas/${data.id}`);
    }
  };

  const handleCreateProject = async (team) => {
    if (!user?.id) {
      signInWithOAuth("google");
      return;
    }

    try {
      const { data } = await supabase
        .from("omnia_projects")
        .insert({ user_id: user.id, name: `${team.name} Project` })
        .select("id, name, created_at, updated_at")
        .single();

      if (data) {
        const newProject = { id: data.id, name: data.name, created_at: data.created_at, updated_at: data.updated_at };
        setTeams((prev) => {
          const next = prev.map((t) => {
            if (t.id !== team.id) return t;
            return { ...t, projects: [...(t.projects || []), newProject] };
          });
          saveLocalTeams(next);
          return next;
        });

        if (selectedTeam?.id === team.id) {
          setSelectedTeam((prev) => ({ ...prev, projects: [...(prev.projects || []), newProject] }));
        }

        try {
          await supabase
            .from("team_spaces")
            .update({ projects: [...(team.projects || []), newProject] })
            .eq("id", team.id)
            .eq("owner_id", user.id);
        } catch {}

        nav(`/project/${data.id}`);
      }
    } catch {
      const { data } = await supabase
        .from("omnia_projects")
        .insert({ user_id: user.id, name: "New Project" })
        .select("id")
        .single();
      if (data?.id) nav(`/project/${data.id}`);
    }
  };

  const handleLinkProjects = async (projectsToLink) => {
    const team = modal?.team;
    if (!team) return;

    const newEntries = projectsToLink.map((p) => ({
      id: p.id,
      name: p.name,
      created_at: p.created_at,
      updated_at: p.updated_at,
    }));

    setTeams((prev) => {
      const next = prev.map((t) => {
        if (t.id !== team.id) return t;
        const existingIds = new Set((t.projects || []).map((p) => p.id));
        const toAdd = newEntries.filter((p) => !existingIds.has(p.id));
        return { ...t, projects: [...(t.projects || []), ...toAdd], updated_at: new Date().toISOString() };
      });
      saveLocalTeams(next);
      return next;
    });

    if (selectedTeam?.id === team.id) {
      setSelectedTeam((prev) => {
        const existingIds = new Set((prev.projects || []).map((p) => p.id));
        const toAdd = newEntries.filter((p) => !existingIds.has(p.id));
        return { ...prev, projects: [...(prev.projects || []), ...toAdd] };
      });
    }

    if (user?.id) {
      try {
        const current = teams.find((t) => t.id === team.id);
        const existingIds = new Set((current?.projects || []).map((p) => p.id));
        const toAdd = newEntries.filter((p) => !existingIds.has(p.id));
        await supabase
          .from("team_spaces")
          .update({ projects: [...(current?.projects || []), ...toAdd] })
          .eq("id", team.id)
          .eq("owner_id", user.id);
      } catch {}
    }
  };

  const handleSelectTeam = (team) => {
    setSelectedTeam(team);
  };

  return (
    <div className="min-h-screen bg-transparent text-black relative overflow-x-hidden">
      {/* Top panel bar */}
      <div className="fixed top-3 left-0 right-0 z-[70] px-3 flex items-center justify-end pointer-events-none">
        <div className="pointer-events-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTopPanelOpen((v) => !v)}
            className="rounded-full w-8 h-8 glass-control hover:opacity-90 touch-manipulation flex items-center justify-center"
            title={topPanelOpen ? "Hide panel" : "Show panel"}
          >
            {topPanelOpen ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
          </button>

          {topPanelOpen && (
            <div className="flex h-9 items-center gap-2 p-1 rounded-full glass-control">
              <button
                type="button"
                onClick={() => setModal({ type: "create" })}
                className="flex items-center gap-1.5 text-[11px] font-medium px-3 py-1 rounded-full glass-control hover:opacity-90"
              >
                <Plus className="w-3 h-3" />
                New Team
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Main content */}
      <div className="relative z-20 flex flex-col pt-16 pb-4" style={{ height: "100vh" }}>
        {selectedTeam ? (
          <TeamDetail
            team={selectedTeam}
            onBack={() => setSelectedTeam(null)}
            onInvite={(t) => setModal({ type: "invite", team: t })}
            onEdit={(t) => setModal({ type: "edit", team: t })}
            onNavigateProject={(projectId) => nav(`/project/${projectId}`)}
            onNavigateCalendar={() => nav("/calendar")}
            onRemoveMember={handleRemoveMember}
            onCreateProject={handleCreateProject}
            onLinkProject={(t) => setModal({ type: "link-project", team: t })}
            onUpdateTeam={(updated) => {
              setSelectedTeam(updated);
              setTeams((prev) => {
                const next = prev.map((t) => (t.id === updated.id ? updated : t));
                saveLocalTeams(next);
                return next;
              });
            }}
          />
        ) : (
          <>
            {/* Page Header */}
            <div className="px-6 pb-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h1 className="text-2xl font-semibold text-black/85 dark:text-white/85">
                    Team Spaces
                  </h1>
                  <p className="text-[13px] text-black/45 dark:text-white/45 mt-0.5">
                    {teams.length} team{teams.length !== 1 ? "s" : ""} &middot; Collaborate with boards, calendars, and more
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0 pt-1">
                  <div className="flex items-center gap-2 rounded-xl border border-black/10 dark:border-white/10 bg-transparent px-2.5 py-1.5 text-[11px] text-black/60 dark:text-white/60">
                    <Search className="w-3.5 h-3.5" />
                    <input
                      type="text"
                      placeholder="Search teams..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-32 bg-transparent outline-none placeholder:text-black/35 dark:placeholder:text-white/35 text-black/70 dark:text-white/70 text-[11px]"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Teams Grid */}
            <div className="flex-1 overflow-y-auto px-6 pb-8">
              {teams.length === 0 ? (
                <div className="text-center py-20">
                  <div className="w-16 h-16 rounded-2xl bg-black/[0.04] dark:bg-white/[0.04] flex items-center justify-center mx-auto mb-4">
                    <Users className="w-7 h-7 text-black/20 dark:text-white/20" />
                  </div>
                  <h2 className="text-[15px] font-semibold text-black/60 dark:text-white/60 mb-1">
                    Create your first team
                  </h2>
                  <p className="text-[12px] text-black/35 dark:text-white/35 mb-5 max-w-sm mx-auto leading-relaxed">
                    Organize your work by creating teams. Invite members, share boards, and coordinate through shared calendars.
                  </p>
                  <button
                    type="button"
                    onClick={() => setModal({ type: "create" })}
                    className="inline-flex items-center gap-1.5 text-[12px] font-medium px-5 py-2.5 rounded-full glass-control hover:opacity-90 transition-all"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Create Team
                  </button>
                </div>
              ) : filteredTeams.length === 0 ? (
                <div className="text-center py-20">
                  <div className="w-16 h-16 rounded-2xl bg-black/[0.04] dark:bg-white/[0.04] flex items-center justify-center mx-auto mb-4">
                    <Users className="w-7 h-7 text-black/20 dark:text-white/20" />
                  </div>
                  <h2 className="text-[15px] font-semibold text-black/60 dark:text-white/60 mb-1">
                    No matching teams
                  </h2>
                  <p className="text-[12px] text-black/35 dark:text-white/35">
                    Try adjusting your search query
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  <button
                    type="button"
                    onClick={() => setModal({ type: "create" })}
                    className="rounded-2xl border-2 border-dashed border-black/[0.08] dark:border-white/[0.08] hover:border-black/[0.16] dark:hover:border-white/[0.16] transition-all p-4 flex flex-col items-center justify-center gap-2 min-h-[160px]"
                  >
                    <div className="w-10 h-10 rounded-xl bg-black/[0.04] dark:bg-white/[0.04] flex items-center justify-center">
                      <Plus className="w-5 h-5 text-black/25 dark:text-white/25" />
                    </div>
                    <span className="text-[11px] text-black/40 dark:text-white/40 font-medium">New Team</span>
                  </button>
                  {filteredTeams.map((team, i) => (
                    <TeamCard
                      key={team.id || i}
                      team={team}
                      index={i}
                      onClick={handleSelectTeam}
                      onInvite={(t) => setModal({ type: "invite", team: t })}
                      onEdit={(t) => setModal({ type: "edit", team: t })}
                      onDelete={(t) => setModal({ type: "delete", team: t })}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Modals */}
      {modal?.type === "create" && (
        <TeamModal
          onClose={() => setModal(null)}
          onSave={handleCreateOrEditTeam}
        />
      )}
      {modal?.type === "edit" && (
        <TeamModal
          team={modal.team}
          onClose={() => setModal(null)}
          onSave={handleCreateOrEditTeam}
        />
      )}
      {modal?.type === "invite" && (
        <InviteModal
          team={modal.team}
          onClose={() => setModal(null)}
          onInvite={handleInviteMembers}
        />
      )}
      {modal?.type === "delete" && (
        <DeleteConfirmModal
          team={modal.team}
          onClose={() => setModal(null)}
          onConfirm={() => handleDeleteTeam(modal.team.id)}
        />
      )}
      {modal?.type === "link-project" && (
        <LinkProjectModal
          team={modal.team}
          existingProjects={userProjects}
          linkedIds={(modal.team?.projects || []).map((p) => p.id)}
          onClose={() => setModal(null)}
          onLink={handleLinkProjects}
        />
      )}
    </div>
  );
}
