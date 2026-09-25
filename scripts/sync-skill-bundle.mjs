// Keep the checked-in CLI bundle reproducible from the repository Skill source.
// References are copied too: the crate installer ships the complete directory.
import { cpSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
cpSync(`${root}skill`, `${root}crates/bsk-cli/skill`, { recursive: true });
console.log("synced skill/ -> crates/bsk-cli/skill/");
