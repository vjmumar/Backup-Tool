import bcrypt from "bcrypt";

export const compareHashedPassword = async (
  plain: string,
  hashed: string
): Promise<boolean> => {
  if (!plain || !hashed) {
    throw new Error("Both plain and hashed passwords are required");
  }
  return bcrypt.compare(plain, hashed);
};
