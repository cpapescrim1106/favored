import type { User as UserDTO } from "@/generated/prisma/client";

export type UserWithoutPassword = Omit<UserDTO, "password">;
