// The AI half of the commit message: the agent or API that writes it, the model list, and
// the subject/body that come back. This fork's own code, MIT with the rest.
import { exec, readTextFile, appHome, shared, setShared, knownAgents } from "herdr";

export const NL = String.fromCharCode(10);

export const AGENT_CLI = {
  claude: {
    name: "Claude Code",
    print: (p, m) => [...(m ? ["--model", m] : []), "-p", "--output-format", "json", p],
    // JSON mode keeps the answer in "result"; the thinking and the plan are not in it.
    parse: (out) => {
      try {
        const data = JSON.parse(out);
        if (data.is_error) throw new Error(String(data.result ?? data.subtype ?? "claude reported an error"));
        return String(data.result ?? "");
      } catch (e) { if (e instanceof SyntaxError) return out; throw e; }
    },
  },
  pi: { name: "Pi", print: (p, m) => ["-p", "--no-session", "--no-tools", "--no-context-files", ...(m ? ["--model", m] : []), p], list: ["--list-models"] },
  codex: { name: "Codex", print: (p, m) => ["exec", "--skip-git-repo-check", "--sandbox", "read-only", ...(m ? ["--model", m] : []), p] },
  gemini: { name: "Gemini", print: (p, m) => [...(m ? ["-m", m] : []), p] },
  copilot: { name: "Copilot", print: (p, m) => [...(m ? ["--model", m] : []), "-p", p] },
};

export const AGENT_PROMPT_LIMIT = 7600;

export const tail = (text) => String(text).trim().split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 240);

export const SUBJECT_SHAPE = /^[a-z][a-z0-9-]*(\([^)]{0,40}\))?!?: \S/;

export const SUBJECT = /^(feat|fix|chore|docs|refactor|test|build|ci|perf|style|revert)(\([^)]{0,40}\))?!?:\s+\S/;

export function byWeight(diff) {
  const parts = String(diff).split(/^(?=diff --git )/m);
  if (parts.length < 2) return diff;
  const weight = (part) => (part.match(/^[+-][^+-]/gm) || []).length;
  return parts.map((part, i) => [weight(part), i, part]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map(([, , part]) => part).join("");
}

export function wrap72(line) {
  const indent = /^- /.test(line) ? "  " : "";
  const out = [];
  let cur = "";
  for (const word of line.split(/\s+/)) {
    const next = cur ? cur + " " + word : word;
    if (next.length > 72 && cur) { out.push(cur); cur = indent + word; }
    else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

export function pickBody(raw, subject) {
  const lines = String(raw).split(NL).map((l) => l.trim());
  const norm = (l) => l.replace(/^[-*`"'\s]+|[-*`"'\s]+$/g, "").replace(/^(commit )?subject\s*:\s*/i, "").replace(/\.$/, "").trim();
  let at = -1;
  lines.forEach((l, i) => { if (norm(l) === subject) at = i; });
  if (at < 0) return "";
  // A bullet the model wrapped continues on the next line: join those first, then count bullets, not lines.
  const items = [];
  for (const l of lines.slice(at + 1)) {
    if (!l || /^```/.test(l) || /^[-*]?\s*(body|footer|subject)\s*:/i.test(l)) continue;
    if (/^[-*]\s/.test(l) || !items.length) items.push(l);
    else items[items.length - 1] += " " + l;
  }
  return items.slice(0, 6).flatMap((l) => wrap72(l)).join(NL).trim();
}

export function pickSubject(raw) {
  const lines = String(raw).split(NL).map((l) => l.trim().replace(/^[-*`"'\s]+|[-*`"'\s]+$/g, "")).filter(Boolean)
    .map((l) => l.replace(/^(commit )?subject\s*:\s*/i, ""));
  const typed = lines.filter((l) => SUBJECT.test(l));
  const line = typed.length ? typed[typed.length - 1] : (lines.filter((l) => l.length <= 100).pop() ?? lines.pop() ?? "");
  return line.replace(/\.$/, "").trim();
}

export function keepByFilter(filter, name) {
  if (!filter) return true;
  const f = String(filter), n = String(name);
  if (!f.includes("*")) return n === f;
  const [a, b] = f.split("*");
  return n.length >= a.length + b.length && n.startsWith(a) && n.endsWith(b);
}

export class AiCommit {
  constructor() { this.providers = []; this.selected = null; this.catalog = {}; this.auto = false; this.modelName = null; }

  async readAiConfig() {
    const text = await readTextFile(`${appHome()}/settings.json`).catch(() => null);
    let ai = null;
    if (text) { try { ai = JSON.parse(text).ai; } catch { return null; } }
    let auto = false;
    let providers = !ai ? [] : Array.isArray(ai.providers)
      ? ai.providers
      : (Array.isArray(ai.models) ? ai.models : [ai]).filter((m) => m && m.model).map((m) => ({ ...m, model: m.model }));
    providers = providers.filter((p) => p && p.provider).map((p) => {
      // "pi" was a provider of its own before agents were a thing.
      const agent = p.agent ?? (p.provider === "pi" ? "pi" : null);
      const kind = p.provider === "pi" ? "agent" : p.provider;
      return { ...p, provider: kind, ...(agent ? { agent } : {}), name: p.name ?? p.label ?? AGENT_CLI[agent]?.name ?? p.provider };
    });
    if (!providers.length) {
      // Nothing configured: offer the agents already installed and logged in. No key, no file, nothing to write.
      const installed = await knownAgents({}).catch(() => []);
      providers = installed.filter((a) => a.installed && AGENT_CLI[a.key]).map((a) => ({ name: a.name, provider: "agent", agent: a.key, auto: true }));
      if (!providers.length) return null;
      auto = true; ai = { providers };
    }
    // The choice from the menu (shared state) wins over settings.json's default.
    let selected = null;
    try {
      const stored = JSON.parse(shared("ai-commit.selected") ?? "null");
      if (stored && providers.some((p) => p.name === stored.provider)) selected = { provider: stored.provider, model: stored.model ?? null };
    } catch {}
    const d = ai?.default;
    if (!selected && d && typeof d === "object" && providers.some((p) => p.name === d.provider)) selected = { provider: d.provider, model: d.model ?? null };
    if (!selected && typeof d === "string" && providers.some((p) => p.name === d)) selected = { provider: d, model: providers.find((p) => p.name === d).model ?? null };
    if (!selected) selected = { provider: providers[0].name, model: providers[0].model ?? null };
    return { providers, selected, auto };
  }

  async apiKey(ai) {
    if (ai.api_key) return ai.api_key;
    if (!ai.api_key_env) return "";
    const name = String(ai.api_key_env);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid api_key_env name: ${name}`);
    const unix = await exec("printenv", [name]).catch(() => null);
    if (unix?.code === 0 && unix.stdout.trim()) return unix.stdout.trim();
    const win = await exec("powershell", ["-NoProfile", "-Command", `$v=[Environment]::GetEnvironmentVariable('${name}','User'); if(-not $v){$v=[Environment]::GetEnvironmentVariable('${name}','Machine')}; if(-not $v){$v=$env:${name}}; Write-Output $v`]).catch(() => null);
    if (win?.code === 0 && win.stdout.trim()) return win.stdout.trim();
    throw new Error(`environment variable ${name} is not set`);
  }

  async askFull(ai, diff, retryHint, summary) {
    const system = "You write git commit messages: a subject line, a blank line, then a short body. No quotes, no markdown fences, nothing before or after the message. If you think first, the message is the last thing in your reply.";
    const head = [
      "Write a git commit message for these changes.",
      summary ? "Files changed:" + NL + summary : "",
      "Subject: type(scope): subject",
      "- type: fix for corrections, feat only for new behavior, refactor, test, docs, chore as appropriate.",
      "- the subject describes the whole change, every file in the list, not one of them: a mixed change gets one broad subject that covers it (e.g. \"refactor(ai-commit): rework agent subjects, menu and license\").",
      "- prefer a broad subject that fits the 50 characters over a narrow one that leaves parts out.",
      "- imperative mood, lowercase subject, no trailing period, at most 50 characters in total.",
      "Body: after one blank line, 2 to 4 short bullet lines starting with \"- \", each under 72 characters, saying what changed and why. Name the main files. Do not repeat the subject.",
      "- describe the change, not its results or metrics.",
      retryHint ? "- " + retryHint : "",
    ].filter(Boolean).join(NL);
    // An agent CLI may print its plan before the answer: pick the line that is a subject, and the body under it.
    const raw = await this.callModel(ai, system, head + NL + NL + diff);
    const subject = pickSubject(raw);
    return { subject, body: subject ? pickBody(raw, subject) : "" };
  }

  async runCli(command, args, options) {
    try { return await exec(command, args, options); }
    catch (e) {
      if (!/program not found/i.test(String(e))) throw e;
      const flat = args.map((a) => (typeof a === "string" && a.includes(NL) ? a.split(NL).join("⏎") : a));
      try { return await exec(`${command}.cmd`, flat, options); } catch { throw e; }
    }
  }

  async callModel(ai, system, user) {
    if (ai.provider === "agent") {
      // An agent CLI that is already logged in, in its non-interactive mode: no key, no session, no tools.
      // The prompt is one argument, so it must fit a command line (generateMessage trims the diff).
      const prompt = `${system}\n\n${user}`;
      const spec = ai.command ? null : AGENT_CLI[ai.agent];
      if (!ai.command && !spec) throw new Error(`unknown agent "${ai.agent}": known are ${Object.keys(AGENT_CLI).join(", ")}; set "command" for anything else`);
      const command = ai.command ? String(ai.command[0]) : ai.agent;
      const args = ai.command ? [...ai.command.slice(1).map(String), prompt] : spec.print(prompt, ai.model || "");
      const r = await this.runCli(command, args, { timeout: 240000 });
      if (r.code !== 0) throw new Error(tail(r.stderr || r.stdout) || `${command} exited with code ${r.code}`);
      return spec?.parse ? spec.parse(r.stdout) : r.stdout;
    }
    const messages = [{ role: "system", content: system }, { role: "user", content: user }];
    if (ai.provider === "anthropic") {
      const key = await this.apiKey(ai);
      if (!key) throw new Error('no Anthropic API key: set "api_key" or "api_key_env" for this model in settings.json');
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": key },
        body: JSON.stringify({ model: ai.model, max_tokens: 512, system, messages: [{ role: "user", content: user }] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
      if (!text.trim()) throw new Error(`no text in reply (stop_reason=${data.stop_reason})`);
      return text;
    }
    if (ai.provider === "openai") {
      const key = await this.apiKey(ai);
      const base = String(ai.base_url || "https://api.openai.com/v1").replace(/\/$/, "");
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: ai.model, messages, max_tokens: 512 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content ?? "";
    }
    // Default: Ollama. A local server needs no key; ollama.com (cloud) needs one.
    const base = String(ai.base_url || "http://127.0.0.1:11434").replace(/\/$/, "");
    const key = await this.apiKey(ai);
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: ai.model, messages, stream: false }),
    });
    if (res.status === 401 && !key) throw new Error(`${ai.model} runs in the Ollama cloud and needs an API key: set the OLLAMA_API_KEY variable (ollama.com) or pick a model installed locally`);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return data.message?.content ?? "";
  }

  async fetchModels(p) {
    if (p.model) return [p.model];
    if (p.provider === "agent") {
      // An agent asks its own CLI for its models when it has such a command; otherwise it has one entry,
      // the model it is already set up with (null: pass no --model at all).
      const spec = p.command ? null : AGENT_CLI[p.agent];
      if (!p.command && !spec) throw new Error(`unknown agent "${p.agent}": known are ${Object.keys(AGENT_CLI).join(", ")}; set "command" for anything else`);
      if (!spec?.list) return [null];
      const r = await this.runCli(p.agent, spec.list, { timeout: 60000 });
      if (r.code !== 0) throw new Error(tail(r.stderr || r.stdout) || `${p.agent} ${spec.list.join(" ")} failed`);
      // "provider/model", one per row after the header.
      return r.stdout.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((t) => t.length >= 2).map(([prov, model]) => `${prov}/${model}`);
    }
    const base = (u) => String(u).replace(/\/$/, "");
    if (p.provider === "anthropic") {
      const key = await this.apiKey(p);
      if (!key) throw new Error('no API key (set "api_key" or "api_key_env")');
      const res = await fetch("https://api.anthropic.com/v1/models?limit=100", { headers: { "anthropic-version": "2023-06-01", "x-api-key": key } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return ((await res.json()).data ?? []).map((m) => m.id);
    }
    if (p.provider === "openai") {
      const key = await this.apiKey(p);
      const res = await fetch(`${base(p.base_url || "https://api.openai.com/v1")}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return ((await res.json()).data ?? []).map((m) => m.id);
    }
    if (p.provider === "ollama") {
      // The list needs no key; a key (for ollama.com) is sent when one is configured.
      const key = await this.apiKey(p).catch(() => "");
      const res = await fetch(`${base(p.base_url || "http://127.0.0.1:11434")}/api/tags`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Embedding models can't write messages: leave them out. On a local server, models tagged
      // "-cloud" / ":cloud" only run on ollama.com (listed under the cloud provider), so leave them out too.
      const local = !p.base_url || /127\.0\.0\.1|localhost/.test(p.base_url);
      return ((await res.json()).models ?? []).map((m) => m.name)
        .filter((n) => !/embed/i.test(n))
        .filter((n) => !(local && /[:-]cloud$/.test(n)));
    }
    throw new Error(`unknown provider "${p.provider}"`);
  }

  async loadCatalog(cx) {
    const cfg = await this.readAiConfig();
    if (!cfg) return;
    this.providers = cfg.providers; this.selected = cfg.selected;
    this.catalog = this.catalog ?? {};
    // In parallel: one unreachable server must not hold up the others' lists.
    await Promise.all(cfg.providers.map(async (p) => {
      if (this.catalog[p.name]) return;
      try {
        const models = await this.fetchModels(p);
        const kept = models.length === 1 && models[0] === null ? models : models.filter((m) => keepByFilter(p.filter, m));
        this.catalog[p.name] = kept.length || !p.filter ? { models: kept } : { error: `no model matches ${p.filter}` };
      }
      catch (e) { this.catalog[p.name] = { error: String(e).replace(/^Error:\s*/, "").slice(0, 160) }; }
      cx.notify();
    }));
  }

  pickModel(provider, model, cx) {
    setShared("ai-commit.selected", JSON.stringify({ provider, model }));
    this.selected = { provider, model };
    this.modelName = model || provider;
    this.menuOpen = false;
    cx.notify();
  }
}
