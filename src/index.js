// 次の回まで：講習のあとの復習アプリ（Cloudflare Workers）
// 画面は public/ 。ここは記録の読み書きと合言葉の確認だけを受け持つ。

const DAY = 86400000;
const AUDIO_MAX = 8 * 1024 * 1024; // おさらい音声は8MBまで
const KINDS = ["attend", "review", "listen", "correct", "try", "ask"];

const DEFAULT_WORDS = {
  firstTry: "試したことが、いちばんの復習です。",
  tally5: "一つ目の「正」。いい調子です。",
  ready: "準備ととのいました。当日は、持ってきたものから始めましょう。",
  tally10: "二つ目の「正」。ここまで来たら、もう習慣です。",
  idle: "見返すのは1分の音声だけでも大丈夫です。"
};

// 記録の入れ物。はじめて動いたときに自分で作る（置く人が何もしなくてよいように）
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)",
  "CREATE TABLE IF NOT EXISTS lessons (no INTEGER PRIMARY KEY, title TEXT NOT NULL, date TEXT NOT NULL, data TEXT, video TEXT, audio_type TEXT, published INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS members (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, pin_hash TEXT NOT NULL, show_teacher INTEGER NOT NULL DEFAULT 0, asked_share INTEGER NOT NULL DEFAULT 0, fails INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, ver INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, member INTEGER NOT NULL, k TEXT NOT NULL, key TEXT, day TEXT NOT NULL, t INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS events_member ON events(member, t)",
  "CREATE TABLE IF NOT EXISTS tries (id INTEGER PRIMARY KEY AUTOINCREMENT, member INTEGER NOT NULL, lesson INTEGER, text TEXT NOT NULL, public INTEGER NOT NULL DEFAULT 0, t INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS questions (id INTEGER PRIMARY KEY AUTOINCREMENT, member INTEGER NOT NULL, lesson INTEGER, text TEXT NOT NULL, answered INTEGER NOT NULL DEFAULT 0, t INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS answers (id INTEGER PRIMARY KEY AUTOINCREMENT, lesson INTEGER, q TEXT NOT NULL, a TEXT NOT NULL, t INTEGER NOT NULL)"
];
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map(q => env.DB.prepare(q)));
  schemaReady = true;
}

// 分野ごとのひな形（はじめの設定で選ぶ。あとから設定で直せる）
const FIELDS = {
  health: { audience: "施術や健康の仕事をする人。AIやパソコンが得意でない人も多い", ngWords: "治る、治す、完治、必ず、絶対、診断、副作用なし" },
  beauty: { audience: "美容の仕事をする人。AIやパソコンが得意でない人も多い", ngWords: "必ず、絶対、治る、消える、若返る" },
  business: { audience: "お店や事業を営む人。AIやパソコンが得意でない人も多い", ngWords: "必ず儲かる、絶対、確実に、保証" },
  hobby: { audience: "習いごとの生徒。年齢も経験もさまざま", ngWords: "" },
  other: { audience: "講座の参加者。AIやパソコンが得意でない人もいる", ngWords: "必ず、絶対" }
};
const randStr = n => { const a = "abcdefghjkmnpqrstuvwxyz23456789"; const b = crypto.getRandomValues(new Uint8Array(n)); return Array.from(b, x => a[x % a.length]).join(""); };

// 合言葉と鍵（置く人が登録しなくてよいよう、データベースに持つ）
async function keys(env) {
  const rows = (await env.DB.prepare("SELECT k, v FROM settings WHERE k IN ('teacher_hash','member_code','session_secret')").all()).results;
  const o = Object.fromEntries(rows.map(r => [r.k, r.v]));
  if (!o.session_secret) {
    o.session_secret = randStr(48);
    await env.DB.prepare("INSERT OR IGNORE INTO settings (k, v) VALUES ('session_secret', ?)").bind(o.session_secret).run();
    o.session_secret = (await env.DB.prepare("SELECT v FROM settings WHERE k = 'session_secret'").first()).v;
  }
  return o;
}

// 講座ごとに変えられる設定の初期値
const DEFAULT_SETUP = {
  teacherName: "講師",
  audience: "講座の参加者。AIやパソコンが得意でない人もいる",
  ngWords: "",
  channel: "LINE"
};

const jstDay = t => new Date(t + 9 * 3600000).toISOString().slice(0, 10);
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (msg, status = 400) => json({ error: msg }, status);
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// ---------- 合言葉・しるし ----------
const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = s => atob(s.replace(/-/g, "+").replace(/_/g, "/"));
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
}
async function sha(text) { return b64u(await crypto.subtle.digest("SHA-256", enc.encode(text))); }
function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0;
}
async function makeToken(env, payload) {
  const body = b64u(enc.encode(JSON.stringify({ ...payload, exp: Date.now() + 180 * DAY })));
  return body + "." + await hmac(env.KEYS.session_secret, body);
}
async function readToken(env, req, url) {
  const h = req.headers.get("authorization") || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : url.searchParams.get("t") || "";
  const [body, sig] = tok.split(".");
  if (!body || !sig || !same(sig, await hmac(env.KEYS.session_secret, body))) return null;
  let p; try { p = JSON.parse(fromB64u(body)); } catch { return null; }
  if (!p.exp || p.exp < Date.now()) return null;
  if (p.r === "m") {
    const m = await env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(p.id).first();
    if (!m || m.ver !== p.v || !m.pin_hash) return null;
    return { role: "m", member: m };
  }
  return p.r === "t" ? { role: "t" } : null;
}
const pinHash = (env, name, pin) => sha(env.KEYS.session_secret + "|" + name + "|" + pin);
const codeHash = (env, code) => sha(env.KEYS.session_secret + "|teacher|" + code);

// ---------- 設定 ----------
async function settings(env) {
  const rows = (await env.DB.prepare("SELECT k, v FROM settings").all()).results;
  const s = Object.fromEntries(rows.map(r => [r.k, r.v]));
  let words = DEFAULT_WORDS;
  try { if (s.words) words = { ...DEFAULT_WORDS, ...JSON.parse(s.words) }; } catch {}
  let setup = DEFAULT_SETUP;
  try { if (s.setup) setup = { ...DEFAULT_SETUP, ...JSON.parse(s.setup) }; } catch {}
  return { courseName: s.course_name || env.COURSE_NAME || "講座", words, ...setup };
}

// ---------- 回の並び ----------
async function lessons(env) {
  const rows = (await env.DB.prepare("SELECT * FROM lessons ORDER BY no").all()).results;
  const now = Date.now();
  let nextFound = false;
  return rows.map(r => {
    const t = Date.parse(r.date);
    let status;
    if (t <= now) status = r.published && r.data ? "done" : "prep";
    else if (!nextFound) { status = "next"; nextFound = true; }
    else status = "later";
    let data = null; try { data = r.data ? JSON.parse(r.data) : null; } catch {}
    return { ...r, t, status, data };
  });
}
const lastDone = ls => [...ls].reverse().find(l => l.status === "done");

function readiness(events, since) {
  const after = events.filter(e => e.t >= since);
  return [
    after.some(e => e.k === "review" || e.k === "listen"),
    after.some(e => e.k === "correct"),
    after.some(e => e.k === "try")
  ];
}

// ---------- 検査 ----------
function cleanLessonData(d) {
  if (!d || typeof d !== "object") return null;
  const arr = (v, n, max) => (Array.isArray(v) ? v : []).slice(0, n).map(x => str(x, max)).filter(Boolean);
  const out = {
    three: arr(d.three, 3, 80),
    text: arr(d.text, 8, 600),
    terms: (Array.isArray(d.terms) ? d.terms : []).slice(0, 12)
      .map(t => [str(t?.[0], 40), str(t?.[1], 160)]).filter(t => t[0] && t[1]),
    quiz: (Array.isArray(d.quiz) ? d.quiz : []).slice(0, 8).map(q => ({
      stem: str(q?.stem, 160),
      opts: arr(q?.opts, 5, 100),
      a: Number.isInteger(q?.a) ? q.a : -1,
      exp: str(q?.exp, 300)
    })).filter(q => q.stem && q.opts.length >= 2 && q.a >= 0 && q.a < q.opts.length),
    task: str(d.task, 200)
  };
  return out.three.length ? out : null;
}

// ---------- 参加者 ----------
async function memberState(env, me) {
  const [s, ls] = await Promise.all([settings(env), lessons(env)]);
  const db = env.DB;
  const log = (await db.prepare("SELECT k, key, t FROM events WHERE member = ? ORDER BY t").bind(me.id).all()).results;
  const myTries = (await db.prepare("SELECT id, lesson, text, public, t FROM tries WHERE member = ? ORDER BY t DESC LIMIT 30").bind(me.id).all()).results;
  const others = (await db.prepare("SELECT text, t FROM tries WHERE public = 1 AND member != ? ORDER BY t DESC LIMIT 10").bind(me.id).all()).results;
  const answers = (await db.prepare("SELECT lesson, q, a, t FROM answers ORDER BY t DESC LIMIT 20").all()).results;
  const total = (await db.prepare("SELECT COUNT(*) AS n FROM members").first()).n;
  const tried = (await db.prepare("SELECT COUNT(DISTINCT member) AS n FROM tries WHERE t >= ?").bind(Date.now() - 7 * DAY).first()).n;
  return {
    courseName: s.courseName, words: s.words, teacherName: s.teacherName, channel: s.channel,
    lessons: ls.map(l => ({ no: l.no, title: l.title, date: l.date, status: l.status,
      ...(l.status === "done" ? { data: l.data, video: l.video || "", audio: !!l.audio_type } : {}) })),
    me: { name: me.name, showTeacher: !!me.show_teacher, askedShare: !!me.asked_share },
    log, myTries, others, answers, everyone: { total, tried }
  };
}

async function addEvent(env, me, k, key) {
  if (!KINDS.includes(k)) return { added: false };
  key = str(key || "", 40) || null;
  const now = Date.now(), day = jstDay(now);
  let dup;
  if (k === "correct" || k === "attend") dup = await env.DB.prepare("SELECT 1 FROM events WHERE member = ? AND k = ? AND key IS ?").bind(me.id, k, key).first();
  else dup = await env.DB.prepare("SELECT 1 FROM events WHERE member = ? AND k = ? AND day = ? AND key IS ?").bind(me.id, k, day, key).first();
  if (dup) return { added: false };
  await env.DB.prepare("INSERT INTO events (member, k, key, day, t) VALUES (?, ?, ?, ?, ?)").bind(me.id, k, key, day, now).run();
  return { added: true, t: now };
}

// ---------- 講師 ----------
async function teacherState(env) {
  const [s, ls] = await Promise.all([settings(env), lessons(env)]);
  const db = env.DB;
  const members = (await db.prepare("SELECT id, name, show_teacher FROM members ORDER BY name").all()).results;
  const ld = lastDone(ls);
  const since = ld ? ld.t : 0;
  const events = (await db.prepare("SELECT member, k, t FROM events").all()).results;
  const byMember = new Map();
  for (const e of events) { if (!byMember.has(e.member)) byMember.set(e.member, []); byMember.get(e.member).push(e); }
  const now = Date.now();
  let ready = 0, idle = 0;
  const shared = [];
  for (const m of members) {
    const ev = byMember.get(m.id) || [];
    const r = readiness(ev, since);
    const isReady = r.every(Boolean);
    if (isReady) ready++;
    const last = ev.reduce((a, e) => Math.max(a, e.t), 0);
    if (!last || now - last > 7 * DAY) idle++;
    if (m.show_teacher) shared.push({ name: m.name, strokes: ev.length, ready: r.filter(Boolean).length, last });
  }
  const triedWeek = (await db.prepare("SELECT COUNT(DISTINCT member) AS n FROM tries WHERE t >= ?").bind(now - 7 * DAY).first()).n;
  const questions = (await db.prepare("SELECT id, lesson, text, t FROM questions WHERE answered = 0 ORDER BY t").all()).results;
  const answers = (await db.prepare("SELECT id, lesson, q, a, t FROM answers ORDER BY t DESC LIMIT 30").all()).results;
  return {
    courseName: s.courseName, words: s.words, teacherName: s.teacherName, audience: s.audience, ngWords: s.ngWords, channel: s.channel,
    lessons: ls.map(l => ({ no: l.no, title: l.title, date: l.date, status: l.status, published: !!l.published,
      data: l.data, video: l.video || "", audio: !!l.audio_type })),
    stats: { members: members.length, triedWeek, ready, idle },
    shared, names: members.map(m => m.name), questions, answers
  };
}

// ---------- 入口 ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (!p.startsWith("/api/")) return env.ASSETS ? env.ASSETS.fetch(req) : new Response("Not found", { status: 404 });
    const m = req.method;
    let body = {};
    if ((m === "POST" || m === "PUT") && (req.headers.get("content-type") || "").includes("application/json")) {
      try { body = await req.json(); } catch { return fail("送られた内容が読めませんでした"); }
    }

    try {
      await ensureSchema(env);
      env = { ...env, KEYS: await keys(env) };
      const isSetUp = !!env.KEYS.teacher_hash;

      if (p === "/api/ping") return json({ ok: true, setup: !isSetUp });

      // はじめの設定（最初に開いた人が講師になる。済んだあとは使えない）
      if (p === "/api/setup" && m === "POST") {
        if (isSetUp) return fail("はじめの設定はもう済んでいます。講師の合言葉で入ってください", 409);
        const courseName = str(body.courseName, 60), teacherName = str(body.teacherName, 30), code = str(body.teacherCode, 60);
        const field = FIELDS[body.field] ? body.field : "other";
        if (!courseName) return fail("講座の名前を入れてください");
        if (code.length < 6) return fail("講師の合言葉は6字以上にしてください");
        const memberCode = "sanka-" + randStr(6);
        const setup = { ...DEFAULT_SETUP, ...FIELDS[field], teacherName: teacherName || DEFAULT_SETUP.teacherName };
        const r = await env.DB.prepare("INSERT OR IGNORE INTO settings (k, v) VALUES ('teacher_hash', ?)").bind(await codeHash(env, code)).run();
        if (!r.meta.changes) return fail("はじめの設定はもう済んでいます", 409);
        await env.DB.batch([
          env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('member_code', ?)").bind(memberCode),
          env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('course_name', ?)").bind(courseName),
          env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('setup', ?)").bind(JSON.stringify(setup))
        ]);
        return json({ role: "t", token: await makeToken(env, { r: "t" }), memberCode });
      }
      if (!isSetUp && p !== "/api/ping") return fail("まだはじめの設定が済んでいません", 409);

      if (p === "/api/login" && m === "POST") {
        const code = str(body.code, 100);
        if (same(await codeHash(env, code), env.KEYS.teacher_hash)) return json({ role: "t", token: await makeToken(env, { r: "t" }) });
        if (!same(code, env.KEYS.member_code)) return fail("合言葉がちがいます", 401);
        const name = str(body.name, 20), pin = str(body.pin, 4);
        if (!name || !pin) return json({ need: "name" });
        if (!/^\d{4}$/.test(pin)) return fail("暗証番号は数字4けたです");
        let mem = await env.DB.prepare("SELECT * FROM members WHERE name = ?").bind(name).first();
        const now = Date.now();
        if (!mem) {
          await env.DB.prepare("INSERT INTO members (name, pin_hash, created) VALUES (?, ?, ?)").bind(name, await pinHash(env, name, pin), now).run();
          mem = await env.DB.prepare("SELECT * FROM members WHERE name = ?").bind(name).first();
        } else if (!mem.pin_hash) {
          await env.DB.prepare("UPDATE members SET pin_hash = ?, fails = 0, locked_until = 0 WHERE id = ?").bind(await pinHash(env, name, pin), mem.id).run();
        } else {
          if (mem.locked_until > now) return fail("暗証番号を何度もまちがえたため、15分ほど入れません。講師に再設定を頼むこともできます。", 429);
          if (!same(mem.pin_hash, await pinHash(env, name, pin))) {
            const fails = mem.fails + 1;
            await env.DB.prepare("UPDATE members SET fails = ?, locked_until = ? WHERE id = ?").bind(fails >= 5 ? 0 : fails, fails >= 5 ? now + 15 * 60000 : 0, mem.id).run();
            return fail("その呼び名はもう使われているか、暗証番号がちがいます", 401);
          }
          await env.DB.prepare("UPDATE members SET fails = 0 WHERE id = ?").bind(mem.id).run();
        }
        return json({ role: "m", token: await makeToken(env, { r: "m", id: mem.id, v: mem.ver }) });
      }

      const who = await readToken(env, req, url);
      if (!who) return fail("もう一度、合言葉から入ってください", 401);

      // 音声（参加者も講師も聞ける）
      const am = p.match(/^\/api\/audio\/(\d+)$/);
      if (am && m === "GET") {
        const { value, metadata } = await env.AUDIO.getWithMetadata("lesson-" + am[1], "arrayBuffer");
        if (!value) return fail("音声がありません", 404);
        return new Response(value, { headers: { "content-type": metadata?.type || "audio/mpeg", "cache-control": "private, max-age=3600" } });
      }

      if (who.role === "m") {
        const me = who.member;
        if (p === "/api/state" && m === "GET") return json(await memberState(env, me));
        if (p === "/api/event" && m === "POST") return json(await addEvent(env, me, body.k, body.key));
        if (p === "/api/me" && m === "POST") {
          await env.DB.prepare("UPDATE members SET show_teacher = ?, asked_share = 1 WHERE id = ?").bind(body.showTeacher ? 1 : 0, me.id).run();
          return json({ ok: true });
        }
        if (p === "/api/try" && m === "POST") {
          const text = str(body.text, 400);
          if (!text) return fail("ひとことを書いてから押してください");
          await env.DB.prepare("INSERT INTO tries (member, lesson, text, public, t) VALUES (?, ?, ?, ?, ?)")
            .bind(me.id, Number.isInteger(body.lesson) ? body.lesson : null, text, body.public ? 1 : 0, Date.now()).run();
          return json(await addEvent(env, me, "try", null));
        }
        if (p === "/api/question" && m === "POST") {
          const text = str(body.text, 600);
          if (!text) return fail("質問を書いてから押してください");
          await env.DB.prepare("INSERT INTO questions (member, lesson, text, t) VALUES (?, ?, ?, ?)")
            .bind(me.id, Number.isInteger(body.lesson) ? body.lesson : null, text, Date.now()).run();
          return json(await addEvent(env, me, "ask", null));
        }
        return fail("見つかりません", 404);
      }

      // ---- ここから講師だけ ----
      if (p === "/api/t/state" && m === "GET") return json({ ...(await teacherState(env)), memberCode: env.KEYS.member_code });

      if (p === "/api/t/codes" && m === "POST") {
        const out = {};
        if (body.teacherCode) {
          const code = str(body.teacherCode, 60);
          if (code.length < 6) return fail("講師の合言葉は6字以上にしてください");
          await env.DB.prepare("UPDATE settings SET v = ? WHERE k = 'teacher_hash'").bind(await codeHash(env, code)).run();
          out.teacher = true;
        }
        if (body.newMemberCode) {
          out.memberCode = "sanka-" + randStr(6);
          await env.DB.prepare("UPDATE settings SET v = ? WHERE k = 'member_code'").bind(out.memberCode).run();
        }
        return json(out);
      }

      if (p === "/api/t/settings" && m === "PUT") {
        const name = str(body.courseName, 60);
        const words = {};
        for (const k of Object.keys(DEFAULT_WORDS)) words[k] = str(body.words?.[k], 120) || DEFAULT_WORDS[k];
        if (name) await env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('course_name', ?)").bind(name).run();
        await env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('words', ?)").bind(JSON.stringify(words)).run();
        const setup = {
          teacherName: str(body.teacherName, 30) || DEFAULT_SETUP.teacherName,
          audience: str(body.audience, 200) || DEFAULT_SETUP.audience,
          ngWords: str(body.ngWords, 400),
          channel: str(body.channel, 20) || DEFAULT_SETUP.channel
        };
        await env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('setup', ?)").bind(JSON.stringify(setup)).run();
        return json({ ok: true });
      }

      if (p === "/api/t/lesson" && m === "PUT") {
        const no = Number(body.no), title = str(body.title, 60), date = str(body.date, 40);
        if (!Number.isInteger(no) || no < 1 || no > 99) return fail("回の番号は1〜99で入れてください");
        if (!title) return fail("題を入れてください");
        if (!date || isNaN(Date.parse(date))) return fail("日時を入れてください");
        let data = null;
        if (body.data) { data = cleanLessonData(body.data); if (!data) return fail("中身の形が読めませんでした。今日の3つが入っているか確かめてください"); }
        const video = str(body.video, 300);
        const old = await env.DB.prepare("SELECT audio_type FROM lessons WHERE no = ?").bind(no).first();
        await env.DB.prepare("INSERT OR REPLACE INTO lessons (no, title, date, data, video, audio_type, published) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(no, title, date, data ? JSON.stringify(data) : null, video, old?.audio_type || null, body.published && data ? 1 : 0).run();
        return json({ ok: true });
      }
      const dl = p.match(/^\/api\/t\/lesson\/(\d+)$/);
      if (dl && m === "DELETE") {
        await env.DB.prepare("DELETE FROM lessons WHERE no = ?").bind(+dl[1]).run();
        await env.AUDIO.delete("lesson-" + dl[1]);
        return json({ ok: true });
      }

      const au = p.match(/^\/api\/t\/audio\/(\d+)$/);
      if (au && m === "PUT") {
        const type = (req.headers.get("content-type") || "").split(";")[0];
        if (!type.startsWith("audio/")) return fail("音声のファイルを選んでください");
        const buf = await req.arrayBuffer();
        if (buf.byteLength > AUDIO_MAX) return fail("音声が大きすぎます（8MBまで）。1分ほどに短くしてください");
        const row = await env.DB.prepare("SELECT no FROM lessons WHERE no = ?").bind(+au[1]).first();
        if (!row) return fail("先に回を保存してください");
        await env.AUDIO.put("lesson-" + au[1], buf, { metadata: { type } });
        await env.DB.prepare("UPDATE lessons SET audio_type = ? WHERE no = ?").bind(type, +au[1]).run();
        return json({ ok: true });
      }
      if (au && m === "DELETE") {
        await env.AUDIO.delete("lesson-" + au[1]);
        await env.DB.prepare("UPDATE lessons SET audio_type = NULL WHERE no = ?").bind(+au[1]).run();
        return json({ ok: true });
      }

      if (p === "/api/t/answer" && m === "POST") {
        const q = str(body.q, 600), a = str(body.a, 1000);
        if (!q || !a) return fail("質問と答えの両方を入れてください");
        await env.DB.prepare("INSERT INTO answers (lesson, q, a, t) VALUES (?, ?, ?, ?)").bind(Number.isInteger(body.lesson) ? body.lesson : null, q, a, Date.now()).run();
        if (Number.isInteger(body.qid)) await env.DB.prepare("UPDATE questions SET answered = 1 WHERE id = ?").bind(body.qid).run();
        return json({ ok: true });
      }
      const qa = p.match(/^\/api\/t\/question\/(\d+)\/close$/);
      if (qa && m === "POST") {
        await env.DB.prepare("UPDATE questions SET answered = 1 WHERE id = ?").bind(+qa[1]).run();
        return json({ ok: true });
      }
      const da = p.match(/^\/api\/t\/answer\/(\d+)$/);
      if (da && m === "DELETE") {
        await env.DB.prepare("DELETE FROM answers WHERE id = ?").bind(+da[1]).run();
        return json({ ok: true });
      }

      if (p === "/api/t/reset-pin" && m === "POST") {
        const name = str(body.name, 20);
        const r = await env.DB.prepare("UPDATE members SET pin_hash = '', ver = ver + 1, fails = 0, locked_until = 0 WHERE name = ?").bind(name).run();
        if (!r.meta.changes) return fail("その呼び名の人が見つかりません");
        return json({ ok: true });
      }

      return fail("見つかりません", 404);
    } catch (e) {
      return fail("うまく動きませんでした：" + (e && e.message ? e.message : e), 500);
    }
  }
};
