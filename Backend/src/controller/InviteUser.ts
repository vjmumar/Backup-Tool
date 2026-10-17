import { Request, Response } from "express";
import crypto from "crypto";
import { prisma } from "../index";
import { hashPassword } from "../utils/hashPassword";
import { sendEmail } from "../utils/sendEmail";

// Generates a random 8-character URL-safe temporary password
const generateTempPassword = (): string => {
  return crypto.randomBytes(6).toString("base64url").slice(0, 8);
};

// POST /api/invite-user — only for new users
export const inviteUser = async (
  req: Request<unknown, unknown, { email: string; connectionLimit?: number }>,
  res: Response
) => {
  try {
    // First — validate required fields
    const { email, connectionLimit } = req.body;
    if (!email) {
      return res.status(400).json({
        message: "error",
        data: { message: "Email is required" },
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

    // Then — create the user, applying connectionLimit if provided (defaults to 3)
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        freshSignIn: true,
        ...(connectionLimit !== undefined ? { connectionLimit } : {}),
      },
      select: {
        id: true,
        email: true,
        freshSignIn: true,
        connectionLimit: true,
        createdAt: true,
      },
    });

    // Then — send the invite email with the temporary password
    const appConfig = await prisma.appConfig.findFirst({ select: { downloadLink: true } });
    const downloadLine = appConfig?.downloadLink
      ? `\n\nTo download the extension, click here:\n${appConfig.downloadLink}`
      : "";

    await sendEmail(
      email,
      `You have been invited!\n\nYour temporary password is: ${tempPassword}\n\nPlease sign in and change your password immediately.${downloadLine}`,
      "no-reply@yourdomain.com",
      "You're invited"
    );

    // Finally — respond (temp password is never returned in the response)
    return res.status(201).json({ message: "success", data: user });
  } catch (err) {
    return res.status(500).json({ message: "error", data: err, ...(err as object) });
  }
};

// POST /api/invite-user/increment-connection — only for existing users
export const incrementConnection = async (
  req: Request<unknown, unknown, { email: string; amount?: number }>,
  res: Response
) => {
  try {
    // First — validate required fields
    const { email, amount } = req.body;
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

    // Then — increment the connection limit by the given amount (defaults to 1)
    const addAmount = amount ?? 1;
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
