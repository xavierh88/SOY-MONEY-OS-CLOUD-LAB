import { Router, type IRouter } from "express";
import healthRouter from "./health";
import soyMoneyRouter from "./soy-money";

const router: IRouter = Router();

router.use(healthRouter);
router.use(soyMoneyRouter);

export default router;
