import { Request, Response } from "express";

const PLATFORMS = [
  {
    name: "kajabi",
    scraperName: "kajabi",
    urlPattern: "^https:\\/\\/app\\.kajabi\\.com\\/admin\\/sites\\/\\d+\\/courses\\/?",
    accountIdExpression: "window.CLIENT_INFO?.account_id",
  },
  {
    name: "kartra",
    scraperName: "kartra",
    urlPattern: "^https:\\/\\/app\\.kartra\\.com\\/memberships\\/all-memberships",
    accountIdExpression: "JSON.parse(sessionStorage.getItem(\"pusherAuth\")).memberId",
  },
];
// GET /api/platforms
export const getPlatforms = async (req: Request, res: Response) => {
  try {
    // Finally — return the platforms constant
    return res.status(200).json({ message: "success", data: PLATFORMS });
  } catch (err) {
    return res.status(500).json({ message: "error", data: err, ...(err as object) });
  }
};
