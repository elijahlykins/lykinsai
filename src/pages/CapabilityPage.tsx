import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import LandingHeader from "@/components/landing/LandingHeader";
import { LyknWordmark, markLykn } from "@/components/landing/LyknWordmark";
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

interface CapFaq {
  q: string;
  a: string;
}

interface CapContent {
  name: string;
  headline: string;
  /** Opening paragraph under the headline. */
  lede: string;
  /** Second short paragraph of explanation. */
  body: string;
  /** Two comparison / how-it-works questions under the hero. */
  faq: [CapFaq, CapFaq];
  demo: () => JSX.Element;
}

function CapQuestions({ items }: { items: CapFaq[] }) {
  return (
    <section className="cappg-faq" aria-label="Questions">
      <h2 className="cappg-faq-title">Questions</h2>
      <div className="cappg-faq-grid">
        {items.map((item) => (
          <article key={item.q} className="cappg-faq-item">
            <h3 className="cappg-faq-q">{item.q}</h3>
            <p className="cappg-faq-a">{markLykn(item.a)}</p>
          </article>
        ))}
      </div>
    </section>
  );
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
    faq: [
      {
        q: "How is this different from the ChatGPT or Claude Mac apps?",
        a: "Those wrap a chat in a window. LYKN desktop is Home on your Mac: the chat bar on your wallpaper, your real Desktop folder, Finder files that open in place, plus Build, Imagine, Research, and Browser in the same place.",
      },
      {
        q: "Do I still need Glass if I have the desktop app?",
        a: `Desktop is where you live. Glass is the overlay for when you are already in another app. Press ${HOTKEY}, it reads the screen, then it gets out of the way. You do not have to choose one forever.`,
      },
    ],
    demo: CapDesktopLive,
  },
  glass: {
    name: "Glass",
    headline: "AI on every\nscreen you use.",
    lede: `Press ${HOTKEY} and LYKN Glass appears over whatever you're working on. It reads the page in front of you, answers in place, and gets out of the way. Chat, build, research, or talk without leaving the app you were already in.`,
    body: "No copy-paste and no context switching. Summon it over a doc, a design tool, a spreadsheet, or a browser tab. When you're done, it collapses so your work stays front and center.",
    faq: [
      {
        q: "How is this different from Spotlight or a menu-bar chatbot?",
        a: "Spotlight finds files. A menu-bar chat answers questions in a strip. Glass appears over the actual screen you are looking at, reads it, and lets you chat, build, research, or talk without leaving that app. When you are done, it collapses.",
      },
      {
        q: "Does it watch my screen all the time?",
        a: "No. You summon it when you want it. It reads what is in front of you to answer the ask, then gets out of the way. Screen Recording permission is only used when visual context is needed.",
      },
    ],
    demo: CapGlassDemo,
  },
  chat: {
    name: "Chat",
    headline: "Ask anything.\nConnect your tools.",
    lede:
      "Chat is the everyday conversation in LYKN. Ask a question, plan a project, or tell it to act, with your memory and files already in the thread. Connect Gmail, Slack, Notion, GitHub, and the rest of your stack, then just say what you need.",
    body:
      "Pick any model, or let LYKN route for you. Chat can search the web, work through the apps you connect, save what matters, and keep the same thread on your desktop. When the job needs software, images, or a deep report, switch modes without starting over.",
    faq: [
      {
        q: "How is this different from ChatGPT or Claude?",
        a: "Those are chats in a browser tab. LYKN Chat lives on your desktop with your files, memory, and the apps you connect. Pick any model, including Claude and GPT, then tell it to search, draft, or act in Gmail, Slack, Notion, GitHub, and the rest. When the job needs software, images, or a report, switch modes in the same place instead of starting over in another product.",
      },
      {
        q: "What can it actually do besides answer questions?",
        a: "Connect a tool and ask. Chat can search the web, work through the apps you connect, save what matters, and keep the same thread on your desktop. Sends, deletes, and shares wait for you. It is the everyday lane; Build, Imagine, and Research take over when you want a deliverable.",
      },
    ],
    demo: CapChatDemo,
  },
  build: {
    name: "Build",
    headline: "You describe it.\nLYKN builds the rest.",
    lede:
      "Build takes on the complex work: full apps, refactors, and the multi-file changes you would rather not babysit. LYKN routes every model. Just pick the one you want to use.",
    body:
      "LYKN writes the code, runs it, and keeps going until it works. Every project lives on your device. If you want it pushed, just say the word.",
    faq: [
      {
        q: "How does this compare to Claude Code or Codex?",
        a: "Claude Code and Codex are excellent coding agents in a terminal or IDE, usually locked to one lab's models. LYKN Build does that work on your machine, and you pick the model. Use Claude Fable, GPT-6 Astra, or a faster coding model when you want speed. Projects live on your device. LYKN writes, runs, and iterates until it works. If you want it pushed, just say the word. Chat, Research, Imagine, and your connected tools sit in the same desktop, so building is not a separate app you context-switch into.",
      },
      {
        q: "Does the code stay on my computer?",
        a: "Yes. Build writes real projects on your device, not a preview that vanishes when you close the tab. LYKN runs the code locally and keeps going until it works. Nothing leaves your machine unless you ask.",
      },
    ],
    demo: CapBuildDemo,
  },
  imagine: {
    name: "Imagine",
    headline: "Any image model.\nThe best video models.",
    lede:
      "Imagine generates from the models you pick, not a single locked pipeline. Choose any image model for stills, or switch to video and run the best video generators available. Four images land at a time so you can pick a direction, then edit in the same thread.",
    body:
      "Bring a reference image and make it yours, or start from a sentence. Lighting, mood, crop, and format are follow-ups, not a new tool. For video, LYKN uses models built for motion.",
    faq: [
      {
        q: "How is this different from Midjourney or a single-model image app?",
        a: "Those lock you to one generator. Imagine lets you pick any image model for stills, then edit lighting, mood, crop, or format in the same thread. Four images land at a time so you can choose a direction. Bring a reference or start from a sentence. You are not exporting out of one tool to finish the job in another.",
      },
      {
        q: "Can it generate video too?",
        a: "Yes. Switch to video and LYKN runs the best video models available, built for motion rather than stretching a stills engine. Stills and clips live in the same Imagine thread, next to Chat and your files, instead of a separate video site.",
      },
    ],
    demo: CapImagineDemo,
  },
  voice: {
    name: "Voice",
    headline: "Talk to LYKN\nlike a teammate.",
    lede:
      "Voice is a live conversation, not a dictation box. Think out loud, interrupt, redirect, and keep your hands on the work. It shares memory, projects, and connected tools with Chat, so you can look something up or take an action without typing.",
    body:
      "No push-to-talk and no waiting for a transcript. Change your mind mid-sentence. Use it at the desktop, or from Glass when you need to talk over another app.",
    faq: [
      {
        q: "How is this different from ChatGPT Voice?",
        a: "ChatGPT Voice is a conversation with one model in one app. LYKN Voice is a live conversation with the same LYKN that already has your files, projects, and connected tools. Interrupt, redirect, and change your mind mid-sentence. Talk from the desktop, or from Glass over whatever you are already looking at.",
      },
      {
        q: "Is this just dictation?",
        a: "No. Voice is not a transcript you send later. It is a real-time conversation. Think out loud, get work back, and take actions through the same tools as Chat without typing.",
      },
    ],
    demo: CapVoiceDemo,
  },
  research: {
    name: "Research",
    headline: "Give a topic.\nGet a real report.",
    lede:
      "Research does the long version of a search. You pick the sources it should draw from: the open web, academic papers, news, social, or markets. LYKN plans the questions, reads the pages, and writes a structured report you can actually cite.",
    body:
      "Findings land as takeaways, disagreements, and linked sources, not a wall of text. Save the report, open a citation, or keep asking to extend the same brief.",
    faq: [
      {
        q: "How is this different from Perplexity or ChatGPT with search?",
        a: "A search chat gives you a summary and a few links. Research plans the questions, reads the pages, and writes a structured report with takeaways, disagreements, and citations. You pick the sources it should draw from: the open web, academic papers, news, social, or markets.",
      },
      {
        q: "Can I choose which sources it uses?",
        a: "Yes. Before it digs in, pick the mix: all sources, web, academic, news, social, or markets. Follow-ups extend the same report. Save it, open a citation, or keep asking.",
      },
    ],
    demo: CapResearchCard,
  },
  browser: {
    name: "Browser",
    headline: "A browser that\nworks with you.",
    lede:
      "LYKN Browser is an agent that opens real pages, clicks through them, and pulls out what matters while you watch. Ask it to collect pricing, fill a form, or walk a site, and it works the web the way you would.",
    body:
      "It docks beside chat so you can keep asking while it browses. Closed sessions land in history, ready to reopen like a real browser.",
    faq: [
      {
        q: "How is this different from Chrome, or from computer-use agents?",
        a: "A normal browser waits for you to click. Computer-use agents often drive your whole desktop. LYKN Browser is an agent that opens real pages, clicks through them, and extracts what matters while you watch. It docks beside chat, so you can keep asking while it works. Closed sessions land in history like a real browser.",
      },
      {
        q: "When should I use Browser instead of connected apps?",
        a: "If Gmail, Notion, or GitHub is already connected, ask Chat to use that tool. Browser is for the open web: pricing pages, forms, research sites, anything that is not a connected app. You watch it work, and anything consequential waits for you.",
      },
    ],
    demo: CapBrowserLive,
  },
  agents: {
    name: "Agents",
    headline: "AI teammates,\nalways on the job.",
    lede:
      "Agents are standing teammates, not one-off chats. Give one a name, a role, and a job, then message it like a coworker. It can research, browse, use your connected apps, and keep working from the desktop while you do something else.",
    body:
      "Each agent lives in the dock with its own character, memory, and skills. Check in, hand it the next job, or pick up where it left off. You stay in charge of anything that sends, deletes, or shares.",
    faq: [
      {
        q: "How is this different from Custom GPTs or Claude Projects?",
        a: "Those are saved chats with instructions. A LYKN agent is a standing teammate on your desktop: its own name, role, character, and skills. Message it like a coworker. It can research, browse, use your connected apps, and keep working from the dock while you do something else.",
      },
      {
        q: "Do I lose control of what they send or change?",
        a: "No. You stay in charge of anything that sends, deletes, or shares. Check in from the dock, hand it the next job, or pick up where it left off.",
      },
    ],
    demo: CapAgentsDemo,
  },
  sync: {
    name: "Sync with Mac",
    headline: "Your files,\nright where you left them.",
    lede:
      "Your real Desktop folder, the folders you choose, and your wallpaper show up on Home. Drop a file there and it lands on disk. LYKN is looking at the same files your Mac already has, not an uploaded copy.",
    body:
      "No importing and no duplicate library. Pick which folders to share, change them anytime, and ask about any of them from Chat, Build, or Research.",
    faq: [
      {
        q: "Is this uploading my Mac into the cloud?",
        a: "No. You choose which folders to share. Your real Desktop, those folders, and your wallpaper show up on Home. Drop a file there and it lands on disk. LYKN is looking at the same files your Mac already has, not an uploaded copy.",
      },
      {
        q: "How is this different from iCloud Drive?",
        a: "iCloud copies files between your devices. Sync with Mac puts the folders you choose inside LYKN so you can ask about them, open them, and build against them. Change the list anytime. There is no duplicate library to maintain.",
      },
    ],
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

        <CapQuestions items={cap.faq} />
      </main>

      <SiteFooter />
    </div>
  );
}
