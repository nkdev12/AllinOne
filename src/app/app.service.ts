import { Injectable } from "@nestjs/common";

@Injectable()
export class AppService {
  getRoot() {
    return {
      message: "Allinone Backend API",
      status: "running",
      version: "1.0.0",
    };
  }

  getInfo() {
    return {
      name: "Allinone Backend",
      version: "1.0.0",
      status: "ok",
    };
  }
}
