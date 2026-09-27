import { WorkerModule } from "./worker.module";
import { getQueueToken } from "@nestjs/bull";

describe("WorkerModule", () => {
  it("should be defined and declare worker queues and tokens", () => {
    expect(WorkerModule).toBeDefined();
    const maintenanceQueueToken = getQueueToken("maintenance");
    const mailQueueToken = getQueueToken("mail");
    const notificationQueueToken = getQueueToken("notification");
    const exportQueueToken = getQueueToken("export");

    expect(maintenanceQueueToken).toBe("BullQueue_maintenance");
    expect(mailQueueToken).toBe("BullQueue_mail");
    expect(notificationQueueToken).toBe("BullQueue_notification");
    expect(exportQueueToken).toBe("BullQueue_export");
  });
});
