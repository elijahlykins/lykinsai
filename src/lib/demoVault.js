// Demo content shared with the Synthesis Layer's guest preview graph.
//
// IMPORTANT: nothing in this file is ever rendered into the user's actual
// Vault — not for guests, not for brand-new signed-in users, not for anyone.
// We used to seed these rows into `notes` on first sign-in (and render them
// as synthetic cards for guests), but that meant users who emptied their
// vault saw the starter pack reappear on their next visit, which was
// confusing and unwanted. The seeding/rendering paths have been removed;
// only `DEMO_VAULT_ITEMS` is still exported so the synthesis-layer guest
// demo (see `demoSynthesis.js`) can keep its graph populated.

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
      "Took this on a run before sunrise. Clearest I'd seen the horizon in months.",
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
      "Light falling through the atrium. Revisit for the brand moodboard.",
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
      "Drove past this on the way back and pulled over. Glad I did.",
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
      "How calm studios feel: lots of empty space, a few good objects.",
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
      "Books to re-read this year. Keep the list short so it stays honest.",
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
      "Travel list, places that keep coming up in conversation:\n• Lisbon in autumn\n• rural Japan\n• somewhere without wifi for a week",
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

// No render/seed helpers are exported anymore — the Vault never displays
// template content. If a future synthesis-layer demo needs file-notes,
// build them at the call site rather than reintroducing them here.
