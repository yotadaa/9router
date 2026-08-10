"use client";

import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components";
import OverviewPageClient from "./OverviewPageClient";

export default function OverviewPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <OverviewPageClient />
    </Suspense>
  );
}
