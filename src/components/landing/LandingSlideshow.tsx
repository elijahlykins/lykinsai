import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  CalendarDays,
  FileText,
  Folder,
  FolderKanban,
  Inbox,
  ListTodo,
  Search,
} from "lucide-react";
import BotAvatar, { BotMark } from "@/components/bots/BotAvatar";
import BrowserMark from "@/components/macdesktop/BrowserMark";
import { LyknWordmark } from "@/components/landing/LyknWordmark";
import { CalendarTile, MonthTile } from "@/components/landing/DesktopHomePreview";
import slideGlass from "@/assets/slide-glass-blue.jpg";

/** "Sync with Mac": the synced Desktop folder as a mini Finder-ish window.
    Also the Sync feature page's demo, framed over the same blue glass. */
export function SyncVisual() {
  return (
    <div className="ls-vis-panel ls-vis-sync">
      <div className="ls-vis-titlebar">
        <span className="ls-vis-dots">
          <i />
          <i />
          <i />
        </span>
        <span className="ls-vis-titlebar-label">Desktop</span>
      </div>
      <div className="ls-vis-folders">
        {["Files", "Screenshots", "Projects", "Vault", "Marketing", "LYKN"].map(
          (label) => (
            <span key={label} className="ls-vis-folder">
              <Folder strokeWidth={1} fill="currentColor" />
              <em>{label}</em>
            </span>
          ),
        )}
      </div>
      <div className="ls-vis-chip">
        <FileText />
        <span>Q3-report.pdf</span>
        <em>saved to disk</em>
      </div>
    </div>
  );
}

/** "Fully customize desktop": the Home widgets and the dock. */
function CustomizeVisual() {
  return (
    <div className="ls-vis-customize">
      <div className="ls-vis-widgets">
        <CalendarTile />
        <MonthTile />
      </div>
      <div className="ls-vis-dock">
        <span>
          <BrowserMark className="h-5 w-5" />
        </span>
        <span>
          <BotMark className="h-5 w-5" />
        </span>
        <span>
          <FolderKanban className="h-5 w-5" />
        </span>
        <span>
          <Folder className="h-5 w-5" />
        </span>
        <span>
          <CalendarDays className="h-5 w-5" />
        </span>
        <span>
          <ListTodo className="h-5 w-5" />
        </span>
      </div>
    </div>
  );
}

/** "Create agents": a roster of real bot characters, each with its own
    shape, eyes, color, and signature move. Also the Agents feature page's
    demo, framed over the same blue glass wallpaper. */
export function AgentsVisual() {
  return (
    <div className="ls-vis-panel ls-vis-agents">
      <div className="ls-vis-agent">
        <span className="ls-vis-agent-mark">
          <BotAvatar
            face="squircle"
            eyes="dot"
            color="sky"
            size={44}
            seed={11}
            quirk="wobble"
          />
        </span>
        <span className="ls-vis-agent-copy">
          <strong>Inbox agent</strong>
          <em>
            <Inbox /> Watching mail · 3 drafts ready
          </em>
        </span>
        <i className="ls-vis-live" />
      </div>
      <div className="ls-vis-agent">
        <span className="ls-vis-agent-mark">
          <BotAvatar
            face="circle"
            eyes="visor"
            color="teal"
            size={44}
            seed={23}
            quirk="spin"
          />
        </span>
        <span className="ls-vis-agent-copy">
          <strong>Research agent</strong>
          <em>
            <Search /> Reading 12 sources
          </em>
        </span>
        <i className="ls-vis-live" />
      </div>
      <div className="ls-vis-agent">
        <span className="ls-vis-agent-mark">
          <BotAvatar
            face="blob"
            eyes="arc"
            color="orange"
            size={44}
            seed={37}
            quirk="hop"
          />
        </span>
        <span className="ls-vis-agent-copy">
          <strong>Ops routine</strong>
          <em>
            <CalendarDays /> Runs weekdays · 9:00 AM
          </em>
        </span>
        <i className="ls-vis-live is-idle" />
      </div>
    </div>
  );
}

const SLIDES = [
  {
    id: "sync",
    title: "Sync with Mac",
    body: "Your real Desktop folder, Finder files, and wallpaper show up on Home. Drop a file there and it lands on disk. Ask about it from the same chat bar.",
    Visual: SyncVisual,
  },
  {
    id: "customize",
    title: "Fully customize desktop",
    body: "Wallpaper, widgets, folders, and the dock are yours. Make Home look like your Mac, then keep working from the same bar.",
    Visual: CustomizeVisual,
  },
  {
    id: "agents",
    title: "Create agents",
    body: "Spin up a teammate for a job: research, inbox, or a repeating workflow. It keeps context and works from the same desktop.",
    Visual: AgentsVisual,
  },
] as const;

/** Dwell/fade windows across the pin: each page holds, then dissolves. */
const FADE_1: readonly [number, number] = [0.18, 0.44];
const FADE_2: readonly [number, number] = [0.56, 0.82];

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Three full-page glass slides. Each page dwells, then fades out to reveal
 * the next full-bleed page sitting beneath it.
 */
export default function LandingSlideshow() {
  const pinRef = useRef<HTMLElement>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const el = pinRef.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const rect = el.getBoundingClientRect();
      const total = Math.max(1, el.offsetHeight - window.innerHeight);
      setProgress(Math.min(1, Math.max(0, -rect.top / total)));
      const vh = Math.max(1, window.innerHeight);
      const merge = rect.top <= 0 ? 0 : Math.min(1, rect.top / (vh * 0.55));
      el.style.setProperty("--ls-merge", merge.toFixed(3));
    };
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  let from = 0;
  let t = 0;
  if (progress >= FADE_2[1]) {
    from = 2;
  } else if (progress >= FADE_2[0]) {
    from = 1;
    t = (progress - FADE_2[0]) / (FADE_2[1] - FADE_2[0]);
  } else if (progress >= FADE_1[1]) {
    from = 1;
  } else if (progress >= FADE_1[0]) {
    from = 0;
    t = (progress - FADE_1[0]) / (FADE_1[1] - FADE_1[0]);
  }

  return (
    <section
      ref={pinRef}
      className="ls-pin"
      aria-label="LYKN desktop"
    >
      <div className="ls-sticky" data-header-tone="dark">
        {SLIDES.map((slide, i) => {
          let opacity = 1;
          // The outgoing copy drops out ahead of the background dissolve so
          // the two headlines never read on top of each other.
          let copy = 1;
          let z = 1;

          if (i < from) {
            opacity = 0;
            z = 1;
          } else if (i === from) {
            opacity = 1 - easeInOutCubic(t);
            copy = 1 - easeInOutCubic(Math.min(1, t / 0.45));
            z = 3;
          } else if (i === from + 1) {
            z = 2;
          } else {
            opacity = 0;
            z = 0;
          }

          return (
            <article
              key={slide.id}
              className={`ls-slide is-${slide.id}`}
              style={
                {
                  opacity: Number(opacity.toFixed(3)),
                  zIndex: z,
                  "--ls-copy": copy.toFixed(3),
                } as CSSProperties
              }
              aria-hidden={opacity < 0.2}
            >
              <img className="ls-slide-wall" src={slideGlass} alt="" draggable={false} />
              <div className="ls-slide-inner gl-reveal is-in">
                <div className="ls-copy">
                  <p className="ls-kicker">
                    <LyknWordmark decorative /> desktop
                  </p>
                  <h2 className="ls-title">{slide.title}</h2>
                  <p className="ls-body">{slide.body}</p>
                </div>
                <div className="ls-vis" aria-hidden="true">
                  <slide.Visual />
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
