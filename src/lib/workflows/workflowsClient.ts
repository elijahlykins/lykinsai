// Learned Workflows client - the renderer's typed door to the main-process
// TeachSession and workflow runtime. Recording, storage, and execution remain
// in main; this module only provides desktop-safe IPC wrappers and React state.

import { useEffect, useState } from "react";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type TeachEventKind = "browser" | "local" | "mcp" | "remote" | "task";

export type StructuredTeachTarget = {
  strategy?: "semantic" | "visual_anchor" | "unresolved";
  role?: string;
  name?: string;
  ariaLabel?: string;
  label?: string;
  text?: string;
  placeholder?: string;
  href?: string;
  testId?: string;
  url?: string;
  app?: string;
  path?: string;
  connectionId?: string;
  toolName?: string;
  remoteTargetId?: string;
  taskId?: string;
  confidence?: "high" | "low";
  visual_anchor?: Record<string, JsonValue>;
};

/** Structured actions only. Raw page content and credentials do not belong here. */
export type StructuredTeachEvent = {
  kind: TeachEventKind;
  action: string;
  target?: StructuredTeachTarget;
  input?: JsonValue;
  output?: JsonValue;
  timestamp?: string;
  human_takeover?: boolean;
  approvalRequired?: boolean;
  metadata?: Record<string, JsonValue>;
};

export type TeachSession = {
  id: string;
  botId: string;
  status: "active";
  name?: string;
  objective?: string;
  eventCount: number;
  rawEventCount?: number;
  droppedEventCount?: number;
  human_takeover?: boolean;
  startedAt: string;
  sourceTaskId?: string;
  sensitiveDataPolicy?: string;
};

export type TeachStatus = {
  active: boolean;
  session: TeachSession | null;
};

export type WorkflowParameter = {
  name: string;
  type?: string;
  required?: boolean;
  default?: JsonValue;
  paths?: string[];
};

export type WorkflowStep = {
  id: string;
  kind: TeachEventKind;
  action: string;
  target?: StructuredTeachTarget;
  input?: JsonValue;
  verification: Record<string, JsonValue>;
  semanticVerification?: Record<string, JsonValue>;
  approvalRequired?: boolean;
  human_takeover?: boolean;
};

export type RecoveredWorkflowUpdate = {
  id: string;
  summary?: string;
  createdAt?: string;
};

export type LearnedWorkflow = {
  schema?: "lykn.workflow";
  schemaVersion?: 1;
  id: string;
  botId: string;
  name: string;
  objective?: string;
  version: number;
  steps: WorkflowStep[];
  parameters: WorkflowParameter[];
  capabilities?: string[];
  connections: Array<{ kind: "mcp" | "remote"; id: string }>;
  approvalPolicy: "preserve_executor_security_gates";
  metadata?: Record<string, JsonValue>;
  recoveredUpdate?: RecoveredWorkflowUpdate | null;
  createdAt: string;
  updatedAt: string;
};

export type StartTeachingInput = {
  botId: string;
  bot?: Record<string, JsonValue>;
  agentId?: string;
  name?: string;
  objective?: string;
  sourceTaskId?: string;
};

export type FinishTeachingInput = {
  name?: string;
};

export type WorkflowInput = LearnedWorkflow;

export type WorkflowPatch = Partial<
  Pick<LearnedWorkflow, "name" | "objective" | "steps" | "parameters">
> & { expectedVersion?: number };

export type WorkflowRunInput = {
  parameters?: Record<string, JsonValue>;
  botId?: string;
  bot?: Record<string, JsonValue>;
};

export type WorkflowRoutineInput = {
  botId: string;
  bot?: Record<string, JsonValue>;
  name?: string;
  instruction?: string;
  trigger?: { type: string; [key: string]: JsonValue };
  enabled?: boolean;
};

type Result<T extends object = object> = { ok: boolean; error?: string } & T;
type Unsubscribe = () => void;
type TeachingChanged = { active?: boolean; session?: TeachSession | null };
type WorkflowsChanged = { workflows?: LearnedWorkflow[] };

type Lykn = {
  desktop?: boolean;
  teachStart?: (input: StartTeachingInput) => Promise<Result<{ session?: TeachSession }>>;
  teachFinish?: (input: FinishTeachingInput) => Promise<Result<{ workflow?: LearnedWorkflow }>>;
  teachCancel?: () => Promise<Result>;
  teachStatus?: () => Promise<Result<TeachStatus>>;
  teachRecordEvent?: (event: StructuredTeachEvent) => Promise<Result>;
  workflowsList?: (botId?: string) => Promise<Result<{ workflows?: LearnedWorkflow[] }>>;
  workflowCreate?: (input: WorkflowInput) => Promise<Result<{ workflow?: LearnedWorkflow }>>;
  workflowUpdate?: (
    workflowId: string,
    patch: WorkflowPatch,
  ) => Promise<Result<{ workflow?: LearnedWorkflow }>>;
  workflowDelete?: (workflowId: string) => Promise<Result>;
  workflowRun?: (
    workflowId: string,
    input?: WorkflowRunInput,
  ) => Promise<Result<{ taskId?: string; runId?: string }>>;
  workflowCreateRoutine?: (
    workflowId: string,
    input: WorkflowRoutineInput,
  ) => Promise<Result<{ routineId?: string }>>;
  workflowApplyRecoveredUpdate?: (
    workflowId: string,
    recoveredUpdateId: string,
  ) => Promise<Result<{ workflow?: LearnedWorkflow }>>;
  onTeachingChanged?: (callback: (payload: TeachingChanged) => void) => Unsubscribe;
  onWorkflowsChanged?: (callback: (payload: WorkflowsChanged) => void) => Unsubscribe;
};

const bridge = (): Lykn =>
  typeof window !== "undefined" ? ((window as { lykn?: Lykn }).lykn ?? {}) : {};

const unavailable = <T extends object = object>(): Promise<Result<T>> =>
  Promise.resolve({ ok: false, error: "desktop_only" } as Result<T>);

export function workflowsAvailable(): boolean {
  const lykn = bridge();
  return !!lykn.desktop && typeof lykn.workflowsList === "function";
}

export function teachingAvailable(): boolean {
  const lykn = bridge();
  return !!lykn.desktop && typeof lykn.teachStatus === "function";
}

export function startTeaching(input: StartTeachingInput) {
  return bridge().teachStart?.(input) ?? unavailable<{ session?: TeachSession }>();
}

export function finishTeaching(input: FinishTeachingInput = {}) {
  return bridge().teachFinish?.(input) ?? unavailable<{ workflow?: LearnedWorkflow }>();
}

export function cancelTeaching() {
  return bridge().teachCancel?.() ?? unavailable();
}

export async function getTeachStatus(): Promise<TeachStatus> {
  const response = await bridge().teachStatus?.();
  const session = response?.ok && response.session ? response.session : null;
  return { active: response?.ok ? (response.active ?? session?.status === "active") : false, session };
}

/**
 * Trusted app integrations may add an already-structured action to the active
 * session. Main still validates, bounds, and scrubs the event before retaining it.
 */
export function recordTeachEvent(event: StructuredTeachEvent) {
  return bridge().teachRecordEvent?.(event) ?? unavailable();
}

export async function listWorkflows(botId?: string): Promise<LearnedWorkflow[]> {
  const response = await bridge().workflowsList?.(botId);
  return response?.ok && Array.isArray(response.workflows) ? response.workflows : [];
}

export function createWorkflow(input: WorkflowInput) {
  return bridge().workflowCreate?.(input) ?? unavailable<{ workflow?: LearnedWorkflow }>();
}

export function updateWorkflow(workflowId: string, patch: WorkflowPatch) {
  return (
    bridge().workflowUpdate?.(workflowId, patch) ??
    unavailable<{ workflow?: LearnedWorkflow }>()
  );
}

export function deleteWorkflow(workflowId: string) {
  return bridge().workflowDelete?.(workflowId) ?? unavailable();
}

export function runWorkflow(workflowId: string, input: WorkflowRunInput = {}) {
  return (
    bridge().workflowRun?.(workflowId, input) ??
    unavailable<{ taskId?: string; runId?: string }>()
  );
}

export function createRoutineFromWorkflow(
  workflowId: string,
  input: WorkflowRoutineInput,
) {
  return (
    bridge().workflowCreateRoutine?.(workflowId, input) ??
    unavailable<{ routineId?: string }>()
  );
}

/** Recovery suggestions are inert until the user explicitly applies one. */
export function applyRecoveredWorkflowUpdate(
  workflowId: string,
  recoveredUpdateId: string,
) {
  return (
    bridge().workflowApplyRecoveredUpdate?.(workflowId, recoveredUpdateId) ??
    unavailable<{ workflow?: LearnedWorkflow }>()
  );
}

export const onTeachingChanged = (callback: (payload: TeachingChanged) => void) =>
  bridge().onTeachingChanged?.(callback) ?? (() => {});

export const onWorkflowsChanged = (callback: (payload: WorkflowsChanged) => void) =>
  bridge().onWorkflowsChanged?.(callback) ?? (() => {});

export function useTeachSession(): TeachStatus {
  const [status, setStatus] = useState<TeachStatus>({ active: false, session: null });

  useEffect(() => {
    if (!teachingAvailable()) return;
    let alive = true;
    const refresh = () => {
      void getTeachStatus().then((next) => {
        if (alive) setStatus(next);
      });
    };
    refresh();
    const off = onTeachingChanged((payload) => {
      if (!alive) return;
      if ("session" in payload) {
        const session = payload.session ?? null;
        setStatus({
          active: payload.active ?? session?.status === "active",
          session,
        });
      } else {
        refresh();
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  return status;
}

/** Live learned-workflow list, optionally scoped to one bot. */
export function useWorkflows(botId?: string): LearnedWorkflow[] {
  const [workflows, setWorkflows] = useState<LearnedWorkflow[]>([]);

  useEffect(() => {
    if (!workflowsAvailable()) return;
    let alive = true;
    const apply = (all: LearnedWorkflow[]) => {
      if (alive) setWorkflows(botId ? all.filter((workflow) => workflow.botId === botId) : all);
    };
    const refresh = () => {
      void listWorkflows(botId).then(apply);
    };
    refresh();
    const off = onWorkflowsChanged((payload) => {
      if (Array.isArray(payload.workflows)) apply(payload.workflows);
      else refresh();
    });
    return () => {
      alive = false;
      off();
    };
  }, [botId]);

  return workflows;
}
