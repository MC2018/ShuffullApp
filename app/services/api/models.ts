import { z } from "zod";

export const UserSchema = z.object({
    userId: z.number().int(),
    username: z.string(),
    version: z.coerce.date()
});
export type User = z.infer<typeof UserSchema>;

export const AuthenticateResponseSchema = z.object({
    user: UserSchema,
    token: z.string(),
    expiration: z.coerce.date()
});
export type AuthenticateResponse = z.infer<typeof AuthenticateResponseSchema>;
