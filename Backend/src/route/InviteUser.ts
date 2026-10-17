import { Router } from "express";
import { inviteUser, incrementConnection } from "../controller/InviteUser";

const router = Router();

router.post("/", inviteUser);
router.post("/increment-connection", incrementConnection);

export default router;
