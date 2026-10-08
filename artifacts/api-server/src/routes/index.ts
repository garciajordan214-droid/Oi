import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import financeRouter from "./finance";
import auditRouter from "./audit";
import { requireClerkIdentity } from "../lib/auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(requireClerkIdentity);
router.use(authRouter);
router.use(financeRouter);
router.use(auditRouter);

export default router;
