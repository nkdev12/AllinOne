import { Test, TestingModule } from "@nestjs/testing";
import { MetricsService } from "./metrics.service";
import { PrismaService } from "@/common/prisma/prisma.service";

describe("MetricsService", () => {
  let service: MetricsService;
  let prismaService: any;

  beforeEach(async () => {
    prismaService = {
      checkHealth: jest.fn().mockResolvedValue({ latency: 5 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MetricsService,
        { provide: PrismaService, useValue: prismaService },
      ],
    }).compile();

    service = module.get<MetricsService>(MetricsService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("getPrometheusMetrics", () => {
    it("should generate formatted Prometheus metrics output including system, DB, sync throughput, and latency histograms", async () => {
      service.recordHttpRequest({
        method: "POST",
        route: "/sync/push",
        statusCode: 200,
        durationSeconds: 0.045,
      });

      service.incrementSyncPush(3);
      service.incrementSyncPull();
      service.incrementSyncChangesCompacted(5);

      const output = await service.getPrometheusMetrics();

      expect(output).toContain("# HELP process_uptime_seconds");
      expect(output).toContain("# HELP database_connections_active");
      expect(output).toContain("database_connections_active 1");
      expect(output).toContain("sync_throughput_pushes_total 1");
      expect(output).toContain("sync_throughput_changes_total 3");
      expect(output).toContain("sync_throughput_pulls_total 1");
      expect(output).toContain("sync_changes_compacted_total 5");
      expect(output).toContain("# HELP http_request_duration_seconds");
      expect(output).toContain(
        'method="POST",route="/sync/push",status_code="200"',
      );
    });
  });
});
