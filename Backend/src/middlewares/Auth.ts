import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { TUser } from "../types/User";
import { prisma } from "../index";

export const verifyJwt = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers["authorizationx"] as string | undefined;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      message: "error",
      data: { message: "Unauthorized: missing or malformed token" },
    });
  }

  const token = authHeader.split(" ")[1];

  let decoded: TUser;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET as string) as TUser;
  } catch {
    return res.status(401).json({
      message: "error",
      data: { message: "Unauthorized: invalid or expired token" },
    });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, email: true, isActive: true },
    });

    if (!user) {
      return res.status(401).json({
        message: "error",
        data: { message: "Unauthorized: user not found" },
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        message: "error",
        data: { message: "Forbidden: account is deactivated" },
      });
    }

    req.user = { id: user.id, email: user.email };
    next();
  } catch {
    return res.status(500).json({
      message: "error",
      data: { message: "Internal server error during authentication" },
    });
  }
};
