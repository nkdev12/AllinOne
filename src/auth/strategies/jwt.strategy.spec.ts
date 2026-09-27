import { JwtStrategy } from "./jwt.strategy";
import { UsersService } from "@/users/users.service";
import { ConfigurationService } from "@/config/configuration.service";
import { ErrorCode } from "@/common/errors/error-code";

describe("JwtStrategy", () => {
  let strategy: JwtStrategy;
  let usersService: { getUserById: jest.Mock; isSessionLive: jest.Mock };

  const user = {
    id: "user-1",
    email: "test@example.com",
    displayName: "Test User",
    status: "ACTIVE",
    deletedAt: null,
  };

  const withSession = {
    sub: "user-1",
    email: "test@example.com",
    sessionId: "session-1",
  };

  beforeEach(() => {
    usersService = {
      getUserById: jest.fn().mockResolvedValue(user),
      isSessionLive: jest.fn().mockResolvedValue(true),
    };

    strategy = new JwtStrategy(
      { jwtAccessSecret: "access-secret" } as ConfigurationService,
      usersService as unknown as UsersService,
    );
  });

  it("accepts a token whose session is still live", async () => {
    await expect(strategy.validate(withSession)).resolves.toMatchObject({
      id: "user-1",
      sessionId: "session-1",
    });
    expect(usersService.isSessionLive).toHaveBeenCalledWith(
      "user-1",
      "session-1",
    );
  });

  it("rejects a token whose session has been revoked", async () => {
    usersService.isSessionLive.mockResolvedValue(false);

    await expect(strategy.validate(withSession)).rejects.toMatchObject({
      response: { code: ErrorCode.SESSION_REVOKED },
    });
  });

  it("rejects a token that names a session belonging to somebody else", async () => {
    // The lookup is scoped by user, so a stolen id from another account cannot
    // stand in for the attacker's own live session.
    usersService.isSessionLive.mockResolvedValue(false);

    await expect(
      strategy.validate({ ...withSession, sessionId: "not-mine" }),
    ).rejects.toMatchObject({ response: { code: ErrorCode.SESSION_REVOKED } });

    expect(usersService.isSessionLive).toHaveBeenCalledWith(
      "user-1",
      "not-mine",
    );
  });

  it("still accepts tokens that carry no session, which is what older and service tokens look like", async () => {
    await expect(
      strategy.validate({ sub: "user-1", email: "test@example.com" }),
    ).resolves.toMatchObject({ id: "user-1" });

    expect(usersService.isSessionLive).not.toHaveBeenCalled();
  });

  it("rejects an account that is no longer active", async () => {
    usersService.getUserById.mockResolvedValue({
      ...user,
      status: "SUSPENDED",
    });

    await expect(strategy.validate(withSession)).rejects.toMatchObject({
      response: { code: ErrorCode.ACCOUNT_DISABLED },
    });
    expect(usersService.isSessionLive).not.toHaveBeenCalled();
  });
});
