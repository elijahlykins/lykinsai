// Preloaded "starter" grids. Shown to guests (pre-sign-in) as interactive
// preview boards so the "/chat" surface doesn't feel empty. Paired with
// `demoVault.js` and `demoSynthesis.js` — the three files share themes,
// tags, and image URLs so the whole demo experience feels cohesive.
//
// Guests can pan, zoom, edit, and drag blocks around — but save is a no-op
// (see useLyknChatPersistence) so nothing persists. Signed-in users who follow
// a demo link also get a read/edit canvas with no persistence, which is a
// fine "try it out" surface.
//
// Board ids MUST match the ones exported from `demoSynthesis.js` so nodes
// in project and Vault surfaces can link back here.
//
// Each of the three grids intentionally uses a different layout style so
// the preview surface shows the canvas's range:
//   - Harbor  — linear top-to-bottom "strategy doc"
//   - Greenroom — cluster layout with two columns + full-width bands
//   - Studio 12 — spatial floor-plan (zone cards placed where the zones
//                  actually live in the room)
// Each grid seeds a handful of `wireConnections` to show how related
// blocks can be linked without wiring everything.

const unsplash = (id) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop&w=1200&q=80`;

const G = 24; // canvas gridSize — keep all positions snap-aligned

function textBlock({ id, x, y, width, height, content, variant = "body", listType = "none", format = "plain" }) {
  return {
    id,
    type: "text",
    x,
    y,
    width,
    height,
    content,
    format,
    data: {
      content,
      textVariant: variant,
      listType,
    },
  };
}

function imageBlock({ id, x, y, width, height, url, name, title }) {
  return {
    id,
    type: "create",
    mode: "image",
    x,
    y,
    width,
    height,
    data: {
      src: url,
      name: name || title || "Image",
      title: title || name || "",
    },
  };
}

// Positioning helper — all values in grid cells so layouts read in cells
// rather than raw pixels. Each section anchors on a rounded cy and
// columns snap to the same cx grid.
const at = (cx, cy, cw, ch) => ({
  x: cx * G,
  y: cy * G,
  width: cw * G,
  height: ch * G,
});

// Wire helper — keeps the `{ id, fromId, toId, fromSide, toSide }` shape
// consistent and avoids hand-typing ids for every wire. Optional
// controlPoints are passed in pixel coords (use `wpc(cx, cy)` to build
// them in cell coords).
const wire = (id, fromId, fromSide, toId, toSide, controlPoints) => ({
  id,
  fromId,
  toId,
  fromSide,
  toSide,
  ...(controlPoints && controlPoints.length ? { controlPoints } : {}),
});

// Waypoint in cell coords — wires use pixel coords internally, so this
// just multiplies by G so the wire routes read in cells like the block
// positions above.
const wpc = (cx, cy) => ({ x: cx * G, y: cy * G });

/* ================================================================== */
/*  Grid 1 — Harbor (business idea) · LINEAR layout                    */
/* ================================================================== */

const harborBlocks = [
  // — Masthead ---------------------------------------------------------
  textBlock({
    id: "demo-harbor-title",
    ...at(0, 0, 30, 4),
    content: "Harbor",
    variant: "h1",
  }),
  textBlock({
    id: "demo-harbor-oneliner",
    ...at(0, 5, 30, 5),
    content: "Curated restorative retreats for teams and solo operators.",
    variant: "h2",
  }),
  textBlock({
    id: "demo-harbor-tagline",
    ...at(0, 11, 30, 4),
    content:
      "Three-day and week-long packages in vetted rural houses. Wifi, food, and a house manager: handled. You bring the team and the work; we handle the other 80%.",
    variant: "body",
  }),
  imageBlock({
    id: "demo-harbor-hero",
    ...at(32, 0, 28, 14),
    url: unsplash("photo-1493809842364-78817add7ffb"),
    name: "harbor-hero.jpg",
    title: "Flagship house: Catskills",
  }),

  // — Problem ----------------------------------------------------------
  textBlock({
    id: "demo-harbor-problem-h",
    ...at(0, 16, 60, 3),
    content: "The problem",
    variant: "h2",
  }),
  textBlock({
    id: "demo-harbor-problem-body",
    ...at(0, 20, 38, 10),
    content:
      "Most offsites fail before they start. Teams book Airbnbs, lose day one to wifi and groceries, and leave without shipping anything. Solo founders and senior ICs almost never plan their own retreats. The logistics alone kill the intent.\n\nThe people who most need focused time don't take it, or take it badly.",
    variant: "body",
  }),
  imageBlock({
    id: "demo-harbor-problem-img",
    ...at(40, 20, 20, 10),
    url: unsplash("photo-1505691938895-1758d7feb511"),
    name: "chaotic-offsite.jpg",
    title: "Day one, usually",
  }),

  // — Who it's for ----------------------------------------------------
  textBlock({
    id: "demo-harbor-personas-h",
    ...at(0, 34, 60, 3),
    content: "Who it's for",
    variant: "h2",
  }),
  textBlock({
    id: "demo-harbor-persona-1",
    ...at(0, 38, 19, 10),
    content:
      "Distributed startup teams (4–12)\n\nSeed to Series B. Remote-first. Two offsites a year. Sick of someone on the team playing travel agent. Will pay for all-in pricing if the retreat feels thought-through.",
    variant: "body",
  }),
  textBlock({
    id: "demo-harbor-persona-2",
    ...at(20, 38, 19, 10),
    content:
      "Solo founders & senior ICs\n\nBurn-out prone. Need think-weeks to zoom out. Won't plan one themselves. Wants a quiet room, reliable food, and nobody asking questions until dinner.",
    variant: "body",
  }),
  textBlock({
    id: "demo-harbor-persona-3",
    ...at(40, 38, 20, 10),
    content:
      "Creative duos & writing partners\n\nAuthors, designers, podcasters. Sprinting to finish a thing. Taste-forward. Price-sensitive. Repeat customers if it lands the first time.",
    variant: "body",
  }),

  // — Solution --------------------------------------------------------
  textBlock({
    id: "demo-harbor-solution-h",
    ...at(0, 50, 60, 3),
    content: "What we do",
    variant: "h2",
  }),
  textBlock({
    id: "demo-harbor-solution-body",
    ...at(0, 54, 28, 13),
    content:
      "A small portfolio of vetted rural properties, each with a house manager. Every booking is a fixed package: arrival dinner, a couple of structured check-ins, one facilitated retro, and no other calendar.\n\nMeals, transport, wifi: handled. You arrive, you work, you leave with something shipped.\n\nWe say no to most things so we can say yes to the work.",
    variant: "body",
  }),
  textBlock({
    id: "demo-harbor-solution-features",
    ...at(29, 54, 14, 13),
    content:
      "vetted houses: wifi, ergonomics, sleep quality\nprivate chef or stocked pantry\nhouse manager 9am–8pm\noptional facilitator for retros\npre-arrival brief + departure recap\none flat, all-in price",
    variant: "body",
    listType: "bullet",
  }),
  imageBlock({
    id: "demo-harbor-solution-img",
    ...at(44, 54, 16, 13),
    url: unsplash("photo-1498050108023-c5249f4df085"),
    name: "retreat-workspace.jpg",
    title: "Shared workspace, Catskills",
  }),

  // — Market ----------------------------------------------------------
  textBlock({
    id: "demo-harbor-market-h",
    ...at(0, 68, 60, 3),
    content: "Market",
    variant: "h2",
  }),
  textBlock({
    id: "demo-harbor-market-stat-1",
    ...at(0, 72, 14, 8),
    content: "$12B\n\nUS offsite spend / year",
    variant: "body",
  }),
  textBlock({
    id: "demo-harbor-market-stat-2",
    ...at(15, 72, 14, 8),
    content: "68%\n\nremote teams run ≥1 offsite per year",
    variant: "body",
  }),
  textBlock({
    id: "demo-harbor-market-stat-3",
    ...at(30, 72, 14, 8),
    content: "$1.8K\n\navg. offsite cost per person",
    variant: "body",
  }),
  textBlock({
    id: "demo-harbor-market-stat-4",
    ...at(45, 72, 15, 8),
    content: "~45K\n\ndistributed US startups, bottom-up TAM ≈ $360M",
    variant: "body",
  }),

  // — Competition -----------------------------------------------------
  textBlock({
    id: "demo-harbor-comp-h",
    ...at(0, 84, 60, 3),
    content: "Competitive landscape",
    variant: "h2",
  }),
  textBlock({
    id: "demo-harbor-comp-1",
    ...at(0, 88, 29, 7),
    content:
      "Airbnb for Work\n\nInventory, zero ops. You still book, plan, and cook. Dominates the cheap end; doesn't touch our segment.",
    variant: "body",
  }),
  textBlock({
    id: "demo-harbor-comp-2",
    ...at(31, 88, 29, 7),
    content:
      "WeWork Workation\n\nUrban, not restorative. Product is effectively dead, which leaves a gap we can walk straight into.",
    variant: "body",
  }),
  textBlock({
    id: "demo-harbor-comp-3",
    ...at(0, 96, 29, 7),
    content:
      "Mindtrip / Pioneer Summits\n\nEvent-driven, not private. Good for discovery and networking, not for a team's own offsite.",
    variant: "body",
  }),
  textBlock({
    id: "demo-harbor-comp-4",
    ...at(31, 96, 29, 7),
    content:
      "Offsite Club / Onsite\n\nClosest competitor. Heavier facilitation, higher price point, US-only. We go lighter-touch and undercut by ~15%.",
    variant: "body",
  }),
  textBlock({
    id: "demo-harbor-positioning",
    ...at(0, 104, 60, 4),
    content:
      "Our wedge: handle the 80% nobody wants to handle, and leave the actual work alone. Not another facilitation company, not another booking platform: the thing in between.",
    variant: "body",
  }),

  // — Business model --------------------------------------------------
  textBlock({
    id: "demo-harbor-bm-h",
    ...at(0, 110, 60, 3),
    content: "How we make money",
    variant: "h2",
  }),
  textBlock({
    id: "demo-harbor-bm-day",
    ...at(0, 114, 19, 13),
    content:
      "Day Pass\n\n$340 / person / day\n2–8 guests · 2-night min\nFood included. BYO itinerary.\n\nEntry tier, designed to let teams try one night before committing to a full retreat.",
    variant: "body",
  }),
  textBlock({
    id: "demo-harbor-bm-team",
    ...at(20, 114, 19, 13),
    content:
      "Team Retreat\n\n$9,400 all-in / 3 days\nup to 10 guests\ndinners, facilitated retro, pre-brief, transport.\n\nFlagship product. This is what we want 80% of revenue to come from by end of year one.",
    variant: "body",
  }),
  textBlock({
    id: "demo-harbor-bm-annual",
    ...at(40, 114, 20, 13),
    content:
      "Annual Partner\n\n$60K / year / team ≤12\nthree retreats · priority booking\nquarterly planning calls · same-team priority.\n\nRetention product. Locks a team in, lifts LTV, smooths seasonality.",
    variant: "body",
  }),
  textBlock({
    id: "demo-harbor-bm-econ",
    ...at(0, 128, 60, 4),
    content:
      "Unit economics target: 38% contribution margin at steady state. Blended nightly rate needs to land near $180 per guest incl. food, transport, and staff. One house manager covers ~3 regional properties part-time until volume justifies full-time.",
    variant: "body",
  }),

  // — Go-to-market ----------------------------------------------------
  textBlock({
    id: "demo-harbor-gtm-h",
    ...at(0, 134, 60, 3),
    content: "Go-to-market",
    variant: "h2",
  }),
  textBlock({
    id: "demo-harbor-gtm-launch",
    ...at(0, 138, 28, 10),
    content:
      "Launch with three flagship properties: Catskills (signed), Oregon coast (LOI out), Sonoma foothills (sourcing).\n\nStart with 10 hand-picked YC and Series A CEOs for paid pilots. Convert three, write the essay, run the wedge publicly.",
    variant: "body",
  }),
  textBlock({
    id: "demo-harbor-gtm-channels",
    ...at(29, 138, 14, 10),
    content:
      "founder Twitter (owned)\nLenny's Newsletter sponsor\nYC partner referrals\nSeries A CEO outbound: 50 / mo\ncase studies after every retreat",
    variant: "body",
    listType: "bullet",
  }),
  textBlock({
    id: "demo-harbor-gtm-partners",
    ...at(44, 138, 16, 10),
    content:
      "Partnerships on the roadmap: Linear (shipping retreats), Notion (planning retreats), an a16z ops partner.\n\nCo-brand the first two. Measured by inbound inquiries / month per partner.",
    variant: "body",
  }),

  // — Roadmap ---------------------------------------------------------
  textBlock({
    id: "demo-harbor-roadmap-h",
    ...at(0, 152, 60, 3),
    content: "Roadmap: now / next / later",
    variant: "h2",
  }),
  textBlock({
    id: "demo-harbor-now",
    ...at(0, 156, 19, 13),
    content:
      "[x] Sign Catskills property (Apr 1)\n[x] Close ops co-founder\n[ ] Book 3 paid pilot retreats by Jun 15\n[ ] MVP booking + inquiry flow live\n[ ] Hire house manager #1\n[ ] Ship pricing page",
    variant: "body",
    listType: "todo",
    format: "todo",
  }),
  textBlock({
    id: "demo-harbor-next",
    ...at(20, 156, 19, 13),
    content:
      "[ ] Open Oregon coast property\n[ ] Launch Team Retreat tier publicly\n[ ] Complete 10 retreats end-to-end\n[ ] NPS ≥ 70 across first cohort\n[ ] First Annual Partner signed\n[ ] Brand refresh + new site",
    variant: "body",
    listType: "todo",
    format: "todo",
  }),
  textBlock({
    id: "demo-harbor-later",
    ...at(40, 156, 20, 13),
    content:
      "[ ] 6 properties across 3 regions\n[ ] Alumni community (return-rate > 40%)\n[ ] International pilot: Portugal, Japan\n[ ] Operator playbook productized\n[ ] $3M ARR",
    variant: "body",
    listType: "todo",
    format: "todo",
  }),

  // — Team ------------------------------------------------------------
  textBlock({
    id: "demo-harbor-team-h",
    ...at(0, 172, 60, 3),
    content: "Team",
    variant: "h2",
  }),
  textBlock({
    id: "demo-harbor-team-body",
    ...at(0, 176, 38, 10),
    content:
      "Founder: ex-product designer, 10 years remote, built ops for a YC B2B SaaS.\n\nOps co-founder: former Ace Hotel GM; has opened two boutique properties from scratch.\n\nAdvisor: two-time founder, YC W19, operates in the adjacent hospitality space.\n\nFirst in-person house manager this quarter. Chef roster stays 1099 until volume justifies W2.",
    variant: "body",
  }),
  imageBlock({
    id: "demo-harbor-team-img",
    ...at(40, 176, 20, 10),
    url: unsplash("photo-1487958449943-2429e8be8625"),
    name: "team-space.jpg",
    title: "Ops room",
  }),

  // — Risks & assumptions --------------------------------------------
  textBlock({
    id: "demo-harbor-risks-h",
    ...at(0, 190, 60, 3),
    content: "Risks & assumptions",
    variant: "h2",
  }),
  textBlock({
    id: "demo-harbor-risks",
    ...at(0, 194, 29, 10),
    content:
      "Risks:\nseasonality: Q1 and Q4 booking soft in most regions\nproperty damage / insurance edge cases at B2B scale\nhouse-manager single-points-of-failure cascade to full retreat\nteam offsite budgets contract sharply in a downturn\nbrand risk if one retreat goes badly (NPS has to stay high early)",
    variant: "body",
    listType: "bullet",
  }),
  textBlock({
    id: "demo-harbor-assumptions",
    ...at(31, 194, 29, 10),
    content:
      "Assumptions:\nteams will pay a premium to not think about logistics\n3 days is the minimum viable retreat length\none house manager can cover ~3 regional properties\nword-of-mouth conversion exceeds 25% within 18 months\nremote-first teams aren't going back, offsites are permanent",
    variant: "body",
    listType: "bullet",
  }),

  // — Open questions --------------------------------------------------
  textBlock({
    id: "demo-harbor-q-h",
    ...at(0, 208, 60, 3),
    content: "Open questions",
    variant: "h2",
  }),
  textBlock({
    id: "demo-harbor-q-body",
    ...at(0, 212, 60, 10),
    content:
      "Do we own, lease, or broker the properties? The capital/control tradeoff is the single biggest model decision and we haven't nailed it.\n\nHow much facilitation do teams actually want: zero, light, or heavy? Our gut says light; the first three retreats will tell us.\n\nIs there a B2C version (writers, creators, couples), or do we stay strictly B2B until the model is proven?\n\nBrand voice: 'restorative' or 'ship-it'? Both? The landing page is doing gymnastics right now.",
    variant: "body",
  }),

  // — Mood references -------------------------------------------------
  textBlock({
    id: "demo-harbor-mood-h",
    ...at(0, 224, 60, 3),
    content: "Mood references",
    variant: "h2",
  }),
  imageBlock({
    id: "demo-harbor-mood-1",
    ...at(0, 228, 14, 9),
    url: unsplash("photo-1464822759023-fed622ff2c3b"),
    name: "mood-morning.jpg",
    title: "Arrival view",
  }),
  imageBlock({
    id: "demo-harbor-mood-2",
    ...at(15, 228, 14, 9),
    url: unsplash("photo-1505142468610-359e7d316be0"),
    name: "mood-coast.jpg",
    title: "Oregon coast concept",
  }),
  imageBlock({
    id: "demo-harbor-mood-3",
    ...at(30, 228, 14, 9),
    url: unsplash("photo-1500382017468-9049fed747ef"),
    name: "mood-field.jpg",
    title: "Sonoma concept",
  }),
  imageBlock({
    id: "demo-harbor-mood-4",
    ...at(45, 228, 15, 9),
    url: unsplash("photo-1495474472287-4d71bcdd2085"),
    name: "mood-ritual.jpg",
    title: "Morning ritual: the product moment",
  }),

  // — Next check-ins --------------------------------------------------
  textBlock({
    id: "demo-harbor-checkin-h",
    ...at(0, 240, 60, 3),
    content: "Next check-ins",
    variant: "h2",
  }),
  textBlock({
    id: "demo-harbor-todos",
    ...at(0, 244, 29, 10),
    content:
      "[ ] Close pilot property #2 by Apr 30\n[ ] Write 'Why offsites fail' essay, publish May 5\n[ ] Run pricing page past 5 founder friends\n[ ] Interview 3 house-manager candidates\n[ ] Rework projections with Q1 actuals",
    variant: "body",
    listType: "todo",
    format: "todo",
  }),
  textBlock({
    id: "demo-harbor-metrics",
    ...at(31, 244, 29, 10),
    content:
      "Metrics to watch:\ninquiry → booking conversion\navg. nights per booking\npost-retreat NPS\nreturn-rate within 12 months\ncontribution margin per retreat",
    variant: "body",
    listType: "bullet",
  }),
];

// Wires stay short and local so they route through the gaps between
// blocks instead of cutting across sections. Adjacent-column wires use
// the 1-cell gap between cards. Cross-section wires exit into the right
// gutter (x > 60 cells, always empty in the linear layout) so the
// bezier bulges into open space.
const harborWires = [
  // problem body ↔ its supporting image (short, 2-cell gap)
  wire("demo-harbor-wire-1", "demo-harbor-problem-body", "right", "demo-harbor-problem-img", "left"),
  // persona flow (adjacent cards)
  wire("demo-harbor-wire-2", "demo-harbor-persona-1", "right", "demo-harbor-persona-2", "left"),
  wire("demo-harbor-wire-3", "demo-harbor-persona-2", "right", "demo-harbor-persona-3", "left"),
  // upsell ladder across the three pricing tiers
  wire("demo-harbor-wire-4", "demo-harbor-bm-day", "right", "demo-harbor-bm-team", "left"),
  wire("demo-harbor-wire-5", "demo-harbor-bm-team", "right", "demo-harbor-bm-annual", "left"),
  // closest competitor → our positioning (both on right edge, wire bulges into the right gutter)
  wire("demo-harbor-wire-6", "demo-harbor-comp-4", "right", "demo-harbor-positioning", "right"),
  // risks ↔ assumptions (adjacent columns, 2-cell gap)
  wire("demo-harbor-wire-7", "demo-harbor-risks", "right", "demo-harbor-assumptions", "left"),
  // TAM → later-roadmap ambition (long vertical via the right gutter)
  wire("demo-harbor-wire-8", "demo-harbor-market-stat-4", "right", "demo-harbor-later", "right"),
];

/* ================================================================== */
/*  Grid 2 — Greenroom (content creation) · CLUSTER layout             */
/* ================================================================== */
//
// Two-column cluster layout with a visible empty gutter at cx=60..72.
// Related info sits in aligned rows (identity ↔ audience, purpose ↔
// pillars, rhythm ↔ calendar, etc.) so readers can scan horizontally
// as well as vertically. Three full-width bands at the bottom (mood,
// this-week) break the column rhythm.

const greenroomBlocks = [
  // — ROW 1: identity (left) + audience (right) ----------------------
  textBlock({
    id: "demo-green-title",
    ...at(0, 0, 30, 4),
    content: "Greenroom",
    variant: "h1",
  }),
  textBlock({
    id: "demo-green-oneliner",
    ...at(0, 5, 30, 5),
    content: "A weekly essay and an interview podcast about creative work.",
    variant: "h2",
  }),
  textBlock({
    id: "demo-green-tagline",
    ...at(0, 11, 30, 5),
    content:
      "For people who make things (writers, designers, founders, musicians) trying to do the work without burning themselves out. 10K subscribers, shipping since 2024.",
    variant: "body",
  }),
  imageBlock({
    id: "demo-green-hero",
    ...at(32, 0, 28, 14),
    url: unsplash("photo-1517842645767-c639042777db"),
    name: "greenroom-hero.jpg",
    title: "Desk: essay draft in progress",
  }),

  textBlock({
    id: "demo-green-audience-h",
    ...at(72, 0, 58, 3),
    content: "Who reads this",
    variant: "h2",
  }),
  textBlock({
    id: "demo-green-audience-1",
    ...at(72, 4, 18, 10),
    content:
      "Working creatives\n\nWriters, designers, solo devs. Ten years in, mid-career, quietly restless. Reads Craig Mod, Mandy Brown, Ethan Marcotte.",
    variant: "body",
  }),
  textBlock({
    id: "demo-green-audience-2",
    ...at(92, 4, 18, 10),
    content:
      "Thoughtful founders\n\nRunning a 2–20 person studio or product team. Wants to think about craft, not just ops. Would pay for a good essay.",
    variant: "body",
  }),
  textBlock({
    id: "demo-green-audience-3",
    ...at(112, 4, 18, 10),
    content:
      "Creative-adjacent operators\n\nNot creatives full-time, but work next to them. Value-reading. Share widely. Largest count, smallest depth.",
    variant: "body",
  }),

  // — ROW 2: purpose (left) + pillars (right) ------------------------
  textBlock({
    id: "demo-green-what-h",
    ...at(0, 18, 60, 3),
    content: "What this is",
    variant: "h2",
  }),
  textBlock({
    id: "demo-green-what-body",
    ...at(0, 22, 28, 10),
    content:
      "A personal publication about the craft, mess, and economics of creative work. Essay every Thursday. Podcast every other Monday: long, uncut conversations with people who ship things I admire.\n\nNo productivity tips. No hacks.",
    variant: "body",
  }),
  textBlock({
    id: "demo-green-goal",
    ...at(30, 22, 30, 10),
    content:
      "2026 goal\n\n25K subscribers.\nPaid tier launched.\nTwo long-term sponsors.\nFour live events.\n\nThe measure isn't scale. It's whether readers tell their friends unprompted.",
    variant: "body",
  }),

  textBlock({
    id: "demo-green-pillars-h",
    ...at(72, 18, 58, 3),
    content: "Content pillars",
    variant: "h2",
  }),
  textBlock({
    id: "demo-green-pillar-1",
    ...at(72, 22, 18, 12),
    content:
      "Craft: 50%\n\nHow the work actually gets made. Process essays, detailed case studies, post-mortems. The biggest pillar; the reason people subscribe.",
    variant: "body",
  }),
  textBlock({
    id: "demo-green-pillar-2",
    ...at(92, 22, 18, 12),
    content:
      "Economics: 30%\n\nHow creative work is paid for (or isn't). Pricing, contracts, platform economics, side income. The pillar that travels furthest on social.",
    variant: "body",
  }),
  textBlock({
    id: "demo-green-pillar-3",
    ...at(112, 22, 18, 12),
    content:
      "Practice: 20%\n\nHabits, rituals, burnout, the internal side of the work. Counterweight to the other two. Slower to write, essential to voice.",
    variant: "body",
  }),

  // — ROW 3: weekly rhythm (left) + editorial calendar (right) -------
  textBlock({
    id: "demo-green-rhythm-h",
    ...at(0, 38, 60, 3),
    content: "Weekly rhythm",
    variant: "h2",
  }),
  textBlock({
    id: "demo-green-mon",
    ...at(0, 42, 11, 8),
    content: "Mon\n\nOutline next essay. Record podcast if scheduled.",
    variant: "body",
  }),
  textBlock({
    id: "demo-green-tue",
    ...at(12, 42, 11, 8),
    content: "Tue\n\nDraft. One 3-hour deep block, no meetings.",
    variant: "body",
  }),
  textBlock({
    id: "demo-green-wed",
    ...at(24, 42, 11, 8),
    content: "Wed\n\nEdit pass. Sleep on it.",
    variant: "body",
  }),
  textBlock({
    id: "demo-green-thu",
    ...at(36, 42, 11, 8),
    content: "Thu\n\nShip essay 7am PT. Amplify 9am.",
    variant: "body",
  }),
  textBlock({
    id: "demo-green-fri",
    ...at(48, 42, 12, 8),
    content: "Fri\n\nAnalytics, reader replies, planning next week.",
    variant: "body",
  }),

  textBlock({
    id: "demo-green-cal-h",
    ...at(72, 38, 58, 3),
    content: "Editorial calendar: next 8 weeks",
    variant: "h2",
  }),
  textBlock({
    id: "demo-green-cal-w1",
    ...at(72, 42, 13, 7),
    content: "W1 (this week)\nEssay: The price of context-switching",
    variant: "body",
  }),
  textBlock({
    id: "demo-green-cal-w2",
    ...at(86, 42, 13, 7),
    content: "W2\nPodcast Ep. 12: Craig Mod on place",
    variant: "body",
  }),
  textBlock({
    id: "demo-green-cal-w3",
    ...at(100, 42, 13, 7),
    content: "W3\nEssay: Why I don't do discovery calls",
    variant: "body",
  }),
  textBlock({
    id: "demo-green-cal-w4",
    ...at(114, 42, 16, 7),
    content: "W4\nEssay: Five things I'd tell 2018 me",
    variant: "body",
  }),
  textBlock({
    id: "demo-green-cal-w5",
    ...at(72, 50, 13, 7),
    content: "W5\nPodcast Ep. 13: Kate Darling on weird objects",
    variant: "body",
  }),
  textBlock({
    id: "demo-green-cal-w6",
    ...at(86, 50, 13, 7),
    content: "W6\nEssay: Pricing by the hour is a trap",
    variant: "body",
  }),
  textBlock({
    id: "demo-green-cal-w7",
    ...at(100, 50, 13, 7),
    content: "W7\nQuarterly field-notes dump",
    variant: "body",
  }),
  textBlock({
    id: "demo-green-cal-w8",
    ...at(114, 50, 16, 7),
    content: "W8\nPodcast Ep. 14: guest TBD",
    variant: "body",
  }),

  // — ROW 4: voice & style (left) + metrics (right) ------------------
  textBlock({
    id: "demo-green-voice-h",
    ...at(0, 58, 60, 3),
    content: "Voice & style",
    variant: "h2",
  }),
  textBlock({
    id: "demo-green-voice-dos",
    ...at(0, 62, 29, 10),
    content:
      "Do:\nwrite in short paragraphs\nopen with a scene or an idea, never a lead-in\nuse first person\nname the names\nship when it's good, not when it's perfect\ncut one paragraph from every essay before publishing",
    variant: "body",
    listType: "bullet",
  }),
  textBlock({
    id: "demo-green-voice-donts",
    ...at(31, 62, 29, 10),
    content:
      "Don't:\nuse 'craft' in a headline (overplayed)\nopen with 'recently I've been thinking…'\nbullet-list when a paragraph works\npromote two things at once\nquote myself in my own tweet\npublish on Mondays (dead zone)",
    variant: "body",
    listType: "bullet",
  }),

  textBlock({
    id: "demo-green-metrics-h",
    ...at(72, 58, 58, 3),
    content: "Metrics",
    variant: "h2",
  }),
  textBlock({
    id: "demo-green-metric-1",
    ...at(72, 62, 13, 8),
    content: "10.4K\n\nsubscribers, growing ~4% / mo",
    variant: "body",
  }),
  textBlock({
    id: "demo-green-metric-2",
    ...at(86, 62, 13, 8),
    content: "61%\n\navg. essay open rate",
    variant: "body",
  }),
  textBlock({
    id: "demo-green-metric-3",
    ...at(100, 62, 13, 8),
    content: "3.8%\n\navg. click rate (target 3%)",
    variant: "body",
  }),
  textBlock({
    id: "demo-green-metric-4",
    ...at(114, 62, 16, 8),
    content: "4.1K\n\npodcast downloads by day 7",
    variant: "body",
  }),

  // — ROW 5: growth loops (left) + interview pipeline (right) --------
  textBlock({
    id: "demo-green-growth-h",
    ...at(0, 78, 66, 3),
    content: "Growth loops",
    variant: "h2",
  }),
  textBlock({
    id: "demo-green-loop-1",
    ...at(0, 82, 21, 9),
    content:
      "Referrals\n\nAvg reader shares to 1.8 friends. At 5 referrals, a limited-run essay print.\n\nStatus: live, working.",
    variant: "body",
  }),
  textBlock({
    id: "demo-green-loop-2",
    ...at(22, 82, 21, 9),
    content:
      "Guest cross-post\n\nEvery podcast guest gets a clean essay version of their interview to share. Pulls ~200 subs per drop.\n\nStatus: live, working.",
    variant: "body",
  }),
  textBlock({
    id: "demo-green-loop-3",
    ...at(44, 82, 22, 9),
    content:
      "Search\n\nOlder craft essays drive search inflow. Need: rewrite the 5 best-performing posts with TOCs + better metadata.\n\nStatus: Q2 project.",
    variant: "body",
  }),

  textBlock({
    id: "demo-green-pipeline-h",
    ...at(72, 78, 58, 3),
    content: "Interview pipeline",
    variant: "h2",
  }),
  textBlock({
    id: "demo-green-pipeline-body",
    ...at(72, 82, 58, 9),
    content:
      "Confirmed:\n• Ep. 12 Craig Mod (recorded, drops W2)\n• Ep. 13 Kate Darling (calendar hold)\n\nOutreach pending:\n• Mandy Brown · Ethan Marcotte · Robin Sloan\n\nCold list, Q3:\n• Jenny Odell · Austin Kleon · Mike Monteiro · Oliver Reichenstein",
    variant: "body",
  }),

  // — ROW 6: monetization (left) + tool stack (right) ----------------
  textBlock({
    id: "demo-green-money-h",
    ...at(0, 95, 66, 3),
    content: "Monetization",
    variant: "h2",
  }),
  textBlock({
    id: "demo-green-tier-free",
    ...at(0, 99, 21, 11),
    content:
      "Free\n\nEvery essay. Every podcast. The whole archive.\n\nThis will always be the case. The free tier is the product.",
    variant: "body",
  }),
  textBlock({
    id: "demo-green-tier-paid",
    ...at(22, 99, 21, 11),
    content:
      "Paid: $8/mo or $72/yr\n\nMonthly deep-dive essay, subscriber Q&A, subscriber-only podcast cut.\n\nTarget: 2% of list by EOY. 200 paid subs ≈ $14K/yr.",
    variant: "body",
  }),
  textBlock({
    id: "demo-green-tier-spons",
    ...at(44, 99, 22, 11),
    content:
      "Sponsors: 2 slots\n\nOne podcast, one newsletter. $2.5K / drop.\n\nOnly products I actually use. No more than one per week.",
    variant: "body",
  }),

  textBlock({
    id: "demo-green-tools-h",
    ...at(72, 95, 58, 3),
    content: "Tool stack",
    variant: "h2",
  }),
  textBlock({
    id: "demo-green-tools-body",
    ...at(72, 99, 28, 11),
    content:
      "Ghost: newsletter + archive\nDescript: podcast editing\nRiverside: remote recordings\nBuffer: social scheduling\nPlausible: analytics (no Google)\nNotion: editorial calendar\nFigma: essay illustrations",
    variant: "body",
    listType: "bullet",
  }),
  textBlock({
    id: "demo-green-tools-notes",
    ...at(102, 99, 28, 11),
    content:
      "Considered Substack, stayed on Ghost for ownership. Tried Squadcast, switched to Riverside after two dropped recordings. Plausible is non-negotiable. Google Analytics signals the wrong thing to readers.",
    variant: "body",
  }),

  // — ROW 7: publishing workflow (full-width under the columns) ------
  textBlock({
    id: "demo-green-workflow-h",
    ...at(0, 114, 130, 3),
    content: "Publishing workflow",
    variant: "h2",
  }),
  textBlock({
    id: "demo-green-workflow-body",
    ...at(0, 118, 130, 8),
    content:
      "1. Draft in Ghost, hit preview.   2. Read aloud: every paragraph, every sentence. If a sentence stumbles, cut it.   3. Edit pass with the style-sheet pinned.   4. Schedule for Thu 7:00 PT.   5. Write three amplification posts: Twitter, LinkedIn, Bluesky. Each different, each pulling the same thread.   6. Two hours after drop: reply to every DM for one hour, then stop.   7. Friday: skim analytics, not before (they're a trap).",
    variant: "body",
  }),

  // — ROW 8: mood / covers band (full-width) ------------------------
  textBlock({
    id: "demo-green-mood-h",
    ...at(0, 130, 130, 3),
    content: "Mood & covers",
    variant: "h2",
  }),
  imageBlock({
    id: "demo-green-mood-1",
    ...at(0, 134, 30, 10),
    url: unsplash("photo-1495474472287-4d71bcdd2085"),
    name: "mood-coffee.jpg",
    title: "Morning draft session",
  }),
  imageBlock({
    id: "demo-green-mood-2",
    ...at(32, 134, 30, 10),
    url: unsplash("photo-1498050108023-c5249f4df085"),
    name: "mood-desk.jpg",
    title: "Studio desk",
  }),
  imageBlock({
    id: "demo-green-mood-3",
    ...at(64, 134, 30, 10),
    url: unsplash("photo-1487958449943-2429e8be8625"),
    name: "mood-architecture.jpg",
    title: "Cover reference",
  }),
  imageBlock({
    id: "demo-green-mood-4",
    ...at(96, 134, 34, 10),
    url: unsplash("photo-1505691938895-1758d7feb511"),
    name: "mood-studio.jpg",
    title: "Podcast setup",
  }),

  // — ROW 9: this week (full-width) ---------------------------------
  textBlock({
    id: "demo-green-week-h",
    ...at(0, 148, 130, 3),
    content: "This week",
    variant: "h2",
  }),
  textBlock({
    id: "demo-green-week-todos",
    ...at(0, 152, 60, 10),
    content:
      "[ ] Ship 'Price of context-switching' essay by Thu 7am\n[ ] Re-record intro for Ep. 12\n[ ] Draft outreach note to Mandy Brown\n[ ] Archive cleanup: tag top 20 craft essays\n[ ] Buy prints for referral milestone",
    variant: "body",
    listType: "todo",
    format: "todo",
  }),
  textBlock({
    id: "demo-green-week-notes",
    ...at(64, 152, 66, 10),
    content:
      "Open threads:\nShould the podcast move weekly? Probably not. One solid ep beats two mid ones.\nPaid tier copy still not landing. Try the Craig Mod episode as the first lead magnet.\nBluesky is outperforming Twitter for share-through. Lean in.",
    variant: "body",
  }),
];

// Wires highlight cross-cluster thinking: which audience the first
// pillar serves, how pillars drive the calendar, how Friday's planning
// feeds next week, how the cross-post loop feeds the podcast pipeline,
// and how the pipeline drives download numbers.
// Clustered layout has two visible gutters: the middle corridor between
// the left column (x 0-60) and the right column (x 72-130), and the
// right margin (x > 130). Every wire routes through one of those or
// through the 1-cell gaps between sibling cards so nothing cuts through
// a block.
const greenroomWires = [
  // tagline (left column) → first audience persona (right column).
  // Routes DOWN past the hero image (hero occupies x 32-60 / y 0-14)
  // via two waypoints that slip under its bottom edge, then across the
  // middle gutter at y=17 and up into the persona row.
  wire("demo-green-wire-1", "demo-green-tagline", "right", "demo-green-audience-1", "left", [
    wpc(30, 17),
    wpc(66, 17),
  ]),
  // audience persona → the pillar they read. Both blocks live in the
  // same x-column (72-90); using left-to-left lets the default bezier
  // bulge LEFT into the empty middle gutter instead of dropping
  // straight down through the pillars header.
  wire("demo-green-wire-2", "demo-green-audience-1", "left", "demo-green-pillar-1", "left"),
  // pillars section → calendar section. Right-to-right at the canvas
  // edge — the bezier bulges further right into the empty margin past
  // the right column.
  wire("demo-green-wire-3", "demo-green-pillars-h", "right", "demo-green-cal-h", "right"),
  // friday recap → saturday long-form. Short hop across the middle
  // gutter between columns.
  wire("demo-green-wire-4", "demo-green-fri", "right", "demo-green-cal-w1", "left"),
  // top download-source metric → the research pipeline that feeds it.
  // Targets the pipeline header (not body) so the wire doesn't have to
  // cross it; the bezier stays in the gap above pipeline-h.
  wire("demo-green-wire-5", "demo-green-metric-4", "bottom", "demo-green-pipeline-h", "top"),
];

/* ================================================================== */
/*  Grid 3 — Studio 12 (design spaces) · SPATIAL floor-plan layout     */
/* ================================================================== */
//
// The four zone cards are placed roughly where those zones live in the
// actual room: desk at the top (north, by the window), reading chair
// upper-west, sleep corner lower-west, bookshelf running the full east
// wall, closet south-center, door at the bottom. Palette sits along
// the east edge of the canvas (the "wall" that gets most of the
// color). Current-state photos sit far west as the "before." Furniture,
// moodboard, and the rest of the project doc stack below the floor
// plan as supporting material.

const studio12Blocks = [
  // — Masthead (full-width across the top) ---------------------------
  textBlock({
    id: "demo-studio-title",
    ...at(0, 0, 30, 4),
    content: "Studio 12",
    variant: "h1",
  }),
  textBlock({
    id: "demo-studio-oneliner",
    ...at(0, 5, 30, 5),
    content: "Redesigning the back room: home studio + reading floor.",
    variant: "h2",
  }),
  textBlock({
    id: "demo-studio-brief",
    ...at(0, 11, 30, 5),
    content:
      "460 sq ft. One window, north-facing. Currently: storage, an unused bike, a wobbly IKEA desk. Ambition: a proper studio for writing and reading, with a sleep corner guests would actually want to stay in.\n\nBudget: $9,000 all-in. Timeline: 6 weeks. Completion: mid-July.",
    variant: "body",
  }),
  imageBlock({
    id: "demo-studio-hero",
    ...at(32, 0, 38, 14),
    url: unsplash("photo-1493809842364-78817add7ffb"),
    name: "studio-hero.jpg",
    title: "Reference: warmth, light, restraint",
  }),
  textBlock({
    id: "demo-studio-budget",
    ...at(72, 0, 18, 14),
    content:
      "Budget: $9,000\n\n$3.5K furniture\n$2K paint + floor\n$1.5K lighting\n$1K rugs + textiles\n$1K contingency\n\nHard ceiling. No financing.",
    variant: "body",
  }),
  textBlock({
    id: "demo-studio-time",
    ...at(92, 0, 18, 14),
    content:
      "Time: 6 weeks\n\nStart: Jun 3\nW1: paint + floor\nW2–3: furniture\nW4–5: lighting\nW6: move-in\nDone: Jul 14",
    variant: "body",
  }),
  textBlock({
    id: "demo-studio-structural",
    ...at(112, 0, 18, 14),
    content:
      "Structural\n\nNo plumbing changes.\nCan add outlets.\nCan't cut the north wall.\nCeiling: 8'6\".\nFloor: existing pine (refinish, not replace).",
    variant: "body",
  }),

  // — Current state — "before" photos on the far west ----------------
  textBlock({
    id: "demo-studio-current-h",
    ...at(0, 18, 22, 3),
    content: "Before",
    variant: "h2",
  }),
  imageBlock({
    id: "demo-studio-current-1",
    ...at(0, 22, 22, 12),
    url: unsplash("photo-1505691938895-1758d7feb511"),
    name: "before-1.jpg",
    title: "Looking in from the hall",
  }),
  imageBlock({
    id: "demo-studio-current-2",
    ...at(0, 35, 22, 12),
    url: unsplash("photo-1498050108023-c5249f4df085"),
    name: "before-2.jpg",
    title: "Current desk corner",
  }),
  textBlock({
    id: "demo-studio-current-notes",
    ...at(0, 48, 22, 8),
    content:
      "Pain points: overhead lighting. No dedicated desk. I work on the kitchen table and drag books around. Reading on the couch, falling asleep by 9. One closet full of things I haven't touched in two years.",
    variant: "body",
  }),

  // — Floor plan centerpiece — zones placed spatially ----------------
  textBlock({
    id: "demo-studio-floor-h",
    ...at(28, 18, 76, 3),
    content: "Floor plan: the room",
    variant: "h2",
  }),
  textBlock({
    id: "demo-studio-floor-intro",
    ...at(28, 22, 76, 3),
    content:
      "Each card below sits roughly where the zone lives. North is up: the window is along the top edge; you enter from the bottom.",
    variant: "body",
  }),

  // Desk — north (top), centered on the window
  textBlock({
    id: "demo-studio-zone-desk",
    ...at(38, 28, 54, 10),
    content:
      "Desk: 48×28  ·  north wall, centered on the window\n\nThe anchor. Full-spectrum task lamp. Nothing on it except what's in use. Chair that won't make me slouch by 3pm.",
    variant: "body",
  }),

  // Reading chair — upper-west
  textBlock({
    id: "demo-studio-zone-read",
    ...at(30, 42, 18, 12),
    content:
      "Reading chair + side table\nwest, upper\n\nGood leather chair, floor lamp, stack of current books. Visible and inviting from the door.",
    variant: "body",
  }),

  // Sleep corner — lower-west
  textBlock({
    id: "demo-studio-zone-sleep",
    ...at(30, 58, 18, 14),
    content:
      "Sleep corner: full bed\nwest, lower\n\nTucked behind a low (36 in) open shelf acting as a subtle divider. Curtain, not a door. 2–3 guest nights / quarter.",
    variant: "body",
  }),

  // Bookshelf — tall, runs the full east wall
  textBlock({
    id: "demo-studio-zone-shelf",
    ...at(84, 42, 18, 30),
    content:
      "Built-in shelving\nfull east wall\n\nBooks, paper, supplies, one hidden cable drawer.\n\nAim for ~30% empty on install. Rooms need room to grow.",
    variant: "body",
  }),

  // Closet — south-center
  textBlock({
    id: "demo-studio-zone-closet",
    ...at(54, 60, 22, 12),
    content:
      "Closet\nsouth, center\n\nClothes + linens + taped-up box of things I haven't opened since the last move. Decision in week 2: keep or donate.",
    variant: "body",
  }),

  // Door marker — south
  textBlock({
    id: "demo-studio-door",
    ...at(54, 74, 22, 3),
    content: "↓   doorway   ↓",
    variant: "body",
  }),

  // Floor-plan body notes — below the plan
  textBlock({
    id: "demo-studio-floor-notes",
    ...at(28, 79, 76, 9),
    content:
      "Walk in: reading chair to the left, backed by the bookshelf wall. Pass through to the desk at the far end, centered on the north window. Sleep corner carved out of the west, behind a low open shelf. Closet south, beside the door.\n\nCirculation: 36-inch cleared zones everywhere. Never forces you to squeeze past the desk chair to reach the reading chair.",
    variant: "body",
  }),

  // — Palette & materials — along the east edge ----------------------
  textBlock({
    id: "demo-studio-palette-h",
    ...at(108, 18, 22, 3),
    content: "Palette",
    variant: "h2",
  }),
  textBlock({
    id: "demo-studio-swatch-1",
    ...at(108, 22, 22, 10),
    content:
      "Warm off-white\nFarrow & Ball School House White (No. 291)\n\nAll walls. Soft, reads warm in north light.",
    variant: "body",
  }),
  textBlock({
    id: "demo-studio-swatch-2",
    ...at(108, 33, 22, 10),
    content:
      "Deep inked blue\nBenjamin Moore Hale Navy\n\nAccent wall behind the desk. Holds the focus of the room at night.",
    variant: "body",
  }),
  textBlock({
    id: "demo-studio-swatch-3",
    ...at(108, 44, 22, 10),
    content:
      "Honey oak\nExisting floor, refinished\n\nNo stain. Let it age. The one warm neutral the whole room sits on.",
    variant: "body",
  }),
  textBlock({
    id: "demo-studio-materials",
    ...at(108, 55, 22, 11),
    content:
      "Materials\nlinen: curtains + throw\nwool: 8×10 hand-knotted rug\nmatte brass: lamp bases, hardware\ncognac leather: reading chair\npaper: task lamp shades",
    variant: "body",
    listType: "bullet",
  }),

  // — Lighting plan — tucked under the current-state column ----------
  textBlock({
    id: "demo-studio-light-h",
    ...at(0, 60, 22, 3),
    content: "Lighting",
    variant: "h2",
  }),
  textBlock({
    id: "demo-studio-light-body",
    ...at(0, 64, 22, 14),
    content:
      "Three layers: ambient, task, accent.\n\nOverhead becomes a flush brass ring, dimmable. Task light at the desk (Anglepoise). Reading chair: floor lamp w/ paper shade. Accent: picture light over the bookshelf.\n\nRule: the room should be readable at 6pm without flipping anything on. If I need the overhead, lighting failed.",
    variant: "body",
  }),
  imageBlock({
    id: "demo-studio-light-img",
    ...at(0, 79, 22, 9),
    url: unsplash("photo-1519682337058-a94d519337bc"),
    name: "light-ref.jpg",
    title: "Lighting reference",
  }),

  // — Furniture picks — full-width row below the floor plan ----------
  textBlock({
    id: "demo-studio-furn-h",
    ...at(0, 94, 130, 3),
    content: "Furniture picks",
    variant: "h2",
  }),
  textBlock({
    id: "demo-studio-furn-desk",
    ...at(0, 98, 32, 12),
    content:
      "Desk\nFloyd The Table, 48×28\n\nBlack linoleum on birch ply. $795. Flat-packs.\nIn stock, ready to ship.",
    variant: "body",
  }),
  textBlock({
    id: "demo-studio-furn-chair",
    ...at(33, 98, 32, 12),
    content:
      "Chair\nHerman Miller Sayl, grey\n\nRefurbished $420. Ergonomic without being imposing.\nReady to order.",
    variant: "body",
  }),
  textBlock({
    id: "demo-studio-furn-read",
    ...at(66, 98, 32, 12),
    content:
      "Reading chair\nThrift / estate sale, ~$800 budget\n\nMid-century, leather, low arms. Actively hunting.\nNot sourced yet.",
    variant: "body",
  }),
  textBlock({
    id: "demo-studio-furn-shelf",
    ...at(99, 98, 31, 12),
    content:
      "Shelving\nCustom built-in, ~$1,400\n\nLocal carpenter (Diego). Honey oak, site-built.\nQuoted. Awaiting schedule.",
    variant: "body",
  }),

  // — Moodboard band (full-width) ------------------------------------
  textBlock({
    id: "demo-studio-mood-h",
    ...at(0, 114, 130, 3),
    content: "Moodboard",
    variant: "h2",
  }),
  imageBlock({
    id: "demo-studio-mood-1",
    ...at(0, 118, 20, 10),
    url: unsplash("photo-1493809842364-78817add7ffb"),
    name: "mood-warm-room.jpg",
    title: "Warm interior",
  }),
  imageBlock({
    id: "demo-studio-mood-2",
    ...at(22, 118, 20, 10),
    url: unsplash("photo-1505691938895-1758d7feb511"),
    name: "mood-studio-corner.jpg",
    title: "Studio corner",
  }),
  imageBlock({
    id: "demo-studio-mood-3",
    ...at(44, 118, 20, 10),
    url: unsplash("photo-1498050108023-c5249f4df085"),
    name: "mood-desk.jpg",
    title: "Minimal desk",
  }),
  imageBlock({
    id: "demo-studio-mood-4",
    ...at(66, 118, 20, 10),
    url: unsplash("photo-1487958449943-2429e8be8625"),
    name: "mood-architecture.jpg",
    title: "Light + volume",
  }),
  imageBlock({
    id: "demo-studio-mood-5",
    ...at(88, 118, 20, 10),
    url: unsplash("photo-1519682337058-a94d519337bc"),
    name: "mood-textures.jpg",
    title: "Soft textures",
  }),
  imageBlock({
    id: "demo-studio-mood-6",
    ...at(110, 118, 20, 10),
    url: unsplash("photo-1441974231531-c6227db76b6e"),
    name: "mood-natural.jpg",
    title: "Natural materials",
  }),
  textBlock({
    id: "demo-studio-mood-notes",
    ...at(0, 129, 130, 6),
    content:
      "Throughline: quiet, warm, and under-filled. Every image has more empty surface than filled. Light is always indirect. Wood and linen do most of the work; metal is the seasoning. Anti-pattern to avoid: the 'Pinterest Scandinavian' trap: too many greys, too few books, too much performance.",
    variant: "body",
  }),

  // — Phased plan + sourcing (two columns, narrower) -----------------
  textBlock({
    id: "demo-studio-phase-h",
    ...at(0, 138, 70, 3),
    content: "Phased plan",
    variant: "h2",
  }),
  textBlock({
    id: "demo-studio-phase-1",
    ...at(0, 142, 22, 10),
    content:
      "Week 1: shell\n\nClear room. Patch + prime. Paint first coat. Refinish floor.\n\nOutcome: clean, freshly painted shell.",
    variant: "body",
  }),
  textBlock({
    id: "demo-studio-phase-2",
    ...at(24, 142, 22, 10),
    content:
      "Weeks 2–3: bones\n\nFixture + outlets. Curtains. Desk + chair. Shelving measured + ordered.\n\nOutcome: usable, even if not finished.",
    variant: "body",
  }),
  textBlock({
    id: "demo-studio-phase-3",
    ...at(48, 142, 22, 10),
    content:
      "Weeks 4–6: finish\n\nShelving installed. Reading chair delivered. Lamps + accessories. Rug. Styling pass.\n\nOutcome: complete.",
    variant: "body",
  }),

  textBlock({
    id: "demo-studio-source-h",
    ...at(74, 138, 56, 3),
    content: "Sourcing list",
    variant: "h2",
  }),
  textBlock({
    id: "demo-studio-source-1",
    ...at(74, 142, 27, 10),
    content:
      "Desk: Floyd                  $795\nChair: Sayl                 $420\nFloor lamp: Orbit           $240\nTask lamp: Anglepoise        $380\nRug: Revival 8×10 wool    $1,100",
    variant: "body",
  }),
  textBlock({
    id: "demo-studio-source-2",
    ...at(102, 142, 28, 10),
    content:
      "Curtains: West Elm linen    $280\nBed: reupholster headboard  $300\nBedding: Parachute linen    $340\nPicture light: RH           $180\nPaint: F&B + BM Hale Navy  ~$220",
    variant: "body",
  }),

  // — Questions + budget tracker -------------------------------------
  textBlock({
    id: "demo-studio-q-h",
    ...at(0, 156, 60, 3),
    content: "Questions: architect visit Jun 2",
    variant: "h2",
  }),
  textBlock({
    id: "demo-studio-q-body",
    ...at(0, 160, 60, 11),
    content:
      "Can we add two outlets behind the desk + one above the shelving? Quoted cost?\n\nCan the overhead fixture move 14 inches toward the window without touching the joists?\n\nIs refinishing the pine worth it vs. laying a new floor? Break-even on cost?\n\nAny reason not to build the shelving into the drywall rather than freestanding?",
    variant: "body",
  }),
  textBlock({
    id: "demo-studio-budget-track-h",
    ...at(64, 156, 66, 3),
    content: "Budget tracker: as of today",
    variant: "h2",
  }),
  textBlock({
    id: "demo-studio-budget-track",
    ...at(64, 160, 66, 11),
    content:
      "Spent / committed: $4,080\n• Paint + supplies           $180\n• Desk + chair             $1,215\n• Shelving deposit          $500\n• Rug                      $1,100\n• Electrician deposit       $200\n• Contingency reserved    $1,000\n\nRemaining: $4,920 of $9,000, on track.",
    variant: "body",
  }),

  // — Next actions (full-width) --------------------------------------
  textBlock({
    id: "demo-studio-next-h",
    ...at(0, 175, 130, 3),
    content: "Next actions",
    variant: "h2",
  }),
  textBlock({
    id: "demo-studio-next-todos",
    ...at(0, 179, 62, 10),
    content:
      "[x] Paint ordered, picked up Sat\n[ ] Call Diego re: shelving schedule (Wed)\n[ ] Visit Oakland estate sale Sat for reading chair\n[ ] Architect visit Jun 2, prep questions\n[ ] Book floor refinisher\n[ ] Order curtains + bedding",
    variant: "body",
    listType: "todo",
    format: "todo",
  }),
  textBlock({
    id: "demo-studio-next-notes",
    ...at(64, 179, 66, 10),
    content:
      "Decisions still open:\nBuilt-in shelving vs. freestanding: talk with Diego + architect.\nNorth-wall curtain length: floor-puddle or kiss-the-sill? leaning puddle.\nPicture light wired-in or plug-in? plug-in is cheaper and reversible.",
    variant: "body",
  }),
];

// Wires tie the spatial zones to the furniture that will live in them,
// link the accent-wall swatch to the desk zone it paints, connect the
// budget tracker to the sourcing list it funds, and thread the
// "before" column down to the phased plan that transforms it.
// Floor-plan layout is dense — zone cards in the centre are surrounded
// on all sides. Long diagonal wires through the middle would always
// cut through something, so we keep wires either SHORT and local
// (same-column, same-row, or through one of the empty gutters on
// either side of the zones) or use right-to-right bulges into the
// canvas margin.
const studio12Wires = [
  // accent-wall swatch → the zone that wall belongs to (short hop
  // through the empty strip between the desk zone and palette column).
  wire("demo-studio-wire-1", "demo-studio-swatch-2", "left", "demo-studio-zone-desk", "right"),
  // shelving zone → materials card that describes what it's built of
  // (both live at the east wall, almost touching).
  wire("demo-studio-wire-2", "demo-studio-zone-shelf", "right", "demo-studio-materials", "left"),
  // current-state notes → floor-plan header. Travels up through the
  // empty left corridor (x=22-28, clear from y=19 to y=93) between the
  // notes and the plan.
  wire("demo-studio-wire-3", "demo-studio-current-notes", "right", "demo-studio-floor-h", "left"),
  // phase flow (roadmap row): week 1 → weeks 2-3 → week 4. Adjacent
  // cards with a clean 2-cell gap between each.
  wire("demo-studio-wire-4", "demo-studio-phase-1", "right", "demo-studio-phase-2", "left"),
  wire("demo-studio-wire-5", "demo-studio-phase-2", "right", "demo-studio-phase-3", "left"),
];

/* ================================================================== */
/*  Snapshot builder                                                   */
/* ================================================================== */

const EMPTY_NOTES_DOC = { type: "doc", content: [{ type: "paragraph" }] };

function buildSnapshot(title, blocks, wires = []) {
  const blocksRecord = {};
  const order = [];
  for (const b of blocks) {
    blocksRecord[b.id] = b;
    order.push(b.id);
  }
  return {
    title,
    version: 2,
    blocks: blocksRecord,
    blockOrder: order,
    camera: { x: 0, y: 0, zoom: 1 },
    gridSize: G,
    wireConnections: wires,
    chatMessages: [],
    aiThread: [],
    notesPages: [{ id: "demo-notes-page-1", title: "Page 1", content: EMPTY_NOTES_DOC }],
  };
}

// Keyed by the demo board id. Ids MUST match DEMO_BOARDS in demoSynthesis.js
// so retained product links can resolve it cleanly.
export const DEMO_GRID_SNAPSHOTS = {
  "demo-board-harbor": buildSnapshot("Harbor: business idea", harborBlocks, harborWires),
  "demo-board-greenroom": buildSnapshot("Greenroom: content creation", greenroomBlocks, greenroomWires),
  "demo-board-studio12": buildSnapshot("Studio 12: design spaces", studio12Blocks, studio12Wires),
};

// Ordered list for the sidebar. Keeps display order deterministic.
export const DEMO_GRID_LIST = [
  { id: "demo-board-harbor", title: "Harbor: business idea" },
  { id: "demo-board-greenroom", title: "Greenroom: content creation" },
  { id: "demo-board-studio12", title: "Studio 12: design spaces" },
];

export function isDemoLyknChatId(id) {
  if (typeof id !== "string") return false;
  if (Object.prototype.hasOwnProperty.call(DEMO_GRID_SNAPSHOTS, id)) return true;
  return false;
}

// Compute a camera that frames the top of a demo grid at a zoom level
// where the full bbox width fits comfortably inside the current viewport.
// Baking this directly into the returned snapshot (via `camera` on the
// returned object) is what short-circuits `applySnapshot`'s default-camera
// auto-center logic — it only re-centers when `camera.x === 0 && camera.y === 0`.
// Single camera commit per demo load keeps `canvasZoomRef` / `el.scrollTop`
// in lockstep; setting the camera twice (snapshot default → post-override)
// opens a window where an in-flight wheel-zoom flush reads stale refs and
// clamps the scroll to maxTop, which visually "shoots" the user to the
// bottom of the content area.
function computeDemoCamera(snap) {
  const blocks = snap && snap.blocks ? Object.values(snap.blocks) : [];
  if (blocks.length === 0) return { x: 0, y: 0, zoom: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  for (const b of blocks) {
    const bx = Number(b?.x) || 0;
    const by = Number(b?.y) || 0;
    const bw = Number(b?.width) || 0;
    if (bx < minX) minX = bx;
    if (by < minY) minY = by;
    if (bx + bw > maxX) maxX = bx + bw;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return { x: 0, y: 0, zoom: 1 };
  const vpW = (typeof window !== "undefined" && window.innerWidth) || 1280;
  const vpH = (typeof window !== "undefined" && window.innerHeight) || 800;
  const bboxW = Math.max(1, maxX - minX);
  const fitZoom = Math.max(0.35, Math.min(1, (vpW * 0.88) / bboxW));
  const cx = (minX + maxX) / 2;
  const gSize = Number(snap?.gridSize) || G;
  return {
    x: cx - vpW / (2 * fitZoom),
    y: minY - gSize - (vpH * 0.04) / fitZoom,
    zoom: fitZoom,
  };
}

export function getDemoLyknChatSnapshot(id) {
  if (!isDemoLyknChatId(id)) return null;
  // Deep-clone so callers that mutate the snapshot don't poison the
  // shared template.
  const snap = JSON.parse(JSON.stringify(DEMO_GRID_SNAPSHOTS[id]));
  snap.camera = computeDemoCamera(snap);
  return snap;
}
