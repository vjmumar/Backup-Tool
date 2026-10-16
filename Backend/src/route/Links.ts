import { Router } from "express";
import { getLinks } from "../controller/Links";

const router = Router();

router.get("/", getLinks);

export default router;
