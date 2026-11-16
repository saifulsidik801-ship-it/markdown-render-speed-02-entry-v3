// Driver for the markdown-render-speed-02 harness.
// Reads every case from $MAKEFUN_INPUT_DIR/cases.json (default /input),
// renders each with parse() from ./parse.js, and writes the HTML array to
// $MAKEFUN_OUTPUT_DIR/html.json (default /output). Deterministic: the same
// input always produces the same output, byte for byte.
import { parse } from "./parse.js";
import * as fs from "node:fs";
import * as path from "node:path";

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const raw = fs.readFileSync(path.join(inputDir, "cases.json"), "utf8");
const cases = JSON.parse(raw);
if (!Array.isArray(cases)) throw new Error("cases.json is not an array");
const results: string[] = [];
for (const c of cases) {
  results.push(parse(c.markdown));
}
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "html.json"), JSON.stringify(results));
