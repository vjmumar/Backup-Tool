import { TUser } from "../../src/types/User";

declare global {
  namespace Express {
    interface Request {
      user?: TUser;
    }
  }
}
