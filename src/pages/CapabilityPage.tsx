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
      "LYKN desktop is Home on your Mac. The chat bar sits on your wallpaper, your Desktop folder is right there, and Finder files open in place.",
    body:
      "Sync with Mac keeps your real Desktop, folders, and wallpaper inside LYKN. Ask about a file from the same bar you use to chat, build, research, or imagine. Glass is still one shortcut away when you need LYKN over another app.",
    demo: CapDesktopLive,
  },
  glass: {
    name: "Glass",
    headline: "AI on every\nscreen you use.",
    lede: `Press ${HOTKEY} and LYKN Glass appears over whatever you're working on. It reads the page, answers in place, and gets out of your way.`,
    body: `No copy-paste and no context switching. Summon Glass over a doc, design tool, spreadsheet, or browser tab and talk about what's in front of you. When you're done, it collapses so your work stays front and center.`,
    demo: CapGlassDemo,
  },
  chat: {
    name: "Chat",
    headline: "Chat that already knows the context.",
    lede:
      "Summon LYKN over whatever you're working on and just ask. It reads the screen, remembers your projects, and answers like it's been in the room the whole time.",
    body:
      "Chat can schedule events, draft emails, update boards, and save notes mid-conversation, and the same thread stays with you across the overlay and the desktop.",
    demo: CapChatDemo,
  },
  build: {
    name: "Build",
    headline: "Describe it. Watch it get built.",
    lede:
      "Build mode turns a sentence into working software: dashboards, presentations, reports, and apps written out live in front of you.",
    body:
      "Ask for a deck or a dashboard and LYKN writes the real thing: live code, real components, styled and interactive. Refine in plain English, and keep every artifact you ship.",
    demo: CapBuildDemo,
  },
  imagine: {
    name: "Imagine",
    headline: "Your ideas,\nrendered on\u2011brand.",
    lede:
      "Generate ads, product shots, and art that already match your brand, or point LYKN at an image you like and make it yours.",
    body:
      "LYKN is an editor as well as a generator. It produces four images at a time so you can pick a direction, then make individual edits on any one of them: lighting, mood, crop, or format, all in the same thread.",
    demo: CapImagineDemo,
  },
  voice: {
    name: "Voice",
    headline: "Talk to your AI like a teammate.",
    lede:
      "Voice mode is a real-time conversation. Think out loud, get answers back instantly, and keep your hands on your work.",
    body:
      "No push-to-talk and no waiting for a transcript. Interrupt, redirect, or change your mind mid-sentence. Voice shares the same memory and projects as Chat.",
    demo: CapVoiceDemo,
  },
  research: {
    name: "Research",
    headline: "Give a topic.\nGet a real report.",
    lede:
      "Research mode digs into current sources and writes a structured report you can cite, refine, and turn into the next artifact.",
    body:
      "Findings land as takeaways, debates, and citations, not a wall of text. Follow the sources, hand them to Browser, or extend the same report with a follow-up.",
    demo: CapResearchCard,
  },
  browser: {
    name: "Browser",
    headline: "A browser that\nworks with you.",
    lede:
      "LYKN Browser is an agent that opens pages, extracts what matters, and acts on the web on your desktop, not a tab you babysit.",
    body:
      "Ask it to navigate, pull pricing, fill forms, or save rows back to your work. It docks beside chat, and closed sessions land in history like a real browser.",
    demo: CapBrowserLive,
  },
  agents: {
    name: "Agents",
    headline: "AI teammates,\nalways on the job.",
    lede:
      "Spin up an agent for a job - inbox triage, research, or a repeating workflow - and it gets to work from your desktop with your context.",
    body:
      "Each agent is a real teammate with its own character, memory, and skills. Message it like a coworker, hand it routines that run on a schedule, and check its progress right from the dock.",
    demo: CapAgentsDemo,
  },
  sync: {
    name: "Sync with Mac",
    headline: "Your files,\nright where you left them.",
    lede:
      "Your real Desktop folder, Finder files, and wallpaper show up on Home. Drop a file there and it lands on disk.",
    body:
      "No importing and no second copy of your life. LYKN reads the same folders your Mac does, so you can ask about any file from the same bar you use to chat, build, research, or imagine.",
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
