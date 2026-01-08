import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";

export async function POST() {
  try {
    // Check kill switch
    const config = await prisma.config.findUnique({
      where: { id: "singleton" },
    });

    if (config?.killSwitchActive) {
      return NextResponse.json(
        { error: "Kill switch is active" },
        { status: 403 }
      );
    }

    // Log the scan request
    await prisma.log.create({
      data: {
        level: "INFO",
        category: "SCAN",
        message: "Manual scan triggered from UI",
      },
    });

    // Note: In production, this would trigger the worker.
    // For now, we just log the request. The worker runs on its own schedule.
    // You could implement a webhook or message queue here.

    return NextResponse.json({
      success: true,
      message: "Scan triggered. Results will appear shortly.",
    });
  } catch (error) {
    console.error("Failed to trigger scan:", error);
    return NextResponse.json(
      { error: "Failed to trigger scan" },
      { status: 500 }
    );
  }
}
