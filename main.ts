// main.ts — harness entry for the make.fun csv-reader-speed bounty.
// The harness runs `node /bot/main.ts` (Node 22). It feeds one case as a
// JSON object { text, header } on stdin; the answer { columns, rows,
// errors } is written as JSON on stdout. All real work lives in solve.js.
import { readFileSync } from "node:fs";
import { run } from "./solve.js";

const input = JSON.parse(readFileSync(0, "utf8")) as {
  text: string;
  header: boolean;
};
const out = run(input);
process.stdout.write(JSON.stringify(out));
