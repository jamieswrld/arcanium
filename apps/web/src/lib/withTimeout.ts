/**
 * Bound any promise with a fallback value.
 *
 * Pages are prerendered at build time, so an unbounded network read in a page
 * becomes an unbounded *build*. That is exactly how a deploy broke: the home
 * page's protocol-stats read had no timeout, Arc's RPC was gated, and Vercel
 * killed the page render after 60s three times over and failed the build.
 *
 * Anything a page awaits during render must come through here (or carry its own
 * budget). Losing a stat to a fallback is a cosmetic degradation; losing the
 * build is an outage.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  fallback: T,
  ms: number,
  label?: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.catch((err: unknown) => {
        if (label !== undefined) console.warn(`[withTimeout] ${label} failed:`, err);
        return fallback;
      }),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          if (label !== undefined) console.warn(`[withTimeout] ${label} timed out after ${ms}ms`);
          resolve(fallback);
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
