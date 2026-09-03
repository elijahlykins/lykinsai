import { useEffect, useMemo, useState } from "react";
import { API_BASE_URL } from "@/lib/api-config";
import {
  FALLBACK_LANDING_MODELS,
  MODELS_DEV_LOGO_PREFIX,
  sanitizeLandingModel,
  type LandingModel,
} from "@/components/landing/landingModelCatalog";
import {
  FALLBACK_LANDING_TOOLKITS,
  sanitizeLandingToolkit,
  type LandingToolkit,
} from "@/components/landing/landingToolkitCatalog";

// Keep the rotating DOM light even if the public catalogs return hundreds of rows.
const MAX_LABS = 24;
const MAX_TOOLS = 24;

// The labs the carousel may show, keyed by models.dev logo slug. Doubles as
// an allowlist: every slug here is verified to serve the lab's real logo
// (models.dev returns a generic placeholder mark for unknown slugs), so live
// catalog rows from labs outside this map are skipped rather than rendered
// with a placeholder or a raw slug as the name.
const LAB_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  xai: "xAI",
  meta: "Meta",
  deepseek: "DeepSeek",
  mistral: "Mistral AI",
  alibaba: "Qwen",
  moonshotai: "Moonshot AI",
  cohere: "Cohere",
  zai: "Z.ai",
  "amazon-bedrock": "Amazon",
  nvidia: "NVIDIA",
  perplexity: "Perplexity",
  minimax: "MiniMax",
  azure: "Microsoft",
};

// Catalog rows that point at a placeholder-only logo slug, remapped to the
// slug that hosts the lab's real logo.
const LAB_SLUG_REMAP: Record<string, string> = {
  gemini: "google",
  qwen: "alibaba",
  moonshot: "moonshotai",
  zhipu: "zai",
  amazon: "amazon-bedrock",
  microsoft: "azure",
};

type LandingLab = { id: string; name: string; logoUrl: string };

/** Collapses the model catalog into its unique labs (one entry per logo), so
    the carousel rotates through vendors rather than every individual model. */
function deriveLabs(models: LandingModel[]): LandingLab[] {
  const labs: LandingLab[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    if (!model.logoUrl.startsWith(MODELS_DEV_LOGO_PREFIX)) continue;
    const raw = decodeURIComponent(
      model.logoUrl.slice(MODELS_DEV_LOGO_PREFIX.length).replace(/\.svg$/, ""),
    );
    const slug = LAB_SLUG_REMAP[raw] ?? raw;
    if (!LAB_NAMES[slug] || seen.has(slug)) continue;
    seen.add(slug);
    labs.push({
      id: slug,
      name: LAB_NAMES[slug],
      logoUrl: `${MODELS_DEV_LOGO_PREFIX}${encodeURIComponent(slug)}.svg`,
    });
    if (labs.length >= MAX_LABS) break;
  }
  return labs;
}

const MODEL_STEP_MS = 1900;
const TOOL_STEP_MS = 1600;

/** Advances 0..length-1 on a fixed interval; parked when motion is reduced. */
function useRotatingIndex(length: number, stepMs: number): number {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (length < 2) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(
      () => setIndex((cur) => (cur + 1) % length),
      stepMs,
    );
    return () => window.clearInterval(id);
  }, [length, stepMs]);

  return length > 0 ? index % length : 0;
}

/** Shortest signed distance from the active slot, so the ring of items wraps
    around instead of every logo sliding back to the start each cycle. */
function signedOffset(index: number, active: number, length: number): number {
  let off = (index - active) % length;
  if (off < 0) off += length;
  if (off > length / 2) off -= length;
  return off;
}

function Logo({
  name,
  logoUrl,
  fallbackClass,
}: {
  name: string;
  logoUrl: string;
  fallbackClass: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <span className={fallbackClass}>{name.slice(0, 1)}</span>;
  }
  return (
    <img
      src={logoUrl}
      alt=""
      decoding="async"
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

/** Horizontal ring of lab logo tiles: the centered tile is lifted onto a
    brand-blue chip while its neighbors shrink and fade toward the edges. */
function ModelsCarousel({ labs }: { labs: LandingLab[] }) {
  const active = useRotatingIndex(labs.length, MODEL_STEP_MS);

  return (
    <div className="gl-mt-models">
      <div className="gl-mt-carousel" aria-hidden="true">
        {labs.map((lab, i) => {
          const off = signedOffset(i, active, labs.length);
          const dist = Math.abs(off);
          const visible = dist <= 2;
          const scale = off === 0 ? 1 : dist === 1 ? 0.76 : 0.6;
          const opacity = !visible ? 0 : off === 0 ? 1 : dist === 1 ? 0.55 : 0.22;
          return (
            <span
              key={lab.id}
              className={`gl-mt-tile${off === 0 ? " is-active" : ""}`}
              style={{
                transform: `translate(-50%, -50%) translateX(${off * 4.7}rem) scale(${scale})`,
                opacity,
                zIndex: 3 - Math.min(dist, 3),
                visibility: visible ? "visible" : "hidden",
              }}
            >
              <Logo
                name={lab.name}
                logoUrl={lab.logoUrl}
                fallbackClass="gl-mt-tile-fallback"
              />
            </span>
          );
        })}
      </div>
      <p className="gl-mt-model-name" aria-hidden="true">
        <span key={labs[active]?.id ?? active} className="gl-mt-name-swap">
          {labs[active]?.name}
        </span>
      </p>
    </div>
  );
}

/** Vertical ring of connected-app pills: the centered app sits sharp beside a
    quiet "+" affordance while the rest recede above and below. */
function ToolsList({ tools }: { tools: LandingToolkit[] }) {
  const active = useRotatingIndex(tools.length, TOOL_STEP_MS);

  return (
    <div className="gl-mt-list" aria-hidden="true">
      <span className="gl-mt-plus">+</span>
      {tools.map((tool, i) => {
        const off = signedOffset(i, active, tools.length);
        const dist = Math.abs(off);
        const visible = dist <= 2;
        const opacity = !visible ? 0 : off === 0 ? 1 : dist === 1 ? 0.45 : 0.18;
        return (
          <span
            key={`${i}-${tool.slug}`}
            className={`gl-mt-pill${off === 0 ? " is-active" : ""}`}
            style={{
              transform: `translate(-50%, -50%) translateY(${off * 3.1}rem) scale(${off === 0 ? 1 : 0.94})`,
              opacity,
              zIndex: 3 - Math.min(dist, 3),
              visibility: visible ? "visible" : "hidden",
            }}
          >
            <Logo
              name={tool.name}
              logoUrl={tool.logoUrl}
              fallbackClass="gl-mt-pill-fallback"
            />
            <em>{tool.name}</em>
          </span>
        );
      })}
    </div>
  );
}

/** "Models" + "Tools" cards above the one-browser section: animated carousels
    that rotate through the labs behind the model catalog (open and closed
    weights alike) and the connected-app catalog. Live catalogs replace the
    baked-in fallbacks. */
export default function LandingModelsTools() {
  const [models, setModels] = useState<LandingModel[]>(FALLBACK_LANDING_MODELS);
  const [tools, setTools] = useState<LandingToolkit[]>(FALLBACK_LANDING_TOOLKITS);
  const labs = useMemo(() => deriveLabs(models), [models]);

  useEffect(() => {
    let cancelled = false;

    fetch(`${API_BASE_URL}/api/public/models`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const next = Array.isArray(data.models)
          ? data.models
              .map(sanitizeLandingModel)
              .filter((row): row is LandingModel => Boolean(row))
          : [];
        if (next.length >= 8) setModels(next);
      })
      .catch(() => {
        /* Keep the baked-in catalog if the public endpoint is down. */
      });

    fetch(`${API_BASE_URL}/api/public/toolkits`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const next = Array.isArray(data.tools)
          ? data.tools
              .map(sanitizeLandingToolkit)
              .filter((row): row is LandingToolkit => Boolean(row))
          : [];
        if (next.length >= 8) setTools(next.slice(0, MAX_TOOLS));
      })
      .catch(() => {
        /* Keep the baked-in catalog if the public endpoint is down. */
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section
      className="gl-mt gl-reveal"
      aria-label="Compatible models and tools"
    >
      <div className="gl-mt-inner">
        <article className="gl-mt-card">
          <header className="gl-mt-head">
            <h3>Models</h3>
            <p>
              In LYKN you get access to every model under one subscription.
              Route them how and where you want.
            </p>
          </header>
          <div className="gl-mt-panel">
            <ModelsCarousel labs={labs} />
          </div>
          <p className="sr-only">
            LYKN can use models from OpenAI, Anthropic, Google, xAI, Meta,
            DeepSeek, Mistral, and the rest of the OpenRouter catalog.
          </p>
        </article>

        <article className="gl-mt-card">
          <header className="gl-mt-head">
            <h3>Tools</h3>
            <p>
              Connect the systems your work already runs on - no migrations
              required.
            </p>
          </header>
          <div className="gl-mt-panel">
            <ToolsList tools={tools.slice(0, MAX_TOOLS)} />
          </div>
          <p className="sr-only">
            LYKN works with Gmail, GitHub, Notion, Slack, Google Calendar, and
            hundreds of other connected apps.
          </p>
        </article>
      </div>
    </section>
  );
}
