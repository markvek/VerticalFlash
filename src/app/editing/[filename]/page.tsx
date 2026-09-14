import { Suspense } from "react";
import { EditingWorkspace } from "@/components/form/EditingWorkspace";
export default async function EditingPage({ params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params;
  return <Suspense fallback={<p className="p-4 text-sm">Loading editing workspace...</p>}><EditingWorkspace filename={filename} /></Suspense>;
}
