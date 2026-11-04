// 次の回まで：Cloudflare に置く台本（Mac でも Windows でも）
// 使い方：このフォルダで  node oku.mjs
// はじめても、新しい版に置き直すときも、同じこれ一つ。
// 同じ「アプリの名前」で実行すれば、記録の入れ物と合言葉をそのまま引き継ぐ。

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
process.chdir(here);

const bold = s => `\x1b[1m${s}\x1b[0m`;
const say = s => console.log("\n" + bold(s));
const stop = (msg, out) => {
  if (out) console.log(out);
  console.log("\n" + msg + "\nうまくいかないときは、この画面の表示をそのままClaudeに見せてください。");
  process.exit(1);
};

// コマンドを動かす。quiet なら表示を受け取って返す
function run(cmd, { quiet = true, input } = {}) {
  const r = spawnSync(cmd, { shell: true, encoding: "utf8", input, stdio: quiet ? ["pipe", "pipe", "pipe"] : "inherit" });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}
const wr = (args, opts) => run(`npx wrangler ${args}`, opts);
const firstJSON = text => { const i = text.search(/[\[{]/); if (i < 0) return null; try { return JSON.parse(text.slice(i)); } catch { return null; } };

function writeToml(name, dbId, kvId) {
  const course = (settei.courseName || "講座").replace(/"/g, "");
  let t = `name = "${name}"\nmain = "src/index.js"\ncompatibility_date = "2026-10-01"\nworkers_dev = true\n\n[assets]\ndirectory = "./public"\n\n[vars]\nCOURSE_NAME = "${course}"\n`;
  if (dbId) t += `\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${name}"\ndatabase_id = "${dbId}"\n`;
  if (kvId) t += `\n[[kv_namespaces]]\nbinding = "AUDIO"\nid = "${kvId}"\n`;
  writeFileSync("wrangler.toml", t);
}

// ---------- アプリの名前 ----------
const SETTEI = join(here, "settei.json");
let settei = existsSync(SETTEI) ? JSON.parse(readFileSync(SETTEI, "utf8")) : {};
const rl = createInterface({ input: process.stdin, output: process.stdout });
// 一行ずつ受け取る（貼り付けやまとめての入力でも取りこぼさない）
const lines = [], waiters = [];
rl.on("line", l => waiters.length ? waiters.shift()(l) : lines.push(l));
rl.on("close", () => { while (waiters.length) waiters.shift()(""); });
const ask = q => { process.stdout.write(q); return lines.length ? Promise.resolve(lines.shift()) : new Promise(r => waiters.push(r)); };
const argName = process.argv[2];
let name = argName || settei.name;
if (!name) {
  console.log(bold("次の回まで を置きます"));
  console.log("アプリの名前を決めます。アドレスの一部になります（例：https://名前.〇〇.workers.dev）。");
  console.log("英小文字・数字・ハイフンで3〜40字。講座を二つ以上置くときは、講座ごとに別の名前にします。");
  for (;;) {
    name = ((await ask("アプリの名前（何も打たずにEnterで tsugi-no-kai）：")).trim() || "tsugi-no-kai").toLowerCase();
    if (/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(name)) break;
    console.log("英小文字・数字・ハイフンで3〜40字にしてください（はじめと終わりはハイフン以外）。");
  }
  const c = (await ask("講座の名前（あとからアプリの設定でも変えられます）：")).trim();
  settei = { name, courseName: c || "講座" };
}
rl.close();
settei.name = name;
writeFileSync(SETTEI, JSON.stringify(settei, null, 2) + "\n");
console.log(`\nアプリの名前：${name}`);

// ---------- 1. 道具 ----------
say("1/4 道具を入れています（はじめは数分かかります）");
if (!run("npm install --no-audit --no-fund").ok) stop("道具が入れられませんでした。インターネットにつながっているか確かめてください。");

// ---------- 2. Cloudflare に入る ----------
say("2/4 Cloudflare に入っているか確かめています");
writeToml(name); // 入れ物を作る前は、名前だけの設定にしておく
if (/not authenticated|wrangler login/i.test(wr("whoami").out)) {
  console.log("ブラウザが開きます。Cloudflare に入り、「Allow（許可）」を押してください。");
  wr("login", { quiet: false });
  if (/not authenticated|wrangler login/i.test(wr("whoami").out)) stop("Cloudflare に入れませんでした。もう一度 node oku.mjs を実行してください。");
}
console.log("入っています");

// ---------- 3. 記録の入れ物 ----------
say("3/4 記録の入れ物と、音声の置き場所を用意しています");
const findDb = () => { const a = firstJSON(wr("d1 list --json").out); return Array.isArray(a) ? (a.find(d => d.name === name) || {}).uuid : null; };
let dbId = findDb();
if (!dbId) {
  const r = wr(`d1 create ${name}`);
  dbId = (r.out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) || [])[0] || findDb();
  if (!dbId) stop("データベースが作れませんでした。", r.out);
}
const kvTitle = `${name}-audio`;
const findKv = () => { const a = firstJSON(wr("kv namespace list").out); return Array.isArray(a) ? (a.find(n => n.title === kvTitle || n.title === `${name}-${kvTitle}`) || {}).id : null; };
let kvId = findKv();
if (!kvId) {
  const r = wr(`kv namespace create ${kvTitle}`);
  kvId = (r.out.match(/\b[0-9a-f]{32}\b/) || [])[0] || findKv();
  if (!kvId) stop("音声の置き場所が作れませんでした。", r.out);
}
console.log(dbId && kvId ? "できました" : "");
writeToml(name, dbId, kvId);

// ---------- 5. 置く ----------
say("4/4 置いています");
const dep = wr("deploy");
if (!dep.ok) stop("置けませんでした。", dep.out);
const url = (dep.out.match(/https:\/\/[a-zA-Z0-9.-]+\.workers\.dev/) || [])[0];

console.log("\n========================================");
console.log(" 置けました");
console.log(` アドレス：${url || "（上の表示の https://〜.workers.dev）"}`);
console.log("");
console.log(" はじめて置いたときは、すぐにこのアドレスを開いて");
console.log(" 「はじめの設定」を済ませてください（講師の合言葉を決めます）。");
console.log(" 置き直したときは、記録も合言葉もそのままです。");
console.log("========================================\n");
