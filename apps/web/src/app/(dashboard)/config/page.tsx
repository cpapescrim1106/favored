"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Settings, AlertTriangle, Save, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect } from "react";

interface Config {
  minProb: number;
  maxProb: number;
  maxSpread: number;
  minLiquidity: number;
  defaultStake: number;
  maxStakePerMarket: number;
  maxExposurePerMarket: number;
  maxExposurePerCategory: number;
  maxOpenPositions: number;
  maxTotalExposure: number;
  takeProfitThreshold: number;
  maxSlippage: number;
  killSwitchActive: boolean;
  scanInterval: number;
  excludedCategories: string[];
}

export default function ConfigPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [formData, setFormData] = useState<Config | null>(null);
  const [excludedCategoriesInput, setExcludedCategoriesInput] = useState("");

  // Fetch config
  const { data: config, isLoading } = useQuery<Config>({
    queryKey: ["config"],
    queryFn: async () => {
      const res = await fetch("/api/config");
      if (!res.ok) throw new Error("Failed to fetch config");
      return res.json();
    },
  });

  // Initialize form when config loads
  useEffect(() => {
    if (config) {
      setFormData(config);
      setExcludedCategoriesInput(config.excludedCategories.join(", "));
    }
  }, [config]);

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: async (data: Partial<Config>) => {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to save config");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Configuration saved" });
      queryClient.invalidateQueries({ queryKey: ["config"] });
    },
    onError: (error) => {
      toast({
        title: "Failed to save",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Kill switch mutation
  const killSwitchMutation = useMutation({
    mutationFn: async (active: boolean) => {
      const res = await fetch("/api/kill-switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      });
      if (!res.ok) throw new Error("Failed to toggle kill switch");
      return res.json();
    },
    onSuccess: (_, active) => {
      toast({
        title: active ? "Kill switch activated" : "Kill switch deactivated",
        variant: active ? "destructive" : "default",
      });
      queryClient.invalidateQueries({ queryKey: ["config"] });
    },
  });

  const handleSave = () => {
    if (!formData) return;
    const excludedCategories = excludedCategoriesInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    saveMutation.mutate({
      minProb: formData.minProb,
      maxProb: formData.maxProb,
      maxSpread: formData.maxSpread,
      minLiquidity: formData.minLiquidity,
      defaultStake: formData.defaultStake,
      maxStakePerMarket: formData.maxStakePerMarket,
      maxExposurePerMarket: formData.maxExposurePerMarket,
      maxExposurePerCategory: formData.maxExposurePerCategory,
      maxOpenPositions: formData.maxOpenPositions,
      maxTotalExposure: formData.maxTotalExposure,
      takeProfitThreshold: formData.takeProfitThreshold,
      maxSlippage: formData.maxSlippage,
      scanInterval: formData.scanInterval,
      excludedCategories,
    });
  };

  const handleInputChange = (field: keyof Config, value: number | string) => {
    if (!formData) return;
    setFormData({ ...formData, [field]: value });
  };

  if (isLoading || !formData) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-48" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Settings className="h-6 w-6" />
            Configuration
          </h1>
          <p className="text-sm text-zinc-500">
            Manage trading parameters and risk controls
          </p>
        </div>
        <Button onClick={handleSave} disabled={saveMutation.isPending}>
          {saveMutation.isPending ? (
            <RefreshCw className="h-4 w-4 mr-1 animate-spin" />
          ) : (
            <Save className="h-4 w-4 mr-1" />
          )}
          Save Changes
        </Button>
      </div>

      {/* Kill Switch Card */}
      <Card className={formData.killSwitchActive ? "border-red-500 bg-red-50 dark:bg-red-950/20" : ""}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-red-500" />
            Kill Switch
          </CardTitle>
          <CardDescription>
            Emergency stop all trading activity. When active, no new orders will be placed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Switch
                checked={formData.killSwitchActive}
                onCheckedChange={(checked) => {
                  killSwitchMutation.mutate(checked);
                  setFormData({ ...formData, killSwitchActive: checked });
                }}
              />
              <Label>
                {formData.killSwitchActive ? (
                  <Badge variant="destructive">ACTIVE - Trading Disabled</Badge>
                ) : (
                  <Badge variant="outline">Inactive</Badge>
                )}
              </Label>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Probability Band */}
        <Card>
          <CardHeader>
            <CardTitle>Probability Band</CardTitle>
            <CardDescription>
              Only consider candidates within this implied probability range
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Minimum (%)</Label>
                <Input
                  type="number"
                  value={(formData.minProb * 100).toFixed(0)}
                  onChange={(e) =>
                    handleInputChange("minProb", Number(e.target.value) / 100)
                  }
                  min={0}
                  max={100}
                />
              </div>
              <div className="space-y-2">
                <Label>Maximum (%)</Label>
                <Input
                  type="number"
                  value={(formData.maxProb * 100).toFixed(0)}
                  onChange={(e) =>
                    handleInputChange("maxProb", Number(e.target.value) / 100)
                  }
                  min={0}
                  max={100}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Spread & Liquidity */}
        <Card>
          <CardHeader>
            <CardTitle>Spread & Liquidity</CardTitle>
            <CardDescription>Minimum quality requirements for candidates</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Max Spread (%)</Label>
                <Input
                  type="number"
                  value={(formData.maxSpread * 100).toFixed(1)}
                  onChange={(e) =>
                    handleInputChange("maxSpread", Number(e.target.value) / 100)
                  }
                  min={0}
                  max={100}
                  step={0.1}
                />
              </div>
              <div className="space-y-2">
                <Label>Min Liquidity ($)</Label>
                <Input
                  type="number"
                  value={formData.minLiquidity}
                  onChange={(e) =>
                    handleInputChange("minLiquidity", Number(e.target.value))
                  }
                  min={0}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Position Sizing */}
        <Card>
          <CardHeader>
            <CardTitle>Position Sizing</CardTitle>
            <CardDescription>Control share amounts per position</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Default Shares</Label>
                <Input
                  type="number"
                  value={formData.defaultStake}
                  onChange={(e) =>
                    handleInputChange("defaultStake", Number(e.target.value))
                  }
                  min={0}
                  step={50}
                />
              </div>
              <div className="space-y-2">
                <Label>Max Shares per Market</Label>
                <Input
                  type="number"
                  value={formData.maxStakePerMarket}
                  onChange={(e) =>
                    handleInputChange("maxStakePerMarket", Number(e.target.value))
                  }
                  min={0}
                  step={50}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Exposure Caps */}
        <Card>
          <CardHeader>
            <CardTitle>Exposure Caps</CardTitle>
            <CardDescription>Maximum exposure limits</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Per Market ($)</Label>
                <Input
                  type="number"
                  value={formData.maxExposurePerMarket}
                  onChange={(e) =>
                    handleInputChange("maxExposurePerMarket", Number(e.target.value))
                  }
                  min={0}
                />
              </div>
              <div className="space-y-2">
                <Label>Per Category ($)</Label>
                <Input
                  type="number"
                  value={formData.maxExposurePerCategory}
                  onChange={(e) =>
                    handleInputChange("maxExposurePerCategory", Number(e.target.value))
                  }
                  min={0}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Max Positions</Label>
                <Input
                  type="number"
                  value={formData.maxOpenPositions}
                  onChange={(e) =>
                    handleInputChange("maxOpenPositions", Number(e.target.value))
                  }
                  min={0}
                />
              </div>
              <div className="space-y-2">
                <Label>Total Exposure ($)</Label>
                <Input
                  type="number"
                  value={formData.maxTotalExposure}
                  onChange={(e) =>
                    handleInputChange("maxTotalExposure", Number(e.target.value))
                  }
                  min={0}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Exit & Slippage */}
        <Card>
          <CardHeader>
            <CardTitle>Exit & Slippage</CardTitle>
            <CardDescription>Take-profit and slippage controls</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Take Profit (%)</Label>
                <Input
                  type="number"
                  value={(formData.takeProfitThreshold * 100).toFixed(0)}
                  onChange={(e) =>
                    handleInputChange(
                      "takeProfitThreshold",
                      Number(e.target.value) / 100
                    )
                  }
                  min={0}
                  max={100}
                />
              </div>
              <div className="space-y-2">
                <Label>Max Slippage (%)</Label>
                <Input
                  type="number"
                  value={(formData.maxSlippage * 100).toFixed(1)}
                  onChange={(e) =>
                    handleInputChange("maxSlippage", Number(e.target.value) / 100)
                  }
                  min={0}
                  max={100}
                  step={0.1}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Scan Settings */}
        <Card>
          <CardHeader>
            <CardTitle>Scan Settings</CardTitle>
            <CardDescription>Market scanning configuration</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Scan Interval (minutes)</Label>
              <Input
                type="number"
                value={formData.scanInterval}
                onChange={(e) =>
                  handleInputChange("scanInterval", Number(e.target.value))
                }
                min={1}
                max={60}
              />
            </div>
            <div className="space-y-2">
              <Label>Excluded Categories</Label>
              <Input
                type="text"
                value={excludedCategoriesInput}
                onChange={(e) => setExcludedCategoriesInput(e.target.value)}
                placeholder="crypto, sports"
              />
              <p className="text-xs text-zinc-500">Comma-separated list</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
