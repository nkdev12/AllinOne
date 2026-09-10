import { Injectable } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";

export interface HttpRequestMetric {
  method: string;
  route: string;
  statusCode: number;
  durationSeconds: number;
}

@Injectable()
export class MetricsService {
  // Sync throughput counters
  private syncPushesTotal = 0;
  private syncPushedChangesTotal = 0;
  private syncPullsTotal = 0;
  private syncChangesCompactedTotal = 0;

  // Latency samples: method:route:status -> duration array
  private httpRequests: Array<{
    method: string;
    route: string;
    statusCode: number;
    durationSeconds: number;
  }> = [];

  constructor(private prisma: PrismaService) {}

  /**
   * Record HTTP request latency histogram entry.
   */
  recordHttpRequest(metric: HttpRequestMetric) {
    this.httpRequests.push(metric);
    if (this.httpRequests.length > 5000) {
      this.httpRequests.shift(); // Bound memory usage
    }
  }

  /**
   * Increment sync push throughput counter.
   */
  incrementSyncPush(changesCount: number) {
    this.syncPushesTotal += 1;
    this.syncPushedChangesTotal += changesCount;
  }

  /**
   * Increment sync pull throughput counter.
   */
  incrementSyncPull() {
    this.syncPullsTotal += 1;
  }

  /**
   * Increment compacted/pruned change log counter.
   */
  incrementSyncChangesCompacted(count: number) {
    this.syncChangesCompactedTotal += count;
  }

  /**
   * Generates Prometheus exposition format output string.
   */
  async getPrometheusMetrics(): Promise<string> {
    const lines: string[] = [];

    // System uptime
    lines.push("# HELP process_uptime_seconds Process uptime in seconds.");
    lines.push("# TYPE process_uptime_seconds gauge");
    lines.push(`process_uptime_seconds ${process.uptime().toFixed(3)}`);
    lines.push("");

    // Memory usage
    const mem = process.memoryUsage();
    lines.push(
      "# HELP process_resident_memory_bytes Resident memory size in bytes.",
    );
    lines.push("# TYPE process_resident_memory_bytes gauge");
    lines.push(`process_resident_memory_bytes ${mem.rss}`);
    lines.push("");

    // Database connection pool gauge
    let dbStatus = 1;
    try {
      await this.prisma.checkHealth();
    } catch {
      dbStatus = 0;
    }
    lines.push(
      "# HELP database_connections_active Active database connection pool status (1=healthy, 0=unhealthy).",
    );
    lines.push("# TYPE database_connections_active gauge");
    lines.push(`database_connections_active ${dbStatus}`);
    lines.push("");

    // Sync throughput counters
    lines.push(
      "# HELP sync_throughput_pushes_total Total number of sync push requests.",
    );
    lines.push("# TYPE sync_throughput_pushes_total counter");
    lines.push(`sync_throughput_pushes_total ${this.syncPushesTotal}`);
    lines.push("");

    lines.push(
      "# HELP sync_throughput_changes_total Total number of entity changes pushed via sync.",
    );
    lines.push("# TYPE sync_throughput_changes_total counter");
    lines.push(`sync_throughput_changes_total ${this.syncPushedChangesTotal}`);
    lines.push("");

    lines.push(
      "# HELP sync_throughput_pulls_total Total number of sync pull requests.",
    );
    lines.push("# TYPE sync_throughput_pulls_total counter");
    lines.push(`sync_throughput_pulls_total ${this.syncPullsTotal}`);
    lines.push("");

    lines.push(
      "# HELP sync_changes_compacted_total Total number of historical sync change records pruned.",
    );
    lines.push("# TYPE sync_changes_compacted_total counter");
    lines.push(
      `sync_changes_compacted_total ${this.syncChangesCompactedTotal}`,
    );
    lines.push("");

    // HTTP Request Duration Histogram
    lines.push(
      "# HELP http_request_duration_seconds HTTP request latency histogram in seconds.",
    );
    lines.push("# TYPE http_request_duration_seconds histogram");

    // Aggregate histogram buckets per (method, route, statusCode)
    const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
    const grouped = new Map<string, number[]>();

    for (const req of this.httpRequests) {
      const key = `method="${req.method}",route="${req.route}",status_code="${req.statusCode}"`;
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(req.durationSeconds);
    }

    if (grouped.size === 0) {
      lines.push(
        'http_request_duration_seconds_count{method="GET",route="/health",status_code="200"} 0',
      );
      lines.push(
        'http_request_duration_seconds_sum{method="GET",route="/health",status_code="200"} 0',
      );
    } else {
      for (const [labels, durations] of grouped.entries()) {
        let sum = 0;
        for (const duration of durations) {
          sum += duration;
        }

        for (const le of buckets) {
          const bucketCount = durations.filter((d) => d <= le).length;
          lines.push(
            `http_request_duration_seconds_bucket{${labels},le="${le}"} ${bucketCount}`,
          );
        }
        lines.push(
          `http_request_duration_seconds_bucket{${labels},le="+Inf"} ${durations.length}`,
        );
        lines.push(
          `http_request_duration_seconds_sum{${labels}} ${sum.toFixed(6)}`,
        );
        lines.push(
          `http_request_duration_seconds_count{${labels}} ${durations.length}`,
        );
      }
    }

    lines.push("");
    return lines.join("\n");
  }
}
