import { Controller, Get } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { AppService } from "./app.service";

@ApiTags("App")
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiOperation({ summary: "Root endpoint" })
  @ApiResponse({ status: 200, description: "API is running" })
  getRoot() {
    return this.appService.getRoot();
  }

  @Get("info")
  @ApiOperation({ summary: "Get application information" })
  @ApiResponse({ status: 200, description: "Application information" })
  getInfo() {
    return this.appService.getInfo();
  }
}
