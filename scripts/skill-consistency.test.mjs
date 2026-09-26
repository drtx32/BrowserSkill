import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const rootSkill = new URL("../skill/SKILL.md", import.meta.url);
const bundledSkill = new URL("../crates/bsk-cli/skill/SKILL.md", import.meta.url);

async function filesUnder(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(new URL(prefix, directory), { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(directory, name)));
    else files.push(name);
  }
  return files;
}

test("the CLI bundle is generated from the canonical repository Skill", async () => {
  const rootDir = new URL("../skill/", import.meta.url);
  const bundledDir = new URL("../crates/bsk-cli/skill/", import.meta.url);
  const [rootFiles, bundledFiles] = await Promise.all([
    filesUnder(rootDir),
    filesUnder(bundledDir),
  ]);
  assert.deepEqual(bundledFiles.sort(), rootFiles.sort(), "bundle file set must match source");
  for (const name of rootFiles) {
    assert.equal(
      await readFile(new URL(name, rootDir), "utf8"),
      await readFile(new URL(name, bundledDir), "utf8"),
      `crate-bundled Skill must match skill/${name}`,
    );
  }
});

test("canonical BrowserSkill guidance preserves lifecycle and progressive contract", async () => {
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
    "full `observe` last resort",
    "persistent Wiki is a read-only projection",
    "canonical projection entry point",
    "materializes the authoritative projection by default",
    "typed `fields` and `revision`",
    "Duplicate\ncanonical addresses are ambiguous and fail closed",
    "`canonical_diagnostic` is diagnostic evidence only",
  ]) {
    assert.ok(root.includes(required), `Skill is missing lifecycle guidance: ${required}`);
  }
  assert.doesNotMatch(root, /Start tasks with `bsk session start`\./);
});
