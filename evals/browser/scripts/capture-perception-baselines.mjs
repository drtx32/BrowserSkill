import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { capturePerceptionBaselines } from "../lib/perception-baseline-runner.mjs";

const output = resolve(process.argv[2] ?? "evals/browser/fixtures/perception-live.json");
const report = await capturePerceptionBaselines({ bskCommand: process.env.BSK_COMMAND ?? "bsk" });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote ${output}`);
