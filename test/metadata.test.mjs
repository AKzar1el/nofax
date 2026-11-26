import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DEFAULT_TIMEOUT_SECONDS } from "../src/config.mjs";

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
  assert.equal(serverJson.websiteUrl, "https://tomiseregi.si/projects/nofax");
  assert.equal(packageJson.version, serverJson.version);
  assert.equal(registryPackage.registryType, "npm");
  assert.equal(registryPackage.identifier, packageJson.name);
  assert.equal(registryPackage.version, packageJson.version);
  assert.deepEqual(registryPackage.transport, { type: "stdio" });
  assert.deepEqual(registryPackage.packageArguments, [
    { type: "positional", value: "mcp" },
  ]);
});

test("published package includes the local documentation linked from README", async () => {
  const packageJson = await readJson("package.json");
  const packagedFiles = new Set(packageJson.files);

  for (const path of [
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "docs/architecture.md",
    "docs/remote-mcp.md",
  ]) {
    assert.equal(packagedFiles.has(path), true, `${path} must ship with the npm package`);
  }
});

test("Gemini BeforeTool example allows the full human-decision window", async () => {
  const readme = await readFile(new URL("README.md", root), "utf8");
  const geminiSection = readme.split("### Gemini CLI")[1]?.split("### Pi")[0];
  assert.ok(geminiSection, "Gemini integration example must exist");
  const json = /```json\s*([\s\S]*?)```/.exec(geminiSection)?.[1];
  assert.ok(json, "Gemini hook settings must be valid JSON");
  const settings = JSON.parse(json);
  const hookTimeout = settings.hooks.BeforeTool[0].hooks[0].timeout;
  // Publishing and best-effort confirmation run outside the configured wait.
  const requiredMs = DEFAULT_TIMEOUT_SECONDS * 1000 + 15_000 + 5_000 + 10_000;
  assert.ok(hookTimeout >= requiredMs,
    `Gemini hook must allow at least ${requiredMs} ms, got ${hookTimeout}`);
});
