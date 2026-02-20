import { Suspense } from "react";
import { EventsDashboard } from "@ajioncorp/skynet/components";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";

export default function EventsPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSkeleton />}>
        <EventsDashboard />
      </Suspense>
    </ErrorBoundary>
  );
}
