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
 *   PORT=4533 USER=soda PASS=soda node soda_subsonic.js
 *   node soda_subsonic.js --refresh       # 强制重新从客户端同步登录态
 *
 * Folia 侧配置：设置 → 音源/资料库 → Navidrome → 服务器地址 http://127.0.0.1:4533，用户名/密码见上
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
const PORT = parseInt(process.env.PORT || '4533', 10);
const HOST = process.env.HOST || '127.0.0.1';
const USER = process.env.SUB_USER || process.env.USER || 'soda';
const PASS = process.env.SUB_PASS || process.env.PASS || 'soda';
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

const ASSET = __dirname;              // 代码与资源（lib/、ui.html）—— 只读
/**
 * 数据根（缓存 / 登录态）。独立运行 = 脚本目录；**内嵌进 Folia 模组时必须改到 %APPDATA% 下**：
 * Folia 的模组授权绑定「模组目录内容摘要」，往模组目录里写缓存会让摘要失配、模组被撤销授权。
 */
let ROOT = ASSET;
const LIB = path.join(ASSET, 'lib');
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
let CACHE_DIR = path.join(ROOT, '_cache');
let LYRIC_DIR = path.join(ROOT, '_lyric_cache');

// ============================================================ 原生模块（延迟加载 + 多路径探测）
// bdms.node / device.node 都是 N-API 模块（napi_register_module_v1，无 V8/NAN 绑定），
// 跨 Node / Electron 版本 ABI 稳定，不需要为 Electron 重编译。
let NATIVE = null, bdms = null, DEVN = null;
const CORE = require(path.join(LIB, 'luna_core.js'));

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
      try { text = execFileSync('reg', ['query', root, '/s'], { encoding: 'utf8', maxBuffer: 16 << 20 }); }
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
  if (process.env.SODA_NATIVE_DIR) cands.push(process.env.SODA_NATIVE_DIR);
  cands.push(path.join(ASSET, 'native'));          // 模组自带（可选）
  cands.push(path.join(ASSET, 'lib', 'native'));   // 独立运行的布局
  cands.push(path.join(ROOT, 'native'));
  for (const c of cands) if (c && hasNative(c)) return c;
  for (const base of clientInstallDirs()) {
    const d = findNativeIn(base);
    if (d) return d;
  }
  return null;
}

function initNative() {
  if (bdms) return true;
  const dir = resolveNativeDir();
  if (!dir) throw new Error('找不到原生模块：请先安装并运行一次汽水音乐 PC 客户端，或用 SODA_NATIVE_DIR 指定 app.asar.unpacked 目录');
  log('原生模块目录: ' + dir);
  process.env.PATH = dir + path.delimiter + (process.env.PATH || '');
  try { process.chdir(dir); } catch (e) { }   // metasecml.dll 按相对名加载，cwd 得落在这里
  const load = (p) => { const m = { exports: {} }; process.dlopen(m, p); return m.exports; };
  bdms = load(path.join(dir, 'bdms.node'));
  try { DEVN = load(path.join(dir, 'device.node')); }
  catch (e) { log('device.node 加载失败: ' + e.message); DEVN = null; }
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
const UI_HTML = (() => { try { return fs.readFileSync(path.join(ROOT, 'ui.html'), 'utf8'); } catch (e) { return '<h1>ui.html 缺失</h1>'; } })();

// ============================================================ 设备身份 + 登录态
let DEV = null;
let COOKIE = '';
let sessHint = '';

function deviceFile() { return path.join(APPDATA, 'luna_export', 'device.json'); }

/** 初始化原生签名器（必须先做，否则 X-Helios/X-Medusa 为空，track_v2 等接口会返回空响应） */
function initBdms() {
  try {
    bdms.init({ deviceId: DEV.did });
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
  let serial = '';
  try { serial = String(DEVN.getSerial() || '').replace(/\0+$/, ''); } catch (e) { }
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
  const decorated = DEVN.applogDecorated(zlib.gzipSync(Buffer.from(JSON.stringify(payload))));
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
    const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', cmd], { windowsHide: true });
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
  for (const p of [path.join(ROOT, '_pc_cookie.json'), path.join(ROOT, '..', '_pc_cookie.json')]) {
    try {
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const cookie = j.cookie || Object.entries(j.cookieMap || {}).map(([k, v]) => k + '=' + v).join('; ');
      if (!cookie) continue;
      COOKIE = cookie;
      fs.writeFileSync(path.join(ROOT, '_session.txt'), cookie);
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
  fs.writeFileSync(path.join(ROOT, '_session.txt'), cookie);
  COOKIE = cookie;
  sessHint = 'sessionid ' + String(ck.sessionid).slice(0, 10) + '… 共 ' + Object.keys(ck).length + ' 项';
  log('已从客户端同步登录态 sessionid=' + String(ck.sessionid).slice(0, 10) + '…');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }   // 里面是 Cookies 明文副本，用完即删
  return ck;
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

function loadSession() {
  const p = path.join(ROOT, '_session.txt');
  if (fs.existsSync(p)) { COOKIE = fs.readFileSync(p, 'utf8').trim(); sessHint = COOKIE.length + ' 字符（' + new Date(fs.statSync(p).mtime).toLocaleString('zh-CN') + '）'; }
  return COOKIE;
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
function signedHeaders(url, extra, body) {
  const h = { 'user-agent': UA, ...extra };
  if (COOKIE) h['cookie'] = COOKIE;
  if (body) h['x-ss-stub'] = crypto.createHash('md5').update(body).digest('hex').toUpperCase();
  const lines = Object.entries(h).map(([k, v]) => k + '\r\n' + v).join('\r\n');
  const parts = String(bdms.generateHttpSignatureHeaders(url, lines)).split('\r\n').filter(t => t.trim());
  for (let i = 0; i < parts.length / 2; i++) h[parts[i * 2]] = parts[i * 2 + 1];
  return h;
}
function req(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
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
  const headers = signedHeaders(url, { 'content-type': 'application/json; charset=utf-8' }, b);
  return reqJson(url, { method: 'POST', headers, body: b });
}
async function rpcGetOnce(p, extra) {
  const url = buildUrl(p) + (extra ? '&' + Object.entries(extra).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&') : '');
  return reqJson(url, { method: 'GET', headers: signedHeaders(url, {}) });
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
function getBuf(url, extraHeaders, maxRedirect = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { 'user-agent': UA, ...(extraHeaders || {}) } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirect > 0) {
        res.resume();
        const loc = new URL(res.headers.location, url).toString();
        return getBuf(loc, extraHeaders, maxRedirect - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

/** track_v2 → 原始 track 元数据 + 歌词 + 各档位流信息 */
async function trackV2(trackId) {
  const body = JSON.stringify({ track_id: String(trackId), media_type: 'track', queue_type: 'daily_mix', scene_name: 'track_reco' });
  const url = buildUrl('/luna/pc/track_v2');
  const headers = signedHeaders(url, { 'content-type': 'application/json; charset=utf-8' }, body);
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
  const f = path.join(LYRIC_DIR, trackId + '.txt');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  const metaFile = path.join(CACHE_DIR, trackId + '.json');
  if (fs.existsSync(metaFile)) {
    try {
      const m = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (m && typeof m.lyric === 'string') {
        fs.mkdirSync(LYRIC_DIR, { recursive: true });
        fs.writeFileSync(f, m.lyric);
        return m.lyric;
      }
    } catch (e) { }
  }
  const { lyric } = await trackV2(trackId);
  fs.mkdirSync(LYRIC_DIR, { recursive: true });
  fs.writeFileSync(f, lyric || '');
  return lyric || '';
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

/** 取流 + 解密 + 落盘缓存 */
async function ensureAudio(trackId) {
  const metaFile = path.join(CACHE_DIR, trackId + '.json');
  const hit = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : null;
  if (hit && fs.existsSync(path.join(CACHE_DIR, hit.file))) return hit;

  const { track, lyric, translations, items } = await trackV2(trackId);
  const pick = pickItem(items);
  const key = DEVN.decodeSpade(pick.spade_a);
  let coverBuf = null;
  const cu = coverUrlOf(track);
  if (cu) { try { coverBuf = await getBuf(cu); } catch (e) { } }
  const enc = await getBuf(pick.main_url);
  const r = CORE.decrypt(enc, key, {
    title: track.name,
    artist: (track.artists || []).map(a => a.name).join(' / '),
    album: (track.album || {}).name || '',
    lyric, coverBuf,
  });
  const fname = trackId + r.ext;
  fs.writeFileSync(path.join(CACHE_DIR, fname), r.data);
  const meta = {
    id: String(trackId), file: fname, ext: r.ext, kind: r.kind, quality: pick.quality,
    name: track.name, artists: (track.artists || []).map(a => a.name),
    artistIds: (track.artists || []).map(a => String(a.id)),
    album: (track.album || {}).name || '', albumId: String((track.album || {}).id || ''),
    cover: rawCoverOf(track), lyric,
    translations: translations || null,
    duration: track.duration || 0,
  };
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  log('取流完成 ' + meta.name + ' [' + meta.quality + '] ' + (r.data.length / 1048576).toFixed(1) + 'MB');
  return meta;
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

/** 客户端 QueueCache 里记的上次播放到的那首歌（last_played_key，形如 `track-xxx`，剥掉前缀拿 id） */
function readQueueLastKey() {
  const p = path.join(APPDATA, 'SodaMusic', 'LunaStorage', 'QueueCache');
  if (!fs.existsSync(p)) return null;
  const d = fs.readFileSync(p);
  if (d.subarray(0, 4).toString() !== 'LUNA') return null;
  try {
    const j = JSON.parse(zlib.gunzipSync(d.subarray(4)).toString('utf8'));
    for (const v of Object.values(j)) {
      const k = v.last_played_key || v.lastPlayedKey;
      if (k) return String(k).replace(/^track-/, '');
    }
  } catch (e) { }
  return null;
}

/** 模组自己记的「最后播放的歌」（client 的 audioSourceResolved 钩子上报，main 落盘到数据目录）。
 *  优先级高于客户端 QueueCache 的 last_played_key —— 那个只有在汽水客户端里听才会更新。 */
function readLastPlayed() {
  try {
    const f = path.join(ROOT, '_lastplayed.json');
    if (!fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return j && j.id ? String(j.id) : null;
  } catch (e) { return null; }
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
    cover: (p.url_cover && p.url_cover.uri) ? ((p.url_cover.urls && p.url_cover.urls[0]) || 'https://p3-luna.douyinpic.com/img/') + p.url_cover.uri : '',
  }));
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
      const local = readQueueCache();
      const feed = await fetchFeedCached();
      const seen = new Set(local.map(t => String(t.id)));
      const rest = feed.filter(t => !seen.has(String(t.id)));
      // 从「上次播放到的那首」开始：优先用 Folia 自己记的位置（audioSourceResolved 钩子上报），
      // 没有再退回客户端 QueueCache 的 last_played_key。
      const lastId = readLastPlayed() || readQueueLastKey();
      const idx = lastId ? local.findIndex(t => String(t.id) === lastId) : -1;
      const ordered = idx >= 0 ? local.slice(idx).concat(local.slice(0, idx)) : local;
      return ordered.concat(rest);
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
        // 封面取列表里第一首的封面（Folia 侧：coverArt 为空就画占位图标）
        pls.push({ id: v.id, name: v.name, count: ts.length, cover: (ts[0] && ts[0].cover) || '', virtual: true, tracks: ts });
      } catch (e) { log('来源失败 ' + v.name + ': ' + e.message); }
    }
    // 在线歌单
    try {
      const mine = await fetchMyPlaylists();
      for (const p of mine) {
        pls.push({ id: 'pl_' + p.id, name: p.name, count: p.count, cover: p.cover, srcId: p.id, tracks: null });
      }
    } catch (e) { log('我的歌单失败: ' + e.message); }

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
function checkAuth(q) {
  const u = q.u || '';
  if (PASS === '' ) return u === USER || !u;
  if (q.p !== undefined && q.p !== null && q.p !== '') return u === USER && q.p === PASS;
  const salt = q.s || '';
  if (!salt || !q.t) return false;
  return u === USER && md5(PASS + salt).toLowerCase() === String(q.t).toLowerCase();
}

function songOf(t) {
  return {
    id: t.id, parent: t.albumId || '0', isDir: false, title: t.name, album: t.album || '',
    artist: t.artists.join(' / '), track: 0, year: 0, genre: '', coverArt: t.cover || (t.albumId || t.id),
    size: 0, contentType: 'audio/flac', suffix: 'flac', duration: Math.round(((t.duration || 0) || 0) / 1000),
    created: new Date().toISOString(), albumId: t.albumId || '', artistId: t.artistIds[0] || '',
    type: 'music', isVideo: false, path: t.name,
  };
}
function albumOf(a) {
  return {
    id: a.id, name: a.name, artist: a.artist || '未知歌手', artistId: '', coverArt: a.cover || a.id,
    songCount: a.trackIds.length, duration: 0, created: new Date().toISOString(), playCount: 0,
    song: a.trackIds.slice(0, 500).map(id => CATALOG.tracks.get(id)).filter(Boolean).map(songOf),
  };
}
function playlistOf(p) {
  return {
    id: p.id, name: p.name, comment: '', owner: USER, public: false, songCount: p.count || 0,
    duration: 0, created: new Date().toISOString(), changed: new Date().toISOString(),
    coverArt: p.cover || ((p.tracks && p.tracks[0] && p.tracks[0].cover) || ''), entry: (p.tracks || []).map(songOf),
  };
}

function metaToTrack(m) {
  return {
    id: m.id, name: m.name, artists: m.artists || [], artistIds: m.artistIds || [],
    album: m.album || '', albumId: m.albumId || '', cover: m.cover || '', duration: m.duration || 0,
  };
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

  getPlaylists: async () => {
    await refreshCatalog();
    // 列表只需要元信息：去掉 entry，避免把整张歌单塞进列表响应
    return { playlists: { playlist: CATALOG.playlists.map(p => {
      const o = playlistOf(p);
      delete o.entry;
      return o;
    }) } };
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
    if (!t) { t = metaToTrack(await ensureAudio(q.id)); catalogAdd(t); }
    return { song: songOf(t) };
  },

  getArtists: async () => {
    await refreshCatalog();
    let list = [...CATALOG.artists.values()];
    if (MIN_ARTIST_TRACKS > 1) list = list.filter(a => (a.trackIds || []).length >= MIN_ARTIST_TRACKS);
    list = list.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    const idx = [{ name: '#', artist: [] }];
    for (const a of list) idx[0].artist.push({ id: a.id, name: a.name, albumCount: 0, coverArt: '' });
    return { artists: { ignoredArticles: 'The El La Los Las Le Les', index: idx } };
  },
  getArtist: async (q) => {
    await refreshCatalog();
    const a = CATALOG.artists.get(q.id);
    if (!a) throw { code: 70, message: 'artist not found' };
    return { artist: { id: a.id, name: a.name, albumCount: 0, album: [], song: a.trackIds.slice(0, 500).map(id => CATALOG.tracks.get(id)).filter(Boolean).map(songOf) } };
  },
  getArtistInfo2: async (q) => ({ artistInfo2: { biography: '', similarArtist: [] } }),

  getRandomSongs: async (q) => {
    await refreshCatalog();
    const size = parseInt(q.size || '50', 10);
    const all = [...CATALOG.tracks.values()].sort(() => Math.random() - 0.5).slice(0, size);
    return { randomSongs: { song: all.map(songOf) } };
  },

  getStarred2: async () => {
    await refreshCatalog();
    // 「我喜欢的音乐」直接映射为收藏
    const liked = CATALOG.playlists.find(p => /我喜欢的音乐/.test(p.name));
    let ts = [];
    if (liked) { try { ts = await playlistTracks(liked); } catch (e) { } }
    return { starred2: { song: ts.map(songOf), album: [], artist: [] } };
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
      if (s.albumId && !seenA.has(s.albumId)) { seenA.add(s.albumId); albs.push({ id: s.albumId, name: s.album, artist: s.artists[0] || '', coverArt: s.cover, songCount: 0, duration: 0, created: '' }); }
      (s.artistIds || []).forEach((aid, i) => { if (aid && !seenR.has(aid)) { seenR.add(aid); ars.push({ id: aid, name: s.artists[i], albumCount: 0, coverArt: '' }); } });
    }
    return { searchResult3: { artist: ars, album: albs, song: songs.map(songOf) } };
  },
  getLyrics: async (q) => {
    let t = [...CATALOG.tracks.values()].find(x => x.name === q.title && x.artists.join('/').includes(q.artist || '')) ;
    const id = q.id || (t && t.id);
    if (!id) return { lyrics: { artist: q.artist || '', title: q.title || '', value: '' } };
    const m = await ensureAudio(id);
    // 经典 Subsonic 的 value 是纯文本，Folia 会自查格式（detectTimedLyricFormat 认得 enhanced-lrc、
    // 不认得 krc）。所以这里给 enhanced-lrc：`[00:15.50]<00:15.50>肌<00:15.84>寒` —— 行级 + 逐字都能用。
    const en = enhancedLrcFrom(m.lyric);
    return { lyrics: { artist: (m.artists || []).join(' / '), title: m.name, value: en || lrcFrom(m.lyric) } };
  },
  getLyricsBySongId: async (q) => {
    const m = await ensureAudio(q.id);
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
      try { trs = (await trackV2(m.id)).translations; } catch (e) { trs = null; }
      if (trs) { try { fs.writeFileSync(path.join(CACHE_DIR, m.id + '.json'), JSON.stringify({ ...m, translations: trs })); } catch (e) { } }
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
    const f = path.join(CACHE_DIR, 'cover_' + md5(id + '@' + px) + '.jpg');
    if (fs.existsSync(f)) return sendImage(res, fs.readFileSync(f));
    const t = CATALOG.tracks.get(id) || [...CATALOG.tracks.values()].find(x => x.albumId === id);
    const base = (t && t.cover) || (id.startsWith('http') ? id : '');
    if (!base) { res.writeHead(404); res.end('no cover'); return undefined; }
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
      } catch (e2) { res.writeHead(404); res.end('cover fetch failed'); return undefined; }
    }
  },
  stream: async (q, res, reqObj) => {
    const m = await ensureAudio(q.id);
    const file = path.join(CACHE_DIR, m.file);
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
        'Content-Length': end - start + 1, 'Access-Control-Allow-Origin': '*',
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return undefined;
    }
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': stat.size, 'Access-Control-Allow-Origin': '*' });
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
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'max-age=86400', 'Access-Control-Allow-Origin': '*' });
  res.end(buf);
  return undefined;   // 关键：不要返回 res，否则外层会再尝试 emit JSON
}

// ============================================================ HTTP
const server = http.createServer(async (rq, rs) => {
  const u = new URL(rq.url, 'http://' + (rq.headers.host || '127.0.0.1'));
  const q = Object.fromEntries(u.searchParams.entries());

  if (rq.method === 'OPTIONS') {
    rs.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
    return rs.end();
  }

  // ---- 设置页 & 控制 API ----
  if (u.pathname === '/' || u.pathname === '/index.html') {
    rs.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return rs.end(UI_HTML);
  }
  if (u.pathname === '/api/raw') {
    // 调试：直接打汽水接口，回原始文本
    const p = q.p || '/luna/pc/me';
    let out; let url = '';
    try {
      url = buildUrl(p) + (q.extra ? '&' + q.extra : '');
      const r = await req(url, { method: q.method || 'GET', headers: signedHeaders(url, null, q.body || null), body: q.body || null });
      out = { url, host: new URL(url).hostname, ok: r.status === 200, status: r.status, len: r.buf.length, text: r.buf.toString().slice(0, 300) };
    } catch (e) { out = { ok: false, error: e.message, url: url, apiConst: API, host: (() => { try { return new URL(url).hostname; } catch (x) { return 'parse-fail'; } })() }; }
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return rs.end(JSON.stringify(out, null, 1));
  }
  if (u.pathname === '/api/feed') {
    // 给模组的「无限续播」用：每次返回一批全新的推荐（池子是 splice 式的，天然不重复）
    let out;
    try {
      const n = parseInt(q.n || '60', 10) || 60;
      const ts = await fetchFeedN(n);
      out = {
        ok: true, count: ts.length,
        songs: ts.map(t => ({
          id: t.id, name: t.name, artists: t.artists || [], album: t.album || '',
          cover: t.cover || '', duration: t.duration || 0,
        })),
      };
    } catch (e) { out = { ok: false, error: e.message, count: 0, songs: [] }; }
    const body = JSON.stringify(out);
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Content-Length': Buffer.byteLength(body) });
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
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Content-Length': Buffer.byteLength(body) });
    return rs.end(body);
  }
  if (u.pathname === '/api/lyrics') {
    let out;
    try {
      const m = await ensureAudio(q.id);
      const raw = m.lyric || '';
      const isKrc = /^\[\d+,\d+\]/m.test(raw);
      out = { ok: !!raw, format: isKrc ? 'krc' : 'lrc', text: raw, title: m.name, artist: (m.artists || []).join(' / ') };
    } catch (e) { out = { ok: false, error: e.message }; }
    const body = JSON.stringify(out);
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Content-Length': Buffer.byteLength(body) });
    return rs.end(body);
  }
  if (u.pathname === '/api/status') {
    const body = JSON.stringify({
      ok: true, port: PORT, host: HOST, user: USER,
      device: DEV && DEV.did, loggedIn: !!COOKIE,
      sessionHint: COOKIE ? (sessHint || (COOKIE.length + ' 字符')) : '',
      catalog: { tracks: CATALOG.tracks.size, albums: CATALOG.albums.size, artists: CATALOG.artists.size, playlists: CATALOG.playlists.length },
      loadedAt: CATALOG.loadedAt || 0,
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
  if (u.pathname === '/health') {
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return rs.end(JSON.stringify({ ok: true, service: 'soda-subsonic', port: PORT }));
  }
  const m = /^\/rest\/([A-Za-z0-9_]+)(?:\.view)?$/.exec(u.pathname);
  if (!m) { rs.writeHead(404); return rs.end('not found'); }
  const name = m[1];

  const emit = (payload) => {
    const body = JSON.stringify({ 'subsonic-response': payload });
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Content-Length': Buffer.byteLength(body) });
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
  sweepTempCookies();
  if (opts.dataDir) {
    ROOT = path.resolve(opts.dataDir);
    CACHE_DIR = path.join(ROOT, '_cache');
    LYRIC_DIR = path.join(ROOT, '_lyric_cache');
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(LYRIC_DIR, { recursive: true });

  log('soda-subsonic 启动中 …' + (opts.dataDir ? '（数据目录 ' + ROOT + '）' : ''));

  // 先把服务起起来，UI 立刻可见；设备 / 登录态 / 曲库在后台初始化
  await new Promise((resolve, reject) => {
    const onErr = (e) => reject(new Error(e && e.code === 'EADDRINUSE'
      ? ('端口 ' + PORT + ' 已被占用 —— 是不是已经有一个 soda 服务在跑？')
      : (e && e.message) || String(e)));
    server.once('error', onErr);
    server.listen(PORT, HOST, () => { server.removeListener('error', onErr); resolve(); });
  });
  log('就绪 → http://' + HOST + ':' + PORT);
  log('Folia 里填：Navidrome 服务器 http://' + HOST + ':' + PORT + '　用户名 ' + USER + '　密码 ' + PASS);

  try { initNative(); } catch (e) { log('原生模块不可用: ' + e.message); }

  try {
    if (!loadDevice()) await registerDevice();
    else { log('设备身份 did=' + DEV.did); initBdms(); }
  } catch (e) { log('设备身份初始化失败: ' + e.message); }

  loadSession();
  if (!COOKIE || opts.forceSessionSync) {
    try { await refreshSessionFromClient(); }
    catch (e) { log('登录态同步失败（歌单/搜索将不可用）: ' + e.message); }
  } else {
    log('已载入登录态（' + COOKIE.length + ' 字符）');
  }

  try { await refreshCatalog(true); } catch (e) { log('首次刷新目录失败: ' + e.message); }
  const timer = setInterval(() => refreshCatalog(true).catch(() => { }), CATALOG_TTL);

  return {
    port: PORT, host: HOST, user: USER, pass: PASS,
    log: () => LOG_RING.slice(),
    stop() {
      try { clearInterval(timer); } catch (e) { }
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
