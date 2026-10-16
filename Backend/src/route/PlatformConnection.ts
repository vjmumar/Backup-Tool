import { Router } from "express";
import {
  getPlatformConnections,
  createPlatformConnection,
  updatePlatformConnection,
  deletePlatformConnection,
} from "../controller/PlatformConnection";
import { verifyJwt } from "../middlewares/Auth";

const router = Router();

router.get("/", verifyJwt, getPlatformConnections);
router.post("/", verifyJwt, createPlatformConnection);
router.patch("/:id", verifyJwt, updatePlatformConnection);
router.delete("/:id", verifyJwt, deletePlatformConnection);

export default router;
