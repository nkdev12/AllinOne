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

export function assertExpenseShares(total: number, shares: unknown) {
  if (
    !Number.isSafeInteger(total) ||
    total <= 0 ||
    !validShares(shares) ||
    (shares as { owedAmountMinor: number }[]).reduce(
      (sum, share) => sum + share.owedAmountMinor,
      0,
    ) !== total
  ) {
    throw new BadRequestException(
      "Each participant must appear once and shares must add up to the positive expense total.",
    );
  }
}
