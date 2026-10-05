import { UsersService } from "./users.service";
import { PrismaService } from "@/common/prisma/prisma.service";

describe("UsersService.isSessionLive", () => {
  let prisma: { session: { findFirst: jest.Mock } };
  let service: UsersService;

  beforeEach(() => {
    prisma = { session: { findFirst: jest.fn() } };
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
});
