import { Request, Response } from "express";

const LINKS = [
  {
    purchaseLink: "https://your-purchase-link.com",
    otherLinks: "https://your-other-link.com",
  },
];

// GET /api/links
export const getLinks = async (req: Request, res: Response) => {
  try {
    // Finally — return the links constant
    return res.status(200).json({ message: "success", data: LINKS });
  } catch (err) {
    return res.status(500).json({ message: "error", data: err, ...(err as object) });
  }
};
