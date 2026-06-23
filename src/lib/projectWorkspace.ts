// Project workspace data layer — the tasks (lykn_todos, 099) and calendar
// events (lykn_events, 094/095) that belong to a single synthesis-layer
// project. Both tables already carry an optional `project_id` foreign key
// (ON DELETE SET NULL), and the MCP tools (lykn_createTodo / lykn_createEvent)
// stamp it when an outside AI client files work under a project. This module
// is the in-app read/write surface the Projects detail page uses to show and
// edit that same work — so a task LYKN files from chat shows up on the
// project's dashboard, and a deadline the user sets here is visible to every
// connected AI client.
//
// These rows are RLS-protected by user_id and only exist for signed-in users
// (guests have no auth.uid()), so — unlike userProjects.ts — there is no
// localStorage tier here. A missing userId returns empty.

import { supabase } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Tasks (lykn_todos)
// ---------------------------------------------------------------------------

export type TodoStatus = "open" | "completed" | "cancelled";
export type TodoPriority = "low" | "normal" | "high";

export interface ProjectTodo {
  id: string;
  title: string;
  notes: string | null;
  status: TodoStatus;
  priority: TodoPriority;
  dueAt: number | null;
  dueAtText: string | null;
  position: number | null;
  source: string | null;
  createdAt: number;
  completedAt: number | null;
}

const TODO_COLS =
  "id, title, notes, status, priority, due_at, due_at_text, position, source, created_at, completed_at, updated_at";

function mapTodo(r: Record<string, unknown>): ProjectTodo {
  return {
    id: r.id as string,
    title: (r.title as string) || "",
    notes: (r.notes as string | null) ?? null,
    status: ((r.status as string) || "open") as TodoStatus,
    priority: ((r.priority as string) || "normal") as TodoPriority,
    dueAt: r.due_at ? new Date(r.due_at as string).getTime() : null,
    dueAtText: (r.due_at_text as string | null) ?? null,
    position: typeof r.position === "number" ? (r.position as number) : null,
    source: (r.source as string | null) ?? null,
    createdAt: r.created_at ? new Date(r.created_at as string).getTime() : Date.now(),
    completedAt: r.completed_at ? new Date(r.completed_at as string).getTime() : null,
  };
}

/**
 * Every open + completed task filed under this project, newest first.
 * Cancelled rows are omitted (kept server-side for undo/history only).
 */
export async function listProjectTodos(
  userId: string | null | undefined,
  projectId: string,
): Promise<ProjectTodo[]> {
  if (!userId || !projectId) return [];
  try {
    // No user_id filter: on a shared project, tasks filed by other members
    // belong to the project, not just to us. RLS (110) scopes what we can read
    // to our own rows + the shared projects we're a member of, so filtering by
    // project_id alone is both correct and safe.
    const { data, error } = await supabase
      .from("lykn_todos")
      .select(TODO_COLS)
      .eq("project_id", projectId)
      .in("status", ["open", "completed"])
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data || []).map(mapTodo);
  } catch {
    return [];
  }
}

export interface CreateProjectTodoArgs {
  title: string;
  notes?: string | null;
  priority?: TodoPriority | string;
  /** Absolute ISO instant for the deadline, or null for no due date. */
  dueIso?: string | null;
  /** Human phrasing of the deadline kept verbatim for read-back. */
  dueText?: string | null;
}

export async function createProjectTodo(
  userId: string | null | undefined,
  projectId: string,
  args: CreateProjectTodoArgs,
): Promise<ProjectTodo | null> {
  const title = args.title.trim().slice(0, 280);
  if (!userId || !projectId || !title) return null;
  try {
    const { data, error } = await supabase
      .from("lykn_todos")
      .insert({
        user_id: userId,
        project_id: projectId,
        title,
        notes: args.notes ? args.notes.trim().slice(0, 4000) : null,
        priority: args.priority || "normal",
        due_at: args.dueIso || null,
        due_at_text: args.dueText ? args.dueText.slice(0, 200) : null,
        source: "projects-ui",
      })
      .select(TODO_COLS)
      .single();
    if (error) throw error;
    return mapTodo(data);
  } catch {
    return null;
  }
}

export async function setTodoStatus(
  userId: string | null | undefined,
  todoId: string,
  status: TodoStatus,
): Promise<boolean> {
  if (!userId || !todoId) return false;
  try {
    const { error } = await supabase
      .from("lykn_todos")
      .update({
        status,
        completed_at: status === "completed" ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", todoId);
    if (error) throw error;
    return true;
  } catch {
    return false;
  }
}

export async function setTodoPriority(
  userId: string | null | undefined,
  todoId: string,
  priority: TodoPriority | string,
): Promise<boolean> {
  if (!userId || !todoId) return false;
  try {
    const { error } = await supabase
      .from("lykn_todos")
      .update({ priority, updated_at: new Date().toISOString() })
      .eq("id", todoId);
    if (error) throw error;
    return true;
  } catch {
    return false;
  }
}

export async function setTodoDue(
  userId: string | null | undefined,
  todoId: string,
  dueIso: string | null,
  dueText: string | null,
): Promise<boolean> {
  if (!userId || !todoId) return false;
  try {
    const { error } = await supabase
      .from("lykn_todos")
      .update({
        due_at: dueIso,
        due_at_text: dueText,
        updated_at: new Date().toISOString(),
      })
      .eq("id", todoId);
    if (error) throw error;
    return true;
  } catch {
    return false;
  }
}

export async function deleteProjectTodo(
  userId: string | null | undefined,
  todoId: string,
): Promise<boolean> {
  if (!userId || !todoId) return false;
  try {
    const { error } = await supabase
      .from("lykn_todos")
      .delete()
      .eq("id", todoId);
    if (error) throw error;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Calendar events (lykn_events)
// ---------------------------------------------------------------------------

export type EventStatus = "confirmed" | "tentative" | "cancelled";

export interface ProjectEvent {
  id: string;
  title: string;
  description: string | null;
  startsAt: number;
  endsAt: number | null;
  allDay: boolean;
  location: string | null;
  color: string | null;
  status: EventStatus;
  externalProvider: string | null;
  readOnly: boolean;
  createdAt: number;
}

const EVENT_COLS =
  "id, title, description, starts_at, ends_at, all_day, location, color, status, external_provider, read_only, created_at";

function mapEvent(r: Record<string, unknown>): ProjectEvent {
  return {
    id: r.id as string,
    title: (r.title as string) || "",
    description: (r.description as string | null) ?? null,
    startsAt: r.starts_at ? new Date(r.starts_at as string).getTime() : Date.now(),
    endsAt: r.ends_at ? new Date(r.ends_at as string).getTime() : null,
    allDay: Boolean(r.all_day),
    location: (r.location as string | null) ?? null,
    color: (r.color as string | null) ?? null,
    status: ((r.status as string) || "confirmed") as EventStatus,
    externalProvider: (r.external_provider as string | null) ?? null,
    readOnly: Boolean(r.read_only),
    createdAt: r.created_at ? new Date(r.created_at as string).getTime() : Date.now(),
  };
}

/** Every non-cancelled event filed under this project, earliest first. */
export async function listProjectEvents(
  userId: string | null | undefined,
  projectId: string,
): Promise<ProjectEvent[]> {
  if (!userId || !projectId) return [];
  try {
    // No user_id filter: shared-project events belong to the project (see
    // listProjectTodos). RLS (110) keeps us to rows we're allowed to read.
    const { data, error } = await supabase
      .from("lykn_events")
      .select(EVENT_COLS)
      .eq("project_id", projectId)
      .neq("status", "cancelled")
      .order("starts_at", { ascending: true });
    if (error) throw error;
    return (data || []).map(mapEvent);
  } catch {
    return [];
  }
}

export interface CreateProjectEventArgs {
  title: string;
  description?: string | null;
  startsIso: string;
  endsIso?: string | null;
  allDay?: boolean;
  location?: string | null;
  timezone?: string | null;
}

export async function createProjectEvent(
  userId: string | null | undefined,
  projectId: string,
  args: CreateProjectEventArgs,
): Promise<ProjectEvent | null> {
  const title = args.title.trim().slice(0, 280);
  if (!userId || !projectId || !title || !args.startsIso) return null;
  try {
    const { data, error } = await supabase
      .from("lykn_events")
      .insert({
        user_id: userId,
        project_id: projectId,
        title,
        description: args.description ? args.description.trim().slice(0, 4000) : null,
        starts_at: args.startsIso,
        ends_at: args.endsIso || null,
        all_day: Boolean(args.allDay),
        location: args.location ? args.location.trim().slice(0, 300) : null,
        timezone: args.timezone || null,
        source: "projects-ui",
      })
      .select(EVENT_COLS)
      .single();
    if (error) throw error;
    return mapEvent(data);
  } catch {
    return null;
  }
}

export interface UpdateProjectEventArgs {
  title?: string;
  description?: string | null;
  startsIso?: string;
  endsIso?: string | null;
  allDay?: boolean;
  location?: string | null;
}

export async function updateProjectEvent(
  userId: string | null | undefined,
  eventId: string,
  args: UpdateProjectEventArgs,
): Promise<boolean> {
  if (!userId || !eventId) return false;
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (args.title !== undefined) patch.title = args.title.trim().slice(0, 280);
  if (args.description !== undefined)
    patch.description = args.description ? args.description.trim().slice(0, 4000) : null;
  if (args.startsIso !== undefined) patch.starts_at = args.startsIso;
  if (args.endsIso !== undefined) patch.ends_at = args.endsIso || null;
  if (args.allDay !== undefined) patch.all_day = Boolean(args.allDay);
  if (args.location !== undefined)
    patch.location = args.location ? args.location.trim().slice(0, 300) : null;
  try {
    const { error } = await supabase
      .from("lykn_events")
      .update(patch)
      .eq("id", eventId);
    if (error) throw error;
    return true;
  } catch {
    return false;
  }
}

export async function deleteProjectEvent(
  userId: string | null | undefined,
  eventId: string,
): Promise<boolean> {
  if (!userId || !eventId) return false;
  try {
    const { error } = await supabase
      .from("lykn_events")
      .delete()
      .eq("id", eventId);
    if (error) throw error;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shared date helpers — kept here so the page and any future surface format
// deadlines identically.
// ---------------------------------------------------------------------------

/** A YYYY-MM-DD date-input value → ISO instant at end of that local day, so
 * "due Friday" counts as on-time any time on Friday (mirrors LyknTodosPanel). */
export function dateInputToIso(dateStr: string): string | null {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T23:59:59`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Short, friendly label for a date input value ("Fri, Jun 19"). */
export function dateInputToText(dateStr: string): string | null {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T23:59:59`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** The display label for a todo's deadline — verbatim phrasing if present. */
export function todoDueLabel(todo: ProjectTodo): string {
  if (todo.dueAtText) return todo.dueAtText;
  if (todo.dueAt == null) return "";
  const d = new Date(todo.dueAt);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
