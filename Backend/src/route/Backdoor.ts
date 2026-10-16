import { Router } from "express";
import { getPanel, getUsers, updateUser, deleteUser, verifyAccess } from "../controller/Backdoor";

const router = Router();

// Serves the admin HTML panel
router.get("/", getPanel);

// Password verification — no JWT needed
router.post("/access", verifyAccess);

// User management API
router.get("/users", getUsers);
router.patch("/users/:id", updateUser);
router.delete("/users/:id", deleteUser);

export default router;
