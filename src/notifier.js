/** Long-poll wake-up primitive: pollers park here, enqueue and shutdown wake them. */
export function createNotifier() {
  const waiters = new Set();
  return {
    wait(ms) {
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, Math.max(0, ms));
        waiters.add(done);
      });
    },
    notify() {
      for (const done of [...waiters]) done();
    },
    get pending() {
      return waiters.size;
    },
  };
}
