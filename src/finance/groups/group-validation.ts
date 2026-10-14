import { BadRequestException } from "@nestjs/common";

export function validMembers(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 100) return false;
  const ids = new Set<string>();
  const names = new Set<string>();
  return value.every((member) => {
    if (
      !member ||
      typeof member.id !== "string" ||
      !member.id.trim() ||
      member.id.length > 100 ||
      typeof member.name !== "string" ||
      !member.name.trim() ||
      member.name.length > 80 ||
      (member.active !== undefined && typeof member.active !== "boolean") ||
      ids.has(member.id)
    )
      return false;
    ids.add(member.id);
    if (member.active !== false) {
      const name = member.name.trim().toLowerCase();
      if (names.has(name)) return false;
      names.add(name);
    }
    return true;
  });
}

export function validShares(value: unknown): boolean {
  if (!Array.isArray(value) || !value.length || value.length > 100)
    return false;
  const ids = new Set<string>();
  return value.every((share) => {
    if (
      !share ||
      typeof share.userId !== "string" ||
      !share.userId.trim() ||
      ids.has(share.userId) ||
      !Number.isSafeInteger(share.owedAmountMinor) ||
      share.owedAmountMinor < 0 ||
      (share.shareUnits != null &&
        (typeof share.shareUnits !== "number" ||
          !Number.isFinite(share.shareUnits) ||
          share.shareUnits < 0))
    )
      return false;
    ids.add(share.userId);
    return true;
  });
}

/**
 * Split types whose rows are a list of amounts the client already decided:
 * there is nothing left for the server to derive, so their sum is the one thing
 * that has to be checked.
 */
const EXACT_SPLIT_TYPES = new Set(["EXACT", "ITEMIZED"]);

function isExactSplit(splitType: unknown): boolean {
  if (splitType === undefined || splitType === null) return true;
  return EXACT_SPLIT_TYPES.has(String(splitType));
}

interface AllocatedShare {
  userId: string;
  owedAmountMinor: number;
  shareUnits: number | null;
}

const SHARE_MESSAGE =
  "Each participant must appear once and shares must add up to the positive expense total.";

/**
 * Code-point ordering, not `localeCompare`: two devices must file the same
 * complaint about the same expense, and a locale-aware sort answers that
 * question in the locale each one happens to run in.
 */
function byUserId(a: { userId: string }, b: { userId: string }): number {
  if (a.userId === b.userId) return 0;
  return a.userId < b.userId ? -1 : 1;
}

/**
 * The shape `EQUAL`, `PERCENTAGE` and `SHARES` actually send: a participant and
 * a weight, with the amount left to the server. `owedAmountMinor` is tolerated
 * (older devices still send it) but never trusted.
 */
function validShareTargets(value: unknown): boolean {
  if (!Array.isArray(value) || !value.length || value.length > 100)
    return false;
  const ids = new Set<string>();
  return value.every((share) => {
    if (
      !share ||
      typeof share.userId !== "string" ||
      !share.userId.trim() ||
      ids.has(share.userId) ||
      (share.owedAmountMinor !== undefined &&
        share.owedAmountMinor !== null &&
        (!Number.isSafeInteger(share.owedAmountMinor) ||
          share.owedAmountMinor < 0)) ||
      (share.shareUnits != null &&
        (typeof share.shareUnits !== "number" ||
          !Number.isFinite(share.shareUnits) ||
          share.shareUnits < 0))
    )
      return false;
    ids.add(share.userId);
    return true;
  });
}

/**
 * Largest-remainder allocation, server-side.
 *
 * `splitType` and `shareUnits` were stored and then ignored: the client had to
 * send exact minor-unit amounts whatever the split type said, so an honest
 * three-way split of 10000 (3333 x 3) was rejected as a 400 while an arbitrary
 * uneven set was accepted. Dividing minor units cannot be exact, so the answer
 * is to divide by weight, floor, and hand the leftover units to the
 * participants whose fractional part came closest to the next unit.
 *
 * Two properties matter more than the arithmetic: the result sums to the total
 * by construction, and every step is ordered — shares are sorted by `userId`
 * and the tie-break on equal remainders is `userId` too. Floating-point ops are
 * exactly specified, so a device that computes the same split offline gets the
 * same row the server writes; an unordered pass would let two devices disagree
 * about who owes the extra paisa and lose one of the two writes on sync.
 *
 * `PERCENTAGE` weights are normalised by their sum like any other, which means
 * a set of percentages that does not total 100 is scaled rather than rejected —
 * the amounts a client sees are then the proportions it described.
 */
export function allocateExpenseShares(
  total: number,
  shares: unknown,
  splitType: unknown,
): AllocatedShare[] {
  if (
    !Number.isSafeInteger(total) ||
    total <= 0 ||
    !Array.isArray(shares) ||
    !shares.length ||
    shares.length > 100
  ) {
    throw new BadRequestException(SHARE_MESSAGE);
  }

  const list = shares as any[];

  if (isExactSplit(splitType)) {
    if (!validShares(list)) throw new BadRequestException(SHARE_MESSAGE);
    const sum = list.reduce(
      (acc: number, share: any) => acc + share.owedAmountMinor,
      0,
    );
    if (!Number.isSafeInteger(sum) || sum !== total) {
      throw new BadRequestException(SHARE_MESSAGE);
    }
    const sorted = [...list].sort(byUserId);
    return sorted.map((share: any) => ({
      userId: share.userId,
      owedAmountMinor: share.owedAmountMinor,
      shareUnits: share.shareUnits ?? null,
    }));
  }

  if (!validShareTargets(list)) throw new BadRequestException(SHARE_MESSAGE);

  const weightOf = (share: any) =>
    String(splitType) === "EQUAL" ? 1 : Number(share.shareUnits ?? 0);
  const weights = list.map(weightOf);
  const weightTotal = weights.reduce(
    (acc: number, weight: number) => acc + weight,
    0,
  );
  if (
    !Number.isFinite(weightTotal) ||
    weightTotal <= 0 ||
    weights.some((weight: number) => !Number.isFinite(weight) || weight < 0)
  ) {
    throw new BadRequestException(
      "Every participant needs a non-negative share weight and at least one of them must take a share.",
    );
  }

  const parts: (AllocatedShare & { remainder: number })[] = [...list]
    .sort(byUserId)
    .map((share: any) => {
      const exact = (total * weightOf(share)) / weightTotal;
      const floor = Math.floor(exact);
      return {
        userId: share.userId,
        owedAmountMinor: floor,
        shareUnits: share.shareUnits ?? null,
        remainder: exact - floor,
      };
    });

  const floored = parts.reduce(
    (acc: number, part: AllocatedShare) => acc + part.owedAmountMinor,
    0,
  );
  let residual = total - floored;

  // Residual is `total - sum(floors)` and so runs 0..participants-1 and is only
  // ever negative when a decimal weight makes `Math.floor` land a hair under an
  // exact integer quotient. Taking those units back in the same deterministic
  // order keeps the sum exact either way.
  const ranked = [...parts].sort(
    (a, b) => b.remainder - a.remainder || byUserId(a, b),
  );

  for (const part of ranked) {
    if (residual <= 0) break;
    part.owedAmountMinor += 1;
    residual -= 1;
  }
  for (const part of ranked) {
    if (residual >= 0) break;
    if (part.owedAmountMinor <= 0) continue;
    part.owedAmountMinor -= 1;
    residual += 1;
  }

  return parts.map(({ remainder, ...part }) => {
    void remainder;
    return part;
  });
}
