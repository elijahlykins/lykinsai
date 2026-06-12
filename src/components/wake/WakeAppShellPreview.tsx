import {
  Blocks,
  Brain,
  CalendarDays,
  MessageCircle,
  Plug,
  SquarePen,
} from "lucide-react";
import lyknIcon from "@/assets/FINAL/LYKN-ICON-B-Open/PNGs/LYKN-Icon-B-Open-NEUTRAL-web.png";
import WakeChatTourPreview from "@/components/wake/WakeChatTourPreview";

// A non-interactive recreation of the real app shell — the collapsed sidebar
// icon rail plus the live chat surface — used as the marketing "this is the
// product" preview. The actual <AppSidebar /> is fixed-position and data-bound
// to a signed-in session, so it can't be embedded in a scaled preview card;
// this mirrors its collapsed layout and styling while staying self-contained.

const RAIL_ITEMS = [
  { icon: SquarePen, label: "New chat", active: false },
  { icon: MessageCircle, label: "Chat", active: true },
  { icon: Plug, label: "Vault", active: false },
  { icon: CalendarDays, label: "Calendar / To-do", active: false },
  { icon: Brain, label: "Synthesis Layer", active: false },
  { icon: Blocks, label: "Model builder", active: false },
];

export default function WakeAppShellPreview({ active = true }: { active?: boolean }) {
  return (
    <div className="lkn-shell-preview">
      <aside className="lkn-shell-rail">
        <div className="lkn-shell-rail-brand">
          <img src={lyknIcon} alt="" className="lkn-shell-rail-icon" />
        </div>

        <nav className="lkn-shell-rail-nav">
          {RAIL_ITEMS.map(({ icon: Icon, label, active: isActive }) => (
            <div
              key={label}
              className={`lkn-shell-rail-item ${isActive ? "is-active" : ""}`}
              title={label}
            >
              <Icon className="lkn-shell-icon" />
            </div>
          ))}
        </nav>

        <div className="lkn-shell-rail-spacer" />

        <div className="lkn-shell-rail-account">
          <span className="lkn-shell-avatar">Y</span>
        </div>
      </aside>

      <div className="lkn-shell-main">
        <WakeChatTourPreview active={active} />
      </div>
    </div>
  );
}
