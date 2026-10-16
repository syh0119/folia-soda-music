/**
 * 汽水音乐 · 模组 main（Node 侧）
 * =============================================================================
 * 把原本要单独跑的 folia-soda 服务端**内嵌进模组**：
 *   · activate 时在 Folia 主进程里起一个本机 HTTP 服务（默认 127.0.0.1:4533）
 *   · Folia 的 Navidrome 通道照旧连它 —— 所以 NAVI 页签的配置完全不用改
 *   · 禁用 / 重载 / 退出时经 api.lifecycle.onDeactivate 关掉
 *
 * 文件目录：**绝不能落在模组目录里** ——
 * Folia 的模组授权绑定「模组目录的内容摘要」，往里面写一个字节都会摘要失配、
 * 模组被撤销授权并保持禁用。
 *
 * Folium 1.5 起用宿主给的 api.storage.paths（两个 getter，每次读取时目录不存在会先建出来）：
 *   · paths.data  —— 要保留的文件（登录态、设备标识、本机服务密钥 auth.json）
 *   · paths.cache —— 可重建的缓存（解密音频 / 歌词 / 封面），用户可随时在模组面板清空
 * 拿不到 paths 就**直接失败**（不再回退到没申报过的 %APPDATA%\luna_export\soda）。
 * 路径一律按需现取（宿主是 getter，且缓存随时可能被清），不在启动时存字符串。
 *
 * 需要申报的系统操作（详见 README「这个模组动了什么」一节）：
 *   · PowerShell —— 只用来调 DPAPI 解 Chromium Cookies 的加密主密钥（一次性、用完即弃）
 *   · reg query  —— 汽水客户端启动日志里找不到安装目录时，回退查注册表卸载项
 *   · 原生模块   —— bdms.node / device.node / metasecml.dll **不随模组分发**，从用户自己的
 *                   汽水客户端目录探测；且**在独立子进程里加载**（native-host.cjs），
 *                   不进宿主主进程、也不改主进程的 PATH / cwd
 *   · 联网       —— 以官方客户端的 UA 调 api.qishui.com；首次会以本机序列号注册一个设备身份
 */
'use strict';

const fs = require('fs');
const path = require('path');

const server = require('./server.cjs');

/**
 * 返回一个「每次调用都现取路径」的函数交给 server.start。
 * 宿主是 getter：目录不存在时会先建出来；用户清空缓存后也照常工作。
 *
 * **不做任何兜底**（维护者审查意见）：拿不到 api.storage.paths 就直接失败。
 * 以前会退回 `%APPDATA%\luna_export\soda`，那是个既没申报、也和模组数据无关的位置；
 * 更糟的是内嵌运行时「没有路径」的兜底默认值就是模组目录本身 —— 往那里写一个字
 * 都会让模组授权摘要失配、模组被撤销授权。宁可起不来并说清原因。
 */
function makeResolvePaths(api) {
  const st = api && api.storage;
  return () => {
    if (!st || !st.paths) {
      throw new Error('宿主没有 api.storage.paths —— 需要 Folium 1.5 / Folia 0.7.20 及以上；本模组不再回退到未申报的目录');
    }
    return { data: st.paths.data, cache: st.paths.cache };
  };
}

module.exports = function activate(api) {
  let handle = null;
  let lastError = null;
  let starting = false;

  const resolvePaths = makeResolvePaths(api);

  const safe = (fn, fallback) => { try { return fn(); } catch (e) { return fallback; } };

  async function boot() {
    if (starting) return;
    starting = true;
    try {
      handle = await server.start({ resolvePaths, embedded: true });
      lastError = null;
      api.log.info('[汽水] 音源服务已就绪 → http://127.0.0.1:' + handle.port);
    } catch (e) {
      lastError = (e && e.message) || String(e);
      handle = null;
      api.log.error('[汽水] 音源服务启动失败: ' + lastError);
    } finally {
      starting = false;
    }
  }

  // 交给 client 的全部连接信息：端口 / 数据面密码 / 控制面令牌。
  // 令牌每次启动重生成，只走 rpc（不进 URL、不落盘），所以任意网页拿不到。
  //
  // running = 端口已经在监听了 —— 服务可用，client 可以立刻拿密钥去配宿主的 Navidrome。
  // ready   = 后台初始化（原生模块 / 设备身份 / 登录态 / 曲库）也跑完了；
  //           **不要用它来判断「能不能连」**：曲库要几十秒才拉完，client 只等 running。
  api.rpc.handle('status', async () => ({
    running: !!handle,
    ready: handle ? !!handle.initDone() : false,
    port: handle ? handle.port : null,
    host: handle ? handle.host : null,
    user: handle ? handle.user : null,
    pass: handle ? handle.pass : null,
    token: handle ? handle.token : null,
    error: lastError,
    nativeDir: safe(() => server.resolveNativeDir(), null),
    clientDirs: safe(() => server.clientInstallDirs(), []),
    log: handle ? handle.log().slice(-40) : [],
  }));

  api.rpc.handle('restart', async () => {
    try { if (handle) await handle.stop(); } catch (e) { }
    handle = null;
    await boot();
    return { ok: !!handle, port: handle ? handle.port : null, error: lastError };
  });

  api.rpc.handle('log', async () => (handle ? handle.log().slice(-120) : []));

  // 模组自己的小状态（无限续播的开关等），落在 paths.data 里。
  // 以前是往**宿主的 localStorage** 写 `soda_endless_fm` —— 模组不该静默改宿主配置，改走这里。
  const stateFile = () => path.join(resolvePaths().data, 'state.json');
  const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) || {}; } catch (e) { return {}; } };
  api.rpc.handle('flags', async (arg) => {
    const cur = readState();
    if (!arg || typeof arg.key !== 'string') return cur;
    try {
      if (arg.remove) delete cur[arg.key]; else cur[arg.key] = arg.value;
      fs.writeFileSync(stateFile(), JSON.stringify(cur, null, 1));
    } catch (e) { /* 写不了就算了，别让功能整个挂掉 */ }
    return cur;
  });

  // 各个 Electron 窗口的状态 —— 用来判断诊断时主窗口有没有被面板/浮层遮挡或失焦
  // （Chromium 的遮挡检测会在窗口被挡住/失焦时主动降频，那会让测出来的帧率偏低）
  api.rpc.handle('windows', async () => {
    try {
      const { BrowserWindow } = require('electron');
      return BrowserWindow.getAllWindows().map(w => {
        let title = '';
        try { title = w.getTitle(); } catch (e) { }
        return {
          title,
          visible: w.isVisible(),
          focused: w.isFocused(),
          minimized: w.isMinimized(),
          bounds: w.getBounds(),
        };
      });
    } catch (e) {
      return { error: (e && e.message) || String(e) };
    }
  });

  // GPU 加速状态 —— 滑动掉帧最常见的根因就是它退化成软件渲染
  api.rpc.handle('gpu', async () => {
    try {
      const { app } = require('electron');
      const s = app.getGPUFeatureStatus() || {};
      let info = null;
      try {
        const { screen } = require('electron');
        const d = screen.getPrimaryDisplay();
        info = { hz: Number(d.displayFrequency) || 0, w: (d.size || {}).width, h: (d.size || {}).height, scale: d.scaleFactor };
      } catch (e) { }
      let devices = [];
      try {
        const gi = await app.getGPUInfo('complete');
        devices = (gi.gpuDevice || []).map(d => ({
          active: !!d.active,
          deviceId: d.deviceId,
          vendorId: d.vendorId,
          name: d.deviceString || (d.auxAttributes && d.auxAttributes.glRenderer) || '',
          renderer: (d.auxAttributes && d.auxAttributes.glRenderer) || '',
          vendor: (d.auxAttributes && d.auxAttributes.glVendor) || '',
        }));
      } catch (e) { }
      return {
        display: info,
        devices,
        gpu_compositing: s.gpu_compositing,
        rasterization: s.rasterization,
        webgl: s.webgl,
        webgl2: s.webgl2,
        webgpu: s.webgpu,
        skia_graphite: s.skia_graphite,
        canvas_oop_rasterization: s.canvas_oop_rasterization,
        video_decode: s.video_decode,
        raw: s,
      };
    } catch (e) {
      return { error: (e && e.message) || String(e) };
    }
  });

  // 显示器信息喂给渲染端。
  // 关键点：**要报「窗口实际所在那块屏」的刷新率**，而不是主屏的 ——
  // 这台机器上有多个虚拟显示适配器（ToDesk / MuMu / 雷电），窗口可能落在低刷新率的那块上，
  // 而 Chromium 的 rAF 是跟着「窗口所在屏的 vsync」走的。
  api.rpc.handle('display', async () => {
    try {
      const { screen, BrowserWindow } = require('electron');
      const primary = screen.getPrimaryDisplay();
      const displays = screen.getAllDisplays().map(d => ({
        id: d.id,
        hz: Number(d.displayFrequency) || 0,
        w: d.size.width,
        h: d.size.height,
        scale: d.scaleFactor,
        rotation: d.rotation,
        internal: !!d.internal,
        primary: !!d.internal && d.id === primary.id,
        bounds: d.bounds,
      }));
      const windows = BrowserWindow.getAllWindows().map(w => {
        let title = '';
        try { title = w.getTitle(); } catch (e) { }
        const b = w.getBounds();
        let d = null;
        try { d = screen.getDisplayMatching(b); } catch (e) { }
        return {
          title,
          bounds: b,
          displayId: d ? d.id : null,
          hz: d ? (Number(d.displayFrequency) || 0) : 0,
          size: d ? d.size : null,
          scale: d ? d.scaleFactor : null,
        };
      });
      return {
        hz: Number(primary.displayFrequency) || 0,          // 兼容旧字段：主屏
        width: primary.size.width,
        height: primary.size.height,
        scale: primary.scaleFactor,
        displays,
        windows,
      };
    } catch (e) {
      return { hz: 0, error: (e && e.message) || String(e) };
    }
  });

  boot();

  api.lifecycle.onDeactivate(() => {
    try { if (handle) handle.stop(); } catch (e) { }
    handle = null;
  });
};
