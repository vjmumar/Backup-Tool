import { Router } from "express";
import { getConfig, getMaintenance, setMaintenance } from "../controller/Config";
import { verifyJwt } from "../middlewares/Auth";

const router = Router();

router.get("/", verifyJwt, getConfig);
router.get("/maintenance", getMaintenance);
router.patch("/maintenance", setMaintenance);

export default router;
