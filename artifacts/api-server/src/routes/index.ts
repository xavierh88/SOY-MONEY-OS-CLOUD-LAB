import { Router, type IRouter } from "express";
import healthRouter from "./health";
import projectExecutionRouter from "./project-execution";
import soyMoneyRouter from "./soy-money";
import cyclesRouter from "./cycles";
import moneyLabRouter from "./money-lab";

const router: IRouter = Router();

router.use(healthRouter);
router.use(projectExecutionRouter);
router.use(soyMoneyRouter);
router.use(cyclesRouter);
router.use(moneyLabRouter);

export default router;
