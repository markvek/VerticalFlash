import { redirect } from "next/navigation";
export default async function Page({ params }: { params: Promise<{ filename: string }> }) { const { filename } = await params; redirect(`/editing/${encodeURIComponent(filename)}?view=storyboards`); }
