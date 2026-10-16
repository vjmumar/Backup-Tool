import { Router } from "express";
import { getScraperByName } from "../controller/Scrapers";
import { verifyJwt } from "../middlewares/Auth";

const router = Router();

router.get("/:name", verifyJwt, getScraperByName);

export default router;
