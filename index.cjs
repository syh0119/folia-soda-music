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
 *   · paths.data  —— 要保留的文件（登录态、设备标识）
 *   · paths.cache —— 可重建的缓存（解密音频 / 歌词 / 封面），用户可随时在模组面板清空
 * 不支持 paths 的旧宿主（0.7.19 / Folium 1.4）退回 %APPDATA%\luna_export\soda。
 * 路径一律按需现取（宿主是 getter，且缓存随时可能被清），不在启动时存字符串。
 *
 * 原生模块（bdms.node / device.node / metasecml.dll）**不随模组分发**，
 * 首次运行时从用户自己的汽水音乐客户端目录探测（见 server.cjs 的 resolveNativeDir）。
 */
'use strict';

const os = require('os');
const path = require('path');

const server = require('./server.cjs');

/** 旧布局兜底：不支持 api.storage.paths 的宿主 */
function legacyPaths() {
  const root = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'luna_export',
    'soda',
  );
  return { data: root, cache: path.join(root, '_cache') };
}

/**
 * 返回一个「每次调用都现取路径」的函数交给 server.start。
 * 宿主是 getter：目录不存在时会先建出来；用户清空缓存后也照常工作。
 */
function makeResolvePaths(api) {
  const st = api && api.storage;
  const supported = !!(st && st.paths);   // 等价于 'paths' in api.storage
  return () => {
    if (supported) {
      try { return { data: st.paths.data, cache: st.paths.cache }; }
      catch (e) { /* 权限缺失等 → 退回旧布局，别让服务起不来 */ }
    }
    return legacyPaths();
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
      handle = await server.start({ resolvePaths });
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

  api.rpc.handle('status', async () => ({
    running: !!handle,
    port: handle ? handle.port : null,
    user: handle ? handle.user : null,
    pass: handle ? handle.pass : null,
    dataDir: dataRoot,
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

  try { fs.mkdirSync(dataRoot, { recursive: true }); } catch (e) { }

  boot();

  api.lifecycle.onDeactivate(() => {
    try { if (handle) handle.stop(); } catch (e) { }
    handle = null;
  });
};
