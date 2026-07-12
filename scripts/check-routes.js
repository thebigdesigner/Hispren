/**
 * ROUTE COLLISION CHECK.
 *
 * Fastify throws FST_ERR_DUPLICATED_ROUTE at boot if two modules declare the
 * same METHOD + PATH. The server does not start. The site goes down. And the
 * error only appears in the deploy log, after the build has already succeeded.
 *
 * This has now happened three times:
 *   registerNotifyRoutes called twice
 *   POST /api/households in both members/ and care/
 *   ...and it will happen again as modules multiply.
 *
 * No linter catches it: routes are strings, spread across files, and the path
 * often sits on a DIFFERENT LINE from app.post<...>(. So we parse for it.
 *
 *   node scripts/check-routes.js
 */
const fs = require("fs");
const path = require("path");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const seen = new Map();   // "POST /api/x" -> [file:line, ...]
let total = 0;

for (const file of walk(path.join(__dirname, "..", "src"))) {
  const src = fs.readFileSync(file, "utf8");

  // app.post<{...}>(\n  "/api/households", ...
  // The generic can span lines, and the path can be on the next line.
  const re = /app\.(get|post|put|patch|delete|head|options)\s*(?:<[\s\S]*?>)?\s*\(\s*["'`]([^"'`]+)["'`]/g;

  let m;
  while ((m = re.exec(src))) {
    const method = m[1].toUpperCase();
    const route = m[2];
    if (!route.startsWith("/")) continue;

    // line number of the match
    const line = src.slice(0, m.index).split("\n").length;
    const key = `${method} ${route}`;
    const where = `${path.relative(path.join(__dirname, ".."), file)}:${line}`;

    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(where);
    total++;
  }
}

const clashes = [...seen.entries()].filter(([, w]) => w.length > 1);

if (clashes.length) {
  console.error("\nDUPLICATE ROUTES — Fastify will refuse to boot.\n");
  for (const [key, where] of clashes) {
    console.error(`  ${key}`);
    for (const w of where) console.error(`      ${w}`);
  }
  console.error(`\n${clashes.length} collision(s). The server will not start.\n`);
  process.exit(1);
}

console.log(`  ${total} routes, ${seen.size} unique — no collisions`);
