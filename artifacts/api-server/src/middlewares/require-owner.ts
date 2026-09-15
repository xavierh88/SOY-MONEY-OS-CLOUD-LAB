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
 * The first signed-in user claims the singleton atomically with a unique
 * database insert. No request header or client-supplied owner value is used.
 */
export async function requireOwner(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = getAuth(req);
  const userId =
    (auth?.sessionClaims?.userId as string | undefined) ??
    auth?.userId;

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

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

  if (!owner) {
    res.status(403).json({ error: "Owner access required" });
    return;
  }

  req.userId = userId;
  next();
}