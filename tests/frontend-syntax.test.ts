/**
 * The frontend is a plain HTML file with an inline <script>. A single syntax
 * error in it means NOTHING is defined and every button silently does nothing —
 * with no server-side error to find. That exact bug shipped once.
 *
 * This test parses the script block of every page. It runs in CI.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { execSync, writeFileSync } from "child_process";
import { tmpdir } from "os";

const PUBLIC = join(__dirname, "..", "public");

describe("frontend script blocks parse", () => {
  for (const file of readdirSync(PUBLIC).filter(f => f.endsWith(".html"))) {
    it(`${file} has valid JavaScript`, () => {
      const html = readFileSync(join(PUBLIC, file), "utf8");
      const a = html.indexOf("<script>");
      if (a === -1) return;                       // no inline script
      const b = html.lastIndexOf("</script>");
      const js = html.slice(a + 8, b);
      const tmp = join(tmpdir(), `hispren-${file}.js`);
      require("fs").writeFileSync(tmp, js);
      expect(() => execSync(`node --check ${tmp}`, { stdio: "pipe" })).not.toThrow();
    });
  }
});
