import * as z from "zod";

export const postSchema = z.object({
  title: z.string().min(1, { error: "Title is required" }),
  slug: z
    .string()
    .min(1, { error: "Slug is required" })
    .regex(/^[a-z0-9-]+$/, {
      error: "Slug can only contain lowercase letters, numbers and hyphens",
    }),
  categories: z.array(z.string()).optional(),
  content: z.string().min(1, { error: "Content is required" }),
  excerpt: z.string().optional(),
});
