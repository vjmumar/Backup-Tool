import { Request, Response } from "express";
import fs from "fs";
import path from "path";

const SCRAPERS_DIR = path.join(__dirname, "../scrapers");

// GET /api/scrapers/:name
export const getScraperByName = async (
  req: Request<{ name: string }>,
  res: Response
) => {
  try {
    // First — build the file path from the name param
    const filePath = path.join(SCRAPERS_DIR, `${req.params.name}.js`);

    // Then — check the file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        message: "error",
        data: { message: `Scraper "${req.params.name}" not found` },
      });
    }

    // Then — read the file
    const script = fs.readFileSync(filePath, "utf-8");

    // Finally — send the raw script string
    return res.send(script);
  } catch (err) {
    return res.status(500).json({ message: "error", data: err, ...(err as object) });
  }
};
