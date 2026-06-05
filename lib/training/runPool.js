/**
 * Run async work over items with a fixed concurrency cap.
 */
export async function runPool(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];

  const limit = Math.max(1, Math.min(concurrency, list.length));
  const results = new Array(list.length);
  let nextIndex = 0;

  async function drain() {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= list.length) break;
      try {
        results[i] = { ok: true, value: await worker(list[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => drain()));
  return results;
}
