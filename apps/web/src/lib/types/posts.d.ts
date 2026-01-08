import type { Post as PostDTO } from "@/generated/prisma/client";
export type { PostDTO };

export interface PostDTOWithRelations extends PostDTO {
  author: {
    id: string
    name: string | null
    email: string
  }
  categories: {
    category: {
      id: string
      name: string
      slug: string
    }
  }[]
}

export interface Post {
  id: string
  title: string
  slug: string
  excerpt: string
  content: string
  createdAt: Date
  updatedAt: Date
  published?: Date
  author: {
    id: string
    name?: string
    email: string
  }
  categories: {
    id: string
    name: string
    slug: string
  }[]
}
