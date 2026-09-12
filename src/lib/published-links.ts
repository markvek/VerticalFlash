import { promises as fs } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { z } from "zod";
import { DATA_ROOT } from "./paths";
import { withProjectEdit } from "./project-edit-lock";
const file = join(DATA_ROOT, "published-links.json");
const LinkZ = z.object({ videoId: z.string().nullable(), filename: z.string().optional(), exportId: z.string().optional(), confirmedAt: z.string().optional() });
export async function readPublishedLinks() {
  try { return z.record(LinkZ).parse(JSON.parse(await fs.readFile(file, "utf8"))); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw e; }
}
export async function savePublishedLink(id: string, link: z.infer<typeof LinkZ>) {
  await withProjectEdit("published-links", async () => {
    const links = await readPublishedLinks(); links[id] = { ...LinkZ.parse(link), confirmedAt: new Date().toISOString() };
    await fs.mkdir(DATA_ROOT, { recursive: true }); const temp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(links, null, 2)); await fs.rename(temp, file);
  });
}
