import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const limit = Number(searchParams.get("limit") || 100);
    const category = searchParams.get("category");
    const level = searchParams.get("level");

    const where: Record<string, string> = {};
    if (category) where.category = category;
    if (level) where.level = level;

    const logs = await prisma.log.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const serialized = logs.map((log) => ({
      id: log.id,
      level: log.level,
      category: log.category,
      message: log.message,
      metadata: log.metadata,
      createdAt: log.createdAt.toISOString(),
    }));

    return NextResponse.json({ logs: serialized });
  } catch (error) {
    console.error("Failed to fetch logs:", error);
    return NextResponse.json({ error: "Failed to fetch logs" }, { status: 500 });
  }
}
