import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";

const FETCH_INIT = { cache: "no-store" };

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token || "";
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export async function fetchLoraConfig() {
  const res = await fetch(`${API_BASE_URL}/api/v1/lora/config`, {
    ...FETCH_INIT,
    headers: await authHeaders(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
  }
  return body;
}

export async function startLoraTraining(customModelId, { trainingSetId } = {}) {
  const res = await fetch(
    `${API_BASE_URL}/api/v1/custom-models/${encodeURIComponent(customModelId)}/lora/start`,
    {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({
        training_set_id: trainingSetId || undefined,
      }),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const hint =
      res.status === 404
        ? " Apply migration 077_lykn_lora_jobs.sql and restart the server."
        : "";
    throw new Error((body?.message || body?.error || `HTTP ${res.status}`) + hint);
  }
  return body.job;
}

export async function fetchLatestLoraJob(customModelId) {
  const res = await fetch(
    `${API_BASE_URL}/api/v1/custom-models/${encodeURIComponent(customModelId)}/lora/latest`,
    { ...FETCH_INIT, headers: await authHeaders() },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
  }
  return body.job;
}

export async function fetchLoraJob(jobId) {
  const res = await fetch(`${API_BASE_URL}/api/v1/lora-jobs/${encodeURIComponent(jobId)}`, {
    ...FETCH_INIT,
    headers: await authHeaders(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
  }
  return body.job;
}

export function loraJobProgress(status) {
  if (status === "ready") return 100;
  if (status === "running" || status === "uploading") return 55;
  if (status === "failed" || status === "cancelled") return 100;
  return 15;
}

export function loraJobLabel(status, job) {
  if (status === "queued") return "LoRA queued…";
  if (status === "uploading") return "Uploading training file to Together…";
  if (status === "running") return `LoRA training on ${job?.baseTogetherModel || "base model"}…`;
  if (status === "ready") {
    return job?.outputModelId
      ? "LoRA ready: use in chat (Together serverless, per token)"
      : "LoRA adapter ready";
  }
  if (status === "failed") return "LoRA training failed";
  if (status === "cancelled") return "LoRA cancelled";
  return status;
}

export async function pollLoraJob(jobId, { intervalMs = 4000, timeoutMs = 3_600_000, onTick } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await fetchLoraJob(jobId);
    onTick?.(job);
    if (job.status === "ready" || job.status === "failed" || job.status === "cancelled") {
      return job;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("LoRA training timed out. Check Together dashboard or retry later.");
}
