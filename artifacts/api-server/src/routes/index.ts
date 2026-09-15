import { Router, type IRouter } from "express";
import healthRouter from "./health";
import projectExecutionRouter from "./project-execution";
import soyMoneyRouter from "./soy-money";
import cyclesRouter from "./cycles";
import moneyLabRouter from "./money-lab";
import autonomyRouter from "./autonomy";
import controlTowerRouter from "./control-tower";

const router: IRouter = Router();

router.use(healthRouter);
router.use(projectExecutionRouter);
router.use(soyMoneyRouter);
router.use(cyclesRouter);
router.use(moneyLabRouter);
router.use(autonomyRouter);
router.use(controlTowerRouter);

export default router;
