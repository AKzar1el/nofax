import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, root), "utf8"));
}

test("MCP Registry metadata matches the published package contract", async () => {
  const packageJson = await readJson("package.json");
  const serverJson = await readJson("server.json");
  const [registryPackage] = serverJson.packages;

  assert.equal(packageJson.name, "nofax");
  assert.equal(packageJson.mcpName, serverJson.name);
  assert.equal(packageJson.version, serverJson.version);
  assert.equal(registryPackage.registryType, "npm");
  assert.equal(registryPackage.identifier, packageJson.name);
  assert.equal(registryPackage.version, packageJson.version);
  assert.deepEqual(registryPackage.transport, { type: "stdio" });
  assert.deepEqual(registryPackage.packageArguments, [
    { type: "positional", value: "mcp" },
  ]);
});
