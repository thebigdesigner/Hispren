/**
 * Pre-flight check for the frontend. Catches two bugs that NO linter, bundler,
 * or type-checker can see — and both of which shipped once:
 *
 *   1. A syntax error in an inline <script>. The whole block fails to parse,
 *      NOTHING is defined, and every button on the page silently does nothing.
 *      There is no server error to find.
 *
 *   2. An onclick handler naming a function that no longer exists. Handlers are
 *      STRINGS inside HTML attributes — invisible to every static tool. You find
 *      out when a pastor clicks Save and gets "close_ is not defined".
 *
 *   node scripts/check-handlers.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const DIR = path.join(__dirname, "..", "public");

// Things a handler may legitimately call that are not our functions.
const BUILTINS = new Set([
  "alert","confirm","prompt","event","this","window","console","setTimeout",
  "setInterval","location","fetch","if","for","while","switch","return","typeof",
  "stopPropagation","preventDefault","Number","String","Boolean","Array","Object",
  "JSON","Math","Date","encodeURIComponent","decodeURIComponent","parseInt","parseFloat",
]);

let failures = 0;

for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith(".html"))) {
  const html = fs.readFileSync(path.join(DIR, file), "utf8");

  // ---- 1. does the script block even parse? -------------------------------
  const open = html.indexOf("<script>");
  if (open !== -1) {
    const js = html.slice(open + 8, html.lastIndexOf("</script>"));
    try {
      new vm.Script(js, { filename: file });   // parse only, never run
      console.log(`  ${file}  script parses`);
    } catch (e) {
      console.error(`\n  ${file}  SYNTAX ERROR — the whole script block is dead.`);
      console.error(`      ${e.message}`);
      console.error(`      Every button on this page does nothing.\n`);
      failures++;
      continue;   // handler check is meaningless if it doesn't parse
    }
  }

  // ---- 2. does every inline handler point at a real function? --------------
  const defined = new Set();
  for (const m of html.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g))
    defined.add(m[1]);
  for (const m of html.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g))
    defined.add(m[1]);

  const called = new Map();
  for (const m of html.matchAll(/on(?:click|change|input|submit)=["'`]([^"'`]+)/g)) {
    for (const c of m[1].matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (!BUILTINS.has(c[1])) called.set(c[1], m[1].slice(0, 70));
    }
  }

  let broken = 0;
  for (const [fn, sample] of called) {
    if (!defined.has(fn)) {
      if (!broken) console.error("");
      console.error(`  ${file}  handler calls "${fn}()" — but it is not defined`);
      console.error(`      ${sample}`);
      broken++;
      failures++;
    }
  }
  if (!broken && called.size) {
    console.log(`  ${file}  ${called.size} handlers all resolve`);
  }
}

if (failures) {
  console.error(`\n${failures} problem(s). Do not ship this.\n`);
  process.exit(1);
}
console.log("\nfrontend ok\n");
