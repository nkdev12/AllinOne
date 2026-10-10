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

  it("returns only active, non-deleted account suggestions", async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        id: "friend-1",
        email: "priya@example.com",
        displayName: "Priya",
        deletedAt: null,
      },
      {
        id: "deleted-1",
        email: "old@example.com",
        displayName: "Old account",
        deletedAt: new Date(),
      },
    ]);

    await expect(service.suggestAccounts("user-1", "pr")).resolves.toEqual([
      {
        id: "friend-1",
        email: "priya@example.com",
        displayName: "Priya",
      },
    ]);
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { not: "user-1" },
          status: "ACTIVE",
        }),
        take: 12,
      }),
    );
  });

  it("does not search accounts until there are two characters", async () => {
    await expect(service.suggestAccounts("user-1", "p")).resolves.toEqual([]);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});
