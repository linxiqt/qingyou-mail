// Bound expensive jobs without abandoning in-flight work after a rejection.
export async function mapLimit(items, concurrency, mapper) {
  const results = new Array(items.length);
  let next = 0;
  let failure;
  let failed = false;
  await Promise.all(
    Array.from(
      { length: Math.min(items.length, Math.max(1, concurrency)) },
      async () => {
        while (!failed && next < items.length) {
          const index = next++;
          try {
            results[index] = await mapper(items[index], index);
          } catch (error) {
            if (!failed) failure = error;
            failed = true;
          }
        }
      },
    ),
  );
  if (failed) throw failure;
  return results;
}
