import { Request, Response } from "express";

const CONFIG = {
  googleDrive: {
    clientId: "565945392484-u4fktod13ru0guk5sdi96v1ap7tnjv9f.apps.googleusercontent.com",
    clientSecret: "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",
  },
};

// Mutable maintenance flag — toggled via the backdoor panel
let isMaintenance = false;

// GET /api/config
export const getConfig = async (req: Request, res: Response) => {
  try {
    // Finally — return the config constant along with the maintenance flag
    return res.status(200).json({ message: "success", data: { ...CONFIG, isMaintenance } });
  } catch (err) {
    return res.status(500).json({ message: "error", data: err, ...(err as object) });
  }
};

// GET /api/config/maintenance
export const getMaintenance = async (req: Request, res: Response) => {
  try {
    return res.status(200).json({ message: "success", data: { isMaintenance } });
  } catch (err) {
    return res.status(500).json({ message: "error", data: err, ...(err as object) });
  }
};

// PATCH /api/config/maintenance
export const setMaintenance = async (
  req: Request<unknown, unknown, { isMaintenance: boolean }>,
  res: Response
) => {
  try {
    // First — validate the field
    if (typeof req.body.isMaintenance !== "boolean") {
      return res.status(400).json({
        message: "error",
        data: { message: "isMaintenance must be a boolean" },
      });
    }

    // Then — toggle the flag
    isMaintenance = req.body.isMaintenance;

    // Finally — respond
    return res.status(200).json({ message: "success", data: { isMaintenance } });
  } catch (err) {
    return res.status(500).json({ message: "error", data: err, ...(err as object) });
  }
};
