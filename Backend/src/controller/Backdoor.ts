import { Request, Response } from "express";
import path from "path";
import { prisma } from "../index";
import "dotenv/config";

// POST /api/backdoor/access — verify backdoor password
export const verifyAccess = (req: Request<unknown, unknown, { password: string }>, res: Response) => {
  const { password } = req.body;
  const correct = password === process.env.BACKDOOR_PASSWORD;
  return res.status(correct ? 200 : 401).json({ message: correct ? "success" : "error", data: { access: correct } });
};

// GET /backdoor — serve the admin HTML panel
export const getPanel = (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, "../backdoor/index.html"));
};

// GET /api/backdoor/users — list all users
export const getUsers = async (req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        freshSignIn: true,
        isActive: true,
        connectionLimit: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return res.status(200).json({ message: "success", data: users });
  } catch (err) {
    return res.status(500).json({ message: "error", data: err, ...(err as object) });
  }
};

// PATCH /api/backdoor/users/:id — update a user's connectionLimit and/or isActive
export const updateUser = async (
  req: Request<{ id: string }, unknown, { connectionLimit?: number; isActive?: boolean }>,
  res: Response
) => {
  try {
    const { connectionLimit, isActive } = req.body;
    if (connectionLimit === undefined && isActive === undefined) {
      return res.status(400).json({
        message: "error",
        data: { message: "At least one of connectionLimit or isActive is required" },
      });
    }

    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) {
      return res.status(404).json({
        message: "error",
        data: { message: "User not found" },
      });
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        ...(connectionLimit !== undefined ? { connectionLimit } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
      },
      select: { id: true, email: true, connectionLimit: true, isActive: true, updatedAt: true },
    });

    return res.status(200).json({ message: "success", data: updated });
  } catch (err) {
    return res.status(500).json({ message: "error", data: err, ...(err as object) });
  }
};

// DELETE /api/backdoor/users/:id — delete a user
export const deleteUser = async (
  req: Request<{ id: string }>,
  res: Response
) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) {
      return res.status(404).json({
        message: "error",
        data: { message: "User not found" },
      });
    }

    await prisma.user.delete({ where: { id: user.id } });

    return res.status(200).json({ message: "success", data: null });
  } catch (err) {
    return res.status(500).json({ message: "error", data: err, ...(err as object) });
  }
};
