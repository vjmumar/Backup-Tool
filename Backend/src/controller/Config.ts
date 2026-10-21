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
        kajabi: {
          version: config?.kajabiVersion ?? null,
          downloadLink: config?.kajabiDownloadLink ?? null,
          setupLink: config?.kajabiSetupLink ?? null,
          purchaseLink: config?.kajabiPurchaseLink ?? null,
          isMaintenance: config?.kajabiIsMaintenance ?? false,
        },
        kartra: {
          version: config?.kartraVersion ?? null,
          downloadLink: config?.kartraDownloadLink ?? null,
          setupLink: config?.kartraSetupLink ?? null,
          purchaseLink: config?.kartraPurchaseLink ?? null,
          isMaintenance: config?.kartraIsMaintenance ?? false,
        },
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
      googleDriveClientId?: string;
      googleDriveClientSecret?: string;
      // Kajabi
      kajabiVersion?: string;
      kajabiDownloadLink?: string;
      kajabiSetupLink?: string;
      kajabiPurchaseLink?: string;
      kajabiIsMaintenance?: boolean;
      // Kartra
      kartraVersion?: string;
      kartraDownloadLink?: string;
      kartraSetupLink?: string;
      kartraPurchaseLink?: string;
      kartraIsMaintenance?: boolean;
    }
  >,
  res: Response
) => {
  try {
    const {
      googleDriveClientId,
      googleDriveClientSecret,
      kajabiVersion,
      kajabiDownloadLink,
      kajabiSetupLink,
      kajabiPurchaseLink,
      kajabiIsMaintenance,
      kartraVersion,
      kartraDownloadLink,
      kartraSetupLink,
      kartraPurchaseLink,
      kartraIsMaintenance,
    } = req.body;

    // First — validate at least one field is provided
    if (
      googleDriveClientId === undefined &&
      googleDriveClientSecret === undefined &&
      kajabiVersion === undefined &&
      kajabiDownloadLink === undefined &&
      kajabiSetupLink === undefined &&
      kajabiPurchaseLink === undefined &&
      kajabiIsMaintenance === undefined &&
      kartraVersion === undefined &&
      kartraDownloadLink === undefined &&
      kartraSetupLink === undefined &&
      kartraPurchaseLink === undefined &&
      kartraIsMaintenance === undefined
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
      if (!googleDriveClientId || !googleDriveClientSecret) {
        return res.status(400).json({
          message: "error",
          data: { message: "googleDriveClientId and googleDriveClientSecret are required when creating the config for the first time" },
        });
      }

      config = await prisma.appConfig.create({
        data: {
          googleDriveClientId,
          googleDriveClientSecret,
          kajabiVersion: kajabiVersion ?? "",
          kajabiDownloadLink: kajabiDownloadLink ?? "",
          kajabiSetupLink: kajabiSetupLink ?? "",
          kajabiPurchaseLink: kajabiPurchaseLink ?? "",
          kajabiIsMaintenance: kajabiIsMaintenance ?? false,
          kartraVersion: kartraVersion ?? "",
          kartraDownloadLink: kartraDownloadLink ?? "",
          kartraSetupLink: kartraSetupLink ?? "",
          kartraPurchaseLink: kartraPurchaseLink ?? "",
          kartraIsMaintenance: kartraIsMaintenance ?? false,
        },
      });
    } else {
      config = await prisma.appConfig.update({
        where: { id: existing.id },
        data: {
          ...(googleDriveClientId !== undefined ? { googleDriveClientId } : {}),
          ...(googleDriveClientSecret !== undefined ? { googleDriveClientSecret } : {}),
          ...(kajabiVersion !== undefined ? { kajabiVersion } : {}),
          ...(kajabiDownloadLink !== undefined ? { kajabiDownloadLink } : {}),
          ...(kajabiSetupLink !== undefined ? { kajabiSetupLink } : {}),
          ...(kajabiPurchaseLink !== undefined ? { kajabiPurchaseLink } : {}),
          ...(kajabiIsMaintenance !== undefined ? { kajabiIsMaintenance } : {}),
          ...(kartraVersion !== undefined ? { kartraVersion } : {}),
          ...(kartraDownloadLink !== undefined ? { kartraDownloadLink } : {}),
          ...(kartraSetupLink !== undefined ? { kartraSetupLink } : {}),
          ...(kartraPurchaseLink !== undefined ? { kartraPurchaseLink } : {}),
          ...(kartraIsMaintenance !== undefined ? { kartraIsMaintenance } : {}),
        },
      });
    }

    return res.status(200).json({ message: "success", data: config });
  } catch (err) {
    return res.status(500).json({ message: "error", data: err, ...(err as object) });
  }
};
