import { Router } from "express";
import { getSportsHistory } from "../lib/sports/history";

const router = Router();

router.get("/sports-paper/history", async (_req, res) => {
  try {
    res.json(await getSportsHistory());
  } catch (error) {
    console.error("[SPORTS] History:", error);
    res.status(500).json({
      error: "SPORTS_HISTORY_ERROR",
    });
  }
});

export default router;
