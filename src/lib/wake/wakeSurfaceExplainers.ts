export type WakeSurfaceId = "synthesis" | "vault" | "chat";

export interface WakeExplainerStat {
  value: string;
  label: string;
}

export interface WakeExplainerBlock {
  eyebrow?: string;
  title: string;
  body: string;
  bullets?: string[];
}

export interface WakeSurfaceExplainerContent {
  eyebrow: string;
  title: string;
  overview: string;
  stats: WakeExplainerStat[];
  blocks: WakeExplainerBlock[];
  howItWorks: { step: string; title: string; body: string }[];
  closing?: { title: string; body: string };
}

export const WAKE_SURFACE_EXPLAINERS: Record<
  WakeSurfaceId,
  WakeSurfaceExplainerContent
> = {
  synthesis: {
    eyebrow: "Synthesis Layer",
    title: "Your digital brain",
    overview:
      "Most AI forgets who you are when you close the tab. The synthesis layer is a living graph of your beliefs, facts, and projects, structured once and carried into every LLM you connect.",
    stats: [
      { value: "6", label: "Core neuron types built in" },
      { value: "∞", label: "Custom neurons you can add" },
      { value: "1", label: "Profile that follows you everywhere" },
    ],
    blocks: [
      {
        eyebrow: "Structure",
        title: "Six neurons that grow with you",
        body:
          "Every LYKN synthesis layer starts with six core neurons: Chats, Vault, Facts, Beliefs, Concepts, and Projects. They begin empty. As you talk, upload, and decide, each one fills with real structure instead of loose threads.",
        bullets: [
          "Chats capture conversation history and the context behind it",
          "Vault links files to the meanings LYKN extracts from them",
          "Facts hold concrete truths about you, your work, and your world",
          "Beliefs are the principles you want LLMs to respect and apply",
          "Concepts cluster related ideas so reasoning stays coherent",
          "Projects keep active goals, deadlines, and open threads in one place",
        ],
      },
      {
        eyebrow: "Authorship",
        title: "You write the rules, not the model",
        body:
          "Most AI tools guess who you are from a generic default. LYKN flips that. You declare your beliefs, tone, and boundaries explicitly. When an LLM responds through LYKN, it is following your governance, not inventing a persona on the fly.",
        bullets: [
          "Set how blunt, warm, or skeptical replies should feel",
          "Define if-then rules that apply across every connected client",
          "Ratify beliefs so the model treats them as binding, not suggestions",
          "Revise anything anytime. Your layer is live, not frozen at signup",
        ],
      },
      {
        eyebrow: "Visualization",
        title: "See your intelligence as a living graph",
        body:
          "The synthesis layer is not a spreadsheet of settings. It is a 3D graph you can explore. Neurons connect to each other. Clusters form around topics. You spot gaps, duplicates, and contradictions at a glance instead of hunting through chat history.",
        bullets: [
          "Drag, zoom, and inspect any neuron in the graph",
          "Follow connections to see how a belief links to a project or fact",
          "Add new neuron types from the + menu when you need a new category",
          "Watch the graph grow as LYKN learns from chat and vault uploads",
        ],
      },
      {
        eyebrow: "Portability",
        title: "Context that is not trapped in one app",
        body:
          "What you build here does not die when a tab closes. Beliefs, facts, project state, and vault links export through LYKN into whichever LLM you connect next. You stop re-explaining your background every Monday morning.",
        bullets: [
          "Works with the models and tools you wire up under Connections",
          "MCP and API access let external clients read your synthesis layer",
          "Project state persists so the next session picks up mid-thought",
          "One layer, many surfaces. Chat, Cursor, Claude, ChatGPT, all grounded in you",
        ],
      },
      {
        eyebrow: "Compounding",
        title: "Memory that gets sharper, not noisier",
        body:
          "Each neuron you add makes the next reply more precise. LYKN does not dump everything into one bloated prompt. It pulls the beliefs, facts, and files that matter for the question at hand, so context compounds without turning into sludge.",
      },
    ],
    howItWorks: [
      {
        step: "01",
        title: "Start with an empty graph",
        body: "Six core neurons appear on day one. Nothing is pre-filled. The layer is a blank map of you.",
      },
      {
        step: "02",
        title: "Talk and upload",
        body: "Chat teaches LYKN facts about you. Vault uploads become new neurons linked to the graph.",
      },
      {
        step: "03",
        title: "Author beliefs and rules",
        body: "Write the principles and if-then rules you want every LLM to follow. Ratify what matters.",
      },
      {
        step: "04",
        title: "Connect any LLM",
        body: "Wire up models under Connections. They read your synthesis layer before they answer.",
      },
    ],
    closing: {
      title: "This is the center of LYKN",
      body:
        "Everything else in the product feeds the synthesis layer or draws from it. Vault supplies raw material. Chat is where you interact. Connections spread your context outward. But the brain itself lives here.",
    },
  },
  vault: {
    eyebrow: "The Vault",
    title: "Your AI Drive",
    overview:
      "Not cloud storage with a chat box bolted on. An ingestion layer that turns what you collect into structured memory you can reason over forever.",
    stats: [
      { value: "All", label: "Major file types supported" },
      { value: "Auto", label: "Meaning extraction on upload" },
      { value: "Linked", label: "Every item ties to neurons" },
    ],
    blocks: [
      {
        eyebrow: "Ingestion",
        title: "Drop anything in",
        body:
          "The vault is built for the messy reality of how you actually work. PDFs, spreadsheets, slides, images, video, audio, zip archives, web links, and quick notes all land in the same grid. No folder gymnastics required.",
        bullets: [
          "Drag and drop from your desktop in one motion",
          "Paste a URL and LYKN fetches and indexes the page",
          "Capture a quick note without opening another app",
          "Upload batches. LYKN processes them in the background",
        ],
      },
      {
        eyebrow: "Understanding",
        title: "Storage is the floor, not the ceiling",
        body:
          "A normal drive stores bytes. The vault stores meaning. When you add a resume, LYKN does not just file it. It asks what this document says about your skills, goals, and history, then creates neurons that connect to what it already knows.",
        bullets: [
          "PDFs and docs are parsed for facts and themes",
          "Images and screenshots run through vision analysis",
          "Video and audio are transcribed and summarized",
          "Spreadsheets surface structured data as searchable facts",
        ],
      },
      {
        eyebrow: "Organization",
        title: "Find anything in seconds",
        body:
          "As your vault grows, search stays fast. Filter by type, tag, or concept. Run semantic queries when you remember the idea but not the filename. The grid scales from a handful of cards to a full personal archive.",
        bullets: [
          "Full-text and semantic search across every item",
          "Tags and filters to slice by project or topic",
          "Grid, list, and focused views for different workflows",
          "Preview files in place without downloading",
        ],
      },
      {
        eyebrow: "Synthesis link",
        title: "Files become neurons, not orphans",
        body:
          "Every meaningful upload can spawn or enrich neurons in your synthesis layer. A journal entry might strengthen a belief. A project brief might open a new project neuron. The vault is raw material. The synthesis layer is where it becomes intelligence.",
      },
      {
        eyebrow: "Workflow",
        title: "Built for daily use",
        body:
          "Quick notes for fleeting thoughts. Bulk upload for archive migrations. Link capture for research rabbit holes. The vault is designed to be the place you throw things knowing LYKN will make them useful later.",
        bullets: [
          "Floating quick-note button for capture in the moment",
          "Trash and restore so nothing disappears by accident",
          "Demo-ready grid in the walkthrough, full power when you sign in",
          "Same vault whether you open it standalone or from chat",
        ],
      },
    ],
    howItWorks: [
      {
        step: "01",
        title: "Add a file or link",
        body: "Drop it on the grid, paste a URL, or jot a quick note. LYKN accepts it immediately.",
      },
      {
        step: "02",
        title: "LYKN reads and parses",
        body: "Content is extracted, summarized, and tagged. You see a rich card, not a dead icon.",
      },
      {
        step: "03",
        title: "Meanings become neurons",
        body: "What the file says about you connects to existing neurons in your synthesis layer.",
      },
      {
        step: "04",
        title: "Chat and LLMs use it",
        body: "The next time you ask a question, relevant vault context is already in the mix.",
      },
    ],
  },
  chat: {
    eyebrow: "Chat",
    title: "Talk to your intelligence layer",
    overview:
      "Before LYKN answers, it loads your synthesis layer, vault, and connected tools. Every reply is grounded in you, not a default persona the model invents on the fly.",
    stats: [
      { value: "You", label: "Grounded in your neurons" },
      { value: "Any", label: "Model you connect" },
      { value: "Full", label: "Thread continuity" },
    ],
    blocks: [
      {
        eyebrow: "Grounding",
        title: "Replies start from you, not the internet average",
        body:
          "Before LYKN generates a word, it loads what matters from your synthesis layer: beliefs you ratified, facts you confirmed, projects you have open, and vault files that relate to the question. The answer is personalized by construction, not by prompt hack.",
        bullets: [
          "Beliefs and rules shape tone, boundaries, and reasoning",
          "Facts and concepts fill in background the model never had",
          "Vault items surface when the question touches them",
          "Project state keeps multi-day work coherent across sessions",
        ],
      },
      {
        eyebrow: "Models",
        title: "Pick the LLM, keep the same brain",
        body:
          "Switch models from the toolbar without losing yourself. LYKN is the intelligence layer. The model is the engine. You might use a fast model for drafts and a deeper one for hard problems, but your context travels with you either way.",
        bullets: [
          "Model selector in the chat bar, same as production",
          "Tier-aware options based on your plan",
          "LYKN-native routing when you want the default experience",
          "Connected third-party models read your synthesis layer too",
        ],
      },
      {
        eyebrow: "Input",
        title: "Ask anything, attach anything",
        body:
          "Type a question, paste context, or attach files from your vault and desktop. Dictation for hands-free capture. The chat bar matches the real product so what you learn in the walkthrough is what you use after signup.",
        bullets: [
          "Multi-line input with shift+enter for longer prompts",
          "Attachment picker wired to vault and local files",
          "Dictation for mobile and hands-busy moments",
          "Send, stop, and regenerate controls like production chat",
        ],
      },
      {
        eyebrow: "Layout",
        title: "Collapsible chats",
        body:
          "Past exchanges collapse to a short preview so you are not endlessly scrolling through what you already read. Tap to expand any message when you need the full response. Long threads stay easy to scan.",
      },
      {
        eyebrow: "Learning",
        title: "Conversations can mint new neurons",
        body:
          "When you share something durable about yourself, LYKN can learn it into your synthesis layer on the spot. A preference, a decision, a biographical fact. The chat is not read-only. It is one of the ways your digital brain grows.",
        bullets: [
          "The model decides when something is worth remembering",
          "New neurons appear on the graph and in your sidebar",
          "You stay in control. Review and edit anything later",
          "Casual small talk stays casual. No neuron spam",
        ],
      },
    ],
    howItWorks: [
      {
        step: "01",
        title: "Ask a question",
        body: "Type naturally. Attach files if you need to. LYKN loads your layer first.",
      },
      {
        step: "02",
        title: "Context assembles",
        body: "Beliefs, facts, vault hits, and project state merge into the prompt behind the scenes.",
      },
      {
        step: "03",
        title: "The model responds as you",
        body: "Tone, rules, and background are already applied. You get a partner, not a stranger.",
      },
      {
        step: "04",
        title: "The layer can grow",
        body: "Durable learnings become neurons. The next reply, and the next LLM, benefit automatically.",
      },
    ],
    closing: {
      title: "Where it all comes together",
      body:
        "Chat is the surface most people live in. Underneath, LYKN is doing the work: reading your synthesis layer, honoring your rules, and answering like it has known you for years. Because in a sense, it has.",
    },
  },
};
