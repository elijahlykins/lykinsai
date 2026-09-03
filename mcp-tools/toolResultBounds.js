// ============================================================================
// mcp-tools/toolResultBounds.js — bound first-party tool RESULTS for the model
// ============================================================================
// Schemas are already bounded by progressive disclosure. This clips oversized
// handler payloads BEFORE they enter model context.
//
// Small results pass through. Search/list results are compacted. Full-read
// paths (Voice read_document) stay available and are only capped
// at a generous body limit. Local/Remote already have their own output limits
// — this layer must not re-expand them. Universal MCP bounding stays in MCP.

const SEARCH_HIT_CAP = 10;
const LIST_ITEM_CAP = 25;
const SNIPPET_CHARS = 280;
const NOTES_CHARS = 280;
const HTTP_BODY_CHARS = 8000;
const WEB_PAGE_CHARS = 2000;
const DOCUMENT_BODY_CHARS = 16000;
const ARRAY_PREVIEW = 25;

function clipText(value, max) {
  if (value == null) return value;
  const s = String(value);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function compactHit(hit) {
  if (!hit || typeof hit !== 'object') return hit;
  const nodeId = hit.node_id || (hit.id ? `vault_${hit.id}` : null);
  return {
    node_id: nodeId,
    title: clipText(hit.title || '(untitled)', 120),
    snippet: clipText(hit.snippet || '', SNIPPET_CHARS),
    match: hit.match || undefined,
  };
}

function compactEvent(event) {
  if (!event || typeof event !== 'object') return event;
  return {
    id: event.id,
    title: clipText(event.title, 120),
    starts_at: event.starts_at,
    ends_at: event.ends_at,
    all_day: event.all_day,
    location: clipText(event.location, 160),
    status: event.status,
    timezone: event.timezone,
    read_only: event.read_only,
    external_provider: event.external_provider || undefined,
    project_id: event.project_id || undefined,
    project_name: event.project_name || undefined,
    description: event.description ? clipText(event.description, SNIPPET_CHARS) : undefined,
  };
}

function compactTodo(todo) {
  if (!todo || typeof todo !== 'object') return todo;
  return {
    id: todo.id,
    title: clipText(todo.title, 120),
    status: todo.status,
    priority: todo.priority,
    due_at: todo.due_at,
    due_at_text: todo.due_at_text,
    overdue: todo.overdue,
    project_id: todo.project_id || undefined,
    project_name: todo.project_name || undefined,
    notes: todo.notes ? clipText(todo.notes, NOTES_CHARS) : undefined,
  };
}

function compactProject(project) {
  if (!project || typeof project !== 'object') return project;
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    is_focus: project.is_focus,
    last_active_at: project.last_active_at,
    description: project.description ? clipText(project.description, SNIPPET_CHARS) : undefined,
    is_branch: project.is_branch,
    parent_project_id: project.parent_project_id || undefined,
  };
}

function compactWebResult(item) {
  if (!item || typeof item !== 'object') return item;
  return {
    rank: item.rank,
    title: clipText(item.title, 160),
    url: item.url,
    snippet: clipText(item.snippet, SNIPPET_CHARS),
  };
}

function compactWebPage(page) {
  if (!page || typeof page !== 'object') return page;
  return {
    title: clipText(page.title, 160),
    url: page.url,
    content: clipText(page.content, WEB_PAGE_CHARS),
  };
}

function capArray(arr, max) {
  if (!Array.isArray(arr)) return { items: arr, truncated: false, omitted: 0 };
  if (arr.length <= max) return { items: arr, truncated: false, omitted: 0 };
  return { items: arr.slice(0, max), truncated: true, omitted: arr.length - max };
}

function withTruncationMeta(obj, omitted, key = 'omitted') {
  if (!omitted) return obj;
  return { ...obj, truncated: true, [key]: omitted };
}

function boundNamedPayload(name, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;

  if (name === 'lykn_searchVault' || name === 'search_vault') {
    const hits = Array.isArray(payload.hits) ? payload.hits : Array.isArray(payload.documents) ? payload.documents : [];
    const { items, omitted } = capArray(hits, SEARCH_HIT_CAP);
    const compact = items.map(compactHit);
    if (Array.isArray(payload.hits)) {
      const next = { ok: payload.ok, query: payload.query, count: compact.length, hits: compact };
      return withTruncationMeta(next, omitted, 'omitted_hits');
    }
    if (Array.isArray(payload.documents)) {
      return withTruncationMeta(
        { ok: payload.ok, documents: compact, results: payload.results, hint: payload.hint },
        omitted,
        'omitted_hits',
      );
    }
  }

  if (name === 'lykn_listEvents' || name === 'list_events') {
    const events = Array.isArray(payload.events) ? payload.events : [];
    const { items, omitted } = capArray(events, LIST_ITEM_CAP);
    return withTruncationMeta(
      {
        ok: payload.ok,
        count: items.length,
        window: payload.window,
        events: items.map(compactEvent),
        message: payload.message || null,
      },
      omitted,
      'omitted',
    );
  }

  if (name === 'lykn_listTodos' || name === 'list_todos') {
    const todos = Array.isArray(payload.todos) ? payload.todos : [];
    const { items, omitted } = capArray(todos, LIST_ITEM_CAP);
    return withTruncationMeta(
      {
        ok: payload.ok,
        count: items.length,
        todos: items.map(compactTodo),
        message: payload.message || null,
      },
      omitted,
      'omitted',
    );
  }

  if (name === 'lykn_listProjects' || name === 'list_projects') {
    const projects = Array.isArray(payload.projects) ? payload.projects : [];
    const { items, omitted } = capArray(projects, LIST_ITEM_CAP);
    return withTruncationMeta(
      {
        ok: payload.ok,
        count: items.length,
        projects: items.map(compactProject),
      },
      omitted,
      'omitted',
    );
  }

  if (name === 'lykn_web_search' || name === 'web_search') {
    const results = Array.isArray(payload.results) ? payload.results.map(compactWebResult) : payload.results;
    const pages = Array.isArray(payload.pages) ? payload.pages.slice(0, 3).map(compactWebPage) : undefined;
    return {
      ok: payload.ok,
      query: payload.query,
      result_count: Array.isArray(results) ? results.length : payload.result_count,
      results,
      ...(pages ? { pages } : {}),
      ...(payload.error ? { error: payload.error } : {}),
    };
  }

  if (name === 'lykn_web_fetch' || name === 'web_fetch') {
    if (typeof payload.content === 'string' && payload.content.length > DOCUMENT_BODY_CHARS) {
      return {
        ...payload,
        content: payload.content.slice(0, DOCUMENT_BODY_CHARS),
        truncated: true,
        full_length: payload.content.length,
      };
    }
    return payload;
  }

  if (name === 'lykn_http_request') {
    const body = payload.body;
    if (typeof body === 'string' && body.length > HTTP_BODY_CHARS) {
      return { ...payload, body: body.slice(0, HTTP_BODY_CHARS), truncated: true };
    }
    if (body && typeof body === 'object') {
      const json = JSON.stringify(body);
      if (json.length > HTTP_BODY_CHARS) {
        return { ...payload, body: json.slice(0, HTTP_BODY_CHARS), truncated: true, body_was_json: true };
      }
    }
    return payload;
  }

  if (name === 'read_document') {
    const content = payload.content || payload.note?.content || payload.display;
    if (typeof content === 'string' && content.length > DOCUMENT_BODY_CHARS) {
      const clipped = content.slice(0, DOCUMENT_BODY_CHARS);
      if (payload.note && typeof payload.note === 'object') {
        return {
          ...payload,
          note: { ...payload.note, content: clipped, truncated: true },
          display: typeof payload.display === 'string' ? payload.display.slice(0, DOCUMENT_BODY_CHARS) : payload.display,
        };
      }
      return { ...payload, content: clipped, truncated: true, full_length: content.length };
    }
    return payload;
  }

  if (name === 'lykn_getRecentActivity' || name === 'get_recent_activity') {
    const items = Array.isArray(payload.items) ? payload.items : Array.isArray(payload.activity) ? payload.activity : null;
    if (items) {
      const { items: sliced, omitted } = capArray(items, LIST_ITEM_CAP);
      const key = Array.isArray(payload.items) ? 'items' : 'activity';
      return withTruncationMeta({ ...payload, [key]: sliced, count: sliced.length }, omitted, 'omitted');
    }
    return payload;
  }

  return payload;
}

export function boundToolResult(name, payload) {
  try {
    return boundNamedPayload(String(name || ''), payload);
  } catch {
    return payload;
  }
}

export function measureResultPayload(payload) {
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
  const bytes = Buffer.byteLength(json, 'utf8');
  return { bytes, approxTokens: Math.round(bytes / 4), chars: json.length };
}
