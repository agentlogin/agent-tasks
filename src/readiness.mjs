/** Both schemas are authoritative dependencies. Cache only on a monotonic clock and coalesce probes. */
export function readinessCheck({ store, callbacks, stopping = () => false, now = () => performance.now() }) {
  let lastAt = -Infinity, lastResult = false, pending;
  return async () => {
    if (stopping()) return false;
    if (pending) return pending;
    const age = now() - lastAt;
    if (age >= 0 && age < 2000) return lastResult;
    // Wait for every checked-out dependency operation even when its peer fails early.
    pending = Promise.resolve().then(() => Promise.allSettled([store.verify(), callbacks.verifySchema()]))
      .then(results => results.every(result => result.status === 'fulfilled') && !stopping(), () => false)
      .then(result => { lastAt = now(); lastResult = result; return result; })
      .finally(() => { pending = undefined; });
    return pending;
  };
}
