import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { ServerClient } from "postmark";

import AuthRouter from "./route/Auth";
import PlatformConnectionRouter from "./route/PlatformConnection";
import InviteUserRouter from "./route/InviteUser";
import ScrapersRouter from "./route/Scrapers";
import ConfigRouter from "./route/Config";
import PlatformsRouter from "./route/Platforms";
import BackdoorRouter from "./route/Backdoor";

dotenv.config();

// Shared singleton — imported by all controllers as `import { prisma } from "../index"`
export const prisma = new PrismaClient();
export const postmarkClient = new ServerClient(process.env.POSTMARK_API_KEY as string);

const app = express();
const PORT = process.env.PORT || 3000;

// Global middlewares
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Route mounts
app.use("/api/auth", AuthRouter);
app.use("/api/platform-connections", PlatformConnectionRouter);
app.use("/api/invite-user", InviteUserRouter);
app.use("/api/scrapers", ScrapersRouter);
app.use("/api/config", ConfigRouter);
app.use("/api/platforms", PlatformsRouter);
app.use("/backdoor", BackdoorRouter);
app.use("/api/backdoor", BackdoorRouter);

// Start server and connect to DB
const start = async () => {
  try {
    await prisma.$connect();
    console.log("Connected to MongoDB");

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error("Failed to connect to database:", err);
    process.exit(1);
  }
};

start();
