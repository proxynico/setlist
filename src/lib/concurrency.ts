/** Run `fn` over `items` with at most `limit` calls in flight, keeping input order. */
export async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    // Stop handing out work after a failure, so the limit holds while the error propagates.
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index]);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
