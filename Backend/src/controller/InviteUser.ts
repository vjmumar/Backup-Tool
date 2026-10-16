import { Request, Response } from "express";
import crypto from "crypto";
import { prisma } from "../index";
import { hashPassword } from "../utils/hashPassword";
import { sendEmail } from "../utils/sendEmail";

// Generates a random 8-character URL-safe temporary password
const generateTempPassword = (): string => {
  return crypto.randomBytes(6).toString("base64url").slice(0, 8);
};

// POST /api/invite-user
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

    // Then — check if user already exists
    const existing = await prisma.user.findUnique({ where: { email } });

    if (existing) {
      // User exists — just increment their connectionLimit, no email sent
      const addAmount = Number(existing.connectionLimit) + Number(connectionLimit ?? 1);
      const updated = await prisma.user.update({
        where: { email },
        data: { connectionLimit: { increment: addAmount } },
        select: {
          id: true,
          email: true,
          freshSignIn: true,
          connectionLimit: true,
          createdAt: true,
        },
      });

      return res.status(200).json({ message: "success", data: updated });
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
    await sendEmail(
      email,
      `You have been invited!\n\nYour temporary password is: ${tempPassword}\n\nPlease sign in and change your password immediately.`,
      "no-reply@yourdomain.com",
      "You're invited"
    );

    // Finally — respond (temp password is never returned in the response)
    return res.status(201).json({ message: "success", data: user });
  } catch (err) {
    return res.status(500).json({ message: "error", data: err, ...(err as object) });
  }
};
