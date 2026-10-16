/**
 * 原生模块宿主（**独立子进程**）
 * =============================================================================
 * `bdms.node` / `device.node` / `metasecml.dll` 是汽水音乐 PC 客户端自带的第三方原生模块。
 * 它们不是本模组的代码，也不受 Folia 模组权限约束 —— 一旦在主进程里 dlopen，
 * 就等于把一份外部原生代码塞进宿主主进程（同权限、同地址空间、同崩溃域）。
 *
 * 所以这里把它们隔离到子进程：
 *   · 主进程（server.cjs）不再 dlopen 任何外部原生模块；
 *   · 主进程不再修改自己的 `process.env.PATH` 与工作目录；
 *   · 子进程只做三件事：算请求签名 / 取设备序列号 / 解 spade 密钥；
 *   · 对外只是一个 JSON-RPC（`process.send`），入参出参全是可序列化字符串。
 *
 * 子进程由 `server.cjs` 的 NativeHost 用 `child_process.fork` 启动，
 * Electron 下会带上 `ELECTRON_RUN_AS_NODE=1`，这样 fork 出来的是纯 Node 而不是新的 GUI 实例。
 * 原生模块是 N-API（`napi_register_module_v1`），跨 Node / Electron ABI 稳定，无需重编译。
 *
 * 不上报、不联网、不写磁盘：本文件只做上面那三件事。
 */
'use strict';

const path = require('path');

let dir = '';
let bdms = null;
let devn = null;

function dlopen(p) {
  const m = { exports: {} };
  process.dlopen(m, p);   // 只在**本子进程**里加载外部原生代码
  return m.exports;
}

/** 加载原生模块。PATH / cwd 的改动只作用于本子进程，主进程完全不受影响。 */
function boot(nativeDir) {
  dir = String(nativeDir || '');
  if (!dir) throw new Error('native dir is empty');
  // metasecml.dll 是按相对名被 bdms.node 加载的，所以 cwd / PATH 得先落在这里
  process.env.PATH = dir + path.delimiter + (process.env.PATH || '');
  try { process.chdir(dir); } catch (e) { /* cwd 改不动也不致命，PATH 已够 */ }
  bdms = dlopen(path.join(dir, 'bdms.node'));
  try { devn = dlopen(path.join(dir, 'device.node')); } catch (e) { devn = null; }
  return { hasDevice: !!devn };
}

const handlers = {
  /** 初始化签名器；不 init 的话 X-Helios / X-Medusa 会是空串，track_v2 直接返回空 body */
  init(a) {
    if (!bdms) throw new Error('bdms 未加载');
    bdms.init({ deviceId: String(a.deviceId || '') });
    return true;
  },
  /** 算签名头，返回原始多行文本（由调用方按 name\r\nvalue 解析） */
  sign(a) {
    if (!bdms) throw new Error('bdms 未加载');
    return String(bdms.generateHttpSignatureHeaders(String(a.url || ''), String(a.lines || '')));
  },
  /** 机器序列号（device_register 用）。取不到就回空串，不抛。 */
  serial() {
    if (!devn) return '';
    try { return String(devn.getSerial() || '').replace(/\0+$/, ''); } catch (e) { return ''; }
  },
  /** applog 装饰：入参出参都是二进制，走 base64 */
  decorate(a) {
    if (!devn) throw new Error('device 模块未加载');
    const out = devn.applogDecorated(Buffer.from(String(a.b64 || ''), 'base64'));
    return { b64: Buffer.from(out).toString('base64') };
  },
  /** 解 spade 密钥。luna_core.decrypt 要的是 hex 字符串。 */
  decodeSpade(a) {
    if (!devn) throw new Error('device 模块未加载');
    const k = devn.decodeSpade(String(a.spade || ''));
    return Buffer.isBuffer(k) ? { kind: 'buffer', b64: k.toString('base64') } : { kind: 'string', text: String(k) };
  },
};

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object' || msg.id === undefined) return;
  const { id, cmd, args } = msg;
  try {
    if (cmd === 'boot') {
      const r = boot(args && args.dir);
      process.send({ id, ok: true, result: r });
      return;
    }
    if (cmd === 'ping') { process.send({ id, ok: true, result: dir }); return; }
    const fn = handlers[cmd];
    if (!fn) throw new Error('unknown native op: ' + String(cmd));
    process.send({ id, ok: true, result: fn(args || {}) });
  } catch (e) {
    process.send({ id, ok: false, error: (e && e.message) || String(e) });
  }
});

// 父进程没了就自己退出，别留孤儿
process.on('disconnect', () => process.exit(0));
