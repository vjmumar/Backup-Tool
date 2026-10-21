import { Request, Response } from "express";
import crypto from "crypto";
import { postmarkClient, prisma } from "../index";
import { hashPassword } from "../utils/hashPassword";
import { sendEmail } from "../utils/sendEmail";

// Generates a random 8-character URL-safe temporary password
const generateTempPassword = (): string => {
  return crypto.randomBytes(6).toString("base64url").slice(0, 8);
};

const VALID_PLATFORMS = ["kajabi", "kartra"] as const;
type Platform = (typeof VALID_PLATFORMS)[number];

// POST /api/invite-user — only for new users
export const inviteUser = async (
  req: Request<unknown, unknown, { customData: { email: string; name: string; platform?: string; connectionLimit?: string | number } }>,
  res: Response
) => {
  try {
    // First — validate required fields
    const { email, name, platform, connectionLimit } = req.body.customData ?? {};
    if (!email || !name) {
      return res.status(400).json({
        message: "error",
        data: { message: "Email and name are required" },
      });
    }

    // Then — validate platform if provided
    if (platform !== undefined && !VALID_PLATFORMS.includes(platform as Platform)) {
      return res.status(400).json({
        message: "error",
        data: { message: `Invalid platform. Must be one of: ${VALID_PLATFORMS.join(", ")}` },
      });
    }

    // Then — reject if user already exists
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({
        message: "error",
        data: { message: "A user with that email already exists. Use the increment-connection endpoint instead." },
      });
    }

    // Then — generate a temporary password and hash it
    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);

    // Then — create the user, applying connectionLimit and registeredPlatform if provided
    const user = await prisma.user.create({
      data: {
        email,
        name,
        passwordHash,
        freshSignIn: true,
        ...(connectionLimit !== undefined ? { connectionLimit: Number(connectionLimit) } : {}),
        ...(platform !== undefined ? { registeredPlatform: platform as Platform } : {}),
      },
      select: {
        id: true,
        email: true,
        name: true,
        freshSignIn: true,
        connectionLimit: true,
        registeredPlatform: true,
        createdAt: true,
      },
    });

    // Then — send the invite email with the temporary password
    // Pick the right platform's links from AppConfig
    const appConfig = await prisma.appConfig.findFirst({
      select: {
        kajabiVersion: true, kajabiDownloadLink: true, kajabiSetupLink: true,
        kartraVersion: true, kartraDownloadLink: true, kartraSetupLink: true,
      },
    });

    const resolvedPlatform = (platform ?? "kajabi") as Platform;
    const version = resolvedPlatform === "kartra" ? appConfig?.kartraVersion : appConfig?.kajabiVersion;
    const downloadUrl = resolvedPlatform === "kartra" ? appConfig?.kartraDownloadLink : appConfig?.kajabiDownloadLink;
    const setupUrl = resolvedPlatform === "kartra" ? appConfig?.kartraSetupLink : appConfig?.kajabiSetupLink;

    await postmarkClient.sendEmailWithTemplate({
       From: "backuptool@bluemangoesmedia.com",
       To: email,
       TemplateId: 48375191,
       TemplateModel: {
          email,
          name: name,
          password: tempPassword,
          version,
          download_url: downloadUrl,
          setup_url: setupUrl,
       },
    });

    // Finally — respond (temp password is never returned in the response)
    return res.status(201).json({ message: "success", data: user });
  } catch (err) {
    return res.status(500).json({ message: "error", data: err, ...(err as object) });
  }
};

// POST /api/invite-user/increment-connection — only for existing users
export const incrementConnection = async (
  req: Request<unknown, unknown, { customData: { email: string; platform?: string; connectionLimit?: string | number } }>,
  res: Response
) => {
  try {
    // First — validate required fields
    const { email, platform, connectionLimit } = req.body.customData ?? {};
    if (!email) {
      return res.status(400).json({
        message: "error",
        data: { message: "Email is required" },
      });
    }

    // Then — confirm the user exists
    const existing = await prisma.user.findUnique({ where: { email } });
    if (!existing) {
      return res.status(404).json({
        message: "error",
        data: { message: "User not found. Use the invite endpoint to create a new user." },
      });
    }

    // Then — enforce platform match if provided
    if (platform !== undefined && existing.registeredPlatform !== platform) {
      return res.status(403).json({
        message: "error",
        data: { message: `This account is registered for "${existing.registeredPlatform}", not "${platform}".` },
      });
    }

    // Then — increment the connection limit by the given amount (defaults to 1)
    const addAmount = connectionLimit !== undefined ? Number(connectionLimit) : 1;
    const updated = await prisma.user.update({
      where: { email },
      data: { connectionLimit: { increment: addAmount } },
      select: {
        id: true,
        email: true,
        connectionLimit: true,
        updatedAt: true,
      },
    });

    // Finally — respond
    return res.status(200).json({ message: "success", data: updated });
  } catch (err) {
    return res.status(500).json({ message: "error", data: err, ...(err as object) });
  }
};
