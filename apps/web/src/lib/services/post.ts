"use server";

import { EXCERPT_RECOMMENDED_LENGTH } from "@/constants/post";
import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";
import type { Post, PostDTOWithRelations } from "@/lib/types/posts";
import { ensureServer } from "@/utils/ensureRuntime";
import { excerptFromMarkdown } from "@/utils/string";
import BPromise from "bluebird";

export async function mapPostDtoToDomain(
  post: PostDTOWithRelations,
): Promise<Post> {
  const parsedPost: Post = {
    ...post,
    published: post.published ?? undefined,
    author: {
      id: post.author.id,
      name: post.author.name ?? undefined,
      email: post.author.email,
    },
    categories: post.categories.map((c) => ({
      id: c.category.id,
      name: c.category.name,
      slug: c.category.slug,
    })),
    excerpt:
      post.excerpt ??
      (await excerptFromMarkdown(post.content, EXCERPT_RECOMMENDED_LENGTH)),
  };

  return parsedPost;
}

export async function getPosts({
  userId = null,
  published = null,
  sortOrder = "desc",
  take = 20,
}: {
  userId?: string | null;
  published?: boolean | null;
  sortOrder?: "asc" | "desc";
  take?: number;
}): Promise<Post[]> {
  ensureServer("services/getPosts");
  const posts = await prisma.post.findMany({
    where: {
      ...(userId ? { authorId: userId } : {}),
      ...(() => {
        if (published === null) return {};
        return published ? { published: { not: null } } : { published: null };
      })(),
    },
    include: {
      author: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
      categories: {
        include: {
          category: true,
        },
      },
    },
    orderBy: {
      createdAt: sortOrder,
    },
    take,
  });

  return BPromise.map(posts, async (post) => mapPostDtoToDomain(post));
}

export async function getPost({
  slug,
  id,
}: {
  slug?: string;
  id?: string;
}): Promise<Post | undefined> {
  ensureServer("services/getPost");
  const post = await prisma.post.findUnique({
    where: { ...(slug ? { slug } : { id }) },
    include: {
      author: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
      categories: {
        include: {
          category: true,
        },
      },
    },
  });
  if (!post) return undefined;

  return mapPostDtoToDomain(post) as Promise<Post>;
}

export async function createPost({
  authorId,
  title,
  slug,
  content,
  excerpt,
  categories,
}: {
  authorId: string;
  title: string;
  slug: string;
  content: string;
  excerpt?: string;
  categories?: string[];
}) {
  ensureServer("services/createPost");

  const result = await prisma.post.create({
    data: {
      authorId,
      title,
      slug,
      content,
      excerpt,
      categories: {
        create: categories?.map((categoryId) => ({
          category: {
            connect: { id: categoryId },
          },
        })),
      },
    },
  });
  if (!result) return undefined;
  return getPost({ id: result.id });
}

export async function deletePost(id: string) {
  ensureServer("services/deletePost");
  await prisma.categoriesOnPosts.deleteMany({ where: { postId: id } });
  return prisma.post.delete({ where: { id } });
}

export async function updatePost({
  id,
  title,
  slug,
  content,
  excerpt,
  categories,
}: {
  id: string;
  title: string;
  slug: string;
  content: string;
  excerpt?: string;
  categories?: string[];
}) {
  ensureServer("services/updatePost");

  // Delete existing category relationships
  await prisma.categoriesOnPosts.deleteMany({
    where: { postId: id },
  });

  // Update post with new data and categories
  const result = await prisma.post.update({
    where: { id },
    data: {
      title,
      slug,
      content,
      excerpt,
      categories: {
        create: categories?.map((categoryId) => ({
          category: {
            connect: { id: categoryId },
          },
        })),
      },
    },
  });

  if (!result) return undefined;
  return getPost({ id: result.id });
}

export async function setPublishStatus({
  id,
  publish,
}: {
  id: string;
  publish: boolean;
}) {
  ensureServer("services/setPublishStatus");

  const result = await prisma.post.update({
    where: { id },
    data: {
      published: publish ? new Date() : null,
    },
  });

  if (!result) return undefined;
  return getPost({ id: result.id });
}

export async function checkSlugExists(slug: string, excludePostId?: string) {
  const where: Prisma.PostWhereInput = { slug };
  if (excludePostId) where.id = { not: excludePostId };
  const count = await prisma.post.count({ where });
  return count > 0;
}
