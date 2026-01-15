"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Paths } from "@/constants/paths";
import { cn } from "@/utils/shadcn";
import {
  Search,
  ShoppingCart,
  PieChart,
  BarChart3,
  Compass,
  Settings,
  ScrollText,
  AlertTriangle,
} from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { useQuery } from "@tanstack/react-query";

const tabs = [
  { name: "Discover", href: Paths.DISCOVER, icon: Compass },
  { name: "Candidates", href: Paths.CANDIDATES, icon: Search },
  { name: "Basket", href: Paths.BASKET, icon: ShoppingCart },
  { name: "Portfolio", href: Paths.PORTFOLIO, icon: PieChart },
  { name: "MM", href: Paths.MARKET_MAKING, icon: BarChart3 },
  { name: "Config", href: Paths.CONFIG, icon: Settings },
  { name: "Logs", href: Paths.LOGS, icon: ScrollText },
];

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  // Fetch kill switch status
  const { data: config } = useQuery({
    queryKey: ["config"],
    queryFn: async () => {
      const res = await fetch("/api/config");
      return res.json();
    },
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  const killSwitchActive = config?.killSwitchActive;

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-50 w-full border-b border-zinc-200 dark:border-zinc-800 bg-white/75 dark:bg-zinc-950/75 backdrop-blur">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8 max-w-7xl">
          <div className="flex h-14 items-center justify-between">
            {/* Logo */}
            <div className="flex items-center gap-2">
              <span className="font-bold text-xl">Favored</span>
              {killSwitchActive && (
                <span className="flex items-center gap-1 text-xs font-medium text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-900/30 px-2 py-0.5 rounded">
                  <AlertTriangle className="h-3 w-3" />
                  KILL SWITCH
                </span>
              )}
            </div>

            {/* Navigation Tabs */}
            <nav className="flex items-center gap-1">
              {tabs.map((tab) => {
                const isActive = pathname === tab.href;
                const Icon = tab.icon;
                return (
                  <Link
                    key={tab.href}
                    href={tab.href}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md transition-colors",
                      isActive
                        ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100"
                        : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900 hover:text-zinc-900 dark:hover:text-zinc-100"
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    <span className="hidden sm:inline">{tab.name}</span>
                  </Link>
                );
              })}
              <ThemeToggle />
            </nav>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 container mx-auto px-4 sm:px-6 lg:px-8 max-w-7xl py-4">
        {children}
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-200 dark:border-zinc-800 py-4">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8 max-w-7xl">
          <p className="text-xs text-zinc-500 text-center">
            Favored - Polymarket Scanner + Bulk Trader + Portfolio Manager
          </p>
        </div>
      </footer>
    </div>
  );
}
