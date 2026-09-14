import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";
import { z } from "zod";
import { DATA_ROOT } from "./paths";
import { withProjectEdit } from "./project-edit-lock";

const LinksZ = z.record(z.string().nullable());
const path = join(DATA_ROOT, "published-links.json");
// null is an explicit rejection of automatic attribution for this post.
export async function readPublishedLinks() {
  try { return LinksZ.parse(JSON.parse(await fs.readFile(path, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}
export async function savePublishedLink(publishedId: string, publishId: string | null) {
  return withProjectEdit("published-links", async () => {
    const links = await readPublishedLinks();
    links[publishedId] = publishId;
    const tmp = `${path}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(links, null, 2));
    await fs.rename(tmp, path);
  });
}
