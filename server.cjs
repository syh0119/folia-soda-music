#!/usr/bin/env node
/**
 * soda_subsonic.js — 把汽水音乐包装成一个 OpenSubsonic 服务端，供 Folia 当「Navidrome」音源接入
 * =============================================================================
 * 为什么这么做：Folia 的 Folium 模组音源（omni.providers）是实验接口，歌单/专辑/电台只有占位；
 * 而 Navidrome/Subsonic 是 Folia 的**首页一级原生页签**，歌单/专辑/歌手/收藏/随机/歌词/封面全支持。
 *
 * 曲库来源（对应 Folia 里的歌单，可切换）：
 *   1. 启动播放队列   —— 读本地 %APPDATA%\SodaMusic\LunaStorage\QueueCache（客户端打开时自动播的那条）
 *   2. 我喜欢的音乐   —— GET /luna/pc/me/playlist → /luna/pc/playlist/detail
 *   3. 我的歌单…      —— 同上，逐个歌单
 *   4. 推荐流         —— POST /luna/pc/feed/song-tab（持续拉）
 *
 * 用法：
 *   node soda_subsonic.js                 # 默认 127.0.0.1:4533
 *   PORT=4533 node soda_subsonic.js       # 换端口
 *   node soda_subsonic.js --refresh       # 强制重新从客户端同步登录态
 *
 * 鉴权（见「配置」一节）：用户名固定 soda，密码是启动时生成/读取的随机 SECRET
 *   · 首次运行会把 SECRET 写进 <数据目录>/auth.json，之后一直用它
 *   · 控制面 /api/* 另外要一个每次启动随机的 TOKEN（经 rpc 交给模组 client，不落盘）
 *
 * Folia 侧配置：设置 → 音源/资料库 → Navidrome → 服务器地址 http://127.0.0.1:4533，密码看启动日志
 */
'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn, execFileSync } = require('child_process');

// ============================================================ 配置
/**
 * 运行模式：`start({ embedded: true })` 时置真。**嵌入模式一律不读环境变量**
 * （维护者审查意见）：用户全局设了 `HOST=0.0.0.0` 就会把本机服务暴露到局域网，
 * `SUB_PASS`/`SODA_NATIVE_DIR` 同理 —— 密码变成可猜的固定值、原生模块目录可被指到任意位置。
 * 环境变量只对独立运行（`node soda_subsonic.js`）生效。
 */
let EMBEDDED = false;
let LAN_MODE = false;
let PORT = parseInt(process.env.PORT || '4533', 10);
let HOST = process.env.HOST || '127.0.0.1';
/** 系统目录下的可执行文件全路径 —— 不按名字走 PATH（同名程序可以劫持） */
const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const EXE_REG = process.platform === 'win32' ? path.join(SYS32, 'reg.exe') : 'reg';
const EXE_PS = process.platform === 'win32'
  ? path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell';
/**
 * 本机服务的两把钥匙（维护者审查意见：不许再用固定账号 soda/soda）：
 *   · SECRET —— 数据面（`/rest/*`）的密码。**持久化**在 paths.data/auth.json。
 *               宿主的 Navidrome 配置里存的就是它 —— 每次启动换一把的话，用户每次都得去改配置。
 *   · TOKEN  —— 控制面（`/api/*` 与设置页）的令牌。**每次启动随机**，由 main 经 rpc 交给 client，
 *               不落盘、不写进任何对外 URL。
 * 用户名保持固定的 'soda'：用户名不是秘密，密码才是。
 */
const USER = process.env.SUB_USER || 'soda';
let SECRET = process.env.SUB_PASS || '';   // 嵌入模式下 start() 会先清空，再读/生成 auth.json
let TOKEN = '';
const APP_ID = '386088';
const APP_VERSION = '3.8.0';
const CHANNEL = 'official';
const UA = 'LunaPC/3.8.0(467160162)';
const API = 'https://api.qishui.com';
const ORDER = ['lossless', 'hi_res', 'spatial', 'highest', 'higher', 'medium'];
const QUALITY = process.env.QUALITY || 'best';   // best | lossless | highest ...
const CATALOG_TTL = 10 * 60 * 1000;              // 目录缓存 10 分钟
/**
 * 专辑墙 / 歌手页的最小曲目数。默认 2 —— 只让「真正的专辑 / 有多首歌的歌手」进去。
 * 为什么：汽水的单曲发行会给每首歌各自一个 album，导致库里 807 个专辑有 803 个只装 1 首；
 * Folia 的 Navidrome 首页一次要摆几百张卡片，主线程每帧的 DOM 开销被填满，
 * 帧间隔会整齐地贴在 30ms 上下（看起来像被限帧，其实是主线程饱和）。
 * 被挡掉的单曲仍可在「歌单 / 搜索」里找到。想看全部就设 MIN_ALBUM_TRACKS=1 MIN_ARTIST_TRACKS=1。
 */
const MIN_ALBUM_TRACKS = parseInt(process.env.MIN_ALBUM_TRACKS || '1', 10);   // 1 = 不过滤（默认）
const MIN_ARTIST_TRACKS = parseInt(process.env.MIN_ARTIST_TRACKS || '1', 10);  // 1 = 不过滤（默认）
const FEED_PAGES = parseInt(process.env.FEED_PAGES || '12', 10);   // 每页 6 首 → 默认 72 首

const ASSET = __dirname;              // 代码与资源（lib/、ui.html）—— 只读，永不改变
const LIB = path.join(ASSET, 'lib');
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

/**
 * 数据目录。独立运行 = 脚本目录；**内嵌进 Folia 模组时绝不能落在模组目录里** ——
 * Folia 的模组授权绑定「模组目录内容摘要」，往模组目录写文件会让摘要失配、模组被撤销授权。
 *
 * Folium 1.5 起宿主提供 api.storage.paths，两个 **getter**（每次读取时目录不存在会先建出来）：
 *   · paths.data  —— 要保留的文件（登录态、设备标识）
 *   · paths.cache —— 可重建的缓存（解密音频 / 歌词 / 封面），用户可随时在模组面板清空
 * 所以这里不缓存路径字符串，一律经 resolvePaths() 现取（维护者审查意见）。
 */
let resolvePaths = null;      // () => ({ data, cache })，由 start() 注入
let FALLBACK_ROOT = ASSET;    // 兜底根：独立运行 / 不支持 paths 的旧宿主（0.7.19）

/** 要保留的数据目录 */
function dataDir() {
  const p = resolvePaths ? resolvePaths() : null;
  const d = (p && p.data) || FALLBACK_ROOT;
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { }
  return d;
}

/** 用户设置（持久化到数据目录 settings.json） */
const SETTINGS_FILE = () => path.join(dataDir(), 'settings.json');
const SETTINGS_DEFAULTS = { trialDetect: false };
let SETTINGS = null;
function loadSettings() {
  if (SETTINGS) return SETTINGS;
  const d = Object.assign({}, SETTINGS_DEFAULTS);
  try { Object.assign(d, JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')) || {}); } catch (e) { }
  SETTINGS = d;
  return SETTINGS;
}
function saveSettings(patch) {
  const s2 = Object.assign(loadSettings(), patch || {});
  SETTINGS = s2;
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(s2, null, 1));
  } catch (e) { }
  return s2;
}
const trialEnabled = () => !!loadSettings().trialDetect;

/** 可重建的缓存目录（被用户清空后能自建） */
function cacheDir() {
  const p = resolvePaths ? resolvePaths() : null;
  const d = (p && p.cache) || path.join(FALLBACK_ROOT, '_cache');
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { }
  return d;
}

/** 歌词缓存（放 cache 下的子目录） */
function lyricDir() {
  const d = path.join(cacheDir(), 'lyrics');
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { }
  return d;
}

// ---- 缓存容量 ------------------------------------------------------------
// 宿主不限制 paths.cache 的大小，而无损音频涨得很快，上限只能模组自己兜。
// 超过上限就按 mtime 从旧到新删（近似 LRU），直到降到上限的 80%。
// 带 60 秒节流，不会每写一个文件就遍历一次目录。
const MAX_CACHE_BYTES = Math.max(64, parseInt(process.env.SODA_MAX_CACHE_MB || '2048', 10)) * 1024 * 1024;
let lastSweep = 0;

function sweepCache(force) {
  const now = Date.now();
  if (!force && now - lastSweep < 60000) return;
  lastSweep = now;
  try {
    const files = [];
    let total = 0;
    const walk = (d) => {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const e of entries) {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) { walk(fp); continue; }
        try { const st = fs.statSync(fp); files.push({ fp, size: st.size, mtime: st.mtimeMs }); total += st.size; }
        catch (err) { }
      }
    };
    walk(cacheDir());
    if (total <= MAX_CACHE_BYTES) return;
    log('缓存 ' + (total / 1048576).toFixed(0) + ' MB 超过上限 '
      + (MAX_CACHE_BYTES / 1048576).toFixed(0) + ' MB，按最旧优先清理');
    files.sort((a, b) => a.mtime - b.mtime);
    const target = MAX_CACHE_BYTES * 0.8;
    for (const f of files) {
      if (total <= target) break;
      try { fs.unlinkSync(f.fp); total -= f.size; } catch (e) { }
    }
  } catch (e) { }
}

// ============================================================ 原生模块（隔离在子进程里）
// bdms.node / device.node 都是 N-API 模块（napi_register_module_v1，无 V8/NAN 绑定），
// 跨 Node / Electron 版本 ABI 稳定，不需要为 Electron 重编译。
//
// 但它们是**汽水客户端自带的第三方原生代码**，不属于本模组、也不受模组权限约束。
// 在主进程里 dlopen 等于把它拉进宿主主进程（同权限 / 同地址空间 / 同崩溃域），
// 同时还得改主进程的 PATH 与 cwd —— 所以改成**独立子进程**里加载（见 native-host.cjs）。
// 主进程这一侧只留一个 JSON-RPC 代理，不再碰任何全局状态。
let NATIVE = null;            // 原生模块目录（仅用于「有没有」判据与日志）
let host = null;              // 原生宿主子进程
let hostSeq = 0;
const hostWaiters = new Map();
const CORE = require(path.join(LIB, 'luna_core.js'));

const NATIVE_HOST_JS = ['native-host.cjs'].map(f => path.join(ASSET, f))
  .concat([path.join(ASSET, '..', 'native-host.cjs')])
  .find(p => { try { return fs.existsSync(p); } catch (e) { return false; } })
  || path.join(ASSET, 'native-host.cjs');

function hostCall(cmd, args) {
  if (!host || !host.connected) return Promise.reject(new Error('原生宿主未启动'));
  const id = ++hostSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      hostWaiters.delete(id);
      reject(new Error('原生调用超时: ' + cmd));
    }, 30000);
    hostWaiters.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    try { host.send({ id, cmd, args: args || {} }); }
    catch (e) { clearTimeout(timer); hostWaiters.delete(id); reject(e); }
  });
}

function hostStart(dir) {
  if (host && host.connected) return Promise.resolve();
  const { fork } = require('child_process');
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env);
    // Electron 下 fork 出来的默认是**新的应用实例**；带上这个才是纯 Node
    if (process.versions && process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    let child;
    try {
      child = fork(NATIVE_HOST_JS, [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    } catch (e) { return reject(e); }
    child.stdout.on('data', d => log('[native] ' + String(d).trim()));
    child.stderr.on('data', d => log('[native:err] ' + String(d).trim()));
    child.on('message', (m) => {
      const w = m && hostWaiters.get(m.id);
      if (!w) return;
      hostWaiters.delete(m.id);
      if (m.ok) w.resolve(m.result); else w.reject(new Error(m.error || 'native error'));
    });
    const fail = (e) => {
      const err = e instanceof Error ? e : new Error(String(e));
      for (const [, w] of hostWaiters) w.reject(err);
      hostWaiters.clear();
      if (host === child) host = null;
    };
    child.on('error', fail);
    child.on('exit', (code, sig) => {
      if (host === child) fail(new Error('原生宿主进程退出 (code=' + code + (sig ? ' signal=' + sig : '') + ')'));
    });
    host = child;
    hostCall('boot', { dir }).then(() => resolve(), (e) => { fail(e); reject(e); });
  });
}

function hostStop() {
  const h = host;
  host = null;
  try { h && h.kill(); } catch (e) { }
}

const hasNative = (d) => {
  try { return fs.existsSync(path.join(d, 'bdms.node')) && fs.existsSync(path.join(d, 'metasecml.dll')); }
  catch (e) { return false; }
};

/** 汽水客户端的安装目录：先问它自己的启动日志（最准），再回退注册表 */
function clientInstallDirs() {
  const out = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(APPDATA, 'SodaMusic', 'launch_info', 'launch_log.json'), 'utf8'));
    for (const r of (j.launch_records || [])) {
      const m = /"?([A-Za-z]:\\[^"]*?)\\SodaMusic\.exe/i.exec(String(r.cmd_line || ''));
      if (m && !out.includes(m[1])) out.push(m[1]);
    }
  } catch (e) { }
  if (!out.length && process.platform === 'win32') {
    const roots = [
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    ];
    for (const root of roots) {
      let text = '';
      try { text = execFileSync(EXE_REG, ['query', root, '/s'], { encoding: 'utf8', maxBuffer: 16 << 20 }); }
      catch (e) { continue; }
      let cur = {};
      const flush = () => {
        const name = cur.DisplayName || '';
        const icon = (cur.DisplayIcon || '').replace(/^"|"$/g, '');
        const loc = cur.InstallLocation || (icon ? path.dirname(icon) : '');
        if (loc && (/Soda|汽水/i.test(name) || /Soda/i.test(loc)) && !out.includes(loc)) out.push(loc);
        cur = {};
      };
      for (const line of text.split(/\r?\n/)) {
        if (/^HKEY_/i.test(line.trim())) { flush(); continue; }
        const m = /^\s+(\S+)\s+REG_\w+\s+(.+)$/.exec(line);
        if (m) cur[m[1]] = m[2].trim();
      }
      flush();
      if (out.length) break;
    }
  }
  return out;
}

/** 在安装目录里找 resources/app.asar.unpacked（安装根下面常还有一层版本号目录） */
function findNativeIn(base) {
  const tries = [base, path.join(base, 'resources', 'app.asar.unpacked')];
  try { for (const d of fs.readdirSync(base)) tries.push(path.join(base, d, 'resources', 'app.asar.unpacked')); }
  catch (e) { }
  for (const d of tries) if (d && hasNative(d)) return d;
  return null;
}

function resolveNativeDir() {
  const cands = [];
  if (!EMBEDDED && process.env.SODA_NATIVE_DIR) cands.push(process.env.SODA_NATIVE_DIR);
  cands.push(path.join(ASSET, 'native'));          // 模组自带（可选）
  cands.push(path.join(ASSET, 'lib', 'native'));   // 独立运行的布局
  cands.push(path.join(ASSET, 'native'));
  for (const c of cands) if (c && hasNative(c)) return c;
  for (const base of clientInstallDirs()) {
    const d = findNativeIn(base);
    if (d) return d;
  }
  return null;
}

async function initNative() {
  if (host && host.connected) return true;
  const dir = resolveNativeDir();
  if (!dir) throw new Error('找不到原生模块：请先安装并运行一次汽水音乐 PC 客户端，或用 SODA_NATIVE_DIR 指定 app.asar.unpacked 目录');
  log('原生模块目录: ' + dir + '（在独立子进程里加载，主进程不 dlopen 外部原生代码）');
  await hostStart(dir);
  NATIVE = dir;
  return true;
}

const LOG_RING = [];
function log(...a) {
  const line = '[' + new Date().toTimeString().slice(0, 8) + '] ' + a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(line);
  LOG_RING.push(line);
  if (LOG_RING.length > 300) LOG_RING.shift();
}

/**
 * 后台初始化（设备身份 / 登录态 / 曲库）的「就绪门」。
 *
 * 为什么需要它：start() 在端口 listen 成功后就**立刻**返回，把上面那几件慢活儿
 * （子进程加载原生模块、联网注册设备、PowerShell 解 DPAPI、拉整份曲库）放到后台。
 * 内嵌进 Folia 时这些要几十秒，以前全挡在 start() 里 —— handle 迟迟不返回，
 * 模组的 client 在 20 来秒内探活失败就彻底放弃，宿主的 Navidrome 配置因此永远
 * 配不上新的随机密钥（现象：服务明明在跑，NAVI 页签却一直连不上）。
 *
 * 就绪之前，数据面（/rest/*）最多等一小会儿，免得 Folia 首次拉库拿到空结果。
 */
let READY = null;                       // 后台初始化的 promise；null = 还没开始
let READY_DONE = false;                 // 后台初始化是否已经结束（成功或失败都算）
let STOPPED = false;                    // stop() 之后后台流程不要再往下走
const waitReady = async (ms) => {
  if (!READY) return;
  await Promise.race([READY, new Promise((r) => setTimeout(r, ms))]);
};
const UI_HTML = (() => { try { return fs.readFileSync(path.join(ASSET, 'ui.html'), 'utf8'); } catch (e) { return '<h1>ui.html 缺失</h1>'; } })();

// ============================================================ 设备身份 + 登录态
let DEV = null;
let COOKIE = '';
let sessHint = '';

function deviceFile() { return path.join(dataDir(), 'device.json'); }

/** 初始化原生签名器（必须先做，否则 X-Helios/X-Medusa 为空，track_v2 等接口会返回空响应） */
async function initBdms() {
  try {
    if (!host) await initNative();
    await hostCall('init', { deviceId: DEV.did });
    log('签名器已初始化 deviceId=' + DEV.did);
    return true;
  } catch (e) { log('签名器初始化失败: ' + e.message); return false; }
}

function loadDevice() {
  try {
    const d = JSON.parse(fs.readFileSync(deviceFile(), 'utf8'));
    if (d && d.did && d.iid) { DEV = d; return d; }
  } catch (e) { }
  return null;
}

function postRaw(host, p, headers, body) {
  return new Promise((resolve, reject) => {
    const r = https.request({ hostname: host, path: p, method: 'POST', headers }, res => {
      const c = []; res.on('data', x => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(c).toString() }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

/** 复刻客户端 device 注册：gzip(payload) → applogDecorated → POST */
async function registerDevice() {
  const cdid = crypto.randomUUID();
  if (!host) await initNative();
  let serial = '';
  try { serial = String(await hostCall('serial')); } catch (e) { }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  const payload = {
    header: {
      device_id: '', install_id: '', os: 'Windows', device_platform: 'PC',
      sdk_version: '1.0', sdk_version_code: 1,
      aid: APP_ID, mc: '00:00:00:00:00:00', channel: CHANNEL,
      package: 'com.soda.music', language: 'zh-CN',
      app_version: APP_VERSION, os_version: os.version(), device_model: 'no detected',
      time_zone: tz, tz_name: tz, tz_offset: 0,
      resolution: 'no detected', app_region: 'cn', app_language: 'zh-CN',
      display_name: '汽水音乐', pc_uuid: cdid, pc_serial: serial,
    },
    gen_time: Date.now(), magic_tag: 'ss_app_log',
  };
  const decorated = Buffer.from(
    (await hostCall('decorate', { b64: zlib.gzipSync(Buffer.from(JSON.stringify(payload))).toString('base64') })).b64,
    'base64');
  const qs = Object.entries({ aid: APP_ID, channel: CHANNEL, os: os.type(), os_version: os.version(), device_platform: 'PC', app_version: APP_VERSION })
    .map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  const r = await postRaw('api.qishui.com', '/service/2/desktop/device_register/?' + qs,
    { 'content-type': 'application/octet-stream', 'user-agent': UA }, decorated);
  const j = JSON.parse(r.text);
  if (!j.device_id_str) throw new Error('设备注册失败: ' + r.text.slice(0, 160));
  const d = { did: String(j.device_id_str), iid: String(j.install_id_str), cdid, serial, ts: Date.now() };
  fs.mkdirSync(path.dirname(deviceFile()), { recursive: true });
  fs.writeFileSync(deviceFile(), JSON.stringify(d, null, 1));
  DEV = d;
  log('已自助注册设备身份 did=' + d.did);
  initBdms();
  return d;
}

function ps(cmd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(EXE_PS, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', cmd], { windowsHide: true });
    let o = '', e = '', done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { p.kill(); } catch (x) { }
      reject(new Error('PowerShell 超时（' + ((timeoutMs || 15000) / 1000) + 's）'));
    }, timeoutMs || 15000);
    p.stdout.on('data', d => o += d);
    p.stderr.on('data', d => e += d);
    p.on('error', err => { if (done) return; done = true; clearTimeout(timer); reject(new Error('PowerShell 无法启动: ' + err.message)); });
    p.on('exit', c => {
      if (done) return; done = true; clearTimeout(timer);
      c === 0 ? resolve(o.trim()) : reject(new Error(e.trim() || ('powershell exit ' + c)));
    });
  });
}

/** 兜底：读取已提取好的 _pc_cookie.json（由 _pc_cookie.py 用 Python 提取） */
function trySessionFromJson() {
  for (const p of [path.join(dataDir(), '_pc_cookie.json'), path.join(path.dirname(dataDir()), '_pc_cookie.json')]) {
    try {
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const cookie = j.cookie || Object.entries(j.cookieMap || {}).map(([k, v]) => k + '=' + v).join('; ');
      if (!cookie) continue;
      COOKIE = cookie;
      saveSessionCookie(cookie);
      sessHint = '来自 _pc_cookie.json · ' + cookie.length + ' 字符';
      log('已从 _pc_cookie.json 载入登录态（' + p + '）');
      return true;
    } catch (e) { }
  }
  return false;
}

/** 从本机汽水客户端 Cookies 库提取登录态（DPAPI + AES-GCM） */
async function refreshSessionFromClient() {
  const ckPath = path.join(APPDATA, 'SodaMusic', 'Network', 'Cookies');
  const lsPath = path.join(APPDATA, 'SodaMusic', 'Local State');
  if (!fs.existsSync(ckPath)) {
    if (trySessionFromJson()) return {};
    throw new Error('没找到汽水客户端数据目录（需先安装并登录汽水音乐 PC 客户端）');
  }
  const tmp = path.join(os.tmpdir(), 'soda_ck_' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  /**
   * 维护者审查意见：%TEMP% 下这个是 Cookies 的**明文副本**，任何退出路径都必须删。
   * 以前只在成功分支末尾删一次 —— DPAPI 失败、没 sessionid、库被占用这些抛错路径
   * 会把明文 cookie 留在磁盘上。现在整段包进 try/finally。
   */
  try {
    fs.copyFileSync(lsPath, path.join(tmp, 'LocalState.json'));
    try { fs.copyFileSync(ckPath, path.join(tmp, 'Cookies')); }
    catch (e) { throw new Error('Cookies 库被占用 —— 请先完全退出汽水音乐客户端再试'); }

    const ls = JSON.parse(fs.readFileSync(path.join(tmp, 'LocalState.json'), 'utf8'));
    const ek = Buffer.from(ls.os_crypt.encrypted_key || '', 'base64').subarray(5);
    if (!ek.length) throw new Error('Local State 无 encrypted_key');

    let masterB64;
    try {
      masterB64 = await ps("Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String('" + ek.toString('base64') +
        "'); [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))", 20000);
    } catch (e) {
      log('DPAPI 解密（PowerShell）不可用：' + e.message + '，尝试 _pc_cookie.json 兜底 …');
      if (trySessionFromJson()) return {};
      throw new Error('DPAPI 解密失败且无兜底：' + e.message);
    }
    const master = Buffer.from(masterB64, 'base64');

    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(tmp, 'Cookies'));
    const rows = db.prepare('SELECT host_key, name, value, encrypted_value FROM cookies').all();
    db.close();

    function dec(enc) {
      if (!enc || !enc.length) return '';
      const buf = Buffer.from(enc);
      const tag = buf.toString('latin1', 0, 3);
      if (tag === 'v10' || tag === 'v20') {
        const nonce = buf.subarray(3, 15), ct = buf.subarray(15);
        const d = crypto.createDecipheriv('aes-256-gcm', master, nonce);
        d.setAuthTag(ct.subarray(ct.length - 16));
        let out = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
        if (tag === 'v20' && out.length > 32) out = out.subarray(32);
        return out.toString('utf8');
      }
      return buf.toString('utf8');
    }
    const ck = {};
    for (const r of rows) if (r.host_key === '.qishui.com') ck[r.name] = r.value || dec(r.encrypted_value);
    if (!ck.sessionid) throw new Error('未找到 sessionid（客户端里还没登录？）');
    const cookie = Object.entries(ck).map(([k, v]) => k + '=' + v).join('; ');
    saveSessionCookie(cookie);
    COOKIE = cookie;
    sessHint = 'sessionid ' + String(ck.sessionid).slice(0, 10) + '… 共 ' + Object.keys(ck).length + ' 项';
    log('已从客户端同步登录态 sessionid=' + String(ck.sessionid).slice(0, 10) + '…');
    return ck;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }   // 明文副本，用完即删（含异常路径）
  }
}

/** 启动时清扫历史残留：同步登录态会在 %TEMP% 下拷一份 Cookies，旧版本用完没删 */
function sweepTempCookies() {
  try {
    const dir = os.tmpdir();
    let n = 0;
    for (const f of fs.readdirSync(dir)) {
      if (/^soda_(ck|cookies)_/.test(f)) {
        try { fs.rmSync(path.join(dir, f), { recursive: true, force: true }); n++; } catch (e) { }
      }
    }
    if (n) log('已清理 ' + n + ' 个遗留的登录态临时目录');
  } catch (e) { }
}

/**
 * 登录态的落盘与读取。
 * -----------------------------------------------------------------------------
 * 维护者审查意见：**登录态不要明文落盘**。这里改成用宿主（Electron）的 `safeStorage`
 * 加密后再写盘 —— Windows 上它走 DPAPI，密钥绑当前用户账户，别的程序/账户拿到文件也解不开。
 *
 * 拿不到 safeStorage（纯 Node 独立运行、或系统不支持）时**不落盘**：
 * 宁可在启动时多同步一次（要求汽水客户端退出），也不在磁盘上留一份明文 cookie。
 * 顺带清掉旧版本写的 `_session.txt`。
 */
function sessionFile() { return path.join(dataDir(), '_session.bin'); }

function safeStore() {
  try {
    const { safeStorage } = require('electron');
    if (safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()) return safeStorage;
  } catch (e) { }
  return null;
}

function saveSessionCookie(cookie) {
  // 旧的明文文件一律删掉（不管这次能不能加密，都不该留在那里）
  try { fs.rmSync(path.join(dataDir(), '_session.txt'), { force: true }); } catch (e) { }
  const ss = safeStore();
  if (!ss) { log('未启用加密存储（safeStorage 不可用），本次登录态只留在内存里，不落盘'); return false; }
  try {
    fs.writeFileSync(sessionFile(), ss.encryptString(cookie), { mode: 0o600 });
    return true;
  } catch (e) { log('登录态加密落盘失败: ' + e.message); return false; }
}

function loadSession() {
  try { fs.rmSync(path.join(dataDir(), '_session.txt'), { force: true }); } catch (e) { }
  const p = sessionFile();
  if (!fs.existsSync(p)) return COOKIE;
  const ss = safeStore();
  if (!ss) return COOKIE;
  try {
    COOKIE = String(ss.decryptString(fs.readFileSync(p)) || '').trim();
    sessHint = COOKIE.length + ' 字符（加密存储 · ' + new Date(fs.statSync(p).mtime).toLocaleString('zh-CN') + '）';
  } catch (e) { log('登录态解密失败（换过用户/账户？）：' + e.message); }
  return COOKIE;
}

/** 清掉旧版本留下的明文数据目录（%APPDATA%\luna_export）。
 *  · 先**迁移**设备身份（device.json）：它只是一个随机的 did/iid，没必要让用户重新注册一台设备。
 *  · 登录态（_session.txt）是明文，不迁移，直接删 —— 重启后重新同步一次即可。
 *  · 只在旧目录**不是**当前数据目录时才动，免得把正在用的数据删掉。 */
function cleanLegacyLayout() {
  try {
    const legacy = path.join(APPDATA, 'luna_export');
    const legacySoda = path.join(legacy, 'soda');
    const cur = path.resolve(dataDir());
    const inside = (p) => { const r = path.resolve(p); return r === cur || r.startsWith(cur + path.sep); };
    if (inside(legacy) || inside(legacySoda)) return;
    if (!fs.existsSync(legacySoda) && !fs.existsSync(path.join(legacy, 'device.json'))) return;

    // 迁移设备身份
    const srcDevice = fs.existsSync(path.join(legacySoda, 'device.json'))
      ? path.join(legacySoda, 'device.json') : path.join(legacy, 'device.json');
    const dstDevice = deviceFile();
    if (!fs.existsSync(dstDevice) && fs.existsSync(srcDevice)) {
      try {
        fs.mkdirSync(path.dirname(dstDevice), { recursive: true });
        fs.copyFileSync(srcDevice, dstDevice);
        log('已把旧数据目录里的设备身份迁移到新的数据目录');
      } catch (e) { }
    }

    let n = 0;
    for (const t of [legacySoda, path.join(legacy, 'device.json')]) {
      try {
        if (!fs.existsSync(t)) continue;
        fs.rmSync(t, { recursive: true, force: true });
        n++;
      } catch (e) { }
    }
    if (n) log('已清理旧版明文数据目录 ' + legacy);
  } catch (e) { }
}

let _resyncing = null;
/** 登录态失效时自动重同步（客户端还登录着就无感恢复） */
async function tryResync(reason) {
  if (_resyncing) return _resyncing;
  log('登录态疑似失效（' + reason + '），尝试重新同步 …');
  _resyncing = refreshSessionFromClient().catch(e => { log('自动重同步失败: ' + e.message); }).finally(() => { _resyncing = null; });
  return _resyncing;
}

// ============================================================ 汽水 API
function baseQuery() {
  return {
    aid: APP_ID, app_name: 'luna_pc', region: 'cn', geo_region: 'cn', os_region: 'cn', sim_region: '',
    device_id: DEV.did, cdid: '', iid: DEV.iid, version_name: APP_VERSION, version_code: '30080000',
    channel: CHANNEL, build_mode: 'master', network_carrier: '', ac: 'wifi',
    tz_name: 'Asia/Shanghai', resolution: '', device_platform: 'windows', device_type: 'Windows',
    os_version: 'Windows 11 Pro for Workstations', fp: DEV.did,
  };
}
function buildUrl(p) {
  return API + p + '?' + Object.entries(baseQuery()).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
}
/** 加签。签名器住在子进程里，所以这里改成异步（调用点都要 await）。 */
async function signedHeaders(url, extra, body) {
  if (!host) await initNative();
  const h = { 'user-agent': UA, ...extra };
  if (COOKIE) h['cookie'] = COOKIE;
  if (body) h['x-ss-stub'] = crypto.createHash('md5').update(body).digest('hex').toUpperCase();
  const lines = Object.entries(h).map(([k, v]) => k + '\r\n' + v).join('\r\n');
  const parts = String(await hostCall('sign', { url, lines })).split('\r\n').filter(t => t.trim());
  for (let i = 0; i < parts.length / 2; i++) h[parts[i * 2]] = parts[i * 2 + 1];
  return h;
}
function req(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = assertFetchable(url);   // 上游返回的播放地址也先过一遍 https/公网校验
    const r = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers }, res => {
      const c = []; res.on('data', x => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(c) }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const reqJson = async (url, opt) => JSON.parse((await req(url, opt)).buf.toString());

async function rpcPostOnce(p, body) {
  const url = buildUrl(p);
  const b = body === undefined ? null : JSON.stringify(body);
  const headers = await signedHeaders(url, { 'content-type': 'application/json; charset=utf-8' }, b);
  return reqJson(url, { method: 'POST', headers, body: b });
}
async function rpcGetOnce(p, extra) {
  const url = buildUrl(p) + (extra ? '&' + Object.entries(extra).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&') : '');
  return reqJson(url, { method: 'GET', headers: await signedHeaders(url, {}) });
}
/** 登录态失效（1000016）时自动重同步一次再重试 */
async function rpcPost(p, body) {
  const j = await rpcPostOnce(p, body);
  if (j && j.status_code === 1000016) { await tryResync('1000016'); return rpcPostOnce(p, body); }
  return j;
}
async function rpcGet(p, extra) {
  const j = await rpcGetOnce(p, extra);
  if (j && j.status_code === 1000016) { await tryResync('1000016'); return rpcGetOnce(p, extra); }
  return j;
}
/** 本机 / 内网地址判定：SSRF 的最后一道闸。CDN 重定向也不能把我们带到内网去。 */
function isPrivateHost(hostname) {
  const h = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const p = h.split('.').map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127
      || (p[0] === 169 && p[1] === 254)
      || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
      || (p[0] === 192 && p[1] === 168)
      || p[0] >= 224;
  }
  if (h.includes(':')) {
    return h === '::' || h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd');
  }
  return false;
}

/** 只允许 https + 公网主机 + 443 端口 */
function assertFetchable(url) {
  let u;
  try { u = new URL(String(url)); } catch (e) { throw new Error('bad url'); }
  if (u.protocol !== 'https:') throw new Error('只允许 https: ' + u.protocol);
  if (isPrivateHost(u.hostname)) throw new Error('拒绝访问本机/内网地址: ' + u.hostname);
  if (u.port && u.port !== '443') throw new Error('只允许 443 端口');
  return u;
}

function getBuf(url, extraHeaders, maxRedirect = 5) {
  return new Promise((resolve, reject) => {
    const u = assertFetchable(url);   // 每一跳都校验，重定向绕不过去
    // 超时兜底：汽水的封面 CDN 偶尔会「连上了但不回数据」（尤其 douyinpic 那批）。
    // 没有超时的话这个 Promise 永不 settle → getCoverArt 永不响应 → Folia 那张 <img>
    // 就一直停在 pending，界面上就是一块**纯空白**（既没有破图图标，也没有占位图）。
    const req = https.get({ hostname: u.hostname, path: u.pathname + u.search, timeout: 12000, headers: { 'user-agent': UA, ...(extraHeaders || {}) } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirect > 0) {
        res.resume();
        const loc = new URL(res.headers.location, url).toString();
        return getBuf(loc, extraHeaders, maxRedirect - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** track_v2 → 原始 track 元数据 + 歌词 + 各档位流信息 */
async function trackV2Raw(trackId) {
  trackId = safeTrackId(trackId);
  const body = JSON.stringify({ track_id: String(trackId), media_type: 'track', queue_type: 'daily_mix', scene_name: 'track_reco' });
  const url = buildUrl('/luna/pc/track_v2');
  const headers = await signedHeaders(url, { 'content-type': 'application/json; charset=utf-8' }, body);
  const j = await reqJson(url, { method: 'POST', headers, body });
  const tr = j.track, tp = j.track_player;
  if (!tr) throw new Error('track_v2 无 track');
  let items = [];
  if (tp && tp.video_model) {
    const vm = JSON.parse(tp.video_model);
    items = vm.video_list.map(v => ({ quality: v.video_meta.quality, main_url: v.main_url, spade_a: v.encrypt_info ? v.encrypt_info.spade_a : null }));
  } else if (tp && tp.url_player_info) {
    const gi = await reqJson(tp.url_player_info);
    items = gi.Result.Data.PlayInfoList.map(p => ({ quality: p.Quality, main_url: p.MainPlayUrl, spade_a: p.PlayAuth }));
  }
  return { track: tr, lyric: (j.lyric || {}).content || '', translations: (j.lyric || {}).translations || null, items };
}

/**
 * 只取歌词，不取音频（给模组的 lyrics.transform 预取用）。
 * 路径：已缓存的 meta.json → 已缓存的歌词文件 → 打一次 track_v2。
 * 绝不走 ensureAudio —— 那会顺带下载并解密整首歌（无损 25MB，2–5 秒），预取等不起。
 */
async function fetchLyricOnly(trackId) {
  trackId = safeTrackId(trackId);
  const f = path.join(lyricDir(), trackId + '.txt');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  const metaFile = path.join(cacheDir(), trackId + '.json');
  if (fs.existsSync(metaFile)) {
    try {
      const m = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (m && typeof m.lyric === 'string') {
        fs.mkdirSync(lyricDir(), { recursive: true });
        fs.writeFileSync(f, m.lyric);
        return m.lyric;
      }
    } catch (e) { }
  }
  await waitReady(20000);        // 启动竞态：登录态 / 签名器没好先等，别让宿主的歌词请求空手而归
  const { lyric } = await trackV2(trackId);
  fs.mkdirSync(lyricDir(), { recursive: true });
  fs.writeFileSync(f, lyric || '');
  return lyric || '';
}

/**
 * 歌词用的轻量元信息（**不下载、不解密音频**）。
 * -----------------------------------------------------------------------------
 * 之前歌词接口走 ensureAudio()，为了拿一段 KRC 会把整首歌下载+解密一遍：
 *   · 重启后第一次播歌时，歌词请求和「这首歌自己的取流」抢同一个签名/带宽，
 *     宿主的歌词请求 25 秒超时 → 面板上留着**上一次关闭时那首**的歌词，
 *     切下一首就好了（这首的音频此时已缓存），再切回来也正常。
 * 现在只调 track_v2 拿 lyric / 标题，标题优先用曲库里已有的。
 */
async function ensureLyricMeta(trackId) {
  trackId = safeTrackId(trackId);
  const metaFile = path.join(cacheDir(), trackId + '.json');
  if (fs.existsSync(metaFile)) {
    try {
      const m = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (m && typeof m.lyric === 'string') return m;      // 已解密过：meta 里有歌词，直接用
    } catch (e) { }
  }
  await waitReady(20000);        // 启动竞态：登录态 / 签名器还没好的话先等一会儿，别直接失败
  const { track, lyric, translations } = await trackV2(trackId);
  const known = CATALOG.tracks.get(String(trackId));
  const meta = {
    id: String(trackId),
    name: (known && known.name) || track.name,
    artists: (known && known.artists) || (track.artists || []).map(a => a.name),
    lyric: lyric || '',
    translations: translations === undefined ? null : translations,
  };
  try { fs.mkdirSync(lyricDir(), { recursive: true }); fs.writeFileSync(path.join(lyricDir(), trackId + '.txt'), meta.lyric); } catch (e) { }
  return meta;
}

/**
 * trackV2 的 60 秒短缓存。
 * 为什么需要：取流路径现在会先问一次「这首是不是无损档」（tryStreamFlac），
 * 走整首兜底时 ensureAudio 又要同样的数据 —— 两次 track_v2 各 ~250ms，
 * 首字节直接多出半秒。缓存只留在内存里，过期即失效，不加任何一致性负担。
 */
const TV2_MEMO = new Map();
function trackV2(trackId) {
  const key = String(trackId);
  const hit = TV2_MEMO.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.p;
  const p = trackV2Raw(trackId);
  TV2_MEMO.set(key, { at: Date.now(), p });
  p.catch(() => TV2_MEMO.delete(key));
  if (TV2_MEMO.size > 500) TV2_MEMO.delete(TV2_MEMO.keys().next().value);
  return p;
}

function pickItem(items) {
  if (!items || !items.length) throw new Error('无可用流');
  if (QUALITY === 'best') {
    const avail = items.filter(x => x.spade_a);
    if (!avail.length) throw new Error('无可解密档');
    return avail.slice().sort((a, b) => ORDER.indexOf(a.quality) - ORDER.indexOf(b.quality))[0];
  }
  return items.find(x => x.quality === QUALITY) || items[0];
}

function coverUrlOf(tr) {
  const c = tr.album && tr.album.url_cover;
  if (!c || !c.uri) return '';
  const base = (c.urls && c.urls[0]) || 'https://p3-luna.douyinpic.com/img/';
  return base + c.uri + '~' + (c.template_prefix || 'tplv-b829550vbb') + '-crop-center:800:800.jpg';
}
/** 换掉封面 URL 里的尺寸段（`crop-center:800:800` → `crop-center:200:200`），让汽水 CDN 直接出小图 */
function resizeCoverUrl(url, px) {
  return String(url).replace(/(crop-center:)\d+:\d+/, '$1' + px + ':' + px);
}

function rawCoverOf(tr) {
  const c = tr.album && tr.album.url_cover;
  if (!c || !c.uri) return '';
  const base = (c.urls && c.urls[0]) || 'https://p3-luna.douyinpic.com/img/';
  // 必须带模板后缀，否则 douyinpic 返回 404
  return base + c.uri + '~' + (c.template_prefix || 'tplv-b829550vbb') + '-crop-center:800:800.jpg';
}

/**
 * 「试听片段」检测（可选功能，默认关闭，开关在模组面板）。
 * 汽水 VIP 到期后 **PC 链路**只下发 30~60 秒试听档（手机端仍是完整版）。
 * 开启后：取流时对比真实时长 / 文件体积，命中即记入数据目录 `_trial.json`；
 * 歌单与搜索里歌名加「（试听）」后缀，续播默认跳过；整批都是试听时兜底放行。
 */
const TRIAL_FILE = () => path.join(dataDir(), '_trial.json');
let TRIAL_IDS = null;
function loadTrials() {
  if (TRIAL_IDS) return TRIAL_IDS;
  TRIAL_IDS = new Set();
  try { TRIAL_IDS = new Set(JSON.parse(fs.readFileSync(TRIAL_FILE(), 'utf8')) || []); } catch (e) { }
  return TRIAL_IDS;
}
/** 开关关闭时一律视为非试听，历史缓存也不生效 */
function isTrial(id) {
  if (!trialEnabled()) return false;
  return loadTrials().has(String(id));
}
function markTrial(id) {
  if (!trialEnabled()) return false;
  const set = loadTrials();
  const k = String(id);
  if (set.has(k)) return false;
  set.add(k);
  try { fs.writeFileSync(TRIAL_FILE(), JSON.stringify([...set])); } catch (e) { }
  return true;
}

/**
 * mp4/m4a 的 mvhd 时长（毫秒）；认不出返回 0。
 * 偏移相对 **盒起始**：type 在 i 时，version 在 i+4、v0 timescale 在 i+16、duration 在 i+20。
 */
function mp4DurationMs(buf) {
  try {
    for (let i = 0; i + 44 <= buf.length; i++) {
      if (buf.readUInt32BE(i) !== 0x6D766864) continue;        // 'mvhd'
      const v = buf[i + 4];
      if (v === 1) return Number(buf.readBigUInt64BE(i + 28)) / buf.readUInt32BE(i + 24) * 1000;
      return buf.readUInt32BE(i + 20) / buf.readUInt32BE(i + 16) * 1000;
    }
  } catch (e) { }
  return 0;
}
/** flac 的 STREAMINFO 时长（毫秒）；认不出返回 0 */
function flacDurationMs(buf) {
  try {
    if (buf.length < 42 || buf.toString('latin1', 0, 4) !== 'fLaC') return 0;
    // 'fLaC'(4) + 块头(4) + min/max block(4) + min/max frame(6) = 18
    const packed = buf.readBigUInt64BE(18);
    const rate = Number(packed >> 44n);
    const total = Number(packed & 0xFFFFFFFFFn);
    return rate ? total / rate * 1000 : 0;
  } catch (e) { }
  return 0;
}
/** 按文件内容判断格式（不看扩展名，试听档和整曲可能不同） */
function audioDurationMs(buf) {
  if (!buf || buf.length < 16) return 0;
  if (buf.toString('latin1', 0, 4) === 'fLaC') return flacDurationMs(buf);
  return mp4DurationMs(buf);
}

/** 取流 + 解密 + 落盘缓存 */
const AUDIO_INFLIGHT = new Map();        // id -> promise：同一个 id 的并发请求只做一次下载/解密
async function ensureAudio(trackId) {
  trackId = safeTrackId(trackId);
  const metaFile = path.join(cacheDir(), trackId + '.json');
  const hit = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : null;
  if (hit && fs.existsSync(path.join(cacheDir(), hit.file))) return hit;

  // 单飞：宿主取流 / 预取 / 歌词兜底可能同时要同一首，重复下载既慢又浪费带宽
  const pending = AUDIO_INFLIGHT.get(trackId);
  if (pending) return pending;
  const job = (async () => {
    const t0 = Date.now();
    const { track, lyric, translations, items } = await trackV2(trackId);
    const t1 = Date.now();
    const pick = pickItem(items);
    const kr = await hostCall('decodeSpade', { spade: pick.spade_a });
    const t2 = Date.now();
    // decrypt() 要的是 hex 字符串；原生模块正常回字符串，万一回 Buffer 就按 latin1 还原
    const key = kr.kind === 'string' ? kr.text : Buffer.from(kr.b64, 'base64').toString('latin1');
    let coverBuf = null;
    const cu = coverUrlOf(track);
    if (cu) { try { coverBuf = await getBuf(cu); } catch (e) { } }
    const enc = await getBuf(pick.main_url);
    const t3 = Date.now();
    const r = CORE.decrypt(enc, key, {
      title: track.name,
      artist: (track.artists || []).map(a => a.name).join(' / '),
      album: (track.album || {}).name || '',
      lyric, coverBuf,
    });
    const fname = trackId + r.ext;
    // 试听判定（开关开启时才做）：真实时长 < min(90s, 官方 60%)，或体积 < 按码率推算的一半
    let trial = false;
    if (trialEnabled()) {
      try {
        const declared = Number(track.duration || 0);
        const real = audioDurationMs(r.data);
        if (real > 0 && declared > 0 && real < Math.min(90000, declared * 0.6)) trial = true;
        if (!trial && declared > 0) {
          const br = Number(pick.br || 0);
          const expect = br > 0 ? declared / 1000 * br * 1000 / 8 : 0;
          if (expect > 0 && r.data.length < expect * 0.5) trial = true;
        }
        if (trial && markTrial(trackId)) log('试听片段：' + track.name
          + (real ? '（实际 ' + (real / 1000).toFixed(0) + 's）' : '')
          + ' / 官方 ' + (declared / 1000).toFixed(0) + 's —— PC 链路只给了试听档');
      } catch (e) { }
    }
    sweepCache();   // 落盘前兜一下容量上限
    fs.writeFileSync(path.join(cacheDir(), fname), r.data);
    const meta = {
      id: String(trackId), file: fname, ext: r.ext, kind: r.kind, quality: pick.quality, trial,
      name: track.name, artists: (track.artists || []).map(a => a.name),
      artistIds: (track.artists || []).map(a => String(a.id)),
      album: (track.album || {}).name || '', albumId: String((track.album || {}).id || ''),
      cover: rawCoverOf(track), lyric,
      translations: translations || null,
      duration: track.duration || 0,
    };
    fs.writeFileSync(metaFile, JSON.stringify(meta));
    log('取流完成 ' + meta.name + ' [' + meta.quality + '] ' + (r.data.length / 1048576).toFixed(1) + 'MB');
    log('耗时 → track_v2 ' + (t1 - t0) + 'ms / decodeSpade ' + (t2 - t1) + 'ms / 下载 ' + (t3 - t2) + 'ms ('
      + (enc.length / 1048576).toFixed(1) + 'MB) / 解密 ' + (Date.now() - t3) + 'ms');
    return meta;
  })().finally(() => AUDIO_INFLIGHT.delete(trackId));
  AUDIO_INFLIGHT.set(trackId, job);
  return job;
}

// ============================================================ 曲库来源
function readQueueCache() {
  const p = path.join(APPDATA, 'SodaMusic', 'LunaStorage', 'QueueCache');
  if (!fs.existsSync(p)) return [];
  const d = fs.readFileSync(p);
  if (d.subarray(0, 4).toString() !== 'LUNA') return [];
  const j = JSON.parse(zlib.gunzipSync(d.subarray(4)).toString('utf8'));
  const out = [];
  for (const [k, v] of Object.entries(j)) {
    for (const pl of (v.playables || [])) {
      const t = pl.track || {};
      if (!t.id) continue;
      out.push({
        id: String(t.id), name: t.name,
        artists: (t.artists || []).map(a => a.name),
        artistIds: (t.artists || []).map(a => String(a.id)),
        album: (t.album || {}).name || '', albumId: String((t.album || {}).id || ''),
        cover: rawCoverOf(t), duration: t.duration || 0,
      });
    }
  }
  return out;
}

function normTrack(raw) {
  return {
    id: String(raw.id), name: raw.name,
    artists: (raw.artists || []).map(a => (typeof a === 'string' ? a : a.name)),
    artistIds: (raw.artists || []).map(a => (typeof a === 'string' ? '' : String(a.id))),
    album: (raw.album && raw.album.name) || raw.albumName || '', albumId: String((raw.album && raw.album.id) || ''),
    cover: rawCoverOf(raw), duration: raw.duration || 0,
  };
}

async function fetchMyPlaylists() {
  const j = await rpcGet('/luna/pc/me/playlist', { cursor: '0', count: '100' });
  return (j.playlists || []).map(p => ({
    id: String(p.id), name: p.title || p.name || '未命名',
    count: p.count_tracks || p.track_count || 0,
    cover: (p.url_cover && p.url_cover.uri) ? (() => {
      // douyinpic 的封面 URL 必须带模板后缀（~tplv-xxx-crop-center:WxH.jpg）才返回 200，
      // 裸 URI 是 404 —— 之前歌单封面就是漏了这一步，导致自建歌单在书库里全没封面。
      const base = ((p.url_cover.urls && p.url_cover.urls[0]) || 'https://p3-luna.douyinpic.com/img/') + p.url_cover.uri;
      return /~tplv|~crop/.test(base) ? base : base + '~tplv-b829550vbb-crop-center:800:800.jpg';
    })() : '',
  }));
}

/** 首页「推荐」（默认模式）的推荐歌单 —— GET /luna/pc/me/playlist/recommend，
 *  返回带 daily_playlist_info 的每日推荐歌单。曲目走通用的 /luna/pc/playlist/detail。
 *  注意：playlist-square 是「听歌模式」的歌单广场，不是首页推荐要的。 */
async function fetchRecommendedPlaylists(n) {
  let r = null;
  for (const p of ['/luna/pc/me/playlist/recommend', '/luna/me/playlist/recommend']) {
    try { r = await rpcGet(p, { count: '20' }); if (r && (r.playlists || []).length) break; } catch (e) { r = null; }
  }
  const out = [];
  for (const p of ((r && r.playlists) || [])) {
    if (!p.id) continue;
    out.push({
      id: String(p.id),
      name: (p.daily_playlist_info && p.daily_playlist_info.title) || p.title || '每日推荐',
      count: p.count_tracks || p.track_count || 0,
      cover: (p.url_cover && p.url_cover.uri) ? (() => {
        const base = ((p.url_cover.urls && p.url_cover.urls[0]) || 'https://p3-luna.douyinpic.com/img/') + p.url_cover.uri;
        return /~tplv|~crop/.test(base) ? base : base + '~tplv-b829550vbb-crop-center:800:800.jpg';
      })() : '',
    });
  }
  return out.slice(0, n || 20);
}

/**
 * 歌单广场（POST /luna/pc/feed/playlist-square）—— 听歌模式里的推荐歌单格子，items 全是 type=playlist。
 * 曲目走通用的 /luna/pc/playlist/detail（用到时才拉）。
 *
 * 这个接口是**滚动推荐**：`offset` 分页有效，每次返回不同的歌单。所以不再固定 10 个，
 * 而是按页拉到没有新歌单为止（默认最多 6 页 × 20 ≈ 100 个，去重后通常 60~80）。
 * 想少拉就设环境变量 `SODA_SQUARE_PAGES`（独立运行才认，见「配置」一节的说明）。
 */
const SQUARE_PAGE = 20;
const SQUARE_MAX_PAGES = Math.max(1, parseInt(process.env.SODA_SQUARE_PAGES || '6', 10));

async function fetchPlaylistSquare(maxPages) {
  const pages = Math.max(1, maxPages || SQUARE_MAX_PAGES);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < pages; i++) {
    let r;
    try {
      r = await rpcPost('/luna/pc/feed/playlist-square', {
        count: SQUARE_PAGE,
        offset: i * SQUARE_PAGE,
        is_first_request: i === 0,
      });
    } catch (e) {
      if (i === 0) throw e;          // 第一页就失败 → 交给上层记日志
      break;                          // 后续页失败就用已有结果，不要把整份目录搞挂
    }
    const items = (r && r.items) || [];
    if (!items.length) break;
    let added = 0;
    for (const it of items) {
      const p = (it.entity && it.entity.playlist) || {};
      if (!p.id || seen.has(String(p.id))) continue;
      seen.add(String(p.id));
      out.push({
        id: String(p.id), name: p.title || p.name || '未命名',
        count: p.count_tracks || p.track_count || 0,
        cover: (p.url_cover && p.url_cover.uri) ? (() => {
          const base = ((p.url_cover.urls && p.url_cover.urls[0]) || 'https://p3-luna.douyinpic.com/img/') + p.url_cover.uri;
          return /~tplv|~crop/.test(base) ? base : base + '~tplv-b829550vbb-crop-center:800:800.jpg';
        })() : '',
      });
      added++;
    }
    if (!added) break;                // 这一页全是重复 → 接口翻不动了
  }
  return out;
}

async function fetchPlaylistTracks(pid) {
  const out = [];
  let cursor = '0', page = 0;
  while (page < 40) {
    const j = await rpcGet('/luna/pc/playlist/detail', { playlist_id: pid, cursor, count: '100' });
    for (const m of (j.media_resources || [])) {
      const t = (m.entity && m.entity.track_wrapper && m.entity.track_wrapper.track) || null;
      if (t && t.id) out.push(normTrack(t));
    }
    if (!j.has_more || !j.next_cursor) break;
    cursor = j.next_cursor; page++;
  }
  return out;
}

const FEED_CONCURRENCY = parseInt(process.env.FEED_CONCURRENCY || '5', 10);    // 并发抓取（每次请求都要过一遍原生签名，太激进会让整机跟着抖）
const FEED_BATCH = 6;                                   // 汽水 feed 每次固定返 6 首
const FEED_MAX_COUNT = parseInt(process.env.FEED_MAX || '300', 10);  // 单次给到歌单的上限

/**
 * 推荐流 = 一个「只增不减、会话内不重复」的滚动池。
 * ---------------------------------------------------------------------------
 * 汽水 feed 的语义是「每次调用给一批新的」（响应只有 has_more，没有 next_cursor），
 * 所以续拉 = 反复调用 + 去重。把它做成池子：
 *   · 池里够 → 立刻返回（秒开），同时后台补货，下次更快
 *   · 池里不够 → 等一次并发抓取
 *   · seen 集合保证会话内永不重复 → 每次点进「④ 推荐流」都是全新的歌，可以一直听下去
 * Folia 侧能用的「续拉」也就到这个形态：它的播放队列是定长数组，没有续拉钩子。
 */
const feedPool = { q: [], seen: new Set(), filling: null };

async function fillFeed(target) {
  if (feedPool.filling) return feedPool.filling;
  feedPool.filling = (async () => {
    let rounds = 0;
    while (feedPool.q.length < target && rounds < 10) {
      rounds++;
      const need = Math.ceil((target - feedPool.q.length) / FEED_BATCH);
      const n = Math.max(1, Math.min(need, FEED_CONCURRENCY));
      let rs;
      try {
        rs = await Promise.all(Array.from({ length: n }, () =>
          rpcPost('/luna/pc/feed/song-tab', { count: FEED_BATCH, is_first_request: true }).catch(() => null)));
      } catch (e) { break; }
      let fresh = 0;
      for (const j of rs) {
        if (!j) continue;
        for (const it of (j.items || [])) {
          const t = (it.entity && it.entity.track_wrapper && it.entity.track_wrapper.track) || null;
          if (!t || !t.id) continue;
          const id = String(t.id);
          if (feedPool.seen.has(id)) continue;
          feedPool.seen.add(id);
          feedPool.q.push(normTrack(t));
          fresh++;
        }
      }
      if (!fresh) break;
      if (feedPool.seen.size > 20000) feedPool.seen.clear();   // 防无限增长
    }
  })().finally(() => { feedPool.filling = null; });
  return feedPool.filling;
}

/** 每次要给出去的量 */
const feedWant = () => Math.min(FEED_PAGES * FEED_BATCH, FEED_MAX_COUNT);

/**
 * 池子维持的库存 = 2 倍给量。
 * 为什么要 2 倍：取走一次后还剩一整份，下一次仍然是秒开（试过只留一份缓冲，
 * 第二次打开要现场抓 7 秒）。单次给量已从 120 降到 72，所以总请求数反而少了。
 */
const feedTarget = () => feedWant() * 2;

/** 取任意 N 首推荐（池里够就秒回，并后台补回库存）—— 续播就靠这个 */
async function fetchFeedN(n) {
  const want = Math.max(1, Math.min(n || feedWant(), FEED_MAX_COUNT));
  if (feedPool.q.length < want) await fillFeed(Math.max(want, feedTarget()));
  const out = feedPool.q.splice(0, want);
  fillFeed(feedTarget()).catch(() => { });     // 后台补，保证下次还是秒开
  return out;
}

/** 取一批推荐（歌单用的默认量） */
const fetchFeedCached = () => fetchFeedN(feedWant());

/** 预热池子：启动 / 每次目录刷新后调用 */
function prewarmFeed() {
  fillFeed(feedTarget()).catch(() => { });
}

/**
 * 「歌 → 歌单」反查索引 —— 续播跟着**当前歌单**走靠它。
 * ===========================================================================
 * 为什么要反查：Folia 的书库走标准 Navidrome 通道，模组的 client 根本不在那条路上，
 * 拿不到「用户点的是哪个歌单」。它能拿到的只有 `playback.getState().currentSong`，
 * 所以只能拿当前这首曲目去曲库里反查它出现在哪些歌单里，再用那个歌单当续播上下文。
 *
 * 构建代价：要把所有歌单的曲目拉一遍（十几个 playlist/detail，每个都过原生签名）。
 * 因此：① 只在后台预热，**绝不让续播请求等它**；② 带 TTL；③ 单个歌单失败不影响其它。
 * 索引没就绪时 takeFromContext 直接返回空 → 调用方落回通用推荐流，行为跟以前一样。
 */
const CTX_TTL = 30 * 60 * 1000;
const ctxIndex = { bySong: null, at: 0, building: null };

/**
 * 粘性上下文：最近一次成功反查出来的歌单。
 *
 * 为什么需要：相关推荐补进来的歌**不在歌单里**，下一轮拿它反查必然落空 ——
 * 没有粘性的话，风格会在「歌单 → 相关推荐 → 通用流」之间断掉。
 * 有了它，从歌单播出去之后风格能一直延续；切走 15 分钟后自动脱落，不会串味。
 */
const stickyCtx = { plIds: [], names: [], at: 0 };
const STICKY_TTL = 15 * 60 * 1000;

function buildContextIndex() {
  if (ctxIndex.building) return ctxIndex.building;
  ctxIndex.building = (async () => {
    const bySong = new Map();
    const list = CATALOG.playlists.filter(p => p.srcId && !p.live);   // 虚拟来源（推荐流）不参与
    let done = 0;
    for (const pl of list) {
      try {
        const ts = await playlistTracks(pl);
        for (const t of ts) {
          const id = String(t.id);
          const arr = bySong.get(id);
          if (arr) { if (!arr.includes(pl.id)) arr.push(pl.id); }
          else bySong.set(id, [pl.id]);
        }
        done++;
      } catch (e) { /* 单个歌单拉失败就跳过 */ }
    }
    if (bySong.size) {
      ctxIndex.bySong = bySong;
      ctxIndex.at = Date.now();
      log('续播上下文索引已建：' + bySong.size + ' 曲 / ' + done + '/' + list.length + ' 个歌单');
    } else {
      // 一个歌单都没拉到：这是「续播永远跟不上歌单」的头号嫌疑，必须留痕
      log('续播上下文索引为空：' + done + '/' + list.length + ' 个歌单成功，bySong.size=0');
    }
    diagAdd({
      at: new Date().toISOString(), event: 'buildContextIndex',
      songs: bySong.size, playlists: list.length, ok: done,
      names: list.map(p => p.name),
    });
  })().catch((e) => { log('续播上下文索引失败: ' + e.message); })
     .finally(() => { ctxIndex.building = null; });
  return ctxIndex.building;
}

/** 索引是否就绪（过期也算不就绪） */
const ctxReady = () => !!(ctxIndex.bySong && Date.now() - ctxIndex.at < CTX_TTL);

/** 触发一次后台构建，不等待 */
function touchContextIndex() {
  if (!ctxIndex.building && !ctxReady()) buildContextIndex();
}

/**
 * 按种子曲目拉「同风格」的歌 —— `POST /luna/track/related`。
 * ===========================================================================
 * 结构取自汽水客户端 asar 的 `GetRelatedTracksRequest`：
 *   { track_ids?: string[], artist_ids?: string[], scene_name?: string, ... }（全部可选）
 * **只给 `track_ids` 当种子就行** —— 不用像 `/luna/playlist/feed/media` 那样凑一堆
 * 上下文参数（那个实测 15 个歌单 × 两种 play_mode 全返回空）。
 *
 * 实测响应形状（与 `/luna/pc/feed/song-tab` 一致，所以能共用同一套取值路径）：
 *   { status_info, has_more: boolean, items: [{ id, type:'track',
 *       entity: { track_wrapper: { track: {...} } } }] }
 * 只有 `has_more`、**没有游标** ⇒ 想持续拉就得**换种子**（见 takeFromContext）。
 */
function pickTrackFromItem(it) {
  if (!it || typeof it !== 'object') return null;
  const t = (it.entity && it.entity.track_wrapper && it.entity.track_wrapper.track)
    || it.track_wrapper && it.track_wrapper.track
    || it.track
    || (it.entity && it.entity.track)
    || null;
  return (t && t.id) ? t : null;
}

/** 已经从「按种子推荐」给出去过的歌（按顺序），用来告诉服务端「这些我听过了」 */
const relatedGiven = [];
const RELATED_GIVEN_MAX = 120;

async function lunaRelatedTracks(seedIds, dump) {
  const ids = (seedIds || []).filter(Boolean).slice(0, 8).map(String);
  if (!ids.length) return null;
  const body = { track_ids: ids };
  // `played_media`（客户端 asar 的 media.MediaPlayed）：把已经给出去过的歌报上去，
  // 服务端据此换一批新的 —— 只回 has_more 没有游标，这是唯一能「翻页」的手段。
  if (relatedGiven.length) {
    body.played_media = relatedGiven.slice(-50).map((id) => {
      const t = CATALOG.tracks.get(id);
      return { media_id: String(id), type: 'track', played_mills: 0, duration: (t && t.duration) || 0 };
    });
  }
  const j = await rpcPost('/luna/track/related', body);
  const items = (j && Array.isArray(j.items)) ? j.items : [];
  const tracks = [];
  for (const it of items) {
    const t = pickTrackFromItem(it);
    if (t) tracks.push(normTrack(t));
  }
  if (dump && !tracks.length) {
    diagAdd({
      at: new Date().toISOString(), event: 'relatedTracks-unparsed',
      seeds: ids, played: (body.played_media || []).length, status_code: j && j.status_code,
      keys: j ? Object.keys(j) : null,
      shape: j ? JSON.stringify(j).slice(0, 2000) : null,
    });
  }
  return { tracks, hasMore: !!(j && j.has_more), count: items.length };
}

/**
 * 从「当前这首曲目所属的歌单」里挑还没给出去过的歌。
 * 拿不到上下文（索引没建好 / 这首歌不在任何歌单里）就返回空，调用方落回通用推荐流。
 * 给出去的会记进 feedPool.seen，并顺手从待发队列里摘掉，保证同一次会话内不重复。
 *
 * 返回里带一个 `info`，说明这次为什么走上/没走上歌单 —— 续播出问题时全靠它定位，
 * 设 `SODA_DIAG=1` 后会写进 paths.data/diag.json（见 diagAdd）。
 */
async function takeFromContext(seedId, n) {
  const info = {
    ready: ctxReady(),
    indexSize: ctxIndex.bySong ? ctxIndex.bySong.size : 0,
    building: !!ctxIndex.building,
    hit: [],
    reason: '',
  };
  if (!info.ready) {
    touchContextIndex();                       // 顺手把它催起来，下一次就成了
    info.reason = '索引未就绪';
    return { songs: [], name: '', info };
  }
  const plIds = ctxIndex.bySong.get(String(seedId));
  if (!plIds || !plIds.length) {
    if (stickyCtx.plIds.length && Date.now() - stickyCtx.at < STICKY_TTL) {
      // 当前这首歌已经不是歌单里的了（比如上一轮 related 补进来的）——
      // 沿用上一次的上下文，风格才不会被切断。
      info.hit = stickyCtx.names;
      info.sticky = true;
      info.reason = '当前歌不在歌单里，沿用上一次的上下文';
      return await serveFromPlaylists(stickyCtx.plIds, seedId, n, '', info);
    }
    info.reason = '这首歌不在任何已收录的歌单里';
    return { songs: [], name: '', info };
  }
  stickyCtx.plIds = plIds;
  stickyCtx.at = Date.now();
  stickyCtx.names = plIds.map(id => (CATALOG.playlists.find(p => p.id === id) || {}).name).filter(Boolean);
  info.hit = stickyCtx.names;
  return await serveFromPlaylists(plIds, seedId, n, '', info);
}

/**
 * 续播的主体：先从歌单的静态曲目里取，取完再用**歌单里的歌当种子**调
 * `/luna/track/related` 拉同风格的歌。
 *
 * 种子**每轮随机抽**（不从同一处拿）—— 因为 related 接口只回 `has_more`、没有游标，
 * 用固定种子只会每次要回同一批，被去重集合一挡就再也给不出新歌。随机抽能保证
 * 每轮落在歌单风格的不同邻域里，于是能一直续下去；同时把「当前正在播的歌」也塞进去
 * 当锚点，保证跟着当下的听感走。
 */
async function serveFromPlaylists(plIds, seedId, n, usedName, info) {
  const out = [];
  const trialSkipped = [];
  const take = (t) => {
    const id = String(t.id);
    if (feedPool.seen.has(id)) return false;
    if (isTrial(id)) { trialSkipped.push(t); return false; }   // 试听档不进队（开关关闭时恒为 false）
    feedPool.seen.add(id);
    const qi = feedPool.q.findIndex(x => String(x.id) === id);
    if (qi >= 0) feedPool.q.splice(qi, 1);
    out.push(t);
    return true;
  };

  // 1) 歌单自带的曲目，优先
  const pool = [];
  for (const plId of plIds) {
    const pl = CATALOG.playlists.find(p => p.id === plId);
    if (!pl) continue;
    let ts = [];
    try { ts = await playlistTracks(pl); } catch (e) { continue; }
    for (const t of ts) { pool.push(String(t.id)); if (out.length < n) take(t); }
    if (out.length && !usedName) usedName = pl.name;
    if (out.length >= n) break;
  }
  info.pool = pool.length;
  info.trialSkipped = trialSkipped.length;
  // 候选全是试听片段（VIP 整个到期）：宁可不完整，也别让续播断掉
  if (!out.length && trialSkipped.length) {
    for (const t of trialSkipped) { if (out.length >= n) break; take(t); }
    info.trialFallback = true;
  }

  // 2) 歌单取完 → 按种子拉同风格的歌。**多轮换种子**：一次 related 只回十几个 item，
  //    而且用同一批种子要回来的基本是同一批（会被去重挡掉），所以每轮都重新随机抽种子。
  //
  //    种子池分两层：
  //      · origPool  —— 歌单自带的曲目。每轮固定占一半，**风格锚定在歌单上**，不会越漂越远。
  //      · grownPool —— 加上 related 长出来的新歌。另一半从这儿抽，池子才会自我增长；
  //                     只用 origPool 的话，抽几轮就全是重复的，续播第二次就枯竭。
  if (out.length < n) {
    const origPool = [...new Set(pool)];
    const grownPool = new Set(origPool);
    const anchor = /^\d{1,32}$/.test(String(seedId || '')) ? String(seedId) : '';
    let rounds = 0, fetched = 0, hasMore = false, used = 0, dry = 0;
    while (out.length < n && rounds < 14 && origPool.length) {
      rounds += 1;
      const seeds = anchor ? [anchor] : [];
      const draw = (arr, want, avoid) => {
        let guard = 0;
        while (seeds.length < want && guard < 40) {
          guard += 1;
          const pick = arr[Math.floor(Math.random() * arr.length)];
          if (!avoid.includes(pick)) { avoid.push(pick); seeds.push(pick); }
        }
      };
      const picked = [];
      draw(origPool, 2, picked);                                  // 锚定：1 首歌单原曲（+anchor）
      draw([...grownPool], 3, picked);                            // 再补 1 首，让邻域能往外跳
      if (!seeds.length) break;
      try {
        const r = await lunaRelatedTracks(seeds, rounds === 1);
        if (!r || !r.tracks.length) break;
        fetched += r.tracks.length;
        hasMore = r.hasMore;
        let got = 0;
        for (const t of r.tracks) {
          grownPool.add(String(t.id));
          if (out.length >= n) break;
          if (take(t)) {
            got += 1;
            used += 1;
            relatedGiven.push(String(t.id));
            if (relatedGiven.length > RELATED_GIVEN_MAX) relatedGiven.shift();
          }
        }
        if (!got) { dry += 1; if (dry >= 3) break; } else { dry = 0; }
      } catch (e) {
        info.related = { error: (e && e.message) || String(e) };
        break;
      }
    }
    if (rounds) info.related = { rounds, fetched, used, hasMore, pool: origPool.length, grown: grownPool.size };
    if (used && !usedName) usedName = stickyCtx.names[0] || '（同类推荐）';
  }

  if (!out.length) info.reason = info.reason || '这个歌单里已经给不出新歌了';
  return { songs: out, name: usedName, info };
}

/**
 * 续播决策的落盘记录。
 * 模组日志只发给渲染端、**不落盘**，而「续播为什么没跟上歌单」光看界面看不出来。
 * 所以把每次 /api/feed 的决策写进 paths.data/diag.json（最近 40 条），出问题直接读文件。
 * **默认关闭**（每次写盘不值得常开）：设环境变量 `SODA_DIAG=1` 才启用 —— 排查时打开即可。
 * 诊断本身绝不能影响功能 —— 所有失败都吞掉。
 */
const DIAG_ON = process.env.SODA_DIAG === '1';
const DIAG = [];
function diagAdd(rec) {
  if (!DIAG_ON) return;
  try {
    DIAG.push(rec);
    if (DIAG.length > 40) DIAG.shift();
    fs.writeFileSync(path.join(dataDir(), 'diag.json'), JSON.stringify(DIAG, null, 1));
  } catch (e) { /* 写不了就算了 */ }
}

// ============================================================ 目录缓存
const CATALOG = {
  tracks: new Map(),      // id -> normTrack
  playlists: [],          // {id,name,count,cover,tracks:fn|array}
  albums: new Map(),      // albumId -> {id,name,cover,artist,trackIds[]}
  artists: new Map(),     // artistId -> {id,name,trackIds[]}
  loadedAt: 0,
  loading: null,
};

function catalogAdd(t) {
  if (!t || !t.id) return;
  CATALOG.tracks.set(t.id, t);
  if (t.albumId) {
    let a = CATALOG.albums.get(t.albumId);
    if (!a) { a = { id: t.albumId, name: t.album || '未知专辑', cover: t.cover, artist: t.artists[0] || '', trackIds: [] }; CATALOG.albums.set(t.albumId, a); }
    if (!a.trackIds.includes(t.id)) a.trackIds.push(t.id);
  }
  (t.artistIds || []).forEach((aid, i) => {
    if (!aid) return;
    let ar = CATALOG.artists.get(aid);
    if (!ar) { ar = { id: aid, name: t.artists[i] || '未知歌手', trackIds: [] }; CATALOG.artists.set(aid, ar); }
    if (!ar.trackIds.includes(t.id)) ar.trackIds.push(t.id);
  });
}

/** live 来源的上次结果：只给 getPlaylists 显示条数与封面用 */
const lastLive = {};

/** 特殊歌单（非服务器歌单） */
const VIRTUAL = [
  // 「④ 推荐流」= 汽水的 feed。客户端的「启动播放队列」本来就是**同一条 feed 的快照** ——
  // 队列名就叫 `u_xxx:feed`，里面还带着播放位置（last_played_key）。所以这里不把它单列成
  // 第二个歌单（那样内容重复、还割裂），而是把它接在推荐流前面：
  //   · 开头   = 你上次听到的那一批（QueueCache 里的 feed 快照）
  //   · 后面   = 继续往后拉的新歌
  // 一进来就是熟悉的上下文，接着往下才是新推荐，跟客户端「打开就接着播」是同一个感觉。
  // 注意：续播用的 /api/feed 不加开头那一段 —— 那些是已经播过的，续播只要新歌。
  {
    id: 'v_feed',
    name: '④ 推荐流（在线）',
    load: async () => {
      // 只用在线 feed，不混入本地队列（QueueCache 是客户端上次听的旧歌，混进来顺序很怪）；上限 100 首
      return (await fetchFeedCached()).slice(0, 100);
    },
    live: true,
  },
];

async function refreshCatalog(force) {
  if (!force && Date.now() - CATALOG.loadedAt < CATALOG_TTL && CATALOG.tracks.size) return;
  if (CATALOG.loading) return CATALOG.loading;
  CATALOG.loading = (async () => {
    const t0 = Date.now();
    const pls = [];
    // 虚拟来源
    for (const v of VIRTUAL) {
      try {
        if (v.live) {
          pls.push({ id: v.id, name: v.name, count: 0, cover: '', virtual: true, live: true, loader: v.load,
                     tracks: (lastLive[v.id] || {}).tracks || null });
          const c = (lastLive[v.id] || {});
          pls[pls.length - 1].count = c.count || 0;
          pls[pls.length - 1].cover = c.cover || '';
          continue;
        }
        const ts = await v.load();
        // 封面取列表里第一首的封面；都没有就留空 —— 空串时 Folia 会画「名字首字母」占位图，
        // 比硬塞一个取不到的 id（→ 破图）好得多
        pls.push({ id: v.id, name: v.name, count: ts.length, cover: (ts[0] && ts[0].cover) || '', virtual: true, tracks: ts });
      } catch (e) { log('来源失败 ' + v.name + ': ' + e.message); }
    }
    // 在线歌单：我创建的 + 推荐页的歌单广场（type=playlist，走同一个 playlist/detail 入口）
    try {
      const mine = await fetchMyPlaylists();
      for (const p of mine) {
        pls.push({ id: 'pl_' + p.id, name: p.name, count: p.count, cover: p.cover, srcId: p.id, tracks: null });
      }
    } catch (e) { log('我的歌单失败: ' + e.message); }
    try {
      const rec = await fetchRecommendedPlaylists(20);
      for (const p of rec) {
        pls.push({ id: 'pl_' + p.id, name: p.name, count: p.count, cover: p.cover, srcId: p.id, tracks: null, rec: true });
      }
      if (rec.length) log('推荐歌单 ' + rec.length + ' 个');
    } catch (e) { log('推荐歌单失败: ' + e.message); }
    try {
      const sq = await fetchPlaylistSquare();   // 歌单广场：翻页去重合并，刷新时整体替换
      for (const p of sq) {
        pls.push({ id: 'pl_' + p.id, name: p.name, count: p.count, cover: p.cover, srcId: p.id, tracks: null, square: true });
      }
      if (sq.length) log('歌单广场 ' + sq.length + ' 个');
    } catch (e) { log('歌单广场失败: ' + e.message); }

    // 目录 = 队列 + 推荐流 + 我喜欢的音乐/前两个歌单（够首页用）
    for (const p of pls) if (p.tracks) p.tracks.forEach(catalogAdd);
    const warm = pls.filter(p => p.srcId).slice(0, 2);
    for (const p of warm) {
      try { p.tracks = await fetchPlaylistTracks(p.srcId); p.tracks.forEach(catalogAdd); p.count = p.tracks.length; }
      catch (e) { log('歌单曲目失败 ' + p.name + ': ' + e.message); }
    }
    // 没有封面的歌单：直接从已缓存的曲库里随机取一首带封面的当歌单封面。
    // 不拉曲目（零请求）；封面只是"随机装饰"，不必对应歌单内容。
    const coverPool = [...CATALOG.tracks.values()].filter(t => t.cover);
    for (const p of pls.filter(x => !x.cover)) {
      if (coverPool.length) p.cover = coverPool[Math.floor(Math.random() * coverPool.length)].cover;
    }
    CATALOG.playlists = pls;
    CATALOG.loadedAt = Date.now();
    prewarmFeed();   // 预热推荐流池（后台，不等待）
    // 「歌 → 歌单」反查索引：等几秒再建，别和刚结束的目录刷新抢签名请求；同样不等待
    setTimeout(() => { try { touchContextIndex(); } catch (e) { } }, 8000);
    log('目录已刷新：' + CATALOG.tracks.size + ' 曲 / ' + CATALOG.albums.size + ' 专辑 / ' + CATALOG.artists.size + ' 歌手 / ' +
      pls.length + ' 歌单，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  })().finally(() => { CATALOG.loading = null; });
  return CATALOG.loading;
}

async function playlistTracks(pl) {
  if (pl.live && pl.loader) {
    const ts = await pl.loader();            // 不缓存：每次打开都实时抓，边听边有新歌
    pl.tracks = ts; pl.count = ts.length;
    if (ts.length) pl.cover = ts[0].cover || pl.cover;
    lastLive[pl.id] = { count: ts.length, cover: pl.cover, tracks: ts };
    ts.forEach(catalogAdd);
    return ts;
  }
  if (pl.tracks) return pl.tracks;
  if (pl.srcId) {
    const ts = await fetchPlaylistTracks(pl.srcId);
    pl.tracks = ts; pl.count = ts.length;
    if (!pl.cover && ts.length) pl.cover = ts[0].cover || '';   // 自身无封面时用第一首
    ts.forEach(catalogAdd);
    return ts;
  }
  return [];
}

// ============================================================ Subsonic 层
const SUBSONIC_VERSION = '1.16.1';
function ok(extra) {
  return Object.assign({
    status: 'ok', version: SUBSONIC_VERSION, type: 'soda', serverVersion: '1.0.0', openSubsonic: true,
  }, extra || {});
}
function failed(code, msg) { return { status: 'failed', version: SUBSONIC_VERSION, error: { code: code || 0, message: msg || 'error' } }; }

function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }
/** 恒定时间比较，避免用字符串比较泄露长度/前缀 */
function timingEq(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  if (x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch (e) { return false; }
}

/** 数据面密钥的持久化文件（落在宿主给的 paths.data 里，权限 0600） */
function authFile() { return path.join(dataDir(), 'auth.json'); }

/** 读取/生成数据面密钥（`/rest/*` 的密码）。
 *  **必须持久**：宿主的 Navidrome 配置里存的就是它，每次启动换一把会让用户每次都要重填。 */
function loadSecret() {
  if (SECRET) return SECRET;
  try {
    const j = JSON.parse(fs.readFileSync(authFile(), 'utf8'));
    if (j && typeof j.secret === 'string' && j.secret.length >= 16) { SECRET = j.secret; return SECRET; }
  } catch (e) { }
  SECRET = crypto.randomBytes(24).toString('base64url');
  try {
    fs.writeFileSync(authFile(), JSON.stringify({ secret: SECRET, createdAt: new Date().toISOString() }, null, 1), { mode: 0o600 });
    log('已生成本机服务密钥 auth.json（只允许当前用户读取）');
  } catch (e) { log('密钥落盘失败（本次运行仍可用，重启后会变）: ' + e.message); }
  return SECRET;
}

/** Subsonic 认证：用户名固定 `soda`，密码是随机 SECRET；控制面 TOKEN 也接受（方便本机调试）。 */
function checkAuth(q) {
  if (String(q.u || '') !== USER) return false;
  const p = q.p;
  if (p !== undefined && p !== null && p !== '') {
    return timingEq(p, SECRET) || (!!TOKEN && timingEq(p, TOKEN));
  }
  const salt = q.s || '';
  if (!salt || !q.t) return false;
  const t = String(q.t).toLowerCase();
  return timingEq(t, md5(SECRET + salt).toLowerCase())
    || (!!TOKEN && timingEq(t, md5(TOKEN + salt).toLowerCase()));
}

/** 封面 id 只允许指向汽水自家的图片 CDN。
 *  维护者审查意见：`getCoverArt` 不能变成「请求任意 http 地址」的跳板 ——
 *  所以这里做白名单，白名单外的 id 一律落到占位图，不发请求。 */
const COVER_HOSTS = ['douyinpic.com', 'douyincdn.com', 'byteimg.com', 'bytedance.com', 'qishui.com', 'qishuimusic.com'];
function isAllowedCoverUrl(v) {
  try {
    const u = new URL(String(v));
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return COVER_HOSTS.some(d => h === d || h.endsWith('.' + d));
  } catch (e) { return false; }
}

/** 曲目 id 只收数字。
 *  它会直接拼进缓存文件名（`<id>.json` / `<id>.flac`），所以必须挡住 `../`、`/`、`:` 之类。 */
function safeTrackId(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d{1,32}$/.test(s)) throw { code: 70, message: 'invalid song id' };
  return s;
}

function songOf(t) {
  // 封面：**永不为空**。Folia 只有首页那 4 个列表位会把空串兜成 uN 占位图，
  // 墙（Bravais）和歌手详情头图是直接渲染 coverUrl 的 —— 空串 = 那块纯空白。
  // 所以这里一路兜到「占位 id」，由 getCoverArt 现画一张带名字的 SVG。
  return {
    id: t.id, parent: t.albumId || '0', isDir: false,
    title: t.name + (isTrial(t.id) ? '（试听）' : ''), album: t.album || '',
    artist: t.artists.join(' / '), track: 0, year: 0, genre: '', coverArt: coverOrPlaceholder(t),
    size: 0, contentType: 'audio/flac', suffix: 'flac', duration: Math.round(((t.duration || 0) || 0) / 1000),
    created: new Date().toISOString(), albumId: t.albumId || '', artistId: t.artistIds[0] || '',
    type: 'music', isVideo: false, path: t.name,
  };
}
function firstArtistId(a) {
  for (const id of a.trackIds || []) {
    const t = CATALOG.tracks.get(id);
    if (t && t.artistIds && t.artistIds[0]) return t.artistIds[0];
  }
  return '';
}
// 专辑里到底有没有一张能用的封面？决定 coverArt 给 id 还是给空串（见 songOf 注释）。
// 沿目录版本做 memo，避免每首歌都扫一遍全曲库。
let _albCoverAt = 0;
let _albCoverN = -1;
let _albCover = new Map();
function albumHasCover(albumId) {
  if (!albumId) return false;
  if (_albCoverAt !== CATALOG.loadedAt || _albCoverN !== CATALOG.tracks.size) {
    _albCoverAt = CATALOG.loadedAt; _albCoverN = CATALOG.tracks.size; _albCover = new Map();
  }
  let v = _albCover.get(albumId);
  if (v === undefined) {
    const a = CATALOG.albums.get(albumId);
    v = !!(a && a.cover) || [...CATALOG.tracks.values()].some(x => x.albumId === albumId && x.cover);
    _albCover.set(albumId, v);
  }
  return v;
}

/** 占位封面 id：`ph:<名字>` → getCoverArt 现画一张「名字前两字 + 渐变」的 SVG。
 *  必要性：Folia 的墙（Bravais）与歌手详情头图是**直接拿 coverUrl 渲染**的，
 *  不走 uN 占位（uN 只用在首页那 4 个列表位）。coverArt 留空 = 那块就是纯空白。 */
const PH_PREFIX = 'ph:';
function phId(name) { return PH_PREFIX + String(name || '').trim(); }

/** 曲库里找一张**同名**曲目的封面（同一首歌的其它版本），零请求 */
let _nameCoverAt = 0;
let _nameCoverN = -1;
let _nameCover = new Map();
function sameNameCover(name) {
  const n = String(name || '').trim();
  if (!n) return '';
  if (_nameCoverAt !== CATALOG.loadedAt || _nameCoverN !== CATALOG.tracks.size) {
    _nameCoverAt = CATALOG.loadedAt; _nameCoverN = CATALOG.tracks.size; _nameCover = new Map();
  }
  let v = _nameCover.get(n);
  if (v === undefined) {
    const hit = [...CATALOG.tracks.values()].find(x => x.cover && x.name === n);
    v = hit ? hit.cover : '';
    _nameCover.set(n, v);
  }
  return v;
}

/** 一张**永不为空**的封面值：真封面 URL > 同名曲封面 > 专辑 id > 占位 id */
function coverOrPlaceholder(t) {
  if (!t) return '';
  return t.cover
    || (albumHasCover(t.albumId) ? t.albumId : '')
    || sameNameCover(t.name)
    || phId(t.name);
}

/** 专辑卡的封面值（**永不为空**）：自身封面 > 曲库里有封面的专辑 id > 占位 id。
 *  坑：专辑 id 可能是 '0'（Subsonic 的「无专辑」哨兵，本曲库里显示为「未知专辑」，一个人占 57 首）。
 *  Folia 把 '0' 当「没有」处理（parent/coverArt 的根 id 语义），所以 '0' 一律不发，直接落到占位图。 */
function albumCoverValue(albumId, name, ownCover) {
  if (ownCover) return ownCover;
  const a = albumId ? CATALOG.albums.get(albumId) : null;
  if (a && a.cover) return a.cover;
  if (albumId && albumId !== '0' && albumHasCover(albumId)) return albumId;
  return phId(name || (a && a.name) || '');
}
function albumOf(a) {
  return {
    id: a.id, name: a.name, artist: a.artist || '未知歌手', artistId: firstArtistId(a),
    coverArt: albumCoverValue(a.id, a.name, a.cover),
    songCount: a.trackIds.length, duration: 0, created: new Date().toISOString(), playCount: 0,
    song: a.trackIds.slice(0, 500).map(id => CATALOG.tracks.get(id)).filter(Boolean).map(songOf),
  };
}

// 歌手的专辑数 / 头像 / 专辑列表：要从目录里反查，逐首扫太贵 → 按目录版本做一层 memo
// （catalogAdd 会随时加曲目而 loadedAt 不变，所以 tracks.size 也要一起当版本号）
let _arMetaAt = 0;
let _arMetaN = -1;
let _arMeta = new Map();
function artistMeta(a) {
  if (_arMetaAt !== CATALOG.loadedAt || _arMetaN !== CATALOG.tracks.size) {
    _arMetaAt = CATALOG.loadedAt; _arMetaN = CATALOG.tracks.size; _arMeta = new Map();
  }
  let m = _arMeta.get(a.id);
  if (m) return m;
  const albumIds = [];
  const seen = new Set();
  let cover = '';
  for (const id of a.trackIds || []) {
    const t = CATALOG.tracks.get(id);
    if (!t) continue;
    if (!cover && t.cover) cover = t.cover;          // 头像是在线 URL，直接给 Folia 用
    if (t.albumId && !seen.has(t.albumId)) { seen.add(t.albumId); albumIds.push(t.albumId); }
  }
  m = { albumIds, cover };
  _arMeta.set(a.id, m);
  return m;
}
/** 列表用的歌手摘要 */
function artistBrief(a) {
  const m = artistMeta(a);
  return { id: a.id, name: a.name, albumCount: m.albumIds.length, coverArt: m.cover || phId(a.name) };
}
function playlistOf(p) {
  return {
    id: p.id, name: p.name, comment: '', owner: USER, public: false, songCount: p.count || 0,
    duration: 0, created: new Date().toISOString(), changed: new Date().toISOString(),
    coverArt: p.cover || ((p.tracks && p.tracks[0] && p.tracks[0].cover) || '') || phId(p.name), entry: (p.tracks || []).map(songOf),
  };
}

function metaToTrack(m) {
  return {
    id: m.id, name: m.name, artists: m.artists || [], artistIds: m.artistIds || [],
    album: m.album || '', albumId: m.albumId || '', cover: m.cover || '', duration: m.duration || 0,
  };
}

/**
 * 曲目元信息，**不下载音频**。曲库里没有这条（刚启动 / 目录还没刷完）时 getSong 用它兜底 ——
 * 以前兜底走 ensureAudio()，等于为了返回一个标题就把整首无损下载解密一遍，
 * 重启后第一首歌要等十几秒，宿主的歌词 / 封面请求先超时。
 */
async function ensureTrackMeta(trackId) {
  trackId = safeTrackId(trackId);
  const known = CATALOG.tracks.get(String(trackId));
  if (known) return known;
  const metaFile = path.join(cacheDir(), trackId + '.json');
  if (fs.existsSync(metaFile)) {
    try { return metaToTrack(JSON.parse(fs.readFileSync(metaFile, 'utf8'))); } catch (e) { }
  }
  await waitReady(20000);
  const { track } = await trackV2(trackId);
  return metaToTrack({
    id: String(trackId), name: track.name,
    artists: (track.artists || []).map(a => a.name), artistIds: (track.artists || []).map(a => String(a.id)),
    album: (track.album && track.album.name) || '', albumId: String((track.album && track.album.id) || ''),
    cover: rawCoverOf(track), duration: track.duration || 0,
  });
}

// ============================================================ 分块取流（无损 FLAC）
/**
 * 无损单曲 30–60 MB，整首下完再解密才吐第一个字节 = 首字节 5–25 秒，宿主/手机播放器直接超时。
 * 这里改成「边下边解密边发」：
 *   · 汽水的加密容器是 MP4 + 逐样本 AES-128-CTR（每个样本一个 IV），样本之间互不依赖
 *   · FLAC 的输出 = fLaC 头（从 moov/dfLa 重建）+ 逐样本解密后的帧
 *   · 所以只要 moov 在样本之前（faststart），就能先发头、再顺着样本流发
 * 只在「无损档 + 没有缓存 + 非 Range 请求」时走这条路；其它情况一律回退到整首下载。
 */

/** 上游按区间取一段（CDN 支持 Range） */
function httpRangeBytes(url, start, end, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = assertFetchable(url);
    const req = https.get({
      hostname: u.hostname, path: u.pathname + u.search, timeout: timeoutMs || 20000,
      headers: { 'user-agent': UA, Range: 'bytes=' + start + '-' + end },
    }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, buf: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('取头部超时')));
    req.on('error', reject);
  });
}

/**
 * 尝试分块输出无损 FLAC。
 * 返回 true 表示响应已完整写完；false 表示这条曲子不适合流式（调用方回退整首）。
 * 抛错表示流式过程中失败：调用方若还没发头就回退，已经开始发就只能断开让播放器重试。
 */
async function tryStreamFlac(id, res) {
  if (AUDIO_INFLIGHT.has(id)) return false;                       // 已有整首在下载，不抢
  const metaFile = path.join(cacheDir(), id + '.json');
  if (fs.existsSync(metaFile)) return false;                      // 命中缓存：走原来的文件服务

  const t0 = Date.now();
  const { track, lyric, translations, items } = await trackV2(id);
  const pick = pickItem(items);
  if (!pick || !/^(lossless|hi_res)$/.test(String(pick.quality))) return false;

  // 封面和头部并行取：封面只影响标签，不该拖慢首字节
  const cu = coverUrlOf(track);
  const coverP = cu ? getBuf(cu).catch(() => null) : Promise.resolve(null);

  const kr = await hostCall('decodeSpade', { spade: pick.spade_a });
  const keyHex = kr.kind === 'string' ? kr.text : Buffer.from(kr.b64, 'base64').toString('latin1');
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 16) return false;

  // 1) 先取前 2MB 找 moov（样本表 / IV 表都在里面）
  const head = await httpRangeBytes(pick.main_url, 0, 2097152 - 1);
  if (head.status !== 200 && head.status !== 206) return false;
  const hb = head.buf;
  let p = 0, moovEnd = 0, mdatPos = 0;
  while (p + 8 <= hb.length) {
    const sz = hb.readUInt32BE(p);
    if (sz < 8) break;
    const t = hb.toString('latin1', p + 4, p + 8);
    if (t === 'moov') {
      if (p + sz > hb.length) return false;                       // moov 比 2MB 还大：不折腾
      moovEnd = p + sz;
    }
    if (t === 'mdat' && !mdatPos) mdatPos = p;
    p += sz;
  }
  if (!moovEnd) return false;
  if (mdatPos && mdatPos < moovEnd) return false;                 // mdat 在 moov 之前 → 没法先发头
  if (CORE.classify(hb) !== 'flac') return false;

  const table = CORE.parseTrack(hb);
  const ivs = CORE.parseIvs(hb);
  const n = Math.min(table.length, ivs.length);
  if (!n) return false;
  let contiguous = true, expect = table[0][0];
  for (let i = 0; i < n; i++) {
    if (table[i][0] !== expect) { contiguous = false; break; }
    expect += table[i][1];
  }
  if (!contiguous) return false;                                  // 样本不连续：按顺序读会对不上

  // 2) 头部：fLaC + STREAMINFO（+ 文本标签，封面不嵌，省一次下载）
  const coverBuf = await coverP;                 // 通常此时已经回来了（与头部并行）
  const header = CORE.flacEmbed(CORE.flacMetaBlocks(hb), {
    TITLE: track.name || '',
    ARTIST: (track.artists || []).map((a) => a.name).join(' / '),
    ALBUM: (track.album || {}).name || '',
    LYRICS: CORE.krcToLrc(CORE.fixMojibake(lyric || '')),
  }, coverBuf);
  const total = header.length + expect - table[0][0];
  const firstOff = table[0][0], lastOff = expect;

  res.writeHead(200, { 'Content-Type': 'audio/flac', 'Content-Length': total, 'Accept-Ranges': 'none' });
  res.write(header);

  const tmp = path.join(cacheDir(), id + '.flac.part');
  const ws = fs.createWriteStream(tmp);
  ws.write(header);                     // 落盘文件也要带头，否则缓存下来的是「没有 fLaC 头的裸帧」
  let written = 0;

  // 3) 顺序流：样本在加密文件里是连着的，一次 Range 拿整段，按样本大小切
  await new Promise((resolve, reject) => {
    const u = assertFetchable(pick.main_url);
    const req = https.get({
      hostname: u.hostname, path: u.pathname + u.search, timeout: 30000,
      headers: { 'user-agent': UA, Range: 'bytes=' + firstOff + '-' + (lastOff - 1) },
    }, (r) => {
      if (r.statusCode !== 206 && r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      let pending = Buffer.alloc(0), si = 0;
      const pump = () => {
        while (si < n) {
          const size = table[si][1];
          if (pending.length < size) return;
          const enc = pending.subarray(0, size);
          pending = pending.subarray(size);
          const out = CORE.ctr(key, ivs[si], enc);
          res.write(out);
          ws.write(out);
          written += size;
          si += 1;
        }
        r.destroy();
        resolve();
      };
      r.on('data', (c) => { pending = pending.length ? Buffer.concat([pending, c]) : c; pump(); });
      r.on('end', () => { if (si >= n) resolve(); else reject(new Error('上游提前结束 ' + si + '/' + n)); });
      r.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('取流超时')));
    req.on('error', reject);
  });

  await new Promise((r2) => ws.end(r2));
  fs.renameSync(tmp, path.join(cacheDir(), id + '.flac'));
  const meta = {
    id: String(id), file: id + '.flac', ext: '.flac', kind: 'flac', quality: pick.quality,
    name: track.name, artists: (track.artists || []).map((a) => a.name),
    artistIds: (track.artists || []).map((a) => String(a.id)),
    album: (track.album || {}).name || '', albumId: String((track.album || {}).id || ''),
    cover: rawCoverOf(track), lyric: lyric || '',
    translations: translations || null,
    duration: track.duration || 0,
    streamed: true,                       // 分块写出来的：标签只有文本，没有封面
  };
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  sweepCache();
  log('分块流完成 ' + meta.name + ' ' + (written / 1048576).toFixed(1) + 'MB · 首字节 ' + (Date.now() - t0) + 'ms');
  return true;
}

const ROUTES = {
  ping: async () => ({}),
  getLicense: async () => ({ license: { valid: true } }),
  getOpenSubsonicExtensions: async () => ({
    openSubsonicExtensions: [
      { name: 'songLyrics', versions: [1, 2] },
    ],
  }),
  getUser: async (q) => ({ user: { username: USER, email: '', scrobblingEnabled: false, adminRole: true, settingsRole: false, playlistsRole: true, uploadRole: false, downloadRole: true, shareRole: false, streamRole: true } }),
  getMusicFolders: async () => ({
    musicFolders: { musicFolder: [
      { id: 0, name: '汽水音乐' },
      { id: 1, name: '我的歌单' },
      { id: 2, name: '启动播放队列' },
      { id: 3, name: '推荐流' },
    ] },
  }),
  getGenres: async () => ({ genres: { genre: [] } }),
  getScanStatus: async () => ({ scanStatus: { scanning: false, count: CATALOG.tracks.size } }),

  getPlaylists: async (q) => {
    await refreshCatalog();
    // 支持 offset/size 翻页（无限滚动）：不传 offset 时返回全部
    const offset = Math.max(0, parseInt(q.offset || '0', 10) || 0);
    const size = Math.max(1, parseInt(q.size || '0', 10) || 500);
    // 列表只需要元信息：去掉 entry，避免把整张歌单塞进列表响应
    const all = CATALOG.playlists.map(p => {
      const o = playlistOf(p);
      delete o.entry;
      return o;
    });
    return { playlists: { playlist: all.slice(offset, offset + size) } };
  },
  getPlaylist: async (q) => {
    await refreshCatalog();
    const pl = CATALOG.playlists.find(x => x.id === q.id);
    if (!pl) throw { code: 70, message: 'playlist not found' };
    await playlistTracks(pl);
    return { playlist: playlistOf(pl) };
  },
  createPlaylist: async () => { throw { code: 0, message: '只读音源，暂不支持新建歌单' }; },
  deletePlaylist: async () => { throw { code: 0, message: '只读音源，暂不支持删除歌单' }; },
  updatePlaylist: async () => { throw { code: 0, message: '只读音源，暂不支持编辑歌单' }; },

  getAlbumList2: async (q) => {
    await refreshCatalog();
    const size = parseInt(q.size || '50', 10), offset = parseInt(q.offset || '0', 10);
    let list = [...CATALOG.albums.values()];
    if (MIN_ALBUM_TRACKS > 1) list = list.filter(a => (a.trackIds || []).length >= MIN_ALBUM_TRACKS);
    if (q.type === 'alphabeticalByName') list.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    else if (q.type === 'alphabeticalByArtist') list.sort((a, b) => (a.artist || '').localeCompare(b.artist || '', 'zh'));
    else if (q.type === 'random') list.sort(() => Math.random() - 0.5);
    list = list.slice(offset, offset + size);
    return { albumList2: { album: list.map(a => ({ ...albumOf(a), song: undefined })) } };
  },
  getAlbum: async (q) => {
    await refreshCatalog();
    const a = CATALOG.albums.get(q.id);
    if (!a) throw { code: 70, message: 'album not found' };
    return { album: albumOf(a) };
  },
  getSong: async (q) => {
    await refreshCatalog();
    let t = CATALOG.tracks.get(q.id);
    if (!t) { t = await ensureTrackMeta(q.id); catalogAdd(t); }
    return { song: songOf(t) };
  },

  getArtists: async (q) => {
    await refreshCatalog();
    // 支持 offset/size 翻页（Folia 歌手页无限滚动）：不传 offset 时返回全部
    const offset = Math.max(0, parseInt(q.offset || '0', 10) || 0);
    const size = Math.max(1, parseInt(q.size || '0', 10) || 500);
    let list = [...CATALOG.artists.values()];
    if (MIN_ARTIST_TRACKS > 1) list = list.filter(a => (a.trackIds || []).length >= MIN_ARTIST_TRACKS);
    list = list.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    const idx = [{ name: '#', artist: list.slice(offset, offset + size).map(artistBrief) }];
    return { artists: { ignoredArticles: 'The El La Los Las Le Les', index: idx } };
  },
  getArtist: async (q) => {
    await refreshCatalog();
    const a = CATALOG.artists.get(q.id);
    if (!a) throw { code: 70, message: 'artist not found' };
    const m = artistMeta(a);
    const albums = m.albumIds.map(id => CATALOG.albums.get(id)).filter(Boolean).map(x => {
      const o = albumOf(x);
      delete o.song;                 // 歌手页只要专辑卡，曲目另走 getAlbum
      return o;
    });
    return {
      artist: {
        id: a.id, name: a.name, albumCount: albums.length, coverArt: m.cover || phId(a.name),
        album: albums,
        song: a.trackIds.slice(0, 500).map(id => CATALOG.tracks.get(id)).filter(Boolean).map(songOf),
      },
    };
  },
  getArtistInfo2: async (q) => {
    await refreshCatalog();
    const a = CATALOG.artists.get(q.id);
    // Folia 的歌手页头像走这三个字段；**始终填**，没有真封面就给占位 id（现画带名字的 SVG），
    // 否则「没有封面的歌手」在这里会拿到空串 → 头图那块就是纯空白。
    const cov = (a ? artistMeta(a).cover : '') || phId(a ? a.name : '');
    const info = { biography: '', similarArtist: [] };
    info.smallImageUrl = cov; info.mediumImageUrl = cov; info.largeImageUrl = cov;
    return { artistInfo2: info };
  },

  getRandomSongs: async (q) => {
    await refreshCatalog();
    const size = parseInt(q.size || '50', 10);
    const all = [...CATALOG.tracks.values()].sort(() => Math.random() - 0.5).slice(0, size);
    return { randomSongs: { song: all.map(songOf) } };
  },

  getStarred2: async (q) => {
    await refreshCatalog();
    // 「我喜欢的音乐」直接映射为收藏
    const liked = CATALOG.playlists.find(p => /我喜欢的音乐/.test(p.name));
    let ts = [];
    if (liked) { try { ts = await playlistTracks(liked); } catch (e) { } }
    // 分页只作用于歌曲（Folia 的收藏页按歌曲滚动）；专辑/歌手是全量小列表
    const offset = Math.max(0, parseInt(q.offset || '0', 10) || 0);
    const size = Math.max(1, parseInt(q.size || '0', 10) || 500);
    const seenA = new Set(); const seenR = new Set();
    const albs = []; const ars = [];
    for (const t of ts) {
      if (t.albumId && !seenA.has(t.albumId)) {
        seenA.add(t.albumId);
        const al = CATALOG.albums.get(t.albumId);
        if (al) { const o = albumOf(al); delete o.song; albs.push(o); }
        else albs.push({ id: t.albumId, name: t.album || '', artist: (t.artists || [])[0] || '', artistId: (t.artistIds || [])[0] || '', coverArt: albumCoverValue(t.albumId, t.album || (t.artists || [])[0], t.cover), songCount: 0, duration: 0, created: '' });
      }
      (t.artistIds || []).forEach((aid, i) => {
        if (!aid || seenR.has(aid)) return;
        seenR.add(aid);
        const ar = CATALOG.artists.get(aid);
        ars.push(ar ? artistBrief(ar) : { id: aid, name: (t.artists || [])[i] || '', albumCount: 0, coverArt: phId((t.artists || [])[i]) });
      });
    }
    return { starred2: { song: ts.slice(offset, offset + size).map(songOf), album: albs, artist: ars } };
  },
  star: async () => { throw { code: 0, message: '收藏请到「我喜欢的音乐」歌单里操作' }; },
  unstar: async () => { throw { code: 0, message: '收藏请到「我喜欢的音乐」歌单里操作' }; },
  scrobble: async () => ({}),

  search3: async (q) => {
    const query = (q.query || '').trim();
    if (!query) return { searchResult3: { artist: [], album: [], song: [] } };
    const sCount = parseInt(q.songCount || '50', 10);
    const sOffset = parseInt(q.songOffset || '0', 10) || 0;
    let songs = [];
    try {
      // 汽水搜索每次固定返 20 条，且 next_cursor 就是纯 offset（20/40/60…），
      // 所以直接把 Subsonic 的 songOffset 当 cursor 用，再切片到 songCount。
      const j = await rpcGet('/luna/pc/search/track', { q: query, cursor: String(sOffset), count: '20' });
      // 实际结构：{ result_groups: [ { id:'tracks', data:[ { entity:{ track } } ] } ] }
      const groups = j.result_groups || [];
      for (const g of groups) {
        if (g.id && !/track/.test(g.id)) continue;
        for (const it of (g.data || [])) {
          const e = it.entity || {};
          const t = e.track || (e.track_wrapper && e.track_wrapper.track) || it.track;
          if (t && t.id) songs.push(normTrack(t));
        }
      }
      if (!songs.length) {   // 兼容其它可能的形状
        const list = j.tracks || (j.data && j.data.tracks) || j.items || [];
        songs = (Array.isArray(list) ? list : []).map(t => normTrack(t));
      }
      songs = songs.slice(0, sCount);        // 按请求条数裁剪
    } catch (e) { log('在线搜索失败，回退本地: ' + e.message); }
    if (!songs.length) {
      await refreshCatalog();
      const lq = query.toLowerCase();
      songs = [...CATALOG.tracks.values()].filter(t => t.name.toLowerCase().includes(lq) || t.artists.join('/').toLowerCase().includes(lq)).slice(0, sCount);
    }
    const albs = []; const ars = [];
    const seenA = new Set(), seenR = new Set();
    for (const s of songs) {
      if (s.albumId && !seenA.has(s.albumId)) {
        seenA.add(s.albumId);
        albs.push({ id: s.albumId, name: s.album, artist: s.artists[0] || '', artistId: (s.artistIds || [])[0] || '', coverArt: albumCoverValue(s.albumId, s.album || s.artists[0], s.cover), songCount: 0, duration: 0, created: '' });
      }
      (s.artistIds || []).forEach((aid, i) => {
        if (!aid || seenR.has(aid)) return;
        seenR.add(aid);
        const ar0 = CATALOG.artists.get(aid);   // 目录里有的（本地回退/热过）就带上头像与专辑数
        ars.push(ar0 ? artistBrief(ar0) : { id: aid, name: s.artists[i], albumCount: 0, coverArt: s.cover || phId(s.artists[i]) });
      });
    }
    return { searchResult3: { artist: ars, album: albs, song: songs.map(songOf) } };
  },
  getLyrics: async (q) => {
    let t = [...CATALOG.tracks.values()].find(x => x.name === q.title && x.artists.join('/').includes(q.artist || '')) ;
    const id = q.id || (t && t.id);
    if (!id) return { lyrics: { artist: q.artist || '', title: q.title || '', value: '' } };
    const m = await ensureLyricMeta(id);
    // 经典 Subsonic 的 value 是纯文本，Folia 会自查格式（detectTimedLyricFormat 认得 enhanced-lrc、
    // 不认得 krc）。所以这里给 enhanced-lrc：`[00:15.50]<00:15.50>肌<00:15.84>寒` —— 行级 + 逐字都能用。
    const en = enhancedLrcFrom(m.lyric);
    return { lyrics: { artist: (m.artists || []).join(' / '), title: m.name, value: en || lrcFrom(m.lyric) } };
  },
  getLyricsBySongId: async (q) => {
    const m = await ensureLyricMeta(q.id);
    const s = krcToStructured(m.lyric);
    const sub = s.line.length ? s.line : openSubsonicLrc(m.lyric);
    const structuredLyrics = [{
      displayArtist: (m.artists || []).join(' / '), displayTitle: m.name, lang: 'und', synced: true, kind: 'main',
      line: sub,
      // cueLine = 逐字时间轴。没有它 Folia 会退回行级，表现就是「歌词在、动画没了」。
      ...(s.cueLine.length ? { cueLine: s.cueLine } : {}),
    }];
    // 翻译：j.lyric.translations.cn（LRC 行级，如 [00:00.00]接通电源线…）。
    // 有翻译的歌才有 translations 字段；老缓存没有时实时补一次 track_v2 并写回 meta。
    let trs = m.translations;
    if (trs === undefined) {
      // 老缓存没有翻译字段：后台补一次，**不阻塞本次响应**（track_v2 要签名+网络 1-2 秒，
      // await 会让每首老歌都慢一拍）。本次先只给原文；补完写回 meta，下次点开就有翻译。
      trackV2(m.id).then(r => {
        if (r && r.translations) {
          try { fs.writeFileSync(path.join(cacheDir(), m.id + '.json'), JSON.stringify({ ...m, translations: r.translations })); } catch (e) { }
        }
      }).catch(() => { });
      trs = null;
    }
    const cn = trs && trs.cn;
    if (cn) {
      const tl = krcToStructured(cn);                       // 翻译是 LRC 行级，同一个解析器能吃
      const tline = tl.line.length ? tl.line : openSubsonicLrc(cn);
      if (tline.length) structuredLyrics.push({
        displayArtist: (m.artists || []).join(' / '), displayTitle: m.name,
        lang: 'cn', synced: true, kind: 'translation', format: 'LINE_SYNCED', offset: 0,
        line: tline,
      });
    }
    return { lyricsList: { structuredLyrics } };
  },
  getCoverArt: async (q, res) => {
    const id = q.id;
    // 按请求的尺寸取图。汽水的封面 CDN 允许在 URL 尾部指定尺寸
    // （`...~tplv-xxx-crop-center:800:800.jpg`），所以直接改那一段就行 ——
    // 不必下载原图再缩放：省流量，也省掉 Folia 那边的解码与纹理上传开销。
    // 之前忽略了 size，一律回 800×800，几百张卡片一起渲染时 GPU 会被拖死。
    const size = parseInt(q.size || '0', 10);
    const px = size >= 64 ? Math.min(size, 1200) : 800;
    // 占位 id：现画一张带名字的 SVG，不进 jpg 缓存（同一 id 不同名字没法复用）
    if (id && id.startsWith(PH_PREFIX)) return sendPlaceholder(res, id.slice(PH_PREFIX.length), px);
    const f = path.join(cacheDir(), 'cover_' + md5(id + '@' + px) + '.jpg');
    if (fs.existsSync(f)) return sendImage(res, fs.readFileSync(f));
    // ⚠️ 别对「完整 URL 形式的 id」做曲库查找：那是一次几百首的全表遍历，而按定义不可能命中。
    // 墙上有几百张卡片同时请求封面时这段会被放大成明显的卡顿。
    const isUrlId = /^https?:\/\//i.test(String(id || ''));
    const t = isUrlId ? null
      : (CATALOG.tracks.get(id) || [...CATALOG.tracks.values()].find(x => x.albumId === id));
    // 只认「曲目自带的封面」或「白名单 CDN 上的链接」；其它一律走占位图，绝不代发请求
    const base = (t && t.cover) || (isAllowedCoverUrl(id) ? id : '');
    if (!base) return sendPlaceholder(res, coverLabel(id), px);
    try {
      const b = await getBuf(resizeCoverUrl(base, px));
      fs.writeFileSync(f, b);
      log('封面 ' + px + 'px → ' + Math.round(b.length / 1024) + 'KB');
      return sendImage(res, b);
    } catch (e) {
      try {   // 缩放后的 URL 拉不到就退回原图
        const b2 = await getBuf(base);
        fs.writeFileSync(f, b2);
        return sendImage(res, b2);
      } catch (e2) {
        return sendPlaceholder(res, coverLabel(id), px);   // CDN 挂了也别破图
      }
    }
  },
  stream: async (q, res, reqObj) => {
    const streamId = safeTrackId(q.id);
    // 无损：边下边解密边发（Range 请求与已有缓存不走这条）
    if (!reqObj.headers.range) {
      try {
        if (await tryStreamFlac(streamId, res)) return undefined;
      } catch (e) {
        if (res.headersSent) { try { res.destroy(); } catch (x) { } return undefined; }
        log('分块流回退整首: ' + e.message);
      }
    }
    const m = await ensureAudio(q.id);
    // 缓存文件名是我们自己写的（<id>.<ext>）；这里再挡一道，别让被篡改的 meta 把路径带出去
    if (!/^\d{1,32}\.[A-Za-z0-9]{1,8}$/.test(String(m.file || ''))) throw { code: 70, message: 'bad cache entry' };
    const file = path.join(cacheDir(), m.file);
    const stat = fs.statSync(file);
    const type = m.ext === '.flac' ? 'audio/flac' : (m.ext === '.m4a' ? 'audio/mp4' : 'application/octet-stream');
    const range = reqObj.headers.range;
    if (range) {
      const mm = /bytes=(\d*)-(\d*)/.exec(range);
      let start = mm && mm[1] ? parseInt(mm[1], 10) : 0;
      let end = mm && mm[2] ? parseInt(mm[2], 10) : stat.size - 1;
      if (start >= stat.size) { res.writeHead(416); res.end(); return undefined; }
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, {
        'Content-Type': type, 'Accept-Ranges': 'bytes',
        'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return undefined;
    }
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': stat.size });
    fs.createReadStream(file).pipe(res);
    return undefined;
  },
};

// ---------------------------------------------------------- 歌词工具
function fixMojibake(s) {
  if (!s) return '';
  try { const d = Buffer.from(s, 'latin1').toString('utf8'); if (!d.includes('\ufffd')) return d; } catch (e) { }
  return s;
}
/** KRC / LRC → 行数组 [{ms, text}] */
function parseLyricToLines(raw) {
  const s = fixMojibake(raw || '').replace(/\r\n/g, '\n');
  const out = [];
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let m = t.match(/^\[(\d+),(\d+)\](.*)$/);      // KRC
    if (m) {
      const ms = parseInt(m[1], 10);
      let body = m[3];
      let text = body.includes('<') ? (body.match(/>([^<]*)/g) || []).map(x => x.slice(1)).join('') : body;
      text = text.replace(/\u200b/g, '').trim();
      if (text) out.push({ ms, text });
      continue;
    }
    m = t.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/); // LRC
    if (m) {
      const ms = Math.round((parseInt(m[1], 10) * 60 + parseFloat(m[2])) * 1000);
      const text = m[3].trim();
      if (text) out.push({ ms, text });
    }
  }
  out.sort((a, b) => a.ms - b.ms);
  return out;
}
function lrcFrom(raw) {
  return parseLyricToLines(raw).map(({ ms, text }) => {
    const mm = String(Math.floor(ms / 60000)).padStart(2, '0');
    const ss = ((ms % 60000) / 1000).toFixed(2).padStart(5, '0');
    return '[' + mm + ':' + ss + ']' + text;
  }).join('\n');
}
/** OpenSubsonic songLyrics v1：line[] 带毫秒 start */
function openSubsonicLrc(raw) {
  return parseLyricToLines(raw).map(({ ms, text }, i) => ({ index: i, start: ms, value: text }));
}
/**
 * KRC → OpenSubsonic songLyrics v2（line[] + **cueLine[]**，单位毫秒）
 *
 * KRC 一行形如：`[31090,2290]<0,350,0>爱<350,260,0>过<610,280,0>的…`
 *   外层 [行起始ms, 行时长ms]，内层 <字相对行首的偏移ms, 字时长ms, 0>字
 *
 * 为什么必须给 cueLine：Folia 的 parseNavidromeStructuredLyrics 只有在 cueLine 里有 cue 时间轴时
 * 才走逐字分支（`cues.flatMap(...)` 生成 words）；拿不到 cueLine 就退回 parseNavidromeLineLyrics，
 * 表现就是「歌词有、逐字动画没有」。而 pickMainCueLines 只会保留带 cue 的行，
 * 所以没有逐字的行也要补一个覆盖整行的 cue，否则那一行会整个消失。
 */
function krcToStructured(raw) {
  const rows = [];
  for (const rawLine of String(raw || '').split('\n')) {
    const t = rawLine.trim();
    let m = t.match(/^\[(\d+),(\d+)\](.*)$/);                 // KRC
    if (!m) {
      const l = t.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);   // 已经是 LRC 的，只能做行级
      if (!l) continue;
      const ms = Math.round((parseInt(l[1], 10) * 60 + parseFloat(l[2])) * 1000);
      const text = l[3].replace(/\u200b/g, '').trim();
      if (text) rows.push({ ms, dur: 0, text, cue: null });
      continue;
    }
    const lineStart = parseInt(m[1], 10);
    const lineDur = parseInt(m[2], 10);
    const body = m[3];
    const cue = [];
    let text = '';
    const re = /<(\d+),(\d+),(\d+)>([^<]*)/g;                 // <偏移,时长,0>字
    let w;
    while ((w = re.exec(body))) {
      const off = parseInt(w[1], 10);
      const dur = parseInt(w[2], 10);
      const ch = w[4].replace(/\u200b/g, '');
      if (!ch) continue;
      cue.push({ start: lineStart + off, end: lineStart + off + Math.max(dur, 10), value: ch });
      text += ch;
    }
    if (!text) text = body.replace(/<[^>]*>/g, '').replace(/\u200b/g, '').trim();
    if (!text) continue;
    rows.push({ ms: lineStart, dur: lineDur, text, cue: cue.length ? cue : null });
  }
  rows.sort((a, b) => a.ms - b.ms);

  const line = [], cueLine = [];
  rows.forEach((r, i) => {
    const lineEnd = Math.max(r.ms + r.dur, r.ms + 1);
    line.push({ index: i, start: r.ms, value: r.text });
    const cue = (r.cue && r.cue.length)
      ? r.cue
      : [{ start: r.ms, end: lineEnd, value: r.text }];      // 无逐字的行补整行 cue，免得被丢掉
    cueLine.push({
      index: i, start: r.ms, end: Math.max(lineEnd, cue[cue.length - 1].end), value: r.text, cue,
    });
  });
  return { line, cueLine };
}
/** 毫秒 → `mm:ss.xx` */
const lrcTime = (ms) => String(Math.floor(ms / 60000)).padStart(2, '0') + ':' +
  ((ms % 60000) / 1000).toFixed(2).padStart(5, '0');
/**
 * KRC → enhanced-LRC：`[00:15.50]<00:15.50>肌<00:15.84>寒…`
 * 经典 Subsonic 的 getLyrics 只能传纯文本，Folia 会自己 detectTimedLyricFormat ——
 * 它认得 enhanced-lrc（`<\d\d:\d\d.\d\d>`），不认得 krc。
 * 有逐字就给逐字；没有逐字的行退化成「整行一个字」，视觉上等于行级。
 */
function enhancedLrcFrom(raw) {
  return krcToStructured(raw).cueLine.map(cl => {
    const cues = (cl.cue && cl.cue.length) ? cl.cue : [{ start: cl.start, value: cl.value }];
    return '[' + lrcTime(cl.start) + ']' + cues.map(c => '<' + lrcTime(c.start) + '>' + c.value).join('');
  }).join('\n');
}
function sendImage(res, buf) {
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'max-age=86400' });
  res.end(buf);
  return undefined;   // 关键：不要返回 res，否则外层会再尝试 emit JSON
}

/** 取封面用不到的兜底：现画一张 SVG 占位图，别回 404。
 *  为什么不用 404 让 Folia 自己兜底：Folia 只在 **coverArt 为空**时才画 uN(name) 占位图；
 *  一旦它手里已经有 URL，取图失败就是破图/空白 —— 这条路只有服务端能救。 */
function coverLabel(id) {
  const t = CATALOG.tracks.get(id);
  if (t) return t.name;
  const a = CATALOG.albums.get(id);
  if (a) return a.name;
  const ar = CATALOG.artists.get(id);
  if (ar) return ar.name;
  return '';
}
function placeholderSvg(label, px) {
  // 取前两个字，与 Folia 自带占位图（uN）的取名规则一致
  const raw = String(label || '').trim();
  const txt = raw ? Array.from(raw).slice(0, 2).join('') : '♪';
  const esc = txt.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const size = Math.min(Math.max(px || 600, 64), 1200);
  const fs = txt.length > 1 ? 30 : 42;
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 100 100">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#e0f2fe"/><stop offset="1" stop-color="#bae6fd"/></linearGradient></defs>' +
    '<rect width="100" height="100" fill="url(#g)"/>' +
    '<text x="50" y="50" font-size="' + fs + '" text-anchor="middle" dominant-baseline="central" ' +
    'fill="#0f3a5b" font-family="system-ui,-apple-system,Segoe UI,sans-serif">' + esc + '</text></svg>', 'utf8');
}
function sendPlaceholder(res, label, px) {
  const buf = placeholderSvg(label, px);
  res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'max-age=3600' });
  res.end(buf);
  return undefined;
}

// ============================================================ HTTP
/**
 * 只接受「Host 就是本机回环 + 本端口」的请求。
 * 目的：挡住 DNS rebinding —— 恶意页面把某个域名解析到 127.0.0.1 时，
 * 浏览器的 Host 头会是那个域名（不是 127.0.0.1），这里直接 403。
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
function hostAllowed(h) {
  const raw = String(h || '').trim().toLowerCase();
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(raw);
  if (!m) return false;
  const host = m[1];
  const okPort = !m[2] || Number(m[2]) === PORT;
  if (LOOPBACK.has(host)) return okPort;
  // 局域网模式（显式开关）：允许内网地址访问，但仍然是「本机内网 IP」，不接受公网域名/地址
  if (LAN_MODE && okPort) {
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return true;
    if (host === 'localhost' || host.endsWith('.local')) return true;
  }
  return false;
}

/** 控制面令牌：每次启动随机生成，经 rpc 交给本模组自己的 client（不落盘、不进 URL）。 */
function tokenOk(rq, q) {
  if (!TOKEN) return false;
  return timingEq(String(rq.headers['x-soda-token'] || q.token || ''), TOKEN);
}

const server = http.createServer(async (rq, rs) => {
  const reqHost = rq.headers.host;
  // 全站不发 CORS 头：模组自己走 main 进程的 fetch（不受 CORS 约束）、设置页是同源，
  // 都不需要它。少一个 `Access-Control-Allow-Origin: *`，任意网页就没法**读**这里的响应了。
  if (!hostAllowed(reqHost)) { rs.writeHead(403); return rs.end('forbidden host'); }
  const u = new URL(rq.url, 'http://' + reqHost);
  const q = Object.fromEntries(u.searchParams.entries());

  if (rq.method === 'OPTIONS') { rs.writeHead(204); return rs.end(); }

  // ---- 健康探测：只回「活着」，不泄露端口外的任何信息（模组的就绪探测用它）----
  if (u.pathname === '/health') {
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return rs.end(JSON.stringify({ ok: true, service: 'soda-subsonic' }));
  }

  // ---- 设置页：要带令牌。带令牌的地址由 main 写进模组日志，点一下就能开 ----
  if (u.pathname === '/' || u.pathname === '/index.html') {
    if (!tokenOk(rq, q)) {
      rs.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return rs.end('需要令牌：令牌只经 rpc 交给模组前端，不写日志、也不进对外 URL');
    }
    rs.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return rs.end(UI_HTML);
  }

  // ---- 控制 API：一律要令牌（维护者审查意见：/api/* 没有鉴权 = 任意网页可跨站触发）----
  if (u.pathname.startsWith('/api/') && !tokenOk(rq, q)) {
    rs.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    return rs.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
  }

  // ---- 后台初始化（设备身份 / 登录态 / 曲库）还没跑完时，数据面先等一会儿 ----
  // Folia 启动后会马上来拉 NAVI 的列表；这时候返回空库会被当成「里面没有内容」。
  // 最多等 10 秒，等不到就照常处理，不把请求挂死。
  if (u.pathname.startsWith('/rest/')) await waitReady(10000);

  if (u.pathname === '/api/context') {
    // 诊断用：当前这首歌反查出来属于哪些歌单（续播会跟着第一个走）。
    // 顺手在索引不就绪时触发一次后台构建 —— 用户执行「无限续播状态」就能把它催起来。
    const ready = ctxReady();
    const playlists = [];
    if (ready && q.song) {
      for (const id of (ctxIndex.bySong.get(String(q.song)) || [])) {
        const pl = CATALOG.playlists.find(p => p.id === id);
        if (pl) playlists.push({ id: pl.id, name: pl.name });
      }
    }
    if (!ready) touchContextIndex();
    const body = JSON.stringify({
      ok: true, ready,
      indexSize: ctxIndex.bySong ? ctxIndex.bySong.size : 0,
      building: !!ctxIndex.building,
      playlists,
    });
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    return rs.end(body);
  }

  if (u.pathname === '/api/feed') {
    // 给模组的「无限续播」用：每次返回一批全新的推荐（池子是 splice 式的，天然不重复）
    //
    // `song=<当前曲目 id>`（可选）：**续播跟着当前歌单走**。
    //   先给「这首歌所属歌单」里还没给出去过的歌，不够再从通用推荐流补。
    //   拿不到上下文（索引还没建好 / 这首不在任何歌单里）时行为与以前完全一致，就是纯推荐流。
    let out;
    try {
      const n = parseInt(q.n || '60', 10) || 60;
      let ts = [];
      let source = '';
      let info = null;
      if (q.song) {
        const got = await takeFromContext(String(q.song), n);
        ts = got.songs;
        source = got.name;
        info = got.info;
        log('续播上下文 seed=' + q.song + ' → ' +
          (info.hit.length ? '「' + info.hit.join(' / ') + '」' : info.reason) +
          '，给出 ' + ts.length + ' 首');
      }
      const rest = n - ts.length;
      if (rest > 0) ts = ts.concat(await fetchFeedN(rest));
      out = {
        ok: true, count: ts.length, source,
        songs: ts.map(t => ({
          id: t.id, name: t.name, artists: t.artists || [], album: t.album || '',
          cover: t.cover || '', duration: t.duration || 0,
        })),
      };
      diagAdd({
        at: new Date().toISOString(), n,
        seed: q.song ? String(q.song) : null,
        source: source || null, got: ts.length,
        indexSize: ctxIndex.bySong ? ctxIndex.bySong.size : 0,
        building: !!ctxIndex.building,
        info,
      });
    } catch (e) { out = { ok: false, error: e.message, count: 0, songs: [] }; }
    const body = JSON.stringify(out);
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    return rs.end(body);
  }
  if (u.pathname === '/api/lines') {
    // 给模组的 `lyrics.transform` 用：直接给宿主 FoliumLine 形状（秒），
    // 这样「我们的歌词有动画」时可以把在线兜底歌词顶掉。
    // wordByWord 只在真是 KRC 逐字时为 true —— 纯行级的不算，让它继续走在线兜底。
    let out;
    try {
      const raw = await fetchLyricOnly(q.id);
      const isKrc = /\[\d+,\d+\][^\n]*<\d+,\d+,\d+>/.test(raw);
      const s = krcToStructured(raw);
      const lines = s.cueLine.map(cl => ({
        fullText: cl.value,
        startTime: cl.start / 1000,
        endTime: cl.end / 1000,
        words: (cl.cue || []).map(c => ({
          text: c.value, startTime: c.start / 1000, endTime: c.end / 1000,
        })),
      }));
      out = { ok: lines.length > 0 && isKrc, wordByWord: isKrc, count: lines.length, lines };
    } catch (e) { out = { ok: false, wordByWord: false, error: e.message, count: 0, lines: [] }; }
    const body = JSON.stringify(out);
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    return rs.end(body);
  }
  if (u.pathname === '/api/lyrics') {
    let out;
    try {
      const m = await ensureLyricMeta(q.id);
      const raw = m.lyric || '';
      const isKrc = /^\[\d+,\d+\]/m.test(raw);
      out = { ok: !!raw, format: isKrc ? 'krc' : 'lrc', text: raw, title: m.name, artist: (m.artists || []).join(' / ') };
    } catch (e) { out = { ok: false, error: e.message }; }
    const body = JSON.stringify(out);
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    return rs.end(body);
  }
  if (u.pathname === '/api/prefetch') {
    /**
     * 后台预取：把整首下载 + 解密提前做掉，轮到它播时首字节 ≈ 0。
     * 「后台老是停止播放 / 播放错误」就是首字节太慢：无损 30–60 MB 要整首下完才能吐第一个字节，
     * 冷启动那首 5–25 秒，宿主等不及就报错跳歌。冷启动那首没法提前，但连播下一首可以。
     */
    let out;
    try {
      const id = safeTrackId(q.id);
      const metaFile = path.join(cacheDir(), id + '.json');
      let cached = false;
      if (fs.existsSync(metaFile)) {
        try { cached = fs.existsSync(path.join(cacheDir(), JSON.parse(fs.readFileSync(metaFile, 'utf8')).file || '')); } catch (e) { }
      }
      if (!cached) ensureAudio(id).catch(e => log('预取失败 ' + id + ': ' + e.message));
      out = { ok: true, id, cached };
    } catch (e) { out = { ok: false, error: e.message }; }
    const body = JSON.stringify(out);
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    return rs.end(body);
  }
  if (u.pathname === '/api/settings') {
    if (rq.method === 'POST') {
      let raw = '';
      await new Promise((ok) => {
        rq.on('data', (c) => { raw += c; if (raw.length > 8192) { try { rq.destroy(); } catch (e) { } } });
        rq.on('end', ok); rq.on('error', ok);
      });
      let patch = {};
      try { patch = JSON.parse(raw || '{}') || {}; } catch (e) { }
      const st = saveSettings({ trialDetect: !!patch.trialDetect });
      log('设置已更新：识别试听片段 = ' + (st.trialDetect ? '开' : '关'));
    }
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return rs.end(JSON.stringify({ ok: true, settings: loadSettings() }));
  }
  if (u.pathname === '/api/status') {
    const body = JSON.stringify({
      ok: true, port: PORT, host: HOST, user: USER, pass: SECRET,
      device: DEV && DEV.did, loggedIn: !!COOKIE,
      sessionHint: COOKIE ? (sessHint || (COOKIE.length + ' 字符')) : '',
      catalog: { tracks: CATALOG.tracks.size, albums: CATALOG.albums.size, artists: CATALOG.artists.size, playlists: CATALOG.playlists.length },
      loadedAt: CATALOG.loadedAt || 0,
      settings: loadSettings(),
      log: LOG_RING.slice(-120),
    });
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return rs.end(body);
  }
  if (u.pathname === '/api/refresh_session') {
    log('手动触发：从本机客户端同步登录态 …');
    let out;
    try { await refreshSessionFromClient(); out = { ok: true, hint: sessHint }; }
    catch (e) { out = { ok: false, error: e.message }; log('同步失败: ' + e.message); }
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return rs.end(JSON.stringify(out));
  }
  if (u.pathname === '/api/refresh_catalog') {
    let out;
    try { await refreshCatalog(true); out = { ok: true }; }
    catch (e) { out = { ok: false, error: e.message }; }
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return rs.end(JSON.stringify(out));
  }
  const m = /^\/rest\/([A-Za-z0-9_]+)(?:\.view)?$/.exec(u.pathname);
  if (!m) { rs.writeHead(404); return rs.end('not found'); }
  const name = m[1];

  const emit = (payload) => {
    const body = JSON.stringify({ 'subsonic-response': payload });
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    rs.end(body);
  };

  // 认证（coverArt/stream 也校验）
  const handler = ROUTES[name];
  if (!handler) return emit(failed(0, 'unknown endpoint ' + name));
  if (!checkAuth(q)) return emit(failed(40, 'wrong username or password'));

  try {
    const t0 = Date.now();
    const out = await handler(q, rs, rq);
    if (out === undefined) return;              // handler 自己写了响应
    if (name !== 'ping') log(name + ' ' + ((Date.now() - t0)) + 'ms');
    emit(ok(out));
  } catch (e) {
    const code = e && e.code ? e.code : 0;
    log('ERR ' + name + ': ' + (e && e.message ? e.message : e));
    if (!rs.headersSent) emit(failed(code, (e && e.message) || 'internal error'));
  }
});

// ============================================================ 启动 / 停止
/**
 * 启动服务，返回 { port, host, user, pass, log(), stop() }。
 *
 *   opts.dataDir          数据目录（缓存 / 登录态）。不传则用脚本目录；
 *                         **内嵌进 Folia 模组时务必传**，否则会往模组目录里写文件，
 *                         把「模组授权绑定的内容摘要」搞失配，模组会被撤销授权并禁用。
 *   opts.forceSessionSync 强制重新从汽水客户端提取登录态。
 */
async function start(opts = {}) {
  /**
   * 嵌入宿主时**不认环境变量**（维护者审查意见）：`HOST=0.0.0.0` 会把服务暴露到局域网，
   * `SUB_PASS` 会把数据面密码变成可猜的固定值，`SODA_NATIVE_DIR` 能把原生模块目录指到任意位置。
   */
  if (opts.embedded) {
    EMBEDDED = true;
    HOST = '127.0.0.1';
    PORT = 4533;
    SECRET = '';
  }
  /**
   * 局域网模式：允许**手机**连进来（椒盐改包 / 其它 Subsonic 客户端）。
   * 必须是显式开关（独立运行 SODA_LAN=1，或宿主传 opts.lan），不走环境变量猜；
   * 鉴权仍靠 auth.json 的随机密钥，控制面 /api/* 仍要启动令牌。
   */
  if (opts.lan || (!opts.embedded && process.env.SODA_LAN === '1')) {
    HOST = '0.0.0.0';
    LAN_MODE = true;
  }
  sweepTempCookies();
  // 路径：优先用宿主给的 getter（Folium 1.5+）；否则退回 opts.dataDir（独立运行 / 旧宿主）
  if (opts.resolvePaths) {
    resolvePaths = opts.resolvePaths;
  } else if (opts.embedded) {
    // 内嵌进宿主却拿不到 paths：绝不能退回去写模组目录（会让模组授权摘要失配），
    // 也不能写一个没申报过的目录 —— 直接报错，让模组面板把这条原因显示出来。
    throw new Error('宿主没有提供 api.storage.paths（需要 Folium 1.5 / Folia 0.7.20+），拒绝在没有申报的目录里落盘');
  } else if (opts.dataDir) {
    FALLBACK_ROOT = path.resolve(opts.dataDir);
  }
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.mkdirSync(cacheDir(), { recursive: true });
  fs.mkdirSync(lyricDir(), { recursive: true });

  // 控制面令牌：每次启动重新生成；数据面密钥：首次生成后持久
  TOKEN = crypto.randomBytes(24).toString('base64url');
  loadSecret();
  cleanLegacyLayout();

  log('soda-subsonic 启动中 …（数据 ' + dataDir() + ' / 缓存 ' + cacheDir() + '）');

  // 先把服务起起来，UI 立刻可见；设备 / 登录态 / 曲库在后台初始化
  await new Promise((resolve, reject) => {
    const onErr = (e) => reject(new Error(e && e.code === 'EADDRINUSE'
      ? ('端口 ' + PORT + ' 已被占用 —— 是不是已经有一个 soda 服务在跑？')
      : (e && e.message) || String(e)));
    server.once('error', onErr);
    server.listen(PORT, HOST, () => { server.removeListener('error', onErr); resolve(); });
  });
  log('就绪 → http://' + HOST + ':' + PORT);
  if (EMBEDDED) {
    // 维护者审查意见：日志里**不打** `/rest` 密码、也不打带令牌的设置页地址 ——
    // 嵌进宿主后这份日志会进模组面板，还经常被用户整段贴到 issue 里。
    // 密码在数据目录的 auth.json（模组会自动写进宿主的 Navidrome 配置），令牌只经 rpc 给模组前端。
    log('Folia 里填：Navidrome 服务器 http://' + HOST + ':' + PORT + '　用户名 ' + USER + '　密码 ******（已自动写入宿主，见数据目录 auth.json）');
    log('设置页：http://' + HOST + ':' + PORT + '/ （需启动令牌，令牌只经 rpc 交给模组前端，不写日志）');
  } else {
    log('Folia 里填：Navidrome 服务器 http://' + HOST + ':' + PORT + '　用户名 ' + USER + '　密码 ' + SECRET);
    log('设置页（带令牌，仅本机可开）：http://' + HOST + ':' + PORT + '/?token=' + TOKEN);
  }

  // ---- 后台初始化 ------------------------------------------------------------
  // 顺序不能乱：原生签名器 → 设备身份 → 登录态 → 曲库。每一步失败都只记日志，
  // 不让整条链断掉（比如拿不到登录态时，封面和播放仍然能用）。
  //
  // ⚠️ 这一段**故意不 await**：端口已经 listen 成功，handle 立刻交出去，
  //    模组的 client 才能马上拿到端口 / 密钥 / 令牌去配置宿主的 Navidrome。
  STOPPED = false;
  READY = (async () => {
    try { await initNative(); } catch (e) { log('原生模块不可用: ' + e.message); }
    if (STOPPED) return;
    try {
      if (!loadDevice()) await registerDevice();
      else { log('设备身份 did=' + DEV.did); await initBdms(); }
    } catch (e) { log('设备身份初始化失败: ' + e.message); }
    if (STOPPED) return;
    loadSession();
    if (!COOKIE || opts.forceSessionSync) {
      try { await refreshSessionFromClient(); }
      catch (e) { log('登录态同步失败（歌单/搜索将不可用）: ' + e.message); }
    } else {
      log('已载入登录态（' + COOKIE.length + ' 字符）');
    }
    if (STOPPED) return;
    try { await refreshCatalog(true); } catch (e) { log('首次刷新目录失败: ' + e.message); }
    if (!STOPPED) {
      log('初始化完成 → 曲库 ' + CATALOG.tracks.size + ' 曲 / ' + CATALOG.playlists.length + ' 歌单');
      READY_DONE = true;
    }
  })().catch((e) => {
    READY_DONE = true;                       // 失败也算「结束」，不能把 /rest 一直挂着
    log('后台初始化异常: ' + ((e && e.message) || e));
  });

  const timer = setInterval(() => { if (READY_DONE && !STOPPED) refreshCatalog(true).catch(() => { }); }, CATALOG_TTL);

  return {
    port: PORT, host: HOST, user: USER, pass: SECRET, token: TOKEN,
    // 给 status rpc 用：服务已监听 = 可用；ready 只表示曲库等后台初始化是否也跑完了
    initDone: () => READY_DONE,
    log: () => LOG_RING.slice(),
    stop() {
      STOPPED = true;
      try { clearInterval(timer); } catch (e) { }
      hostStop();
      return new Promise((resolve) => {
        try { server.close(() => resolve(true)); } catch (e) { resolve(false); }
      });
    },
  };
}

module.exports = { start, resolveNativeDir, clientInstallDirs };

// 直接 `node soda_subsonic.js` 时自己起来；内嵌进模组时由 index.cjs 调 start()
if (require.main === module) {
  start({ forceSessionSync: process.argv.includes('--refresh') || process.argv.includes('--sync') })
    .catch((e) => { log('启动失败: ' + e.message); process.exitCode = 1; });
}
