export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 10, label = 'condition' } = {}) {
  const startedAt = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await sleep(intervalMs);
  }
}
