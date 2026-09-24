import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rootSkill = new URL("../crates/bsk-cli/skill/SKILL.md", import.meta.url);
const bundledSkill = new URL("../crates/bsk-cli/skill/SKILL.md", import.meta.url);

test("bundled BrowserSkill guidance matches the repository source and lifecycle contract", async () => {
  const [root, bundled] = await Promise.all([
    readFile(rootSkill, "utf8"),
    readFile(bundledSkill, "utf8"),
  ]);
  assert.equal(bundled, root, "crate-bundled Skill must match the repository Skill");
  for (const required of [
    "Use `bsk bootstrap` at task startup",
    "stable logical `default` session",
    "timeouts only end controller execution or its lease",
    "must not close the browser, tabs, pages, Agent Window, or unsaved content",
    "Reconnect/rebind",
  ]) {
    assert.ok(root.includes(required), `Skill is missing lifecycle guidance: ${required}`);
  }
  assert.doesNotMatch(root, /Start tasks with `bsk session start`\./);
});
