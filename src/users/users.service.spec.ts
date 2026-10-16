import { UsersService } from "./users.service";
import { PrismaService } from "@/common/prisma/prisma.service";

describe("UsersService", () => {
  let prisma: {
    session: { findFirst: jest.Mock };
    user: { findMany: jest.Mock };
  };
  let service: UsersService;

  beforeEach(() => {
    prisma = {
      session: { findFirst: jest.fn() },
      user: { findMany: jest.fn() },
    };
    service = new UsersService(prisma as unknown as PrismaService);
  });

  it("accepts a session row with no revocation on it", async () => {
    prisma.session.findFirst.mockResolvedValue({
      id: "session-1",
      userId: "user-1",
      revokedAt: null,
    });

    await expect(service.isSessionLive("user-1", "session-1")).resolves.toBe(
      true,
    );
  });

  it("reports a revoked session as dead", async () => {
    prisma.session.findFirst.mockResolvedValue({
      id: "session-1",
      userId: "user-1",
      revokedAt: new Date(),
    });

    await expect(service.isSessionLive("user-1", "session-1")).resolves.toBe(
      false,
    );
  });

  it("reports a session that another account owns as dead", async () => {
    // Looking the row up under the caller's id is what makes this fail: a
    // session id from elsewhere must not authenticate this token's user.
    prisma.session.findFirst.mockResolvedValue(null);

    await expect(service.isSessionLive("user-1", "session-2")).resolves.toBe(
      false,
    );
    expect(prisma.session.findFirst).toHaveBeenCalledWith({
      where: { id: "session-2", userId: "user-1" },
    });
  });

  it("returns only an id and a display label for account suggestions", async () => {
    prisma.user.findMany.mockResolvedValue([
      { id: "friend-1", displayName: "Priya", deletedAt: null },
      { id: "deleted-1", displayName: "Old account", deletedAt: new Date() },
      { id: "friend-2", displayName: null, deletedAt: null },
    ]);

    const result = await service.suggestAccounts("user-1", "pri");

    expect(result).toEqual([
      { id: "friend-1", displayName: "Priya" },
      // No display name, so the label falls back to the only other thing this
      // endpoint returns: a picker row has to render something.
      { id: "friend-2", displayName: "friend-2" },
    ]);
    // The enumeration guard is the field list: an email here is a directory
    // entry, and this response is readable by any signed-in account.
    expect(JSON.stringify(result)).not.toContain("email");
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { not: "user-1" },
          status: "ACTIVE",
          displayName: { contains: "pri", mode: "insensitive" },
        },
        select: { id: true, displayName: true, deletedAt: true },
        take: 16,
      }),
    );
  });

  it("escapes regex metacharacters in a suggestion term", async () => {
    prisma.user.findMany.mockResolvedValue([]);

    await service.suggestAccounts("user-1", "a.(b+)+$");

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          displayName: {
            contains: "a\\.\\(b\\+\\)\\+\\$",
            mode: "insensitive",
          },
        }),
      }),
    );
  });

  it("does not search accounts until there are three characters", async () => {
    await expect(service.suggestAccounts("user-1", "pr")).resolves.toEqual([]);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});
