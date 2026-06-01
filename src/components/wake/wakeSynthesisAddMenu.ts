import type { LucideIcon } from "lucide-react";
import {
  Atom,
  Brain,
  FolderPlus,
  LayoutGrid,
  Link2,
  Sparkles,
  StickyNote,
} from "lucide-react";

export type WakeAddMenuKey =
  | "belief"
  | "fact"
  | "concept"
  | "vault"
  | "chat"
  | "link"
  | "project";

export interface WakeAddMenuItem {
  key: WakeAddMenuKey;
  label: string;
  blurb: string;
  Icon: LucideIcon;
  divider: boolean;
}

/** Mirrors the synthesis-layer "+" menu — preview-only on the wake slide. */
export const WAKE_SYNTHESIS_ADD_MENU: WakeAddMenuItem[] = [
  {
    key: "belief",
    label: "Beliefs",
    blurb: "A core belief or principle that shapes every reply.",
    Icon: Atom,
    divider: false,
  },
  {
    key: "fact",
    label: "Fact",
    blurb: "A single fact about you the AI should remember.",
    Icon: Brain,
    divider: false,
  },
  {
    key: "concept",
    label: "Concept",
    blurb: "A theme that ties your ideas together.",
    Icon: Sparkles,
    divider: false,
  },
  {
    key: "vault",
    label: "Vault",
    blurb: "Save a note, file, or link.",
    Icon: StickyNote,
    divider: false,
  },
  {
    key: "chat",
    label: "Chat",
    blurb: "Start a new conversation with LYKN.",
    Icon: LayoutGrid,
    divider: true,
  },
  {
    key: "link",
    label: "Link neurons",
    blurb: "Connect two or more neurons together.",
    Icon: Link2,
    divider: false,
  },
  {
    key: "project",
    label: "Create project",
    blurb: "Cluster neurons into a project the AI can see.",
    Icon: FolderPlus,
    divider: false,
  },
];

export const WAKE_WALKTHROUGH_GATE_TEXT =
  "Finish the walkthrough to start building.";

/** Menu entries that open the walkthrough gate instead of building. */
export const WAKE_WALKTHROUGH_GATED_KEYS = new Set<WakeAddMenuKey>([
  "belief",
  "fact",
  "concept",
  "link",
  "project",
]);
