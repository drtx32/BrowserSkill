import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DSH_BROWSER_TOOLS,
  validateSkillDirectory,
} from "../packages/dsh-plugin-browserskill/scripts/validate-skill.mjs";

const root = new URL("../", import.meta.url);
const canonical = fileURLToPath(new URL("skill", root));
const bundled = fileURLToPath(new URL("crates/bsk-cli/skill", root));
assert.equal(
  readFileSync(`${canonical}/SKILL.md`, "utf8"),
  readFileSync(`${bundled}/SKILL.md`, "utf8"),
  "crate-bundled Skill must be generated from canonical skill/SKILL.md",
);
for (const [path, maxEntryBytes, browserTools] of [
  ["skill", 7_000],
  ["crates/bsk-cli/skill", 7_000],
  ["packages/dsh-plugin-browserskill/skill", 4_500, DSH_BROWSER_TOOLS],
]) {
  const { files } = validateSkillDirectory(fileURLToPath(new URL(path, root)), {
    maxEntryBytes,
    browserTools,
  });
  console.log(
    `${path}: valid (${files.size} files, ${Buffer.byteLength(files.get("SKILL.md"))} entry bytes)`,
  );
}
