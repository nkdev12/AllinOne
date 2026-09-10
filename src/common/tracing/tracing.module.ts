import { Module, Global } from "@nestjs/common";
import { TracingService } from "./tracing.service";
import { TracingInterceptor } from "./tracing.interceptor";

@Global()
@Module({
  providers: [TracingService, TracingInterceptor],
  exports: [TracingService, TracingInterceptor],
})
export class TracingModule {}

