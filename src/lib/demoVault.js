// Preloaded "starter" vault content.
//
// Guests see these rendered as synthetic cards (no DB writes, previews allowed,
// mutations blocked). Brand-new signed-in users get the same items seeded once
// as real rows in the `notes` table so they behave like any other note — they
// can be edited, re-tagged, moved into projects, and deleted.

// Neutral, aesthetic imagery from Unsplash. These URLs are stable, public,
// and CORS-friendly, so they work for guests (no Supabase Storage involved).
const unsplash = (id) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop&w=1200&q=80`;

// Image entries can optionally carry `fileNotes` — these render on the card
// as the little speech-bubble badge and let the user read the "why I saved
// this" context, the same way real uploaded files work.
export const DEMO_VAULT_ITEMS = [
  {
    kind: "image",
    title: "Morning coastline",
    fileName: "coastline.jpg",
    url: unsplash("photo-1507525428034-b723cf961d3e"),
    tags: ["nature", "morning", "calm"],
    fileNotes: [
      "Took this on a run before sunrise — clearest I'd seen the horizon in months.",
      "Good reminder to get out earlier.",
    ],
  },
  {
    kind: "image",
    title: "Quiet workspace",
    fileName: "workspace.jpg",
    url: unsplash("photo-1498050108023-c5249f4df085"),
    tags: ["space", "work", "calm"],
    fileNotes: [
      "Finally got the desk setup how I wanted it. Keep this vibe.",
    ],
  },
  {
    kind: "image",
    title: "Soft architecture",
    fileName: "architecture.jpg",
    url: unsplash("photo-1487958449943-2429e8be8625"),
    tags: ["design", "space", "travel"],
    fileNotes: [
      "Light falling through the atrium — revisit for the brand moodboard.",
    ],
  },
  {
    kind: "image",
    title: "Texture study",
    fileName: "linen.jpg",
    url: unsplash("photo-1519682337058-a94d519337bc"),
    tags: ["texture", "design"],
    fileNotes: [
      "Linen weave close-up. Curious if we can echo this in the product background.",
    ],
  },
  {
    kind: "image",
    title: "Mountain morning",
    fileName: "mountain-morning.jpg",
    url: unsplash("photo-1464822759023-fed622ff2c3b"),
    tags: ["nature", "morning", "travel"],
  },
  {
    kind: "image",
    title: "Forest path",
    fileName: "forest-path.jpg",
    url: unsplash("photo-1441974231531-c6227db76b6e"),
    tags: ["nature", "calm", "everyday"],
    fileNotes: [
      "Trying to walk here at least once a week.",
    ],
  },
  {
    kind: "image",
    title: "Minimal desk",
    fileName: "minimal-desk.jpg",
    url: unsplash("photo-1519389950473-47ba0277781c"),
    tags: ["space", "work", "design"],
  },
  {
    kind: "image",
    title: "Coffee ritual",
    fileName: "coffee.jpg",
    url: unsplash("photo-1495474472287-4d71bcdd2085"),
    tags: ["morning", "everyday", "calm"],
    fileNotes: [
      "Slow morning = better day. Protecting this habit.",
    ],
  },
  {
    kind: "image",
    title: "Linen & light",
    fileName: "linen-light.jpg",
    url: unsplash("photo-1522071820081-009f0129c71c"),
    tags: ["texture", "calm"],
  },
  {
    kind: "image",
    title: "Golden field",
    fileName: "golden-field.jpg",
    url: unsplash("photo-1500382017468-9049fed747ef"),
    tags: ["nature", "travel"],
    fileNotes: [
      "Drove past this on the way back — pulled over. Glad I did.",
    ],
  },
  {
    kind: "image",
    title: "Open notebook",
    fileName: "notebook.jpg",
    url: unsplash("photo-1517842645767-c639042777db"),
    tags: ["writing", "everyday", "morning"],
    fileNotes: [
      "Note to self: write before inbox.",
    ],
  },
  {
    kind: "image",
    title: "Quiet city",
    fileName: "quiet-city.jpg",
    url: unsplash("photo-1502920917128-1aa500764cbd"),
    tags: ["travel", "calm"],
  },
  {
    kind: "image",
    title: "Warm interior",
    fileName: "warm-interior.jpg",
    url: unsplash("photo-1493809842364-78817add7ffb"),
    tags: ["space", "everyday", "design"],
    fileNotes: [
      "Inspo for the reading corner.",
    ],
  },
  {
    kind: "image",
    title: "Studio corner",
    fileName: "studio-corner.jpg",
    url: unsplash("photo-1505691938895-1758d7feb511"),
    tags: ["space", "work", "calm"],
    fileNotes: [
      "How calm studios feel — lots of empty space, a few good objects.",
    ],
  },
  {
    kind: "image",
    title: "Ocean quiet",
    fileName: "ocean-quiet.jpg",
    url: unsplash("photo-1505142468610-359e7d316be0"),
    tags: ["nature", "calm", "travel"],
  },
  {
    kind: "note",
    title: "Quick Note",
    content:
      "Ideas worth coming back to:\n• the quieter version of the product\n• ship one small thing a week\n• notes are for thinking, not archiving",
    tags: ["work", "writing"],
  },
  {
    kind: "note",
    title: "Quick Note",
    content:
      "Books to re-read this year — keep the list short so it stays honest.",
    tags: ["reading", "reflection"],
  },
  {
    kind: "note",
    title: "Quick Note",
    content:
      "Weekly review prompts:\n• what did I learn?\n• what did I ship?\n• what drained me?\n• what's worth doing less of?",
    tags: ["reflection", "writing", "work"],
  },
  {
    kind: "note",
    title: "Quick Note",
    content:
      "Travel list — places that keep coming up in conversation:\n• Lisbon in autumn\n• rural Japan\n• somewhere without wifi for a week",
    tags: ["travel", "reading"],
  },
  {
    kind: "note",
    title: "Quick Note",
    content:
      "Design principles I want to hold onto:\n• calm by default\n• one thing per screen\n• make the small stuff feel intentional",
    tags: ["design", "work"],
  },
];

// Fixed ISO timestamp anchor so demo fileNote ids/created_at don't jitter
// across re-renders (important for React keys + note de-dup).
const DEMO_NOTE_EPOCH = "2024-01-01T12:00:00.000Z";

function buildFileNotes(fileNotes, keyPrefix) {
  if (!Array.isArray(fileNotes) || fileNotes.length === 0) return [];
  return fileNotes.map((text, idx) => ({
    id: `${keyPrefix}-fn-${idx}`,
    text: String(text || "").trim(),
    created_at: DEMO_NOTE_EPOCH,
  })).filter((n) => n.text);
}

// Builds in-memory cards shaped the same way the `vaultCards` memo builds them
// from real notes. Used only for guests.
export function buildGuestDemoCards() {
  return DEMO_VAULT_ITEMS.map((item, i) => {
    if (item.kind === "image") {
      return {
        id: `demo-att-${i}`,
        kind: "attachment",
        noteId: `demo-note-${i}`,
        attachmentIndex: 0,
        type: "image",
        attachment: {
          url: item.url,
          name: item.fileName,
          type: "image",
          notes: buildFileNotes(item.fileNotes, `demo-${i}`),
        },
        title: item.title,
        parentTitle: item.title,
        noteExcerpt: "",
        dateLabel: "Today",
        tags: item.tags || [],
        isDemo: true,
      };
    }
    return {
      id: `demo-qn-${i}`,
      kind: "quick-note",
      noteId: `demo-note-${i}`,
      title: item.title,
      excerpt: item.content,
      dateLabel: "Today",
      tags: item.tags || [],
      isDemo: true,
    };
  });
}

/* ------------------------------------------------------------------ */
/*  Landing-prototype preview cards                                     */
/* ------------------------------------------------------------------ */

// Five LYKN-themed starter cards shown to guests who came from the
// landing prototype. The seeded `DEMO_VAULT_ITEMS` are suppressed for
// these visitors (the vault should read as their workspace, not the
// demo workspace), so this gives the page a little context — "here's
// what the vault is" — without faking actual user content.
//
// Mix is intentional: a couple of quick notes for context, one image
// to show how visual saves render, and a couple of saved-link articles
// so the visitor sees that the vault accepts more than just text.
export const PROTOTYPE_PREVIEW_VAULT_ITEMS = [
  {
    kind: "note",
    title: "What the Vault is",
    content:
      "The Vault is your long-term memory in LYKN.\n\nAnything you save here — files, links, photos, quick notes — becomes part of what your synthetic intelligence layer can think with.\n\nIt's not a folder. It's the raw material LYKN uses to learn you.",
    tags: ["lykn", "intro"],
  },
  {
    kind: "image",
    title: "Synthesis, visualized",
    fileName: "synthesis-network.jpg",
    // Abstract neural-network / connections imagery — matches the
    // synthesis-layer aesthetic on the prior step.
    url: unsplash("photo-1635070041078-e363dbe005cb"),
    tags: ["lykn", "synthesis"],
    fileNotes: [
      "This is roughly what your Synthesis Layer is doing under the hood — turning saved fragments into a network you can think with.",
    ],
  },
  {
    kind: "link",
    title: "Building a Second Brain — a primer",
    url: "https://fortelabs.com/blog/basboverview/",
    siteName: "Forte Labs",
    description:
      "A short essay on why offloading what you know into an external system frees up the part of you that actually thinks. Useful framing for what LYKN is trying to do — except LYKN does the synthesis for you.",
    image: unsplash("photo-1455390582262-044cdead277a"),
    tags: ["lykn", "reading"],
  },
  {
    kind: "note",
    title: "First neuron created",
    content:
      "You just made your first neuron in the Synthesis Layer.\n\nThat one neuron is the start of a map of you — what you focus on, what drives you, how you think. It grows every time you add to the Vault or open a Grid.",
    tags: ["lykn", "synthesis", "milestone"],
  },
  {
    kind: "link",
    title: "LYKN — a synthetic intelligence layer for you",
    url: "https://lykn.io",
    siteName: "lykn.io",
    description:
      "Most AI tools answer questions. LYKN learns you. Every file, link, and thought you save becomes a neuron in a synthesis layer that's only ever about you.",
    image: unsplash("photo-1620712943543-bcc4688e7485"),
    tags: ["lykn", "intro"],
  },
];

const PROTO_NOTE_EPOCH = "2024-01-01T12:00:00.000Z";

function buildProtoFileNotes(fileNotes, keyPrefix) {
  if (!Array.isArray(fileNotes) || fileNotes.length === 0) return [];
  return fileNotes
    .map((text, idx) => ({
      id: `${keyPrefix}-fn-${idx}`,
      text: String(text || "").trim(),
      created_at: PROTO_NOTE_EPOCH,
    }))
    .filter((n) => n.text);
}

// Builds in-memory cards for the landing-prototype preview. Same shape
// as `buildGuestDemoCards()` so the existing render path picks them up
// without any special casing.
export function buildPrototypePreviewCards() {
  return PROTOTYPE_PREVIEW_VAULT_ITEMS.map((item, i) => {
    if (item.kind === "image") {
      return {
        id: `proto-att-${i}`,
        kind: "attachment",
        noteId: `proto-vault-note-${i}`,
        attachmentIndex: 0,
        type: "image",
        attachment: {
          url: item.url,
          name: item.fileName,
          type: "image",
          notes: buildProtoFileNotes(item.fileNotes, `proto-${i}`),
        },
        title: item.title,
        parentTitle: item.title,
        noteExcerpt: "",
        dateLabel: "Just now",
        tags: item.tags || [],
        isDemo: true,
      };
    }
    if (item.kind === "link") {
      return {
        id: `proto-att-${i}`,
        kind: "attachment",
        noteId: `proto-vault-note-${i}`,
        attachmentIndex: 0,
        type: "bookmark",
        attachment: {
          type: "bookmark",
          url: item.url,
          name: item.title,
          title: item.title,
          description: item.description || "",
          image: item.image || "",
          favicon: "",
          siteName: item.siteName || "",
          articleText: item.description || "",
          notes: [],
        },
        title: item.title,
        parentTitle: item.title,
        noteExcerpt: item.description || "",
        dateLabel: "Just now",
        tags: item.tags || [],
        isDemo: true,
      };
    }
    return {
      id: `proto-qn-${i}`,
      kind: "quick-note",
      noteId: `proto-vault-note-${i}`,
      title: item.title,
      excerpt: item.content,
      dateLabel: "Just now",
      tags: item.tags || [],
      isDemo: true,
    };
  });
}

// Builds the rows to INSERT into the `notes` table when seeding a brand-new
// signed-in user. Shape mirrors the existing Save Link / Quick Note inserts
// so the read path (parseAttachmentsFromNote, etc.) picks them up without any
// special casing.
export function buildSeedNoteRows(userId) {
  if (!userId) return [];
  return DEMO_VAULT_ITEMS.map((item, i) => {
    if (item.kind === "image") {
      const attachment = [
        {
          type: "image",
          url: item.url,
          name: item.fileName,
          title: item.title,
          notes: buildFileNotes(item.fileNotes, `seed-${i}`),
        },
      ];
      return {
        user_id: userId,
        title: item.title,
        content: `${item.title}\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachment)}]`,
        tags: item.tags || [],
      };
    }
    return {
      user_id: userId,
      title: item.title,
      content: item.content,
      tags: item.tags || [],
    };
  });
}
