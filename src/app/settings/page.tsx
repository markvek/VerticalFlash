import type { Metadata } from "next";
import { ArrowDownToLine, Check, FileText, Monitor, Plug, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentSettingsBoard } from "@/components/settings/AgentSettingsBoard";
import { AGENT_GUIDES, AGENT_KIT_VERSION, agentDownloadHref } from "@/lib/agent-kit-catalog";

export const metadata: Metadata = { title: "Settings · VerticalFlash" };

export default function SettingsPage() {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-8 px-5 py-8 sm:p-10">
      <header className="space-y-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Settings2 className="size-4" aria-hidden="true" />Workspace</div>
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="max-w-2xl text-muted-foreground">Select workflow agents, connect external agent tooling, and manage workspace-level controls.</p>
      </header>

      <AgentSettingsBoard />

      <section aria-labelledby="agent-connection" className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="space-y-5 p-5 sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><Plug className="size-5" aria-hidden="true" /></div>
              <div><h2 id="agent-connection" className="text-lg font-semibold">Connect an agent</h2><p className="text-sm text-muted-foreground">VerticalFlash MCP connector · v{AGENT_KIT_VERSION}</p></div>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground"><Monitor className="size-3.5" aria-hidden="true" />Local connection</span>
          </div>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">Let your agent explore your footage, propose storyboards, trim an edit, add library B-roll, and render a preview. You can review the same projects in the editor.</p>
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            {["Runnable MCP server", "Client configuration example", "Guides for each creative stage", "Setup instructions and tests"].map((item) => <li key={item} className="flex items-center gap-2"><Check className="size-4 text-primary" aria-hidden="true" />{item}</li>)}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild size="lg"><a href={agentDownloadHref("verticalflash-agent-kit.zip")} download><ArrowDownToLine aria-hidden="true" />Download MCP kit<span className="text-xs opacity-75">ZIP</span></a></Button>
            <Button asChild variant="outline" size="lg"><a href={agentDownloadHref("mcp-config.json")} download>Download config example</a></Button>
          </div>
        </div>
        <div className="border-t border-border bg-muted/40 px-5 py-4 text-sm leading-6 text-muted-foreground sm:px-7">
          Run the connector on the same computer as VerticalFlash. Cloud-only agents need a remote connection, which this kit does not include yet.
        </div>
      </section>

      <section aria-labelledby="setup" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="setup" className="text-lg font-semibold">Get connected</h2>
          <a className="inline-flex items-center gap-1.5 text-sm text-primary underline-offset-4 hover:underline" href={agentDownloadHref("setup.md")} download><FileText className="size-4" aria-hidden="true" />Download setup guide</a>
        </div>
        <ol className="grid gap-4 sm:grid-cols-3">
          {[
            ["Install the connector", <>Extract the kit, open its <code className="text-foreground">mcp</code> folder, and run <code className="text-foreground">npm ci</code>. Requires Node 20+.</>],
            ["Add it to your agent", <>Edit the server path in <code className="break-all text-foreground">mcp-config.json</code>, then add it to a client that supports local MCP servers.</>],
            ["Start a conversation", <>Keep VerticalFlash running. Ask your agent to list your projects and read the video workflow guide.</>],
          ].map(([title, description], i) => <li key={i} className="rounded-xl border border-border p-4">
            <span className="mb-3 flex size-6 items-center justify-center rounded-full bg-muted text-xs font-semibold">{i + 1}</span>
            <h3 className="text-sm font-semibold">{title}</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
          </li>)}
        </ol>
      </section>

      <section aria-labelledby="workflow-guides" className="space-y-4">
        <div><h2 id="workflow-guides" className="text-lg font-semibold">Guides for your agent</h2><p className="mt-1 text-sm text-muted-foreground">Markdown files written for this workspace’s video workflow. Included in the kit, or download them individually to attach to a conversation.</p></div>
        <div className="grid gap-3 sm:grid-cols-2">
          {AGENT_GUIDES.map((guide) => <article key={guide.file} className="flex flex-col items-start rounded-xl border border-border bg-card p-5">
            <FileText className="mb-3 size-5 text-muted-foreground" aria-hidden="true" />
            <h3 className="font-semibold">{guide.title}</h3>
            <p className="mb-4 mt-1 flex-1 text-sm leading-6 text-muted-foreground">{guide.description}</p>
            <a href={agentDownloadHref(guide.file)} download className="inline-flex items-center gap-2 text-sm text-primary underline-offset-4 hover:underline"><ArrowDownToLine className="size-4" aria-hidden="true" />Download {guide.file}</a>
          </article>)}
        </div>
      </section>

      <aside className="rounded-xl border border-dashed border-border p-5">
        <h2 className="text-sm font-semibold">Try this with your agent</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">“Help me make a 30-second video from my footage. Let’s choose the angle, compare storyboard options, then edit the best one and add B-roll. Keep my original voice.”</p>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">The connector uses your app’s existing AI services and saved projects. Media work can incur provider costs. Coordinate agent and browser edits; automatic conflict protection is planned.</p>
      </aside>
    </div>
  );
}
