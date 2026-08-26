// The LYKN news posts: shown as tiles in the landing page's "Latest news"
// strip and rendered in full at /news/<slug>. One source of truth so the
// strip and the article pages never drift apart.
import newsTileStudio from "@/assets/news-tile-studio.jpg";
import newsTileGlass from "@/assets/news-tile-glass.jpg";
import newsTileProjects from "@/assets/news-tile-projects.jpg";
import newsTileVoice from "@/assets/news-tile-voice.jpg";

export interface NewsSection {
  heading?: string;
  paragraphs: string[];
}

export interface NewsPost {
  slug: string;
  tag: string;
  date: string;
  title: string;
  /** One-line summary shown under the title on the article page. */
  lede: string;
  art: string;
  /** True when the tile artwork is light and needs dark type over it. */
  lightArt?: boolean;
  body: NewsSection[];
}

export const NEWS_POSTS: NewsPost[] = [
  {
    slug: "introducing-lykn-studio",
    tag: "LYKN Studio",
    date: "Jul 16, 2026",
    title: "Introducing LYKN Studio",
    lede: "One workspace where your projects, notes, and conversations live together, with an AI that actually knows you working across all of it.",
    art: newsTileStudio,
    body: [
      {
        paragraphs: [
          "Most AI tools start every conversation from zero. You re-explain who you are, what you're working on, and what you meant last time, and the moment you close the tab all of that is gone. LYKN Studio is our answer to that: a personal AI workspace built around a single idea, that your AI should accumulate an understanding of you instead of renting you its attention one prompt at a time.",
          "Studio is where everything you do with LYKN lives. Your projects, Vault notes and documents, chats across models, and private Markdown Memory all sit in one place.",
        ],
      },
      {
        heading: "Private Markdown Memory",
        paragraphs: [
          "At the center of Studio is private Markdown Memory: small documents for your explicit preferences, goals, decisions, relationships, projects, and topics. Every model you talk to through LYKN can be grounded in the same durable context.",
          "That context is portable. Whether you're in a Studio chat, the Glass overlay on top of another app, or voice mode, the AI you're talking to is the same one, with the same memory.",
        ],
      },
      {
        heading: "Every model, one memory",
        paragraphs: [
          "Studio isn't tied to a single model. Chat with the frontier models you already use and let LYKN carry your context between them. The model changes; your AI doesn't.",
        ],
      },
      {
        heading: "Where it goes from here",
        paragraphs: [
          "Studio ships today alongside LYKN Glass on macOS, voice mode, and the AI project manager. This is the foundation we'll be building on for the rest of the year, and the posts that follow this one go deeper on each piece.",
        ],
      },
    ],
  },
  {
    slug: "building-lykn-glass",
    tag: "LYKN Glass",
    date: "Jul 8, 2026",
    title: "Building LYKN Glass: AI on every screen",
    lede: "Press ⌘L and LYKN appears over whatever you're working on, reads what you're looking at, and acts. Here's how we built it and why.",
    art: newsTileGlass,
    body: [
      {
        paragraphs: [
          "The best place for your AI isn't another app you have to switch to. It's the screen you're already on. LYKN Glass is a floating glass bar that appears over any app, doc, or browser the moment you press ⌘L, already knowing who you are and what you're working on.",
        ],
      },
      {
        heading: "Invisible until summoned",
        paragraphs: [
          "We had one design rule: Glass should feel like part of the operating system, not a window fighting for space. It rests as a slim frosted bar, expands when you're working with it, and gets out of the way the moment you're done. No dock icon bouncing, no tab to find.",
          "The frosted look isn't decoration. Because Glass sits on top of your work, it has to feel weightless, and letting your screen show through the blur keeps you oriented in whatever you were doing.",
        ],
      },
      {
        heading: "It can see what you see, when you ask",
        paragraphs: [
          "Ask Glass about your screen and it reads what's in front of you: the article you're skimming, the spreadsheet you're stuck in, the design you're reviewing. The snip tool lets you drag a selection over any region and ask about exactly that. Screen reading only happens when you invoke it; Glass never watches in the background.",
        ],
      },
      {
        heading: "And then it acts",
        paragraphs: [
          "Glass is wired into the same Markdown Memory, projects, and Vault as the rest of LYKN, so it doesn't just answer, it does. Update a task, schedule an event, draft the reply, generate the asset, all without leaving the page you're on. That's the whole point: the distance between noticing something and handling it drops to one keystroke.",
        ],
      },
    ],
  },
  {
    slug: "ai-project-manager",
    tag: "Projects",
    date: "Jun 30, 2026",
    title: "Your AI project manager, explained",
    lede: "LYKN holds your projects, tasks, and calendar in real time, keeps them current, and pushes the next step forward, even overnight.",
    art: newsTileProjects,
    lightArt: true,
    body: [
      {
        paragraphs: [
          "A project manager's real job is context: knowing what's done, what's due, what's blocked, and what should happen next. That's exactly the kind of state most AI tools throw away between conversations, and exactly what LYKN is built to keep.",
        ],
      },
      {
        heading: "Projects that stay current",
        paragraphs: [
          "Every project in LYKN holds its own tasks, notes, and calendar. When you finish something from a chat, from Glass, or from your phone, the project updates everywhere at once. Ask \"what's next on the launch?\" from any screen and LYKN just knows, because it's the one keeping score.",
          "Your calendar lives alongside the work. LYKN can schedule, reschedule, flag conflicts, and tie events back to the project they belong to, so your time and your tasks stop living in separate apps.",
        ],
      },
      {
        heading: "Night Shift",
        paragraphs: [
          "Some work shouldn't wait for you to be at your desk. Drop rough ideas into the backlog and overnight LYKN expands them into ready, scoped tasks. In the morning you review the queue, approve what looks right, and schedule the next run. You stay in charge of every decision; LYKN keeps the conveyor belt moving.",
        ],
      },
      {
        heading: "From any screen",
        paragraphs: [
          "Because the project manager is the same AI that powers Glass, managing work never requires opening a management tool. Hit ⌘L wherever you are, say what changed, and get back to it.",
        ],
      },
    ],
  },
  {
    slug: "voice-mode",
    tag: "Voice",
    date: "Jun 20, 2026",
    title: "Talking to LYKN: voice mode is here",
    lede: "A real conversation with an AI that knows your projects, your preferences, and what you said last time.",
    art: newsTileVoice,
    body: [
      {
        paragraphs: [
          "Some thoughts are faster said than typed. Voice mode uses the same Markdown Memory, projects, and Vault grounding as Chat, so you do not start every call by explaining yourself.",
        ],
      },
      {
        heading: "Built for real conversation",
        paragraphs: [
          "Voice mode streams responses with low enough latency that it feels like conversation, not dictation. Interrupt it, redirect it, think out loud. It keeps up, and everything you decide together lands back in your projects and notes like any other LYKN session.",
        ],
      },
      {
        heading: "Where you'll use it",
        paragraphs: [
          "It shines when your hands are busy or your thoughts are messy: walking through tomorrow's plan, talking out a draft, triaging your task list on a commute. Ask it to capture decisions as you go and they're waiting in Studio when you sit back down.",
          "Voice mode is available now in LYKN Studio and through the Glass overlay.",
        ],
      },
    ],
  },
];

export function getNewsPost(slug: string): NewsPost | undefined {
  return NEWS_POSTS.find((p) => p.slug === slug);
}
