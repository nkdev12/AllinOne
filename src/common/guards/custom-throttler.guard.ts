import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const xForwardedFor = req.headers["x-forwarded-for"];
    if (xForwardedFor) {
      const ips = (
        Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor
      ).split(",");
      return ips[0].trim();
    }
    return req.ip || req.socket?.remoteAddress || "127.0.0.1";
  }
}
