import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  AudioLines,
  Briefcase,
  Clock,
  Code,
  Code2,
  FileText,
  FlaskConical,
  GraduationCap,
  ImagePlus,
  LineChart,
  Mail,
  MessageCircle,
  Palette,
  Presentation,
  RefreshCw,
  Target,
  Telescope,
  TrendingUp,
} from "lucide-react";
import LandingHeader from "@/components/landing/LandingHeader";
import lyknLogo from "@/assets/FINAL/LYKN-LOGO-B-Open/PNGs/LYKN-Logo-Primary-B-Open-BLUE-web.png";
import "./Templates.css";

const PREVIEW_COUNT = 4;

type Template = {
  id: string;
  title: string;
  description: string;
  apps: ReactNode[];
  schedule?: { label: string; sync?: boolean };
};

type Section = {
  id: string;
  title: string;
  icon: ReactNode;
  templates: Template[];
};

/** Same Lucide glyphs as Glass Studio mode pills (LyknChat STUDIO_MODE_OPTIONS)
    plus Voice (AudioLines) and supporting Studio-adjacent tools. */
const I = {
  chat: (
    <span className="tpl-app" title="Chat">
      <MessageCircle aria-hidden />
    </span>
  ),
  build: (
    <span className="tpl-app" title="Build">
      <Code aria-hidden />
    </span>
  ),
  imagine: (
    <span className="tpl-app" title="Imagine">
      <ImagePlus aria-hidden />
    </span>
  ),
  voice: (
    <span className="tpl-app" title="Voice">
      <AudioLines aria-hidden />
    </span>
  ),
  research: (
    <span className="tpl-app" title="Research">
      <Telescope aria-hidden />
    </span>
  ),
  docs: (
    <span className="tpl-app" title="Docs">
      <FileText aria-hidden />
    </span>
  ),
  mail: (
    <span className="tpl-app" title="Mail">
      <Mail aria-hidden />
    </span>
  ),
  deck: (
    <span className="tpl-app" title="Presentation">
      <Presentation aria-hidden />
    </span>
  ),
  chart: (
    <span className="tpl-app" title="Analytics">
      <LineChart aria-hidden />
    </span>
  ),
};

function apps(...nodes: ReactNode[]) {
  return nodes;
}

const SECTIONS: Section[] = [
  {
    id: "students",
    title: "Students",
    icon: <GraduationCap size={18} aria-hidden />,
    templates: [
      {
        id: "study-guide",
        title: "Turn lecture notes into a study guide",
        description:
          "Snip slides or notes on screen and get a clean outline with key terms and practice questions.",
        apps: apps(I.chat, I.docs),
        schedule: { label: "After class" },
      },
      {
        id: "flashcards",
        title: "Build flashcards from a textbook page",
        description:
          "Highlight a chapter and LYKN drafts spaced-repetition cards you can save to your vault.",
        apps: apps(I.build, I.docs),
      },
      {
        id: "paper-outline",
        title: "Outline a research paper from sources",
        description:
          "Drop in PDFs and notes; Chat structures a thesis, sections, and citation checklist.",
        apps: apps(I.chat, I.research, I.docs),
        schedule: { label: "Weekdays 6pm" },
      },
      {
        id: "assignment-draft",
        title: "Draft an assignment from the rubric",
        description:
          "Point Glass at the prompt and rubric. Get a first draft that hits every criterion.",
        apps: apps(I.chat, I.voice, I.docs),
      },
      {
        id: "exam-quiz",
        title: "Practice quiz from past exams",
        description:
          "Snip old exams or problem sets and get a timed practice quiz with answer keys.",
        apps: apps(I.build, I.docs),
        schedule: { label: "Before finals" },
      },
      {
        id: "lab-report",
        title: "Lab report from raw observations",
        description:
          "Dump messy lab notes and get Methods, Results, and Discussion drafted in your voice.",
        apps: apps(I.chat, I.docs, I.chart),
      },
      {
        id: "citation-fix",
        title: "Format citations from a bibliography dump",
        description:
          "Paste messy references and get APA, MLA, or Chicago cleaned and consistent.",
        apps: apps(I.chat, I.docs),
      },
      {
        id: "group-agenda",
        title: "Group project agenda and task board",
        description:
          "List teammates and deadlines. Build a shared agenda with owners and check-ins.",
        apps: apps(I.build, I.chat),
        schedule: { label: "Weekdays 5pm" },
      },
      {
        id: "lecture-summary",
        title: "Summarize a recorded lecture",
        description:
          "Point at the transcript or slides and get a one-page recap with timestamps for hard parts.",
        apps: apps(I.chat, I.voice, I.docs),
      },
      {
        id: "thesis-elevator",
        title: "Elevator pitch for your thesis",
        description:
          "Talk through your research out loud; Voice shapes a clear pitch for advisors and interviews.",
        apps: apps(I.voice, I.chat),
      },
      {
        id: "reading-notes",
        title: "Annotated reading notes from a PDF",
        description:
          "Snip key pages and get margin-style notes, definitions, and questions to bring to class.",
        apps: apps(I.chat, I.docs, I.research),
        schedule: { label: "Every Sunday" },
      },
      {
        id: "office-hours",
        title: "Office hours question list",
        description:
          "Dump what confused you this week. Chat turns it into a short, specific question list.",
        apps: apps(I.chat, I.mail),
      },
    ],
  },
  {
    id: "creatives",
    title: "Creatives",
    icon: <Palette size={18} aria-hidden />,
    templates: [
      {
        id: "mood-board",
        title: "Mood board from reference images",
        description:
          "Snip references and Imagine expands them into a cohesive direction with palette notes.",
        apps: apps(I.imagine, I.chat),
      },
      {
        id: "ad-variants",
        title: "Generate ad creative variants",
        description:
          "Start from one hero shot and produce on-brand crops, headlines, and alt copy.",
        apps: apps(I.imagine, I.build),
        schedule: { label: "Every Monday" },
      },
      {
        id: "case-study",
        title: "Write a portfolio case study",
        description:
          "Walk through the project out loud; Voice + Build turn it into a polished case study page.",
        apps: apps(I.voice, I.build, I.docs),
      },
      {
        id: "brand-kit",
        title: "Extract a brand kit from a site",
        description:
          "Open a client's site and pull colors, type notes, and tone guidelines into a one-pager.",
        apps: apps(I.chat, I.imagine, I.docs),
      },
      {
        id: "storyboard",
        title: "Storyboard from a script",
        description:
          "Paste a short script and get scene frames, shot notes, and pacing suggestions.",
        apps: apps(I.imagine, I.build, I.docs),
      },
      {
        id: "logo-explorations",
        title: "Logo explorations from a brief",
        description:
          "Describe the brand once. Imagine generates directions with rationale for each.",
        apps: apps(I.imagine, I.chat),
      },
      {
        id: "art-critique",
        title: "Critique a draft with actionable notes",
        description:
          "Snip your work-in-progress and get composition, hierarchy, and clarity feedback.",
        apps: apps(I.chat, I.imagine),
      },
      {
        id: "client-presentation",
        title: "Client presentation from scattered files",
        description:
          "Point at folders of comps and notes. Build a clean deck ready for review.",
        apps: apps(I.build, I.deck, I.imagine),
        schedule: { label: "Before calls" },
      },
      {
        id: "naming-options",
        title: "Name and tagline options",
        description:
          "Share audience and vibe; Chat returns naming sets with short rationale for each.",
        apps: apps(I.chat, I.docs),
      },
      {
        id: "style-frames",
        title: "Style frames for a motion piece",
        description:
          "Snip references and get key frames with motion notes and transition ideas.",
        apps: apps(I.imagine, I.build),
      },
      {
        id: "caption-pack",
        title: "Caption pack for a photo set",
        description:
          "Drop a shoot folder and get on-brand captions, alt text, and hashtag sets.",
        apps: apps(I.chat, I.imagine, I.mail),
        schedule: { label: "After shoots" },
      },
      {
        id: "creative-brief-fill",
        title: "Fill a creative brief from a kickoff call",
        description:
          "Talk through the kickoff; Voice fills objectives, audience, deliverables, and constraints.",
        apps: apps(I.voice, I.docs),
      },
    ],
  },
  {
    id: "sales",
    title: "Sales",
    icon: <TrendingUp size={18} aria-hidden />,
    templates: [
      {
        id: "prospect-brief",
        title: "Prospect brief from a LinkedIn profile",
        description:
          "Glass reads the profile on screen and drafts talking points, hooks, and recent news.",
        apps: apps(I.chat, I.research),
        schedule: { label: "Daily 7am" },
      },
      {
        id: "call-prep",
        title: "Call prep from CRM notes",
        description:
          "Snip the account page and get a one-page brief: history, risks, and suggested asks.",
        apps: apps(I.chat, I.docs),
        schedule: { label: "Weekdays 8am", sync: true },
      },
      {
        id: "follow-up",
        title: "Follow-up email after a meeting",
        description:
          "Paste or snip meeting notes. Chat writes a concise follow-up with next steps.",
        apps: apps(I.chat, I.mail),
      },
      {
        id: "battlecard",
        title: "Competitive battlecard",
        description:
          "Compare two product pages and Build a one-pager your team can pull up mid-call.",
        apps: apps(I.build, I.research, I.deck),
        schedule: { label: "Every 3 hours", sync: true },
      },
      {
        id: "outbound-sequence",
        title: "Outbound sequence from an ICP",
        description:
          "Describe the buyer; Chat drafts a 5-touch sequence with subject lines and CTAs.",
        apps: apps(I.chat, I.mail),
        schedule: { label: "Every Monday" },
      },
      {
        id: "discovery-script",
        title: "Discovery call script",
        description:
          "Turn your ICP and product notes into a discovery flow with branching questions.",
        apps: apps(I.chat, I.docs, I.voice),
      },
      {
        id: "proposal-draft",
        title: "Proposal from a discovery call",
        description:
          "Drop the call transcript and get a scoped proposal with pricing options and timeline.",
        apps: apps(I.build, I.docs, I.deck),
      },
      {
        id: "objection-sheet",
        title: "Objection handling sheet",
        description:
          "List common pushbacks. Get crisp replies plus when to escalate or walk away.",
        apps: apps(I.chat, I.docs),
      },
      {
        id: "account-map",
        title: "Account map from org charts",
        description:
          "Snip LinkedIn and CRM contacts into a buying committee map with influence notes.",
        apps: apps(I.build, I.research, I.chat),
      },
      {
        id: "demo-agenda",
        title: "Custom demo agenda",
        description:
          "Point at the prospect's site and pain notes. Get a demo flow that leads with their world.",
        apps: apps(I.chat, I.deck),
        schedule: { label: "Before demos" },
      },
      {
        id: "win-loss",
        title: "Win/loss notes synthesizer",
        description:
          "Paste deal notes and emails. Extract patterns, quotes, and product feedback themes.",
        apps: apps(I.chat, I.chart, I.docs),
        schedule: { label: "Every Friday" },
      },
      {
        id: "renewal-brief",
        title: "Renewal risk brief",
        description:
          "Snip usage and support history. Get health score notes and a save playbook.",
        apps: apps(I.chat, I.chart, I.mail),
      },
    ],
  },
  {
    id: "marketing",
    title: "Marketing",
    icon: <Target size={18} aria-hidden />,
    templates: [
      {
        id: "campaign-brief",
        title: "Campaign brief from a brief dump",
        description:
          "Dump goals, audience, and constraints. Get a structured brief ready for creative.",
        apps: apps(I.chat, I.docs),
      },
      {
        id: "social-pack",
        title: "Social pack from one announcement",
        description:
          "One product update in; LinkedIn, X, and email variants out. On-brand and short.",
        apps: apps(I.chat, I.imagine, I.mail),
        schedule: { label: "Weekdays 9am" },
      },
      {
        id: "landing-copy",
        title: "Landing page copy from a feature list",
        description:
          "Point at a feature doc and Build hero, sections, and CTA copy that stays on message.",
        apps: apps(I.build, I.chat),
      },
      {
        id: "seo-outline",
        title: "SEO outline from a competitor article",
        description:
          "Snip a ranking page and get a better outline with gaps, angles, and title options.",
        apps: apps(I.chat, I.research, I.docs),
        schedule: { label: "Every Monday" },
      },
      {
        id: "press-release",
        title: "Press release from product notes",
        description:
          "Drop launch notes and quotes. Get a clean release plus short pitch for journalists.",
        apps: apps(I.chat, I.mail, I.docs),
      },
      {
        id: "webinar-promo",
        title: "Webinar promo kit",
        description:
          "One event page in; get email, social, and reminder copy with a registration CTA.",
        apps: apps(I.chat, I.mail, I.imagine),
        schedule: { label: "Before webinars" },
      },
      {
        id: "persona-cards",
        title: "Persona cards from interview notes",
        description:
          "Paste research dumps and Build persona one-pagers with jobs, fears, and channels.",
        apps: apps(I.build, I.docs, I.chat),
      },
      {
        id: "utm-plan",
        title: "UTM and channel plan",
        description:
          "List campaigns and channels. Get a naming scheme, UTMs, and a tracking checklist.",
        apps: apps(I.chat, I.chart, I.docs),
      },
      {
        id: "ab-test-plan",
        title: "A/B test plan from a hypothesis",
        description:
          "State what you want to learn. Get variants, success metrics, and sample size notes.",
        apps: apps(I.chat, I.chart),
      },
      {
        id: "newsletter-draft",
        title: "Newsletter from this week's updates",
        description:
          "Point at changelogs and posts. Chat drafts a scannable newsletter with one clear CTA.",
        apps: apps(I.chat, I.mail),
        schedule: { label: "Every Thursday" },
      },
      {
        id: "ad-copy-set",
        title: "Paid ad copy set",
        description:
          "Share the offer and audience; get headlines, primary text, and CTA variants by channel.",
        apps: apps(I.chat, I.imagine),
      },
      {
        id: "launch-checklist",
        title: "Launch day checklist",
        description:
          "List assets and owners. Build a timed launch checklist with comms and rollback notes.",
        apps: apps(I.build, I.docs, I.mail),
      },
    ],
  },
  {
    id: "business",
    title: "Business",
    icon: <Briefcase size={18} aria-hidden />,
    templates: [
      {
        id: "meeting-notes",
        title: "Meeting notes to action items",
        description:
          "Drop messy notes or a transcript. Chat extracts owners, deadlines, and follow-ups.",
        apps: apps(I.chat, I.docs),
        schedule: { label: "After meetings" },
      },
      {
        id: "weekly-update",
        title: "Weekly status update",
        description:
          "Pull from your projects and vault to draft a crisp update for leadership.",
        apps: apps(I.chat, I.mail, I.chart),
        schedule: { label: "Fridays 3pm" },
      },
      {
        id: "decision-memo",
        title: "Decision memo from options",
        description:
          "List the options out loud; Voice structures a memo with tradeoffs and a recommendation.",
        apps: apps(I.voice, I.docs),
      },
      {
        id: "okrs-dashboard",
        title: "OKR dashboard from a spreadsheet",
        description:
          "Snip your metrics sheet and Build a live dashboard you can open on the desktop.",
        apps: apps(I.build, I.chart),
      },
      {
        id: "board-deck",
        title: "Board deck from last quarter's notes",
        description:
          "Point at metrics and narrative dumps. Build a tight board deck with appendix slides.",
        apps: apps(I.build, I.deck, I.chart),
        schedule: { label: "Before board" },
      },
      {
        id: "hiring-scorecard",
        title: "Hiring scorecard from a job post",
        description:
          "Snip the role description and get interview scorecards with must-haves and signals.",
        apps: apps(I.chat, I.docs),
      },
      {
        id: "vendor-compare",
        title: "Vendor comparison one-pager",
        description:
          "Open two pricing pages and get a side-by-side with risks, TCO notes, and a pick.",
        apps: apps(I.chat, I.build, I.docs),
      },
      {
        id: "policy-draft",
        title: "Internal policy draft",
        description:
          "Talk through the rule you need; Voice drafts a clear policy with examples and owners.",
        apps: apps(I.voice, I.docs, I.mail),
      },
      {
        id: "budget-narrative",
        title: "Budget narrative from a spreadsheet",
        description:
          "Snip the budget sheet and get a short narrative for finance or leadership review.",
        apps: apps(I.chat, I.chart, I.docs),
      },
      {
        id: "risk-register",
        title: "Risk register from project notes",
        description:
          "Dump worries and blockers. Get a ranked risk register with mitigations and owners.",
        apps: apps(I.build, I.chat, I.docs),
        schedule: { label: "Every Monday", sync: true },
      },
      {
        id: "onboarding-plan",
        title: "New hire 30-60-90 plan",
        description:
          "Share the role and team norms. Build a 30-60-90 with check-ins and success signals.",
        apps: apps(I.build, I.docs),
      },
      {
        id: "customer-health",
        title: "Customer health digest",
        description:
          "Point at CRM and support threads. Get accounts at risk with suggested next moves.",
        apps: apps(I.chat, I.chart, I.mail),
        schedule: { label: "Daily 8am" },
      },
    ],
  },
  {
    id: "research",
    title: "Research",
    icon: <FlaskConical size={18} aria-hidden />,
    templates: [
      {
        id: "literature-map",
        title: "Literature map from open papers",
        description:
          "Snip abstracts and get a theme map, open questions, and a reading order.",
        apps: apps(I.chat, I.research, I.docs),
      },
      {
        id: "interview-synth",
        title: "Synthesize user interviews",
        description:
          "Paste transcripts. Extract jobs-to-be-done, quotes, and conflicting themes.",
        apps: apps(I.chat, I.docs),
        schedule: { label: "After rounds" },
      },
      {
        id: "market-scan",
        title: "Market scan one-pager",
        description:
          "Name a category; Research + Build returns players, positioning, and whitespace.",
        apps: apps(I.research, I.build, I.deck),
        schedule: { label: "Every Monday", sync: true },
      },
      {
        id: "source-digest",
        title: "Daily source digest",
        description:
          "Point Glass at your reading list and get a short digest with links worth saving.",
        apps: apps(I.chat, I.research),
        schedule: { label: "Daily 7am" },
      },
      {
        id: "survey-analysis",
        title: "Survey analysis from raw responses",
        description:
          "Snip the response sheet and get themes, stats notes, and charts worth sharing.",
        apps: apps(I.chat, I.chart, I.build),
      },
      {
        id: "hypothesis-board",
        title: "Hypothesis board from a problem space",
        description:
          "Describe the problem; Chat lays out hypotheses, signals to watch, and falsifiers.",
        apps: apps(I.chat, I.build, I.docs),
      },
      {
        id: "expert-brief",
        title: "Expert interview brief",
        description:
          "Share the topic and gaps. Get a briefing memo plus a sharp question list.",
        apps: apps(I.chat, I.research, I.docs),
      },
      {
        id: "citation-graph",
        title: "Citation trail from a seed paper",
        description:
          "Open a paper and map who it cites and who cites it. With who to read next.",
        apps: apps(I.research, I.chat, I.docs),
      },
      {
        id: "competitive-teardown",
        title: "Competitive product teardown",
        description:
          "Walk a competitor product on screen; get strengths, gaps, and opportunity notes.",
        apps: apps(I.chat, I.imagine, I.deck),
      },
      {
        id: "research-plan",
        title: "Research plan from a question",
        description:
          "State the question once. Get methods, sample, timeline, and success criteria.",
        apps: apps(I.chat, I.docs),
      },
      {
        id: "whitepaper-outline",
        title: "Whitepaper outline from findings",
        description:
          "Dump findings and quotes. Build a whitepaper outline with figure placeholders.",
        apps: apps(I.build, I.docs, I.chart),
      },
      {
        id: "field-notes",
        title: "Field notes cleanup",
        description:
          "Voice-dump messy observations; get structured notes tagged by theme and site.",
        apps: apps(I.voice, I.docs, I.chat),
        schedule: { label: "After sessions" },
      },
    ],
  },
  {
    id: "development",
    title: "Development",
    icon: <Code2 size={18} aria-hidden />,
    templates: [
      {
        id: "pr-summary",
        title: "PR summary from a diff",
        description:
          "Snip the pull request and get a reviewer-ready summary, risks, and test notes.",
        apps: apps(I.chat, I.docs),
      },
      {
        id: "bug-repro",
        title: "Bug report from a failing screen",
        description:
          "Capture the error UI and logs. Chat drafts steps to reproduce and a hypothesized cause.",
        apps: apps(I.chat, I.voice),
      },
      {
        id: "api-docs",
        title: "API docs from an OpenAPI file",
        description:
          "Open the spec and Build a readable reference page with examples your team can share.",
        apps: apps(I.build, I.docs),
      },
      {
        id: "standup-digest",
        title: "Standup digest from yesterday's commits",
        description:
          "Point at the commit log and get a short standup update in your voice.",
        apps: apps(I.chat, I.mail),
        schedule: { label: "Weekdays 9am", sync: true },
      },
      {
        id: "rfc-draft",
        title: "RFC from a design discussion",
        description:
          "Talk through the proposal; Voice + Build draft an RFC with alternatives and risks.",
        apps: apps(I.voice, I.build, I.docs),
      },
      {
        id: "test-plan",
        title: "Test plan from a feature spec",
        description:
          "Snip the spec and get happy paths, edge cases, and regression checklist items.",
        apps: apps(I.chat, I.docs),
      },
      {
        id: "incident-postmortem",
        title: "Incident postmortem draft",
        description:
          "Paste timeline and logs. Get a blameless postmortem with action items and owners.",
        apps: apps(I.chat, I.docs, I.mail),
        schedule: { label: "After incidents" },
      },
      {
        id: "migration-checklist",
        title: "Migration checklist",
        description:
          "Describe old and new systems. Build a phased checklist with rollback and validation.",
        apps: apps(I.build, I.docs, I.chat),
      },
      {
        id: "oncall-handoff",
        title: "On-call handoff notes",
        description:
          "Dump what's burning. Get a crisp handoff with open pages, risks, and watch items.",
        apps: apps(I.chat, I.mail),
        schedule: { label: "Shift change" },
      },
      {
        id: "perf-notes",
        title: "Perf investigation notes",
        description:
          "Snip profiles and traces. Chat structures hypotheses, next measurements, and fixes.",
        apps: apps(I.chat, I.chart, I.docs),
      },
      {
        id: "changelog",
        title: "Changelog from merged PRs",
        description:
          "Point at merged PRs and get user-facing release notes grouped by theme.",
        apps: apps(I.chat, I.docs, I.mail),
        schedule: { label: "Every release" },
      },
      {
        id: "arch-diagram",
        title: "Architecture diagram from a codebase tour",
        description:
          "Walk key files on screen; Build a system diagram with service boundaries and data flow.",
        apps: apps(I.build, I.chat, I.deck),
      },
    ],
  },
];

function TemplateCard({
  template,
  onUse,
}: {
  template: Template;
  onUse: () => void;
}) {
  return (
    <button type="button" className="tpl-card" onClick={onUse}>
      <h3 className="tpl-card-title">{template.title}</h3>
      <p className="tpl-card-desc">{template.description}</p>
      <div className="tpl-card-foot">
        <div className="tpl-card-apps" aria-hidden>
          {template.apps.map((app, i) => (
            <span key={i}>{app}</span>
          ))}
        </div>
        {template.schedule && (
          <span className="tpl-pill" title={template.schedule.label}>
            {template.schedule.sync ? (
              <RefreshCw aria-hidden />
            ) : (
              <Clock aria-hidden />
            )}
            {template.schedule.label}
          </span>
        )}
      </div>
    </button>
  );
}

function TemplateSection({
  section,
  expanded,
  onToggle,
  onUse,
}: {
  section: Section;
  expanded: boolean;
  onToggle: () => void;
  onUse: () => void;
}) {
  const visible = expanded
    ? section.templates
    : section.templates.slice(0, PREVIEW_COUNT);

  return (
    <section className="tpl-section" id={section.id} aria-labelledby={`${section.id}-title`}>
      <div className="tpl-section-head">
        <h2 className="tpl-section-title" id={`${section.id}-title`}>
          <span className="tpl-section-icon">{section.icon}</span>
          {section.title}
          <span className="tpl-section-count">{section.templates.length}</span>
        </h2>
        <button type="button" className="tpl-see-all" onClick={onToggle}>
          {expanded ? "Show less" : "See all →"}
        </button>
      </div>
      <div className="tpl-grid">
        {visible.map((t) => (
          <TemplateCard key={t.id} template={t} onUse={onUse} />
        ))}
      </div>
    </section>
  );
}

/** Standalone marketing Templates gallery, not part of the home scroll. */
export default function Templates() {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  const useTemplate = () => navigate("/download");

  return (
    <div className="tpl-page">
      <LandingHeader />

      <main className="tpl-main">
        <header className="tpl-intro">
          <h1>Templates</h1>
          <p>
            Ready-to-run Glass workflows for how you actually work. Snip,
            ask, build, and ship without leaving your screen.
          </p>
        </header>

        {SECTIONS.map((section) => (
          <TemplateSection
            key={section.id}
            section={section}
            expanded={!!expanded[section.id]}
            onToggle={() =>
              setExpanded((prev) => ({
                ...prev,
                [section.id]: !prev[section.id],
              }))
            }
            onUse={useTemplate}
          />
        ))}
      </main>

      <footer className="lkn-footer">
        <div className="lkn-footer-inner lkn-footer-simple">
          <img src={lyknLogo} alt="LYKN" className="lkn-footer-logo" />
          <nav className="lkn-footer-nav" aria-label="Footer">
            <button type="button" onClick={() => navigate("/templates")}>
              Templates
            </button>
            <button type="button" onClick={() => navigate("/pricing")}>
              Pricing
            </button>
            <button type="button" onClick={() => navigate("/privacy")}>
              Privacy
            </button>
            <button type="button" onClick={() => navigate("/terms")}>
              Terms
            </button>
            <button type="button" onClick={() => navigate("/cookies")}>
              Cookies
            </button>
          </nav>
          <p className="lkn-footer-copy">© {new Date().getFullYear()} LYKN</p>
        </div>
      </footer>
    </div>
  );
}
