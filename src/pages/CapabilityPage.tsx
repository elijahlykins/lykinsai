import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import LandingHeader from "@/components/landing/LandingHeader";
import { LyknWordmark } from "@/components/landing/LyknWordmark";
import { SiteFooter } from "./GlassLanding";
import {
  CapBuildDemo,
  CapChatDemo,
  CapImagineDemo,
  CapResearchCard,
  CapVoiceDemo,
} from "@/components/landing/LandingCapabilities";
import { CapGlassDemo } from "@/components/landing/CapResearchBrowserDemos";
import HeroDesktopStage from "@/components/landing/HeroDesktopStage";
import { AgentsVisual, SyncVisual } from "@/components/landing/LandingSlideshow";
import { useLandingLightTheme } from "@/components/landing/useLandingLightTheme";
import slideGlass from "@/assets/slide-glass-blue.jpg";
import { desktopHotkeyLabel } from "@/lib/desktopHotkey";
import "./GlassLanding.css";
import "@/components/landing/landingIcy.css";
import "./CapabilityPage.css";

const HOTKEY = desktopHotkeyLabel();

type CapId =
  | "glass"
  | "desktop"
  | "chat"
  | "build"
  | "imagine"
  | "voice"
  | "research"
  | "browser"
  | "agents"
  | "sync";

/** The hero's live desktop render — the Desktop page's demo. */
function CapDesktopLive() {
  return (
    <div className="cappg-desk" aria-hidden="true">
      <HeroDesktopStage />
    </div>
  );
}

/** The live desktop with the browser window popped up, same as the home
    page's Browser tab. */
function CapBrowserLive() {
  return (
    <div className="cappg-desk" aria-hidden="true">
      <HeroDesktopStage appWindow="browser" />
    </div>
  );
}

/** A slideshow visual (agents roster, sync window) framed over the blurred
    blue glass wallpaper, like the Voice card. */
function CapSlideVisual({ children }: { children: JSX.Element }) {
  return (
    <div className="cappg-slide" aria-hidden="true">
      <img
        className="cappg-slide-wall"
        src={slideGlass}
        alt=""
        draggable={false}
      />
      {children}
    </div>
  );
}

function CapAgentsDemo() {
  return (
    <CapSlideVisual>
      <AgentsVisual />
    </CapSlideVisual>
  );
}

function CapSyncDemo() {
  return (
    <CapSlideVisual>
      <SyncVisual />
    </CapSlideVisual>
  );
}

interface CapContent {
  name: string;
  headline: string;
  /** Opening paragraph under the headline. */
  lede: string;
  /** Second short paragraph of explanation. */
  body: string;
  demo: () => JSX.Element;
}

/** Copy + live demo for each capability page (/product/:capId). */
const CAPS: Record<CapId, CapContent> = {
  desktop: {
    name: "Desktop",
    headline: "Your Mac,\nalready in sync.",
    lede:
      "LYKN desktop is Home on your Mac. The chat bar sits on your wallpaper, your Desktop folder is right there, and Finder files open in place. Chat, Build, Imagine, Research, and Browser all live here, with your files already in the picture.",
    body:
      "Sync with Mac keeps the real folders you choose inside LYKN, not a second copy of your life. Ask about a file from the same bar you use to build or research. Glass is one shortcut away when you need LYKN over another app.",
    demo: CapDesktopLive,
  },
  glass: {
    name: "Glass",
    headline: "AI on every\nscreen you use.",
    lede: `Press ${HOTKEY} and LYKN Glass appears over whatever you're working on. It reads the page in front of you, answers in place, and gets out of the way. Chat, build, research, or talk without leaving the app you were already in.`,
    body: "No copy-paste and no context switching. Summon it over a doc, a design tool, a spreadsheet, or a browser tab. When you're done, it collapses so your work stays front and center.",
    demo: CapGlassDemo,
  },
  chat: {
    name: "Chat",
    headline: "Ask anything.\nConnect your tools.",
    lede:
      "Chat is the everyday conversation in LYKN. Ask a question, plan a project, or tell it to act, with your memory and files already in the thread. Connect Gmail, Slack, Notion, GitHub, and the rest of your stack, then just say what you need.",
    body:
      "Pick any model, or let LYKN route for you. Chat can search the web, work through the apps you connect, save what matters, and keep the same thread on your desktop. When the job needs software, images, or a deep report, switch modes without starting over.",
    demo: CapChatDemo,
  },
  build: {
    name: "Build",
    headline: "You describe it.\nLYKN builds the rest.",
    lede:
      "Build takes on the complex work: full apps, refactors, and the multi-file changes you would rather not babysit. LYKN routes every model. Just pick the one you want to use.",
    body:
      "LYKN writes the code, runs it, and keeps going until it works. Every project lives on your device. If you want it pushed, just say the word.",
    demo: CapBuildDemo,
  },
  imagine: {
    name: "Imagine",
    headline: "Any image model.\nThe best video models.",
    lede:
      "Imagine generates from the models you pick, not a single locked pipeline. Choose any image model for stills, or switch to video and run the best video generators available. Four images land at a time so you can pick a direction, then edit in the same thread.",
    body:
      "Bring a reference image and make it yours, or start from a sentence. Lighting, mood, crop, and format are follow-ups, not a new tool. For video, LYKN uses models built for motion.",
    demo: CapImagineDemo,
  },
  voice: {
    name: "Voice",
    headline: "Talk to LYKN\nlike a teammate.",
    lede:
      "Voice is a live conversation, not a dictation box. Think out loud, interrupt, redirect, and keep your hands on the work. It shares memory, projects, and connected tools with Chat, so you can look something up or take an action without typing.",
    body:
      "No push-to-talk and no waiting for a transcript. Change your mind mid-sentence. Use it at the desktop, or from Glass when you need to talk over another app.",
    demo: CapVoiceDemo,
  },
  research: {
    name: "Research",
    headline: "Give a topic.\nGet a real report.",
    lede:
      "Research does the long version of a search. You pick the sources it should draw from: the open web, academic papers, news, social, or markets. LYKN plans the questions, reads the pages, and writes a structured report you can actually cite.",
    body:
      "Findings land as takeaways, disagreements, and linked sources, not a wall of text. Save the report, open a citation, or keep asking to extend the same brief.",
    demo: CapResearchCard,
  },
  browser: {
    name: "Browser",
    headline: "A browser that\nworks with you.",
    lede:
      "LYKN Browser is an agent that opens real pages, clicks through them, and pulls out what matters while you watch. Ask it to collect pricing, fill a form, or walk a site, and it works the web the way you would.",
    body:
      "It docks beside chat so you can keep asking while it browses. Closed sessions land in history, ready to reopen like a real browser.",
    demo: CapBrowserLive,
  },
  agents: {
    name: "Agents",
    headline: "AI teammates,\nalways on the job.",
    lede:
      "Agents are standing teammates, not one-off chats. Give one a name, a role, and a job, then message it like a coworker. It can research, browse, use your connected apps, and keep working from the desktop while you do something else.",
    body:
      "Each agent lives in the dock with its own character, memory, and skills. Check in, hand it the next job, or pick up where it left off. You stay in charge of anything that sends, deletes, or shares.",
    demo: CapAgentsDemo,
  },
  sync: {
    name: "Sync with Mac",
    headline: "Your files,\nright where you left them.",
    lede:
      "Your real Desktop folder, the folders you choose, and your wallpaper show up on Home. Drop a file there and it lands on disk. LYKN is looking at the same files your Mac already has, not an uploaded copy.",
    body:
      "No importing and no duplicate library. Pick which folders to share, change them anytime, and ask about any of them from Chat, Build, or Research.",
    demo: CapSyncDemo,
  },
};

const CAP_ORDER: CapId[] = [
  "chat",
  "build",
  "imagine",
  "voice",
  "research",
  "browser",
  "agents",
  "sync",
  "desktop",
];

const DARK_DEMOS = new Set<CapId>([
  "build",
  "imagine",
  "browser",
  "agents",
  "glass",
  "desktop",
  "sync",
]);

export default function CapabilityPage() {
  const navigate = useNavigate();
  const { capId: rawCapId } = useParams();
  const capId = String(rawCapId || "")
    .trim()
    .toLowerCase()
    .replace(/^studio$/, "desktop") as CapId;
  const cap = Object.prototype.hasOwnProperty.call(CAPS, capId)
    ? CAPS[capId]
    : null;

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [capId]);

  useLandingLightTheme();

  if (!cap) {
    return (
      <div className="glass-land cappg">
        <LandingHeader onBrandClick={() => navigate("/")} />
        <main className="cappg-main">
          <h1 className="cappg-headline">Product not found</h1>
          <p className="cappg-lede">
            No page for &ldquo;{rawCapId || "unknown"}&rdquo;. Try{" "}
            {CAP_ORDER.map((id) => CAPS[id].name).join(", ")}.
          </p>
          <div className="cappg-ctas">
            <button
              type="button"
              className="lkn-nav-signup"
              onClick={() => navigate("/product/chat")}
            >
              Open Chat
            </button>
          </div>
        </main>
        <SiteFooter />
      </div>
    );
  }

  const Demo = cap.demo;

  return (
    <div className="glass-land cappg">
      <LandingHeader onBrandClick={() => navigate("/")} />

      <main className="cappg-main">
        <div className="cappg-grid">
          <div className="cappg-copy">
            <p className="cappg-kicker">{cap.name}</p>
            <h1
              className={`cappg-headline${
                cap.headline.includes("\n") ? " cappg-headline--manual" : ""
              }`}
            >
              {cap.headline}
            </h1>
            <p className="cappg-lede">{cap.lede}</p>
            <p className="cappg-body">{cap.body}</p>
            <div className="cappg-ctas">
              <button
                type="button"
                className="lkn-nav-signup"
                onClick={() => navigate("/download")}
                aria-label="Download LYKN"
              >
                Download <LyknWordmark decorative />
              </button>
            </div>
          </div>

          <div className="cappg-visual">
            <div
              className={`cappg-stage${
                DARK_DEMOS.has(capId) ? " is-dark" : ""
              }`}
              data-header-tone={DARK_DEMOS.has(capId) ? "dark" : undefined}
            >
              <Demo key={capId} />
            </div>
          </div>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
