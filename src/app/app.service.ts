import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class AppService {
  constructor(private configService: ConfigService) {}

  getRoot() {
    return {
      message: "Allinone Backend API",
      status: "running",
      version: "1.0.0",
      environment: this.configService.get("APP_ENV"),
      documentation: "/api",
    };
  }

  getInfo() {
    return {
      name: "Allinone Backend",
      version: "1.0.0",
      description:
        "Production-grade backend for cross-platform personal information management",
      environment: this.configService.get("APP_ENV"),
      timestamp: new Date().toISOString(),
      features: [
        "Authentication",
        "User Management",
        "Device Management",
        "Offline-first Synchronization",
        "Notes Management",
        "Task Management",
        "Calendar Management",
        "Encrypted Password Manager",
        "Global Search",
        "Audit Logging",
        "File Attachments",
        "Notifications",
      ],
    };
  }
}
