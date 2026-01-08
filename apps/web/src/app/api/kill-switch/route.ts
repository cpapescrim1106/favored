import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { active } = body;

    if (typeof active !== "boolean") {
      return NextResponse.json(
        { error: "active must be a boolean" },
        { status: 400 }
      );
    }

    const config = await prisma.config.update({
      where: { id: "singleton" },
      data: { killSwitchActive: active },
    });

    // Log kill switch change
    await prisma.log.create({
      data: {
        level: active ? "WARN" : "INFO",
        category: "SYSTEM",
        message: active
          ? "KILL SWITCH ACTIVATED - All trading disabled"
          : "Kill switch deactivated - Trading enabled",
      },
    });

    return NextResponse.json({
      success: true,
      killSwitchActive: config.killSwitchActive,
    });
  } catch (error) {
    console.error("Failed to toggle kill switch:", error);
    return NextResponse.json(
      { error: "Failed to toggle kill switch" },
      { status: 500 }
    );
  }
}
