import { Suspense } from "react";
import { SettingsDashboard } from "@ajioncorp/skynet/components";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";

export default function SettingsPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSkeleton />}>
        <SettingsDashboard />
      </Suspense>
    </ErrorBoundary>
  );
}
