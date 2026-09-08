import { useState } from "react";
import HeroDesktopStage from "@/components/landing/HeroDesktopStage";
import { AgentsVisual } from "@/components/landing/LandingSlideshow";
import { CapBuildDemo } from "@/components/landing/LandingCapabilities";
import { CapGlassDemo } from "@/components/landing/CapResearchBrowserDemos";
import { desktopHotkeyLabel } from "@/lib/desktopHotkey";
import slideGlass from "@/assets/slide-glass-blue.jpg";

// What lives on the LYKN desktop. One expands at a time (numbered
// accordion, reference: the "01 Desktop / 02 CLI" surfaces list).
const APPS = [
  {
    id: "browser",
    name: "Browser",
    desc: "An AI-first browser built into your desktop. Search from a new tab, or hand it research, forms, and errands and let it work the web on its own.",
    alt: "The LYKN browser pulled up on the desktop with AI search on a new tab",
  },
  {
    id: "agents",
    name: "Agents",
    desc: "Purpose-built AI agents that live on your desktop, ready to chat, run tools, and act with your projects and files already in context.",
    alt: "A roster of LYKN agents working on inbox, research, and ops",
  },
  {
    id: "projects",
    name: "Projects",
    desc: "Every project, its files, and its open tasks in one place. LYKN knows what's done, what's due, and what to nudge forward next.",
    alt: "The LYKN desktop Home, where projects, files, and widgets live",
  },
  {
    id: "context",
    name: "Context",
    desc: "LYKN already knows your files, projects, and what's on your screen. Switch between Chat, Build, Imagine, and Research - your context rides along, no re-explaining.",
    alt: "The LYKN desktop switching between Chat, Build, Imagine, and Research",
  },
  {
    id: "custom-apps",
    name: "Custom apps",
    desc: "Describe the tool you wish existed and LYKN builds it - a real app that runs on your desktop, iterated with you until it feels right.",
    alt: "LYKN Build writing and editing a project from a prompt",
  },
  {
    id: "glass",
    name: "Glass",
    desc: `Press ${desktopHotkeyLabel()} and LYKN Glass appears over whatever you're working on. It reads the page, snips the part you care about, and acts on it.`,
    alt: "LYKN Glass appearing over the screen and answering about it",
  },
] as const;

type AppId = (typeof APPS)[number]["id"];

function SlideFrame({ children }: { children: JSX.Element }) {
  return (
    <div className="gl-apps-slide">
      <img
        className="gl-apps-slide-wall"
        src={slideGlass}
        alt=""
        draggable={false}
      />
      {children}
    </div>
  );
}

/** The existing marketing demo for whichever row is open. */
function AppsStage({ id }: { id: AppId }) {
  switch (id) {
    case "browser":
      return <HeroDesktopStage appWindow="browser" />;
    case "agents":
      return (
        <SlideFrame>
          <AgentsVisual />
        </SlideFrame>
      );
    case "projects":
      return <HeroDesktopStage />;
    case "context":
      return (
        <HeroDesktopStage
          cycleModes={["chat", "build", "imagine", "research"]}
          prompt="Use my codebase for this"
        />
      );
    case "custom-apps":
      return <CapBuildDemo />;
    case "glass":
      return <CapGlassDemo />;
  }
}

/** Desktop apps tour: numbered accordion on the left, the matching live
    demo on the right (the same animations as the feature pages). */
export default function LandingDesktopApps() {
  const [open, setOpen] = useState<AppId>(APPS[0].id);
  const active = APPS.find((app) => app.id === open) ?? APPS[0];

  return (
    <section className="gl-apps" aria-label="The apps on the LYKN desktop">
      <div className="gl-apps-inner">
        <ol className="gl-apps-list gl-reveal">
          {APPS.map((app, i) => {
            const expanded = app.id === open;
            return (
              <li
                key={app.id}
                className={`gl-apps-item${expanded ? " is-open" : ""}`}
              >
                <button
                  type="button"
                  className="gl-apps-row"
                  aria-expanded={expanded}
                  onClick={() => setOpen(app.id)}
                >
                  <span className="gl-apps-num" aria-hidden="true">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="gl-apps-name">{app.name}</span>
                </button>
                <div className="gl-apps-desc-wrap">
                  <p className="gl-apps-desc">{app.desc}</p>
                </div>
              </li>
            );
          })}
        </ol>

        <div className="gl-apps-stage gl-reveal">
          <div
            key={active.id}
            className="gl-apps-live"
            data-header-tone="dark"
            role="img"
            aria-label={active.alt}
          >
            <AppsStage id={active.id} />
          </div>
        </div>
      </div>
    </section>
  );
}
