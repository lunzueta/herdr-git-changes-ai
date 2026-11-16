// Tests the AI half on its own: which command actually gets spawned for an agent CLI, how much
// of the diff fits the one argument the CLI gets, and that a CLI which prints nothing says so
// instead of passing for a model with nothing to say. Nothing here needs Herdr.
// Run: node tests/ai.test.mjs
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url)), modDir = join(here, "../mods/git-changes-ai");
const lib = mkdtempSync(join(tmpdir(), "herdr-git-changes-ai-ai-"));
writeFileSync(join(lib, "ai.js"), readFileSync(join(modDir, "ai.js"), "utf8").replace(/from "herdr"/g, 'from "./_stub.js"'));
writeFileSync(join(lib, "_stub.js"), `
const H = globalThis.__ai;
export const exec = (cmd, args, opts) => H.exec(cmd, args, opts);
export const readTextFile = async (p) => H.read?.(p) ?? null;
export const appHome = () => H.home;
export const shared = (k) => H.shared[k];
export const setShared = (k, v) => { H.shared[k] = v; return null; };
export const knownAgents = async () => H.agents;
`);

const H = globalThis.__ai = { calls: [], shared: {}, home: "C:/app", agents: [], exec: async () => ({ code: 0, stdout: "", stderr: "" }) };
const AI = await import(pathToFileURL(join(lib, "ai.js")).href);
const ai = new AI.AiCommit();

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.log(`FAIL ${name}\n     ${String(e.stack ?? e).split("\n").slice(0, 3).join("\n     ")}`); process.exitCode = 1; }
};

const agent = { provider: "agent", agent: "pi" };
const call = (stdout, extra = {}) => async (cmd, args) => { H.calls.push([cmd, args]); return { code: 0, stdout, stderr: "", ...extra }; };

await test("a bare name that does not spawn falls back to the .cmd shim, with the prompt on one line", async () => {
  // What Windows does: the extensionless file is a shell script, and the spawn error says nothing
  // about "program not found", so the old test for that phrase never reached the shim.
  H.calls = [];
  H.exec = async (cmd, args) => {
    H.calls.push([cmd, args]);
    if (cmd === "pi") throw new Error("failed to spawn pi: No such file or directory (os error 2)");
    if (cmd === "pi.cmd") return { code: 0, stdout: "feat(app): export sum\n", stderr: "" };
    throw new Error(`unexpected ${cmd}`);
  };
  const r = await ai.runCli("pi", ["-p", "line one\nline two"], {});
  assert.equal(r.stdout, "feat(app): export sum\n");
  assert.deepEqual(H.calls.map(([c]) => c), ["pi", "pi.cmd"]);
  assert.equal(H.calls[1][1][1], "line one⏎line two", "a batch file gets no line breaks");
});

await test("a command with an extension is not suffixed again, and its own error is the one reported", async () => {
  H.calls = [];
  H.exec = async (cmd, args) => { H.calls.push([cmd, args]); throw new Error(`cannot run ${cmd}`); };
  await assert.rejects(() => ai.runCli("my-agent.exe", ["-p"], {}), /cannot run my-agent\.exe/);
  assert.deepEqual(H.calls.map(([c]) => c), ["my-agent.exe"]);
});

await test("a bare name that runs is not retried", async () => {
  H.calls = [];
  H.exec = call("chore(x): y\n");
  await ai.runCli("claude", ["-p", "a\nb"], {});
  assert.deepEqual(H.calls.map(([c]) => c), ["claude"]);
});

await test("a CLI that prints nothing throws instead of counting as an empty answer", async () => {
  H.exec = call("   \n");
  await assert.rejects(() => ai.callModel(agent, "sys", "user"), /pi printed nothing/);
  H.exec = call("");
  await assert.rejects(() => ai.callModel(agent, "sys", "user"), /printed nothing/);
});

await test("what the CLI did print is in the error when it fails", async () => {
  H.exec = async () => ({ code: 1, stdout: "partial answer", stderr: "no model selected" });
  await assert.rejects(() => ai.callModel(agent, "sys", "user"), /no model selected/);
});

await test("the whole prompt, not just the diff, fits the one argument an agent gets", async () => {
  H.calls = [];
  H.exec = call("feat(harness): sync the knowledge files\n\n- one\n");
  const big = "diff --git a/x b/x\n" + "+line\n".repeat(4000);
  const r = await ai.askFull(agent, big, null, "x.py (+1 −0)");
  assert.equal(r.truncated, true, "the diff was cut");
  assert.equal(r.subject, "feat(harness): sync the knowledge files");
  const prompt = H.calls.at(-1)[1].at(-1);
  assert.ok(prompt.length <= AI.AGENT_PROMPT_LIMIT, `prompt is ${prompt.length}, limit ${AI.AGENT_PROMPT_LIMIT}`);
});

await test("a small diff is sent whole", async () => {
  H.calls = [];
  H.exec = call("fix(x): y\n");
  const r = await ai.askFull(agent, "diff --git a/x b/x\n+one\n", null, "");
  assert.equal(r.truncated, false);
  assert.ok(H.calls.at(-1)[1].at(-1).includes("+one"));
});

await test("a fenced answer still gives a subject and its body", async () => {
  H.exec = call("```\nfeat(app): export sum and set b to 3\n\nChange b from 2 to 3.\n```\n");
  const r = await ai.askFull(agent, "diff --git a/x b/x\n+one\n", null, "");
  assert.equal(r.subject, "feat(app): export sum and set b to 3");
  assert.match(r.body, /Change b from 2 to 3/);
});

rmSync(lib, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode ? ", some failed" : ""}`);
