/**
 * Every onclick/onchange handler in the HTML is a STRING. If the function it
 * names gets deleted, no linter, no bundler, and no type-checker will notice.
 * You find out when a pastor clicks a button and gets "close_ is not defined".
 *
 * That exact bug shipped once. This is the guard.
 *
 *   node scripts/check-handlers.js
 */
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "public");
const BUILTINS = new Set([
  "alert","confirm","prompt","event","this","window","console","setTimeout","location",
  "fetch","if","for","while","return","stopPropagation","preventDefault","Number","String",
]);
let bad = 0;

for (const file of fs.readdirSync(DIR).filter(f => f.endsWith(".html"))) {
  const html = fs.readFileSync(path.join(DIR, file), "utf8");

  // every function this file defines
  const defined = new Set();
  for (const m of html.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g))
    defined.add(m[1]);
  for (const m of html.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g))
    defined.add(m[1]);

  // every function an inline handler CALLS
  const called = new Map();   // name -> sample handler text
  for (const m of html.matchAll(/on(?:click|change|input|submit)=["'`]([^"'`]+)/g)) {
    for (const c of m[1].matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (!BUILTINS.has(c[1])) called.set(c[1], m[1].slice(0, 60));
    }
  }

  for (const [fn, sample] of called) {
    if (!defined.has(fn)) {
      console.error(`  ${file}: handler calls "${fn}()" but it is not defined`);
      console.error(`      -> ${sample}`);
      bad++;
    }
  }
}

if (bad) {
  console.error(`\n${bad} broken handler(s). A button on that screen does nothing.\n`);
  process.exit(1);
}
console.log("all inline handlers resolve to a defined function");
