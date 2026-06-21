import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "src", "public");
const dest = join(root, "dist", "public");

await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });
console.log(`copied ${src} -> ${dest}`);
