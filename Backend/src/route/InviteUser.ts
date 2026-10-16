import { Router } from "express";
import { inviteUser } from "../controller/InviteUser";

const router = Router();

router.post("/", inviteUser);

export default router;
