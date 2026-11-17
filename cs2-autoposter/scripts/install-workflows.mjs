import { mkdir, copyFile, constants } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
if (!process.argv.includes("--install")) {
  console.log(
    "Explicit opt-in: node scripts/install-workflows.mjs --install\nCreates two new files in the repository root .github/workflows. Existing files are never overwritten.",
  );
  process.exit(0);
}
const root = fileURLToPath(
  new URL("../../.github/workflows/", import.meta.url),
);
await mkdir(root, { recursive: true });
for (const name of ["ci", "deploy"])
  await copyFile(
    fileURLToPath(new URL(`../.github/workflows/${name}.yml`, import.meta.url)),
    path.join(root, `cs2-autoposter-${name}.yml`),
    constants.COPYFILE_EXCL,
  );
console.log("Installed workflow files. Commit them separately.");
