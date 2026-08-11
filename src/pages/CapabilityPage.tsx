import { useEffect } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import LandingHeader from "@/components/landing/LandingHeader";
import GlassBackdrop from "@/components/landing/GlassBackdrop";
import WakeVoiceTourPreview from "@/components/wake/WakeVoiceTourPreview";
import WakePreviewFit from "@/components/wake/WakePreviewFit";
import {
  CapBuildDemo,
  CapChatDemo,
  CapImagineDemo,
  SiteFooter,
} from "./GlassLanding";
import {
  CapBrowserDemo,
  CapDriveDemo,
  CapGlassDemo,
  CapResearchDemo,
} from "@/components/landing/CapResearchBrowserDemos";
import { desktopHotkeyLabel } from "@/lib/desktopHotkey";
import "./GlassLanding.css";
import "./CapabilityPage.css";

const HOTKEY = desktopHotkeyLabel();

const GRAD_TEXT_SELECTORS = [".cappg .cappg-headline"];
const MIX_TEXT_SELECTORS = [
  ".cappg .cappg-lede",
  ".cappg .cappg-body",
  ".cappg .cappg-more-label",
  ".cappg .gl-footer-tagline",
  ".cappg .gl-footer-col-title",
  ".cappg .gl-footer-link",
  ".cappg .gl-footer-bottom",
];

type CapId =
  | "glass"
  | "chat"
  | "build"
  | "imagine"
  | "voice"
  | "research"
  | "browser"
  | "drive";

/** The Voice page's demo: the full walkthrough preview with the "Hear it"
    toggle. Wrapped in `.dark` so the surface keeps Voice Mode chrome. */
function CapVoiceHearDemo() {
  return (
    <div className="dark cappg-voice-live">
      <WakePreviewFit designWidth={760} always>
        <WakeVoiceTourPreview />
      </WakePreviewFit>
    </div>
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
      "Chat can schedule events, draft emails, update boards, and save notes mid-conversation, and the same thread stays with you across the overlay, Studio, and desktop.",
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
    demo: CapVoiceHearDemo,
  },
  research: {
    name: "Research",
    headline: "Give a topic.\nGet a real report.",
    lede:
      "Research mode digs into current sources and writes a structured report you can cite, refine, and turn into the next artifact.",
    body:
      "Findings land as takeaways, debates, and citations, not a wall of text. Follow the sources, hand them to Browser, or extend the same report with a follow-up.",
    demo: CapResearchDemo,
  },
  browser: {
    name: "Browser",
    headline: "A browser that\nworks with you.",
    lede:
      "LYKN Browser is an agent that opens pages, extracts what matters, and acts on the web inside Studio, not a tab you babysit.",
    body:
      "Ask it to navigate, pull pricing, fill forms, or save rows back to your work. It docks beside chat, and closed sessions land in history like a real browser.",
    demo: CapBrowserDemo,
  },
  drive: {
    name: "Drive",
    headline: "Everything LYKN\nmakes, kept.",
    lede:
      "Drive is your vault: notes, research reports, builds, images, and files from every mode, searchable and ready for the next ask.",
    body:
      "Artifacts save as you work, stay tied to your projects, and stay askable later. Open, export, or hand a file back into Chat, Build, or Research.",
    demo: CapDriveDemo,
  },
};

const CAP_ORDER: CapId[] = [
  "chat",
  "build",
  "imagine",
  "voice",
  "research",
  "browser",
  "drive",
  "glass",
];

export default function CapabilityPage() {
  const navigate = useNavigate();
  const { capId: rawCapId } = useParams();
  const capId = String(rawCapId || "")
    .trim()
    .toLowerCase() as CapId;
  const cap = Object.prototype.hasOwnProperty.call(CAPS, capId)
    ? CAPS[capId]
    : null;

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [capId]);

  if (!cap) {
    return (
      <div className="glass-land cappg">
        <LandingHeader onBrandClick={() => navigate("/")} />
        <GlassBackdrop
          gradTextSelectors={GRAD_TEXT_SELECTORS}
          mixTextSelectors={MIX_TEXT_SELECTORS}
          wander
          wanderPath="right"
        />
        <main className="cappg-main">
          <h1 className="cappg-headline">Product not found</h1>
          <p className="cappg-lede">
            No page for &ldquo;{rawCapId || "unknown"}&rdquo;. Try{" "}
            {CAP_ORDER.map((id) => CAPS[id].name).join(", ")}.
          </p>
          <div className="cappg-ctas">
            <button
              type="button"
              className="gl-hero-cta"
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
  const others = CAP_ORDER.filter((id) => id !== capId);

  return (
    <div className="glass-land cappg">
      <LandingHeader onBrandClick={() => navigate("/")} />

      <GlassBackdrop
        key={capId}
        gradTextSelectors={GRAD_TEXT_SELECTORS}
        mixTextSelectors={MIX_TEXT_SELECTORS}
        wander
        wanderPath="right"
      />

      <main className="cappg-main">
        <div className="cappg-grid">
          <div className="cappg-copy">
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
                className="gl-hero-cta"
                onClick={() => navigate("/download")}
              >
                Download LYKN
              </button>
            </div>

            <div className="cappg-more">
              <p className="cappg-more-label">Explore the rest of LYKN</p>
              <div className="cappg-more-links">
                {others.map((id) => (
                  <Link key={id} to={`/product/${id}`}>
                    {CAPS[id].name} <span aria-hidden="true">→</span>
                  </Link>
                ))}
              </div>
            </div>
          </div>

          <div className="cappg-stagecol">
            <div className="cappg-stage">
              <article className="gl-cap-card cappg-card">
                <Demo key={capId} />
                <div className="gl-cap-foot">
                  <span className="gl-cap-name">{cap.name}</span>
                </div>
              </article>
            </div>
          </div>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
