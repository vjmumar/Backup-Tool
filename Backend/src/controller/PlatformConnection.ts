import { Request, Response } from "express";
import { prisma } from "../index";

// GET /api/platform-connections
export const getPlatformConnections = async (req: Request, res: Response) => {
  try {
    // First — fetch all platform connections for the logged-in user
    const connections = await prisma.platformConnection.findMany({
      where: { userId: req.user?.id },
    });

    // Finally — respond
    return res.status(200).json({ message: "success", data: connections });
  } catch (err) {
    return res.status(500).json({ message: "error", data: err, ...(err as object) });
  }
};

// POST /api/platform-connections
export const createPlatformConnection = async (
  req: Request<unknown, unknown, { platform: string; lockId: string }>,
  res: Response
) => {
  try {
    // First — validate required fields
    const { platform, lockId } = req.body;
    if (!platform || !lockId) {
      return res.status(400).json({
        message: "error",
        data: { message: "Platform and lockId are required" },
      });
    }

    // Then — fetch the user to check connectionLimit and registeredPlatform
    const user = await prisma.user.findUnique({
      where: { id: req.user?.id },
      include: { _count: { select: { platformConnections: true } } },
    });
    if (!user) {
      return res.status(404).json({
        message: "error",
        data: { message: "User not found" },
      });
    }

    // Then — enforce that the platform matches the user's registeredPlatform
    if (platform !== user.registeredPlatform) {
      return res.status(403).json({
        message: "error",
        data: {
          message: `This account is registered for "${user.registeredPlatform}" only. Cannot add a "${platform}" connection.`,
        },
      });
    }

    // Then — enforce the connection limit
    if (user._count.platformConnections >= user.connectionLimit) {
      return res.status(403).json({
        message: "error",
        data: {
          message: `Connection limit reached (${user.connectionLimit}). Remove an existing connection or upgrade your plan to add more.`,
          connectionLimit: user.connectionLimit,
          currentCount: user._count.platformConnections,
        },
      });
    }

    // Then — prevent duplicate platform + lockId combinations for the same user
    const duplicate = await prisma.platformConnection.findFirst({
      where: { userId: req.user?.id, platform, lockId },
    });
    if (duplicate) {
      return res.status(409).json({
        message: "error",
        data: { message: `A connection for platform "${platform}" with that lockId already exists` },
      });
    }

    // Then — create the connection
    const connection = await prisma.platformConnection.create({
      data: { platform, lockId, userId: req.user?.id as string },
    });

    // Finally — respond
    return res.status(201).json({ message: "success", data: connection });
  } catch (err) {
    return res.status(500).json({ message: "error", data: err, ...(err as object) });
  }
};

// PATCH /api/platform-connections/:id
export const updatePlatformConnection = async (
  req: Request<{ id: string }, unknown, { platform?: string; lockId?: string }>,
  res: Response
) => {
  try {
    // First — validate at least one field is provided
    const { platform, lockId } = req.body;
    if (!platform && !lockId) {
      return res.status(400).json({
        message: "error",
        data: { message: "At least one of platform or lockId is required" },
      });
    }

    // Then — verify the connection belongs to the logged-in user
    const connection = await prisma.platformConnection.findFirst({
      where: { id: req.params.id, userId: req.user?.id },
    });
    if (!connection) {
      return res.status(404).json({
        message: "error",
        data: { message: "Platform connection not found" },
      });
    }

    // Then — check the new platform + lockId combo doesn't already exist for this user
    const newPlatform = platform ?? connection.platform;
    const newLockId = lockId ?? connection.lockId;
    const duplicate = await prisma.platformConnection.findFirst({
      where: {
        userId: req.user?.id,
        platform: newPlatform,
        lockId: newLockId,
        NOT: { id: connection.id },
      },
    });
    if (duplicate) {
      return res.status(409).json({
        message: "error",
        data: { message: `A connection for platform "${newPlatform}" with that lockId already exists` },
      });
    }

    // Then — update the connection
    const updated = await prisma.platformConnection.update({
      where: { id: connection.id },
      data: {
        ...(platform ? { platform } : {}),
        ...(lockId ? { lockId } : {}),
      },
    });

    // Finally — respond
    return res.status(200).json({ message: "success", data: updated });
  } catch (err) {
    return res.status(500).json({ message: "error", data: err, ...(err as object) });
  }
};

// DELETE /api/platform-connections/:id
export const deletePlatformConnection = async (
  req: Request<{ id: string }>,
  res: Response
) => {
  try {
    // First — verify the connection belongs to the logged-in user
    const connection = await prisma.platformConnection.findFirst({
      where: { id: req.params.id, userId: req.user?.id },
    });
    if (!connection) {
      return res.status(404).json({
        message: "error",
        data: { message: "Platform connection not found" },
      });
    }

    // Then — delete it
    await prisma.platformConnection.delete({ where: { id: connection.id } });

    // Finally — respond
    return res.status(200).json({ message: "success", data: null });
  } catch (err) {
    return res.status(500).json({ message: "error", data: err, ...(err as object) });
  }
};
