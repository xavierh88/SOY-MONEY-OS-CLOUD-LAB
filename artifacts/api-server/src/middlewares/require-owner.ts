import { getAuth } from "@clerk/express";
import { and, eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { db, ownerBindingTable } from "@workspace/db";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

/**
 * Authenticate with Clerk and authorize the single persisted SOY MONEY owner.
 *
 * Only the trusted configured Clerk identity may claim or use the singleton.
 * No request header or client-supplied owner value is used.
 */
export async function requireOwner(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // The request header below is deliberately test-only.  It gives offline
  // contract tests a deterministic Clerk boundary without accepting a
  // client-supplied identity in any deployed environment.
  const auth = process.env.NODE_ENV === "test" ? null : getAuth(req);
  const userId = process.env.NODE_ENV === "test"
    ? req.get("x-test-clerk-user-id") ?? undefined
    : (
        (auth?.sessionClaims?.userId as string | undefined) ??
        auth?.userId
      );
  const configuredOwnerId = process.env.SOY_OWNER_CLERK_USER_ID;

  if (!userId) {
    req.log.warn({
      clerkAuthenticated: Boolean(auth?.isAuthenticated),
      hasSessionId: Boolean(auth?.sessionId),
    }, "Owner authorization rejected unauthenticated request");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!configuredOwnerId) {
    req.log.error("Trusted owner identity is not configured");
    res.status(503).json({ error: "Owner provisioning is incomplete" });
    return;
  }
  if (userId !== configuredOwnerId) {
    req.log.warn("Owner authorization rejected non-owner identity");
    res.status(403).json({ error: "Owner access required" });
    return;
  }

  // Avoid a database dependency in offline tests after the owner decision has
  // already been exercised. This branch cannot be enabled outside test mode.
  if (process.env.NODE_ENV === "test") {
    req.userId = userId;
    next();
    return;
  }

  try {
    const [claimed] = await db
      .insert(ownerBindingTable)
      .values({
        id: "default",
        singletonKey: "default",
        clerkUserId: userId,
      })
      .onConflictDoNothing({ target: ownerBindingTable.singletonKey })
      .returning({ clerkUserId: ownerBindingTable.clerkUserId });

    if (claimed?.clerkUserId === userId) {
      req.userId = userId;
      next();
      return;
    }

    const [owner] = await db
      .select({ clerkUserId: ownerBindingTable.clerkUserId })
      .from(ownerBindingTable)
      .where(
        and(
          eq(ownerBindingTable.singletonKey, "default"),
          eq(ownerBindingTable.clerkUserId, userId),
        ),
      )
      .limit(1);

    if (!owner || owner.clerkUserId !== configuredOwnerId) {
      req.log.warn("Owner authorization rejected non-owner identity");
      res.status(403).json({ error: "Owner access required" });
      return;
    }

    req.userId = userId;
    next();
  } catch (error) {
    req.log.error({ err: error }, "Owner authorization storage unavailable");
    res.status(503).json({ error: "Owner authorization unavailable" });
  }
}