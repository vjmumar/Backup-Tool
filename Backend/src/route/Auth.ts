import { Router } from "express";
import { signIn, getMe, updateMe, changePassword, deleteMe, forgotPassword } from "../controller/Auth";
import { verifyJwt } from "../middlewares/Auth";

const router = Router();

// Public
router.post("/sign-in", signIn);
router.post("/forgot-password", forgotPassword);

// Protected
router.get("/me", verifyJwt, getMe);
router.patch("/me", verifyJwt, updateMe);
router.post("/change-password", verifyJwt, changePassword);
router.delete("/me", verifyJwt, deleteMe);

export default router;
