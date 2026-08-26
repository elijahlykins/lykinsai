// ============================================================================
// mcp-tools/exterior/index.js — on-demand exterior capability tools (in-app chat)
// ============================================================================
// These run server-side via the agent loop. They are NOT part of the MCP
// /connections pull-model — they execute inside LYKN when the model calls them.

import { searchWeb } from '../../lib/exterior/webSearch.js';
import { fetchWebPage } from '../../lib/exterior/webFetch.js';
import { calculateExpression, convertUnits } from '../../lib/exterior/calculate.js';
import { generateChart } from '../../lib/exterior/generateChart.js';
import { generateDiagram } from '../../lib/exterior/generateDiagram.js';
import { getCurrentTime } from '../../lib/exterior/currentTime.js';
import { runPythonSnippet } from '../../lib/exterior/runPython.js';
import { generateChatImage } from '../../lib/exterior/generateImage.js';
import { logAiUsage } from '../../usageTracking.js';
import { jsonContent, errorContent } from '../index.js';
import { CAPABILITY_TOOLS } from './capabilityTools.js';

export const webSearchTool = {
  name: 'lykn_web_search',
  title: 'Search the live web',
  scope: 'read',
  description: [
    'Run a live web search when the user needs current information that is',
    'not in their Vault, projects, or Markdown Memory — news, prices, recent events,',
    '"what happened today", facts after your training cutoff.',
    '',
    'WHEN TO CALL:',
    '  • User explicitly asks to search / look up / google / research something online.',
    '  • User names a publication (Fox News, CNN, NYT, BBC, …) or asks for its headlines.',
    '    Search "<outlet> top headlines" immediately. Do NOT ask for a URL or screenshot.',
    '  • User confirms a prior offer to search the web ("yes, search for that").',
    '  • The answer clearly requires live data you do not have (news, prices, latest models).',
    '  • Regular chat — no Web / Deep research mode required. Do not refuse for lack of a mode.',
    '  • Do NOT call for a bare capability question ("can you do live research?") — answer YES.',
    '',
    'WHEN NOT TO CALL:',
    '  • Question is answerable from vault, project state, or conversation.',
    '  • User is asking about their saved notes — use vault/project tools, not web search.',
    '',
    'Returns ranked snippets + optional full text from top result pages.',
    'Cite sources in your reply when you use these results.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (keep concise).' },
      num_results: {
        type: 'integer',
        minimum: 1,
        maximum: 10,
        description: 'Number of results (default 5).',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async handler(args = {}) {
    const result = await searchWeb(args.query, {
      num: args.num_results,
      deepBrowse: true,
    });
    if (!result.ok) return errorContent(result.error || 'search_failed');
    return jsonContent(result);
  },
};

export const webFetchTool = {
  name: 'lykn_web_fetch',
  title: 'Fetch and read a web page',
  scope: 'read',
  description: [
    'Fetch a single URL and extract readable article/body text.',
    'Use when the user pasted a link, when Glass already knows the open-tab',
    'URL and they ask about more of that site than the screenshot shows, or',
    'when you have a specific URL from search results to deep-read.',
    'Never ask them to paste a link you already have from page context or that',
    'you can construct for a named outlet (foxnews.com, cnn.com, nytimes.com).',
    'Do NOT invent page content if fetch fails; say the page could not be read.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'HTTP or HTTPS URL to fetch.' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  async handler(args = {}) {
    const result = await fetchWebPage(args.url);
    if (!result.ok) return errorContent(result.error || 'fetch_failed');
    return jsonContent(result);
  },
};

export const calculateTool = {
  name: 'lykn_calculate',
  title: 'Evaluate a math expression or convert units',
  scope: 'read',
  description: [
    'Exact arithmetic — use instead of mental math for anything non-trivial.',
    'Supports + - * / % ** parentheses and percent literals (e.g. 15%).',
    'Optional unit conversion when from_unit + to_unit are provided',
    '(km, m, mi, ft, kg, lb, l, ml, etc.).',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'Math expression to evaluate, e.g. "(1200 * 0.075) + 450".',
      },
      value: { type: 'number', description: 'Numeric value for unit conversion.' },
      from_unit: { type: 'string', description: 'Source unit when converting.' },
      to_unit: { type: 'string', description: 'Target unit when converting.' },
    },
    additionalProperties: false,
  },
  async handler(args = {}) {
    if (args.from_unit && args.to_unit) {
      const result = convertUnits(args.value ?? args.expression, args.from_unit, args.to_unit);
      if (!result.ok) return errorContent(result.error || 'conversion_failed');
      return jsonContent(result);
    }
    const result = calculateExpression(args.expression);
    if (!result.ok) return errorContent(result.error || 'calculation_failed');
    return jsonContent(result);
  },
};

export const generateChartTool = {
  name: 'lykn_generate_chart',
  title: 'Generate a chart from data',
  scope: 'read',
  description: [
    'Create a bar/line/pie chart from structured labels + datasets.',
    'Returns a chart_url (QuickChart PNG) and a markdown table. The chart card',
    'auto-offers PNG/SVG/PDF downloads, so the user can use it outside LYKN.',
    'Use when the user asks to graph, chart, or visualize numeric data.',
    'Include the chart as a markdown image: ![title](chart_url).',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      chart_type: {
        type: 'string',
        enum: ['bar', 'line', 'pie', 'doughnut', 'radar'],
        description: 'Chart type (default bar).',
      },
      title: { type: 'string', description: 'Optional chart title.' },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Category labels (x-axis or pie slices).',
      },
      datasets: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            data: { type: 'array', items: { type: 'number' } },
          },
          required: ['label', 'data'],
        },
        description: 'One or more numeric series aligned to labels.',
      },
    },
    required: ['labels', 'datasets'],
    additionalProperties: false,
  },
  async handler(args = {}) {
    const result = generateChart(args);
    if (!result.ok) return errorContent(result.error || 'chart_failed');
    return jsonContent(result);
  },
};

export const generateDiagramTool = {
  name: 'lykn_generate_diagram',
  title: 'Generate a Mermaid diagram',
  scope: 'read',
  description: [
    'Build flowcharts, sequence diagrams, ER diagrams, timelines, etc.',
    'Pass valid Mermaid source. If omitted, wraps input as flowchart TD.',
    'Returns markdown with a ```mermaid block — include that in your reply.',
    'The diagram card auto-offers SVG/PNG downloads for use outside LYKN.',
    'Use for architecture, process flows, decision trees, org charts.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      mermaid: { type: 'string', description: 'Mermaid diagram source.' },
      title: { type: 'string', description: 'Optional heading above the diagram.' },
    },
    required: ['mermaid'],
    additionalProperties: false,
  },
  async handler(args = {}) {
    const result = generateDiagram(args);
    if (!result.ok) return errorContent(result.error || 'diagram_failed');
    return jsonContent(result);
  },
};

export const getCurrentTimeTool = {
  name: 'lykn_get_current_time',
  title: 'Get the current date and time',
  scope: 'read',
  description: [
    'Return the current date/time in a named IANA timezone (defaults UTC).',
    'Call when scheduling, deadlines, "what day is it", or timezone math —',
    'do not guess the current date.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'IANA timezone, e.g. America/New_York, Europe/London, UTC.',
      },
    },
    additionalProperties: false,
  },
  async handler(args = {}) {
    const result = getCurrentTime(args.timezone);
    if (!result.ok) return errorContent(result.error || 'time_failed');
    return jsonContent(result);
  },
};

export const runPythonTool = {
  name: 'lykn_run_python',
  title: 'Run a short Python snippet for data analysis',
  scope: 'read',
  description: [
    'Execute a small Python snippet for data transforms, stats, parsing.',
    'Analysis profile allows safe stdlib imports (math, json, statistics, datetime, etc.).',
    'No network or file I/O. Prefer lykn_calculate for simple arithmetic.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'Python code to run (≤6000 chars).',
      },
      profile: { type: 'string', enum: ['strict', 'analysis'], description: 'Default analysis.' },
    },
    required: ['code'],
    additionalProperties: false,
  },
  async handler(args = {}) {
    const result = await runPythonSnippet(args.code, {
      profile: args.profile === 'strict' ? 'strict' : 'analysis',
    });
    if (!result.ok) return errorContent(result.error || 'python_failed');
    return jsonContent(result);
  },
};

export const generateImageTool = {
  name: 'lykn_generate_image',
  title: 'Generate an image with GPT Image 2 (OpenAI)',
  scope: 'read',
  description: [
    'Create an image from a text prompt using OpenAI GPT Image 2',
    '(gpt-image-2, the latest OpenAI image model). Returns a hosted',
    'image_url; the image renders as an inline card in chat automatically.',
    '',
    'AVAILABILITY: This tool is only offered when the user has explicitly',
    'turned on image generation for this message (the "Generate image" mode',
    'in the composer / overlay menu). Never invent images unprompted.',
    '',
    'REFERENCE IMAGES — the image model receives REAL PIXELS, not just text:',
    '  • Images the user ATTACHED this turn are automatically sent to the',
    '    image model as pixel references (you do not need to do anything).',
    '    Because the model sees the actual image, write the prompt as an',
    '    INSTRUCTION RELATIVE TO IT — "same character, now riding a bike",',
    '    "this product on a marble countertop, softer lighting" — and only',
    '    describe what should CHANGE or be ADDED. Do NOT waste the prompt',
    '    re-describing what the reference already shows; a long from-scratch',
    '    description FIGHTS the reference and reduces likeness.',
    '  • If the user attached an image for an UNRELATED reason ("here is my',
    '    homework, also generate a dragon"), pass use_attached_images: false',
    '    so the generation is not contaminated by it.',
    '  • ITERATING on an image you generated earlier in THIS conversation',
    '    ("same but at night", "make the sky pink"): pass that image\'s',
    '    image_url in reference_image_urls so the new render is grounded in',
    '    the previous pixels instead of regenerated from words — this is what',
    '    keeps the subject consistent across refinements.',
    '',
    'QUOTA: If the tool returns image_gen_monthly_limit_reached, the user',
    'hit their monthly cap — tell them honestly and do NOT pretend an image',
    'was created. (The cap is currently lifted, so this should not occur.)',
    '',
    'WHEN NOT TO CALL:',
    '  • User only wants a diagram or flowchart — use lykn_generate_diagram.',
    '  • User wants a data chart — use lykn_generate_chart.',
    '  • User attached an image to analyze — answer from vision, do not regenerate.',
    '',
    'Omit aspect_ratio and image_size unless the user explicitly asks — defaults',
    'work best for most prompts.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'Image description. With reference images present, describe only the CHANGES/additions ' +
          'relative to the reference — not a from-scratch scene description.',
      },
      reference_image_urls: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional http(s) URLs of images to ground the generation in (e.g. the image_url of a ' +
          'generation earlier in this conversation, for iterative refinement). User attachments ' +
          'this turn are included automatically and do NOT need to be listed.',
      },
      use_attached_images: {
        type: 'boolean',
        description:
          'Default true: images the user attached this turn are sent to the image model as pixel ' +
          'references. Pass false ONLY when the attachment is unrelated to the requested image.',
      },
      aspect_ratio: {
        type: 'string',
        enum: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
        description: 'Optional — omit unless the user specifies a shape.',
      },
      image_size: {
        type: 'string',
        enum: ['512', '1K', '2K'],
        description: 'Optional — omit unless the user asks for a specific resolution.',
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.userId || !ctx?.supabaseAdmin) {
      return errorContent('Unauthorized — sign in to generate images.');
    }
    // Pixel references for the image model. Two sources, both optional:
    //   1. The user's attached images this turn — ctx.turnAttachments carries
    //      the metadata (only USER uploads have an imageIndex; the overlay's
    //      auto-screenshot is never listed there), ctx.turnImageUrls the
    //      matching data: / http URLs. On by default, opt out via
    //      use_attached_images: false.
    //   2. reference_image_urls the model passed explicitly (previous
    //      generations, for iterative refinement).
    // generateChatImage normalizes + fetches these and routes them to the
    // provider's pixel-grounded path (OpenAI /images/edits, Gemini inline
    // parts) — dropping any that fail so generation still proceeds.
    const referenceImages = [];
    if (args.use_attached_images !== false) {
      const atts = Array.isArray(ctx?.turnAttachments) ? ctx.turnAttachments : [];
      const urls = Array.isArray(ctx?.turnImageUrls) ? ctx.turnImageUrls : [];
      for (const a of atts) {
        if (a?.type === 'image' && Number.isInteger(a.imageIndex) && urls[a.imageIndex]) {
          referenceImages.push(urls[a.imageIndex]);
        }
      }
    }
    for (const u of Array.isArray(args.reference_image_urls) ? args.reference_image_urls : []) {
      if (typeof u === 'string' && /^https?:\/\//i.test(u.trim())) referenceImages.push(u.trim());
    }
    const result = await generateChatImage({
      prompt: args.prompt,
      aspectRatio: args.aspect_ratio,
      imageSize: args.image_size,
      referenceImages,
      userId: ctx.userId,
      supabaseAdmin: ctx.supabaseAdmin,
      logUsage: (info) => logAiUsage(info),
    });
    if (!result.ok) {
      const msg = result.message || result.error || 'image_generation_failed';
      // Keep the hint attached: it tells the model whether to retry (transient
      // provider error), rephrase (moderation), or report the failure honestly.
      return errorContent(result.hint ? `${msg} — ${result.hint}` : msg);
    }
    return jsonContent(result);
  },
};

export const EXTERIOR_TOOLS = [
  webSearchTool,
  webFetchTool,
  calculateTool,
  generateChartTool,
  generateDiagramTool,
  getCurrentTimeTool,
  runPythonTool,
  generateImageTool,
  ...CAPABILITY_TOOLS,
];

export const EXTERIOR_TOOL_NAMES = EXTERIOR_TOOLS.map((t) => t.name);

export const EXTERIOR_TOOLS_BY_NAME = Object.freeze(
  Object.fromEntries(EXTERIOR_TOOLS.map((t) => [t.name, t])),
);
