import { SyncNotificationService } from "./sync-notification.service";
import { SyncGateway } from "./sync.gateway";

/**
 * The one job of this class is that a wake-up can never cost a request its
 * response: the mutation it reports has already been committed by the time it is
 * called, and it is called from the request path of three other modules.
 */
describe("SyncNotificationService", () => {
  let gateway: { notifySyncInvalidation: jest.Mock };
  let service: SyncNotificationService;

  beforeEach(() => {
    gateway = { notifySyncInvalidation: jest.fn() };
    service = new SyncNotificationService(gateway as unknown as SyncGateway);
  });

  it("hands the gateway the user, the origin device and the cursor", () => {
    service.notifyMutation({
      userId: "user-1",
      originDeviceId: "device-1",
      highestCursor: "42",
    });

    expect(gateway.notifySyncInvalidation).toHaveBeenCalledWith(
      "user-1",
      "device-1",
      "42",
    );
  });

  it("carries a bigint cursor as the string the payload says", () => {
    // `appendChange` hands back a `bigint`, and the REST services pass it
    // straight through. `JSON.stringify` on a bigint throws, and the wire format
    // every other cursor in this codebase uses is a decimal string.
    service.notifyMutation({ userId: "user-1", highestCursor: BigInt(9007) });

    expect(gateway.notifySyncInvalidation).toHaveBeenCalledWith(
      "user-1",
      undefined,
      "9007",
    );
  });

  it("says nothing about an origin device a REST write never had", () => {
    service.notifyMutation({ userId: "user-1" });

    expect(gateway.notifySyncInvalidation).toHaveBeenCalledWith(
      "user-1",
      undefined,
      undefined,
    );
  });

  it("is a no-op with no gateway, and does not throw", () => {
    // The queue worker and any unit graph that compiles one feature module
    // without `SyncModule`: the change row is written either way, so the worst
    // case here is a device learning about it at its next pull.
    const withoutGateway = new SyncNotificationService(undefined);

    expect(() =>
      withoutGateway.notifyMutation({ userId: "user-1", highestCursor: "3" }),
    ).not.toThrow();
    expect(withoutGateway["syncGateway"]).toBeUndefined();
  });

  it("swallows a gateway that threw", () => {
    gateway.notifySyncInvalidation.mockImplementation(() => {
      throw new Error("socket.io server is gone");
    });

    expect(() =>
      service.notifyMutation({ userId: "user-1", highestCursor: "3" }),
    ).not.toThrow();
  });

  it("ignores a notice with no user to wake", () => {
    service.notifyMutation({ userId: "" });

    expect(gateway.notifySyncInvalidation).not.toHaveBeenCalled();
  });
});
