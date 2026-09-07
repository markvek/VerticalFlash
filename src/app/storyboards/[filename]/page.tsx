import { StoryboardWorkspace } from "@/components/form/StoryboardWorkspace";

export default async function StoryboardPage({ params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params;
  return <StoryboardWorkspace filename={filename} />;
}
