"use client";

import { Loader2 } from "lucide-react";

export function LoadingSkeleton() {
  return (
    <div className="flex items-center justify-center py-20">
      <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
      <span className="ml-3 text-sm text-zinc-500">Loading...</span>
    </div>
  );
}
