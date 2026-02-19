import { Suspense } from "react";
import { MonitoringDashboard } from "@ajioncorp/skynet/components";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";

export default function MonitoringPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSkeleton />}>
        <MonitoringDashboard />
      </Suspense>
    </ErrorBoundary>
  );
}
