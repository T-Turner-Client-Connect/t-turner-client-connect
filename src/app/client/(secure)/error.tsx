"use client";

import { Button } from "@/components/ui";

export default function AppError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert" className="mx-auto max-w-lg rounded-2xl border border-red-200 bg-white p-8 text-center shadow-sm">
      <h1 className="text-2xl font-bold">Something went wrong</h1>
      <p className="mt-2 text-slate-600">This page couldn&apos;t load. Nothing you saved was lost. Try again, or go back and retry in a moment.</p>
      <Button className="mt-5" onClick={reset}>Try again</Button>
    </div>
  );
}
