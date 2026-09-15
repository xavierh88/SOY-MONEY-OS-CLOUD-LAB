import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";
import { recordRequest } from "./lib/operational-metrics";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    genReqId: (req) => {
      const supplied = req.headers["x-correlation-id"];
      return (typeof supplied === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(supplied))
        ? supplied
        : randomUUID();
    },
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use((req, res, next) => {
  const id = String(req.id);
  res.setHeader("x-correlation-id", id);
  res.on("finish", () => recordRequest(req.route?.path ?? req.path, res.statusCode >= 500));
  next();
});
app.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (res.statusCode >= 400 && body && typeof body === "object" && !Array.isArray(body)) {
      const value = body as Record<string, unknown>;
      body = {
        ...value,
        code: value.code ?? (res.statusCode >= 500 ? "INTERNAL_ERROR" : `HTTP_${res.statusCode}`),
        correlationId: value.correlationId ?? String(req.id),
      };
    }
    return json(body);
  }) as typeof res.json;
  next();
});
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

const sameOriginCors: RequestHandler = (req, res, next) => {
  const origin = req.get("origin");
  if (!origin) {
    cors({ credentials: true, origin: false })(req, res, next);
    return;
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    res.status(403).json({ error: "Invalid request origin" });
    return;
  }
  if (originHost !== getClerkProxyHost(req)) {
    req.log.warn({ originHost }, "Cross-origin API request rejected");
    res.status(403).json({ error: "Cross-origin request rejected" });
    return;
  }
  cors({ credentials: true, origin })(req, res, next);
};

app.use(sameOriginCors);

const captureRawBody = (req: express.Request, _res: express.Response, buffer: Buffer) => {
  // Keep the exact bytes for the machine-authenticated callback boundary.
  // The value is never logged or sent back to a caller.
  (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
};

// Storage accepts objects up to 10 MiB after base64 decoding. A base64 JSON
// envelope is ~13.4 MiB, so only this endpoint gets a larger parser ceiling;
// every other API route keeps Express' conservative default JSON limit.
app.use("/api/storage/objects", express.json({ limit: "15mb", verify: captureRawBody }));
app.use(express.json({ verify: captureRawBody }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV === "test") {
  // Contract tests must never contact Clerk. requireOwner reads the
  // test-only identity header below instead of invoking Clerk's middleware.
  app.use((_req, _res, next) => next());
} else {
  app.use(
    clerkMiddleware((req) => ({
      publishableKey: publishableKeyFromHost(
        getClerkProxyHost(req) ?? "",
        process.env.CLERK_PUBLISHABLE_KEY,
      ),
    })),
  );
}

app.use("/api", router);
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  req.log.error({ err: error }, "Unhandled API request error");
  if (res.headersSent) {
    next(error);
    return;
  }
  const candidateStatus = Number((error as { status?: unknown; statusCode?: unknown })?.status ?? (error as { statusCode?: unknown })?.statusCode);
  const status = Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus < 500
    ? candidateStatus
    : 500;
  res.status(status).json({
    error: status === 413 ? "Request entity too large" : status === 500 ? "Internal server error" : "Invalid request",
    code: status === 413 ? "PAYLOAD_TOO_LARGE" : status === 500 ? "INTERNAL_ERROR" : `HTTP_${status}`,
    correlationId: req.id,
  });
};
app.use(errorHandler);

export default app;
