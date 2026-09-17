#!/usr/bin/env node
/*
 * 「交给 AI」文案门禁。
 *
 * About 页让管理员复制一段话给外部 AI, 这段话说「去读这些文件」。它只有在三件事
 * 同时成立时才算数:
 *
 *   1. web/src/lib/ai-entry.ts        (文案的唯一事实来源)
 *   2. 磁盘上真的存在这些文件, 且已进入 git —— 否则外部 AI 取到 404
 *   3. 每个场景指向的文档里, 真的写着这个场景该知道的事
 *
 * 第 2 条是这次改动的重点: 文案里的路径写错一个字符, 用户复制出去就是一条死链接,
 * 而管理员不会发现 —— 失败发生在别人的 AI 那里。所以门禁**直接 import 事实来源**,
 * 而不是把这几个路径在脚本里再抄一遍 (抄一遍就是第二份真相, 正是要避免的漂移)。
 *
 *   node scripts/verify-ai-entry.ts
 *
 * 退出 0 = 文案、磁盘与 git 三方一致。退出 1 = 有路径取不到。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 事实来源是 TS, 且刻意不导入任何模块 —— 这里直接加载它, 不解析 @ 别名、不经过 Vite。
// 包在 async main 里是因为本仓库根目录没有 package.json, tsx 以 CJS 输出运行,
// 那一层不支持顶层 await。
async function main() {
const source = await import(resolve(root, "web/src/lib/ai-entry.ts"));
const { AI_ENTRY_SCENARIOS, AI_ENTRY_PATHS, aiEntryRawURL, buildAiEntryPrompt } = source;

let failures = 0;
function report(label, problems) {
  if (problems.length === 0) {
    console.log("ok   " + label);
    return;
  }
  failures += problems.length;
  console.log("FAIL " + label);
  for (const problem of problems) console.log("       " + problem);
}

// --- 1. 每个被引用的路径都要能在磁盘上读到, 并且是个文件 -------------
// 空文件也算失败: 一条指向空文档的链接和死链接一样没用。
const missing = [];
const empty = [];
for (const path of AI_ENTRY_PATHS) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    missing.push(path);
    continue;
  }
  if (readFileSync(absolute, "utf8").trim().length === 0) empty.push(path);
}
report("referenced docs exist on disk", [
  ...missing.map((path) => path + " does not exist; the copied prompt would 404"),
  ...empty.map((path) => path + " is empty"),
]);

// --- 2. 这些路径必须已进入 git ----------------------------------------
// 本机能读到不等于外部 AI 能读到。未 track 的文件在 GitHub 上不存在,
// 而用户复制的正是 GitHub 地址 (hx-proxy-admin 就曾长期处于未 track 状态)。
const untracked = [];
for (const path of AI_ENTRY_PATHS) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", path], { cwd: root, stdio: "pipe" });
  } catch {
    untracked.push(path);
  }
}
report("referenced docs are committed", untracked.map((path) =>
  path + " is not tracked by git; a raw URL for it returns 404"));

// --- 3. unreleased 标记必须与 git 的事实一致 ---------------------------
// 文案把已发布版本的程序钉在它自己的 tag 上。一个文件如果**不在**那个 tag 里,
// 钉上去就是死链; 反过来, 文件已经随 Release 发出却还标着 unreleased,
// 就等于让用户永远读 main —— 两者都是「口径不一」, 只是方向相反。
// 所以这里不信任注释, 直接问 git: 文件在最新的 Release tag 里吗?
let newestTag = "";
try {
  newestTag = execFileSync("git", ["tag", "--sort=-v:refname"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^v\d/.test(line))[0] ?? "";
} catch {
  newestTag = "";
}

const releasedProblems = [];
if (!newestTag) {
  console.log("skip released-tag check (no release tag in this clone)");
} else {
  for (const scenario of AI_ENTRY_SCENARIOS) {
    for (const doc of scenario.docs) {
      let inTag = false;
      try {
        inTag = execFileSync("git", ["ls-tree", "-r", "--name-only", newestTag, "--", doc.path], {
          cwd: root,
          encoding: "utf8",
        }).trim().length > 0;
      } catch {
        inTag = false;
      }
      if (!inTag && !doc.unreleased) {
        releasedProblems.push(
          doc.path + " is absent from " + newestTag + ", so a version-pinned URL 404s; mark it unreleased: true",
        );
      }
      if (inTag && doc.unreleased) {
        releasedProblems.push(
          doc.path + " already ships in " + newestTag + "; drop unreleased: true so the URL pins to the version",
        );
      }
    }
  }
}
report("unreleased flags match " + (newestTag || "no") + " release contents", releasedProblems);

// --- 4. 场景注册表本身要自洽 ------------------------------------------
const duplicateIDs = AI_ENTRY_SCENARIOS.map((s) => s.id).filter((id, index, all) => all.indexOf(id) !== index);
const malformed = AI_ENTRY_SCENARIOS.flatMap((scenario) => {
  const problems = [];
  if (!scenario.id || !scenario.label || !scenario.intent) problems.push("scenario " + scenario.id + " is missing id/label/intent");
  if (!scenario.docs || scenario.docs.length === 0) problems.push("scenario " + scenario.id + " references no doc");
  return problems;
});
report("scenario registry is coherent", [...duplicateIDs.map((id) => "duplicate scenario id " + id), ...malformed]);

// --- 5. 生成的文案必须真的带上每个场景的地址 --------------------------
// 文案是拼出来的; 拼错一个分隔符就会得到一条断链, 而单元测试看不见。
const options = { version: "v0.12.0", repositoryUrl: "https://github.com/HengXin666/HX-ProxyGroup", sourceRoot: "/srv/checkout" };
const promptProblems = [];
for (const scenario of AI_ENTRY_SCENARIOS) {
  const text = buildAiEntryPrompt({ ...options, scenario });
  if (!text.includes(scenario.label)) promptProblems.push("prompt omits the label for " + scenario.id);
  for (const doc of scenario.docs) {
    // 未发布的文件必须走 main —— 这正是钉版本号时最容易写错的一处。
    const expectedRef = doc.unreleased ? "main" : "v0.12.0";
    const url = aiEntryRawURL(options.repositoryUrl, expectedRef, doc.path);
    if (!text.includes(url)) promptProblems.push("prompt omits " + url);
    if (doc.unreleased && text.includes(aiEntryRawURL(options.repositoryUrl, "v0.12.0", doc.path))) {
      promptProblems.push(doc.path + " is unreleased but the prompt pins it to v0.12.0");
    }
    if (!text.includes(options.sourceRoot + "/" + doc.path)) promptProblems.push("prompt omits the local path for " + doc.path);
  }
}
// 发布版本必须被钉住; 否则文案会指向 main 上尚未发布的接口面。
if (!buildAiEntryPrompt({ ...options, scenario: AI_ENTRY_SCENARIOS[0] }).includes("/raw/v0.12.0/")) {
  promptProblems.push("a release version must pin the docs to that tag, not to main");
}
report("generated prompt carries every scenario", promptProblems);

if (failures > 0) {
  console.log("");
  console.log("The AI entry prompt drifted. Fix the lagging side and re-run.");
  process.exit(1);
}
console.log("");
console.log("ai entry: prompt, disk and git agree for " + AI_ENTRY_PATHS.length + " document(s) across " + AI_ENTRY_SCENARIOS.length + " scenario(s)");
}

main().catch((error) => {
  console.error("verify-ai-entry: " + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
