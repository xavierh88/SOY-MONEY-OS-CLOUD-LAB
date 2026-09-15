import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
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

const app: Express = express();

app.use(
  pinoHttp({
    logger,
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.use("/api", router);

const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  req.log.error({ err: error }, "Unhandled API request error");
  if (res.headersSent) {
    next(error);
    return;
  }
  res.status(500).json({ error: "Internal server error" });
};
app.use(errorHandler);

export default app;
