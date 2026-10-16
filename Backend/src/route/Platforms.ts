import { Router } from "express";
import { getPlatforms } from "../controller/Platforms";
import { verifyJwt } from "../middlewares/Auth";

const router = Router();

router.get("/", verifyJwt, getPlatforms);

export default router;
