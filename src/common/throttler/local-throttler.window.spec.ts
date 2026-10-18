import { LocalThrottlerWindow } from "./local-throttler.window";

const WINDOW = 60_000;
const BLOCK = 30_000;

/** A `null` return means the table had no room; one test asserts that on purpose. */
function hit(
  store: LocalThrottlerWindow,
  key: string,
  now: number,
  limit = 5,
  blockDuration = BLOCK,
  ttl = WINDOW,
) {
  const result = store.record(key, ttl, limit, blockDuration, now);
  if (!result) throw new Error(`expected the table to have room for ${key}`);
  return result;
}

describe("LocalThrottlerWindow", () => {
  it("arms the window on the first hit and never moves it", () => {
    const store = new LocalThrottlerWindow();

    expect(hit(store, "a", 1_000).totalHits).toBe(1);
    hit(store, "a", 40_000);
    const last = hit(store, "a", 59_000);

    expect(last.totalHits).toBe(3);
    // Armed at 1000 for 60s, so two seconds are left at 59000. A window that
    // slid forward on every hit would never close.
    expect(last.timeToExpire).toBe(2);
  });

  it("starts a fresh window after the old one rolls over", () => {
    const store = new LocalThrottlerWindow();

    expect(hit(store, "a", 1_000, 1).isBlocked).toBe(false);
    expect(hit(store, "a", 30_000, 1).isBlocked).toBe(true);

    // Past 61000 the first window is gone, so this is hit one again.
    const after = hit(store, "a", 61_500, 1);
    expect(after.totalHits).toBe(1);
    expect(after.isBlocked).toBe(false);
  });

  it("blocks only a tier that asked for a block duration", () => {
    const store = new LocalThrottlerWindow();

    // Over the limit, twice, and still nothing but a count: `blockDuration: 0`
    // tiers are the ones the app sets on routes where a 429 mid-flow is worse
    // than a slow one.
    expect(hit(store, "a", 1_000, 1, 0).isBlocked).toBe(false);
    expect(hit(store, "a", 2_000, 1, 0).isBlocked).toBe(false);
    expect(hit(store, "a", 3_000, 1, 0).totalHits).toBe(3);
  });

  it("refuses a caller over the limit without counting the refusal", () => {
    const store = new LocalThrottlerWindow();

    hit(store, "a", 1_000, 2);
    hit(store, "a", 2_000, 2);
    const over = hit(store, "a", 3_000, 2);
    expect(over.isBlocked).toBe(true);
    expect(over.timeToBlockExpire).toBe(BLOCK / 1000);

    const during = hit(store, "a", 20_000, 2);
    expect(during.isBlocked).toBe(true);
    // Not counted while blocked, so hammering cannot stretch the penalty: the
    // block was earned at 3000 and still ends at 33000.
    expect(during.totalHits).toBe(3);
    expect(during.timeToBlockExpire).toBe(13);
    expect(hit(store, "a", 25_000, 2).totalHits).toBe(3);
  });

  it("treats a block that outlived its window as still a block", () => {
    const store = new LocalThrottlerWindow();

    // A 120s block over a 10s window: reading the counter alone would report
    // zero hits and hand the allowance back to a refused caller.
    hit(store, "a", 1_000, 0, 120_000, 10_000);
    const later = hit(store, "a", 50_000, 0, 120_000, 10_000);

    expect(later.isBlocked).toBe(true);
    expect(later.totalHits).toBe(1);
    expect(later.timeToExpire).toBe(10);
  });

  it("reclaims an expired window first and never a live block", () => {
    const store = new LocalThrottlerWindow(2);

    hit(store, "quiet", 1_000, 5, 0, 1_000); // rolls over at 2000
    hit(store, "blocked", 1_000, 0, BLOCK); // blocks until 31000

    expect(hit(store, "newcomer", 5_000, 5, 0).totalHits).toBe(1);
    expect(store.trackedKeys).toBe(2);
    expect(store.record("blocked", WINDOW, 0, BLOCK, 5_000)).toMatchObject({
      isBlocked: true,
      timeToBlockExpire: 26,
    });

    // Nothing is expired now, so the entry that never blocked anybody goes.
    expect(hit(store, "another", 6_000, 5, 0).totalHits).toBe(1);
    expect(store.record("blocked", WINDOW, 0, BLOCK, 6_000)).toMatchObject({
      isBlocked: true,
      timeToBlockExpire: 25,
    });
    expect(store.record("quiet", WINDOW, 5, 0, 6_000)).toMatchObject({
      totalHits: 1,
    });
  });

  it("reports no room rather than inventing a block", () => {
    const store = new LocalThrottlerWindow(2);

    hit(store, "a", 1_000, 0, BLOCK);
    hit(store, "b", 1_000, 0, BLOCK);

    // Every slot is refusing someone, so a stranger is let through uncounted —
    // which is what the caller's `null` branch means — rather than blocked for a
    // table it never touched.
    expect(store.record("c", WINDOW, 0, BLOCK, 2_000)).toBeNull();
    expect(store.trackedKeys).toBe(2);
  });

  it("forgets everything when Redis answers again", () => {
    const store = new LocalThrottlerWindow();

    hit(store, "a", 1_000, 1);
    hit(store, "a", 2_000, 1);
    store.clear();

    expect(store.trackedKeys).toBe(0);
    expect(hit(store, "a", 3_000, 1).totalHits).toBe(1);
  });
});
