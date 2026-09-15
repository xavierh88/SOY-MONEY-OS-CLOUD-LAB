import { Router, type IRouter } from "express";
import healthRouter from "./health";
import projectExecutionRouter from "./project-execution";
import soyMoneyRouter from "./soy-money";
import cyclesRouter from "./cycles";
import moneyLabRouter from "./money-lab";
import autonomyRouter from "./autonomy";
import controlTowerRouter from "./control-tower";
import { requireOwner } from "../middlewares/require-owner";
import serviceCallbacksRouter from "./service-callbacks";
import discoveryRouter from "./discovery";

const router: IRouter = Router();

router.use(healthRouter);
// Machine callbacks are a deliberately narrow boundary and must remain
// outside the Clerk owner gate.  The callback router performs its own HMAC,
// timestamp, dispatch and replay validation.
router.use(serviceCallbacksRouter);
router.use(requireOwner);
router.use(projectExecutionRouter);
router.use(soyMoneyRouter);
router.use(cyclesRouter);
router.use(moneyLabRouter);
router.use(autonomyRouter);
router.use(controlTowerRouter);
router.use(discoveryRouter);

export default router;
