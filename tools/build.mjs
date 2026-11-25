// Generates Apps Script partials from node-runnable sources, so there is
// one copy of each file to maintain.
//   lib/LeagueMath.js -> src/LeagueMath.html  (<script> partial for the client)
// Run: npm run build   (also runs before push and test)
import { readFileSync, writeFileSync } from "node:fs";

const targets = [
  { from: "lib/LeagueMath.js", to: "src/LeagueMath.html" },
];

for (const t of targets) {
  const js = readFileSync(t.from, "utf8")
    // The node export line is harmless in the browser, but drop it to keep the partial clean
    .replace(/^if \(typeof module !== "undefined"\).*$/m, "")
    .trimEnd();
  if (/<\/script/i.test(js)) throw new Error(`${t.from} contains </script>, which would break the partial`);
  const out = `<!-- GENERATED from ${t.from} by tools/build.mjs. Edit that file, not this one. -->\n<script>\n${js}\n</script>\n`;
  writeFileSync(t.to, out);
  console.log(`built ${t.to}`);
}
