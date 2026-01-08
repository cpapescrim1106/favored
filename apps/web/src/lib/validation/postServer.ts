import { z } from "zod";
import { checkSlugExists } from "../services/post";
import { postSchema } from "./post";

// Create a function that returns the schema with context
export const createPostServerSchema = (excludePostId?: string) =>
  postSchema.extend({
    slug: postSchema.shape.slug.superRefine(async (slug, ctx) => {
      const exists = await checkSlugExists(slug, excludePostId);
      if (exists) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "This slug is already taken",
        });
      }
    }),
  });
