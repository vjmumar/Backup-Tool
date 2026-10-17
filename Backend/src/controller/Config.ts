import { Request, Response } from "express";
import { prisma } from "../index";

// Helper — always returns the single AppConfig record, or null if not yet seeded
const getAppConfig = () => prisma.appConfig.findFirst();

// GET /api/config — public, returns everything the client needs
export const getConfig = async (req: Request, res: Response) => {
  try {
    const config = await getAppConfig();

    return res.status(200).json({
      message: "success",
      data: {
        googleDrive: {
          clientId: config?.googleDriveClientId ?? null,
          clientSecret: config?.googleDriveClientSecret ?? null,
        },
        version: config?.version ?? null,
        downloadLink: config?.downloadLink ?? null,
        purchaseLink: config?.purchaseLink ?? null,
        isMaintenance: config?.isMaintenance ?? false,
      },
    });
  } catch (err) {
    return res.status(500).json({ message: "error", data: err, ...(err as object) });
  }
};

// PATCH /api/config — create or update the singleton AppConfig
export const updateConfig = async (
  req: Request<
    unknown,
    unknown,
    {
      version?: string;
      downloadLink?: string;
      purchaseLink?: string;
      isMaintenance?: boolean;
      googleDriveClientId?: string;
      googleDriveClientSecret?: string;
    }
  >,
  res: Response
) => {
  try {
    const { version, downloadLink, purchaseLink, isMaintenance, googleDriveClientId, googleDriveClientSecret } = req.body;

    // First — validate at least one field is provided
    if (
      version === undefined &&
      downloadLink === undefined &&
      purchaseLink === undefined &&
      isMaintenance === undefined &&
      googleDriveClientId === undefined &&
      googleDriveClientSecret === undefined
    ) {
      return res.status(400).json({
        message: "error",
        data: { message: "At least one field is required" },
      });
    }

    const existing = await getAppConfig();
    let config;

    if (!existing) {
      // No record yet — core fields required for first-time creation
      if (!version || !downloadLink || !googleDriveClientId || !googleDriveClientSecret) {
        return res.status(400).json({
          message: "error",
          data: { message: "version, downloadLink, googleDriveClientId, and googleDriveClientSecret are required when creating the config for the first time" },
        });
      }

      config = await prisma.appConfig.create({
        data: {
          version,
          downloadLink,
          purchaseLink: purchaseLink ?? "",
          isMaintenance: isMaintenance ?? false,
          googleDriveClientId,
          googleDriveClientSecret,
        },
      });
    } else {
      config = await prisma.appConfig.update({
        where: { id: existing.id },
        data: {
          ...(version !== undefined ? { version } : {}),
          ...(downloadLink !== undefined ? { downloadLink } : {}),
          ...(purchaseLink !== undefined ? { purchaseLink } : {}),
          ...(isMaintenance !== undefined ? { isMaintenance } : {}),
          ...(googleDriveClientId !== undefined ? { googleDriveClientId } : {}),
          ...(googleDriveClientSecret !== undefined ? { googleDriveClientSecret } : {}),
        },
      });
    }

    return res.status(200).json({ message: "success", data: config });
  } catch (err) {
    return res.status(500).json({ message: "error", data: err, ...(err as object) });
  }
};
