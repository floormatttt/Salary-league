// Assembles the static site into dist/ for GitHub Pages:
//   site/*  +  lib/*.js -> dist/lib/  +  data/*.json -> dist/data/
// Script and style URLs get ?v=<build> so browsers pick up new code after a deploy.
// Run: npm run build
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const version = (process.env.GITHUB_SHA || String(Date.now())).slice(0, 10);

rmSync(DIST, { recursive: true, force: true });
mkdirSync(path.join(DIST, "lib"), { recursive: true });
cpSync(path.join(ROOT, "site"), DIST, { recursive: true });
for (const f of readdirSync(path.join(ROOT, "lib")).filter(f => f.endsWith(".js"))) cpSync(path.join(ROOT, "lib", f), path.join(DIST, "lib", f));
cpSync(path.join(ROOT, "data"), path.join(DIST, "data"), { recursive: true });
const index = path.join(DIST, "index.html");
writeFileSync(index, readFileSync(index, "utf8").replace(/__VERSION__/g, version));
writeFileSync(path.join(DIST, ".nojekyll"), ""); // serve files as-is
console.log(`built dist/ (version ${version})`);
