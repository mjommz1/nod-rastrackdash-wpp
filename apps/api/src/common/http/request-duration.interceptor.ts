import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import { finalize } from "rxjs/operators";

type HttpRequest = {
  method?: string;
  originalUrl?: string;
  url?: string;
};

export function sanitizeRequestPath(path: string): string {
  // The Pipedrive webhook URL carries its secret as ?token=; drop the query.
  const pathname = path.split(/[?#]/u, 1)[0] ?? path;
  if (/^\/webhooks\/pipedrive(?:\/|$)/i.test(pathname)) return pathname;
  return path.replace(
    /([?&]token=)[^&#\s"]*/gi,
    "$1[REDACTED]",
  );
}

@Injectable()
export class RequestDurationInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RequestDurationInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<HttpRequest>();
    const startedAt = Date.now();

    return next.handle().pipe(
      finalize(() => {
        const durationMs = Date.now() - startedAt;
        const thresholdMs = Number(
          process.env.WPPTRACK_API_SLOW_REQUEST_MS ?? 1500,
        );

        if (!Number.isFinite(thresholdMs) || durationMs < thresholdMs) {
          return;
        }

        this.logger.warn(
          JSON.stringify({
            event: "http.request.slow",
            method: request.method ?? "UNKNOWN",
            path: sanitizeRequestPath(
              request.originalUrl ?? request.url ?? "unknown",
            ),
            durationMs,
          }),
        );
      }),
    );
  }
}
