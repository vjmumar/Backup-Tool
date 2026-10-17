import { Router } from "express";
import { getConfig, updateConfig } from "../controller/Config";

const router = Router();

router.get("/", getConfig);
router.patch("/", updateConfig);

export default router;
