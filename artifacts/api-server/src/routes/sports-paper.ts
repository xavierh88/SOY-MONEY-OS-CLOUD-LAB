import { Router } from "express";
import { getSportsPaperState, refreshSportsPaperTriplets } from "../lib/sports-paper";

const router = Router();

router.get("/sports/paper-triplets", async (_req, res): Promise<void> => {
  const state = await refreshSportsPaperTriplets();
  res.json({ success: true, data: { mode: "PAPER", triplets: state, state: getSportsPaperState() } });
});

router.get("/sports/paper-triplets/status", (_req, res) => {
  res.json({ success: true, data: getSportsPaperState() });
});

export default router;
