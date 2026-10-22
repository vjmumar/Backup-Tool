import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { prisma } from "../index";
import { hashPassword } from "../utils/hashPassword";
import { compareHashedPassword } from "../utils/compareHashedPassword";
import { sendEmail } from "../utils/sendEmail";

// Generates a random 8-character URL-safe temporary password
const generateTempPassword = (): string => {
  return crypto.randomBytes(6).toString("base64url").slice(0, 8);
};

// POST /api/auth/sign-in
export const signIn = async (
  req: Request<unknown, unknown, { email: string; password: string; platform: string }>,
  res: Response
) => {
  try {
    // First — validate required fields
    const { email, password, platform } = req.body;
    if (!email || !password || !platform) {
      return res.status(400).json({
        message: "error",
        data: { message: "Email, password, and platform are required" },
      });
    }

    // Then — find the user
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(404).json({
        message: "error",
        data: { message: "No user found with that email" },
      });
    }

    // Then — verify the password
    const valid = await compareHashedPassword(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({
        message: "error",
        data: { message: "Invalid credentials" },
      });
    }

    // Then — check the account is active
    if (!user.isActive) {
      return res.status(403).json({
        message: "error",
        data: { message: "This user is disabled" },
      });
    }

    // Then — enforce platform match
    if (user.registeredPlatform !== platform) {
      return res.status(401).json({
        message: "error",
        data: { message: "Invalid credentials" },
      });
    }

    // Finally — sign a JWT and respond, including freshSignIn so the client can redirect
    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET as string,
      { expiresIn: "7d" }
    );

    return res.status(200).json({
      message: "success",
      data: {
        token,
        user: {
          id: user.id,
          email: user.email,
          freshSignIn: user.freshSignIn,
          registeredPlatform: user.registeredPlatform,
          createdAt: user.createdAt,
        },
      },
    });
  } catch (err) {
    return res.status(500).json({ message: "error", data: err, ...(err as object) });
  }
};

// GET /api/auth/me
export const getMe = async (req: Request, res: Response) => {
  try {
    // First — fetch the authenticated user
    const user = await prisma.user.findUnique({
      where: { id: req?.user?.id },
      select: {
        id: true,
        email: true,
        freshSignIn: true,
        isActive: true,
        connectionLimit: true,
        registeredPlatform: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        message: "error",
        data: { message: "User not found" },
      });
    }

    // Then — check the account is active
    if (!user.isActive) {
      return res.status(403).json({
        message: "error",
        data: { message: "This user is disabled" },
      });
    }

    // Then — check the account is active
    if (!user.isActive) {
      return res.status(403).json({
        message: "error",
        data: { message: "This user is disabled" },
      });
    }

    // Finally — respond
    return res.status(200).json({ message: "success", data: user });
  } catch (err) {
    return res.status(500).json({ message: "error", data: err, ...(err as object) });
  }
};

// PATCH /api/auth/me
export const updateMe = async (
  req: Request<unknown, unknown, { email?: string }>,
  res: Response
) => {
  try {
    // First — validate at least one field is provided
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({
        message: "error",
        data: { message: "No update fields provided" },
      });
    }

    // Then — confirm the user exists
    const user = await prisma.user.findUnique({ where: { id: req.user?.id } });
    if (!user) {
      return res.status(404).json({
        message: "error",
        data: { message: "User not found" },
      });
    }

    // Then — apply the update
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { email },
      select: { id: true, email: true, updatedAt: true },
    });

    // Finally — respond
    return res.status(200).json({ message: "success", data: updated });
  } catch (err) {
    return res.status(500).json({ message: "error", data: err, ...(err as object) });
  }
};

// POST /api/auth/change-password
export const changePassword = async (
  req: Request<unknown, unknown, { currentPassword: string; newPassword: string }>,
  res: Response
) => {
  try {
    // First — validate required fields
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        message: "error",
        data: { message: "currentPassword and newPassword are required" },
      });
    }

    // Then — fetch the user
    const user = await prisma.user.findUnique({ where: { id: req.user?.id } });
    if (!user) {
      return res.status(404).json({
        message: "error",
        data: { message: "User not found" },
      });
    }

    // Then — verify the current password
    const valid = await compareHashedPassword(currentPassword, user.passwordHash);
    if (!valid) {
      return res.status(401).json({
        message: "error",
        data: { message: "Current password is incorrect" },
      });
    }

    // Then — hash the new password and update, clearing freshSignIn
    const passwordHash = await hashPassword(newPassword);
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, freshSignIn: false },
      select: { id: true, email: true, freshSignIn: true, updatedAt: true },
    });

    // Finally — respond
    return res.status(200).json({ message: "success", data: updated });
  } catch (err) {
    return res.status(500).json({ message: "error", data: err, ...(err as object) });
  }
};

// DELETE /api/auth/me
export const deleteMe = async (req: Request, res: Response) => {
  try {
    // First — confirm the user exists
    const user = await prisma.user.findUnique({ where: { id: req.user?.id } });
    if (!user) {
      return res.status(404).json({
        message: "error",
        data: { message: "User not found" },
      });
    }

    // Then — delete the user
    await prisma.user.delete({ where: { id: user.id } });

    // Finally — respond
    return res.status(200).json({ message: "success", data: null });
  } catch (err) {
    return res.status(500).json({ message: "error", data: err, ...(err as object) });
  }
};

// POST /api/auth/forgot-password
export const forgotPassword = async (
  req: Request<unknown, unknown, { email: string; platform: string }>,
  res: Response
) => {
  try {
    // First — validate required fields
    const { email, platform } = req.body;
    if (!email || !platform) {
      return res.status(400).json({
        message: "error",
        data: { message: "Email and platform are required" },
      });
    }

    // Then — find the user
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(404).json({
        message: "error",
        data: { message: "No user found with that email" },
      });
    }

    // Then — enforce platform match
    if (user.registeredPlatform !== platform) {
      return res.status(403).json({
        message: "error",
        data: { message: `This account is registered for "${user.registeredPlatform}". Please use the correct app.` },
      });
    }

    // Then — generate a new temporary password and hash it
    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);

    // Then — update the user with the new password and set freshSignIn = true
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, freshSignIn: true },
    });

    // Then — send the new temporary password to the user's email
    await sendEmail(
      email,
      `You requested a password reset.\n\nYour new temporary password is: ${tempPassword}\n\nPlease sign in and change your password immediately.`,
      "no-reply@yourdomain.com",
      "Your new temporary password"
    );

    // Finally — respond (temp password is never returned in the response)
    return res.status(200).json({
      message: "success",
      data: { message: "A new temporary password has been sent to your email" },
    });
  } catch (err) {
    return res.status(500).json({ message: "error", data: err, ...(err as object) });
  }
};
