import { Router } from "express";
import { getSportsHistory } from "./history";

export const sportsRouter = Router();

sportsRouter.get("/history", async (_req, res) => {
  try {
    const data = await getSportsHistory();
    res.json(data);
  } catch (error) {
    console.error("[SPORTS] History error:", error);
    res.status(500).json({
      error: "SPORTS_HISTORY_ERROR",
    });
  }
});
