import {
  Circle,
  Code,
  FileText,
  Film,
  Folder,
  Globe,
  Image,
  LayoutTemplate,
  Lightbulb,
  Plug,
  Search,
} from "lucide-react";
import {
  collapseThinkingSteps,
  type ThinkingActivityKind,
} from "@/lib/lyknChat/thinkingActivity";

const STEP_ICONS: Record<ThinkingActivityKind, typeof Search> = {
  search: Search,
  read: Globe,
  research: Lightbulb,
  build: LayoutTemplate,
  image: Image,
  write: FileText,
  code: Code,
  files: Folder,
  video: Film,
  connect: Plug,
  other: Circle,
};

interface VoiceActivityStatusProps {
  live: string;
  trail?: string[];
}

/**
 * Compact activity log under the Voice orb: completed tool hops plus the live
 * shimmer line, so searching / reading / building is visible while audio waits.
 */
export default function VoiceActivityStatus({ live, trail = [] }: VoiceActivityStatusProps) {
  const steps = collapseThinkingSteps(trail, live);
  if (!steps.length) return null;

  return (
    <ul
      className="lykn-thinking lykn-thinking--compact lykn-thinking--steps lykn-mark-inherit lykn-voice-activity"
      aria-label="What the voice agent is doing"
    >
      {steps.map((step, i) => {
        const Icon = STEP_ICONS[step.kind] || Circle;
        return (
          <li
            key={`${step.kind}-${i}-${step.label}`}
            className={`lykn-thinking__row lykn-thinking__step${
              step.live ? " lykn-thinking__step--live" : ""
            }`}
          >
            <span className="lykn-thinking__mark">
              <Icon size={12} strokeWidth={1.75} aria-hidden className="lykn-thinking__glyph" />
            </span>
            <span className={`lykn-thinking__label${step.live ? " lykn-chat-thinking-text" : ""}`}>
              {step.label}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
