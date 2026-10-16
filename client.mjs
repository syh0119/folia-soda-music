/**
 * 汽水音乐 → Folia 在线音源（Folium 模组 · omni.providers）
 * =============================================================================
 * 作用：让「汽水音乐」出现在首页右下角的音源切换器里（不需要内置 provider 权限）。
 *       切换后首页搜索框 / 搜索浮层都搜汽水曲库，播放与歌词走本机音源服务。
 *
 * 前置：本机跑着 folia-soda 的 soda_subsonic.js（默认 http://127.0.0.1:4533）。
 *       歌单/专辑浏览请用侧栏的 Navidrome（NAVI）页签——omni.providers 的歌单标签
 *       在 Folium v2 之前是占位，这是上游限制。
 *
 * 接口依据：folia-major 的 src/mods/folium/contract.ts
 *   - folium.net.fetch(url, init) → { ok, status, headers, text(), json() }（json 是同步的！）
 *   - providers.register({ id, displayName, shortName, search, getSong, getAudioUrl, getLyrics })
 *   - getLyrics 返回 { main: { format, text } }，format 支持 'krc' / 'lrc' / 'enhanced-lrc' / 'ttml' …
 *     汽水的歌词原文就是 KRC，直接交给宿主即可原生逐字渲染。
 */
'use strict';

const DEFAULTS = {
  server: 'http://127.0.0.1:4533',
  user: 'soda',
  pass: '',                 // 留空 = 用 main 通过 rpc 报上来的随机密钥（auth.json），不用手填
  lyrics: true,
  autoNavidrome: true,      // 首次运行时把书库的 Navidrome 页签指向本机音源（见 ensureNavidromePreset）
};

export default function activate(folium) {
  const say = (m) => { try { folium.log.info('[汽水] ' + m); } catch (e) { } };

  /**
   * main 通过 rpc 报上来的连接信息（每次启动都可能变）：
   *   port       —— 实际监听端口
   *   user/pass  —— 数据面（`/rest/*`）的用户名与随机密钥（auth.json，**持久**）
   *   token      —— 控制面（`/api/*`）令牌，**每次启动重生成**，不落盘、不进任何对外的 URL
   *
   * 为什么密码不再写死 soda/soda：维护者审查指出固定口令等于没有鉴权。
   * 现在 /rest 用随机密钥（宿主的 Navidrome 配置里存的就是它），/api 再叠一层一次性令牌。
   */
  const CONN = { port: 0, user: '', pass: '', token: '' };
  let saidNoPass = false;
  /**
   * 反复问 main 直到服务真的在监听，然后拿着端口 / 密钥 / 令牌继续。
   *
   * 为什么是轮询而不是问一次（这是 v2.2.0 里导致「服务在跑但 NAVI 连不上」的根因）：
   * main 侧 boot() 是异步的，端口 listen 之前 status 会回 running=false。
   * 旧写法只问一次，撞上 running=false 就把 CONN 定死成空，之后**再也不会重问** ——
   * 于是探活一轮一轮 401，宿主的 Navidrome 配置永远拿不到新的随机密钥。
   *
   * 上限约 60 秒：正常情况端口 1~2 秒就起来；拉曲库要几十秒，但那只影响 ready，
   * 不影响这里（令牌和端口在 listen 成功那一刻就有了）。
   */
  let connReadyResolve = null;
  const connReady = new Promise((resolve) => { connReadyResolve = resolve; });
  (async () => {
    for (let i = 0; i < 150; i += 1) {
      try {
        const st = await folium.rpc.call('status');
        if (st && st.running) {
          CONN.port = st.port || 0;
          CONN.user = st.user || '';
          CONN.pass = st.pass || '';
          CONN.token = st.token || '';
          if (CONN.pass && CONN.token) {
            say('main 已就绪：端口 ' + CONN.port + (st.ready ? '（曲库也好了）' : '（曲库还在后台拉）'));
            break;
          }
        }
      } catch (e) { /* 旧宿主没有这个 rpc：下面会退回设置里手填的值 */ }
      await new Promise((r) => setTimeout(r, 400));
    }
    connReadyResolve(CONN);
  })();

  /**
   * 一拿到数据面密钥就纠正宿主的 Navidrome 配置 —— **不要等 HTTP 探活**。
   * 探活用的是控制面令牌，Navidrome 用的是数据面密钥，两者没有先后依赖；
   * 旧版把「探活成功」写成配 Navidrome 的前提，探活一失败密码就永远纠正不过来，
   * 于是 NAVI 页签一直拿旧口令去连、报「服务不可用」。
   */
  connReady.then(() => { if (CONN.pass) ensureNavidromePreset(); });

  /**
   * 读/写模组自己的小状态。
   * 首选宿主的**模组专用存储** `folium.storage`（按 modId 隔离，宿主自己管的）；
   * 旧宿主没有就退回 main 侧的 `flags` rpc（写进 paths.data/state.json）。
   * 两条路都不碰**宿主的** localStorage。
   */
  const modStore = (() => {
    try { const s = folium.storage; return (s && typeof s.get === 'function') ? s : null; }
    catch (e) { return null; }
  })();
  const flagsGet = async (key) => {
    try { if (modStore) return await modStore.get(key); } catch (e) { }
    try { return (await folium.rpc.call('flags'))[key]; } catch (e) { return undefined; }
  };
  const flagsSet = async (key, value) => {
    try { if (modStore) { await modStore.set(key, value); return; } } catch (e) { }
    try { await folium.rpc.call('flags', { key, value }); } catch (e) { }
  };
  const flagsDel = async (key) => {
    try { if (modStore) { await modStore.delete(key); return; } } catch (e) { }
    try { await folium.rpc.call('flags', { key, remove: true }); } catch (e) { }
  };

  // ---------------------------------------------------------------- 设置分区
  const section = folium.registries.settingsSections.register({
    id: 'conn',
    label: { 'zh-CN': '汽水音乐', en: 'Soda Music' },
    description: {
      'zh-CN': '音源服务已内置在本模组里（main 启动时自动拉起），这里只调连接参数，改完即时生效。\n' +
        '注意：右下角音源切换器里的「汽水音乐」只提供 搜索 / 播放 / 歌词 —— 它的「歌单、专辑、电台」三个标签是 ' +
        'Folia 上游的占位（omni.providers 没有开放这些面，不是本模组没做）。\n' +
        '要浏览汽水的歌单 / 专辑 / 歌手 / 收藏，请用书库里的「Navidrome」（NAVI）页签：它连的就是这个服务，' +
        '而且把切换器切回网易云之类的音源也不会消失。',
      en: 'The source server is bundled in this mod (started by main). Use the library\'s Navidrome tab to browse playlists / albums / artists.',
    },
    settings: [
      {
        key: 'server', type: 'text',
        label: { 'zh-CN': '服务器地址', en: 'Server URL' },
        defaultValue: DEFAULTS.server,
        description: { 'zh-CN': '默认 http://127.0.0.1:4533', en: 'Default http://127.0.0.1:4533' },
      },
      {
        key: 'user', type: 'text',
        label: { 'zh-CN': '用户名', en: 'Username' },
        defaultValue: DEFAULTS.user,
        description: { 'zh-CN': '内建服务固定为 soda', en: 'Fixed to "soda" for the bundled server' },
      },
      {
        key: 'pass', type: 'text',
        label: { 'zh-CN': '密码（留空 = 用自动生成的密钥）', en: 'Password (blank = auto key)' },
        defaultValue: DEFAULTS.pass,
        description: {
          'zh-CN': '内建服务的密码是启动时自动生成/读取的随机密钥（存在数据目录的 auth.json），正常不用填。' +
            '只有把「服务器地址」指向别处自建的服务时才需要手填。',
          en: 'Blank = the bundled server\'s auto-generated key (auth.json in the data dir).',
        },
      },
      {
        key: 'autoNavidrome', type: 'boolean',
        label: { 'zh-CN': '自动配置 Navidrome 页签', en: 'Auto-configure Navidrome tab' },
        defaultValue: DEFAULTS.autoNavidrome,
        description: {
          'zh-CN': '开着时会把书库的 Navidrome 页签指到本机音源 —— 这是本模组**唯一**会改宿主配置的地方' +
            '（写宿主的 navidrome_config / navidrome_enabled），而且只在你还没配过、或本来就指向本机时才写。' +
            '不想让它动宿主配置就关掉，然后按模组日志里打印的地址和密码自己填。',
          en: 'When on, points the library Navidrome tab at the local server. Turn off to configure it yourself.',
        },
      },
      {
        key: 'lyrics', type: 'boolean',
        label: { 'zh-CN': '逐字歌词', en: 'Word-by-word lyrics' },
        defaultValue: DEFAULTS.lyrics,
        description: { 'zh-CN': '用汽水原生 KRC，逐字点亮', en: 'Use native KRC' },
      },
      {
        key: 'vsync', type: 'boolean',
        label: { 'zh-CN': '垂直同步（跟随显示器刷新率）', en: 'V-Sync (follow display)' },
        defaultValue: true,
        group: { 'zh-CN': '性能', en: 'Performance' },
        description: {
          'zh-CN': '打开：不做限帧，动画与显示器刷新对齐。关掉之后，下面填的数值才会生效。',
          en: 'On = render at the display refresh rate (no cap).',
        },
      },
      {
        key: 'frameRate', type: 'number',
        label: { 'zh-CN': '锁定帧率（关闭垂直同步后生效）', en: 'Frame rate cap' },
        min: 0, max: 240, step: 1, defaultValue: 60,
        group: { 'zh-CN': '性能', en: 'Performance' },
        description: {
          'zh-CN': '只在关闭「垂直同步」时生效。0 = 也不限帧；常用 60 / 90 / 120；省电可压到 30。',
          en: 'Only applies when V-Sync is off. 0 = uncapped.',
        },
      },
    ],
  });

  const cfg = () => Object.assign({}, DEFAULTS, section.params.get() || {});
  /** 设置里的地址还是本机那台时，用 main 报上来的真实端口（端口可能被改过） */
  const base = () => {
    const s = String(cfg().server || DEFAULTS.server).replace(/\/+$/, '');
    if (CONN.port && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(s)) return 'http://127.0.0.1:' + CONN.port;
    return s;
  };
  /** 连的是内建服务就用 main 给的随机凭据；设置里明显指向别处时尊重用户填的 */
  const creds = () => {
    const c = cfg();
    const builtin = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(c.server || ''));
    return {
      user: (builtin && CONN.user) || c.user || DEFAULTS.user,
      pass: (builtin && CONN.pass) || c.pass || '',
    };
  };
  const auth = () => {
    const c = creds();
    return 'u=' + encodeURIComponent(c.user) + '&p=' + encodeURIComponent(c.pass) + '&v=1.16.1&c=Folia&f=json';
  };
  /** 控制面请求（/api/*）：带上每次启动随机的令牌 —— 少了它服务端一律 401 */
  const apiFetch = (path, init) => folium.net.fetch(base() + path, Object.assign({}, init || {}, {
    headers: Object.assign({}, (init && init.headers) || {}, CONN.token ? { 'x-soda-token': CONN.token } : {}),
  }));

  /** 调 Subsonic 接口；net.fetch 的 json() 是同步方法，不要 await */
  async function call(ep, params) {
    const url = base() + '/rest/' + ep + '?' + auth() + (params ? '&' + params : '');
    const r = await folium.net.fetch(url, { timeoutMs: 20000 });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (r.statusText || ''));
    const j = r.json();
    const b = j && j['subsonic-response'];
    if (!b) throw new Error('响应不是 subsonic-response');
    if (b.status !== 'ok') throw new Error((b.error && b.error.message) || 'subsonic failed');
    return b;
  }

  const toSong = (s) => ({
    id: String(s.id),
    title: s.title || '未知曲目',
    artists: String(s.artist || '').split(/\s*\/\s*/).filter(Boolean),
    album: s.album || undefined,
    coverUrl: s.coverArt
      ? base() + '/rest/getCoverArt?' + auth() + '&id=' + encodeURIComponent(s.coverArt) + '&size=600'
      : undefined,
    durationMs: (Number(s.duration) || 0) * 1000,
  });

  // ---------------------------------------------------------------- 注册音源
  folium.experimental['omni.providers'].register({
    id: 'soda',
    displayName: '汽水音乐',
    shortName: '汽水',

    async search(query, page) {
      const b = await call('search3',
        'query=' + encodeURIComponent(query) +
        '&songCount=' + page.limit + '&songOffset=' + page.offset +
        '&albumCount=0&artistCount=0');
      const songs = (b.searchResult3 && b.searchResult3.song) || [];
      return { items: songs.map(toSong), hasMore: songs.length >= page.limit };
    },

    async getSong(id) {
      const b = await call('getSong', 'id=' + encodeURIComponent(id));
      return b.song ? toSong(b.song) : null;
    },

    async getAudioUrl(song) {
      return { url: base() + '/rest/stream?' + auth() + '&id=' + encodeURIComponent(song.id) };
    },

    async getLyrics(song) {
      if (!cfg().lyrics) return null;
      try {
        const r = await apiFetch('/api/lyrics?id=' + encodeURIComponent(song.id), { timeoutMs: 25000 });
        if (!r.ok) return null;
        const j = r.json();
        if (!j || !j.ok || !j.text) return null;
        return { main: { format: j.format === 'krc' ? 'krc' : 'lrc', text: j.text } };
      } catch (e) {
        say('歌词获取失败: ' + e.message);
        return null;
      }
    },
  });

  // ---------------------------------------------------------------- 命令（显示在模组面板里，带执行按钮）
  folium.registries.commands.register({
    id: 'sync-login',
    label: { 'zh-CN': '同步汽水客户端登录态', en: 'Sync Soda client login' },
    description: {
      'zh-CN': '从本机汽水音乐 PC 客户端提取登录态（DPAPI + AES-GCM 解 Chromium Cookies 库）。' +
        '同步前请先完全退出汽水客户端，否则 Cookies 库被占用会失败。',
      en: 'Extract the login state from the local Soda Music PC client.',
    },
    keywords: ['汽水', '登录', 'soda', 'login', 'session', '同步'],
    run: async () => {
      try {
        const r = await apiFetch('/api/refresh_session', { method: 'POST', timeoutMs: 60000 });
        const j = r.json();
        if (j && j.ok) {
          say('登录态同步成功：' + (j.hint || ''));
          return { message: '登录态已同步（' + (j.hint || 'ok') + '）。若歌单/搜索没刷新，再执行「刷新汽水曲库目录」。' };
        }
        const err = (j && j.error) || ('HTTP ' + r.status);
        say('登录态同步失败：' + err);
        return { message: '同步失败：' + err };
      } catch (e) {
        const msg = '连不上音源服务 ' + base() + '（' + e.message + '）——音源服务跑在模组里，去模组面板看「汽水音乐」的日志';
        say(msg);
        return { message: msg };
      }
    },
  });

  folium.registries.commands.register({
    id: 'refresh-catalog',
    label: { 'zh-CN': '刷新汽水曲库目录', en: 'Refresh Soda catalog' },
    description: {
      'zh-CN': '重新拉取账号曲库（我的歌单 / 专辑 / 歌手 / 收藏）。改了歌单或刚同步完登录态后执行。',
      en: 'Re-fetch the account library.',
    },
    keywords: ['汽水', '刷新', 'soda', 'refresh', 'catalog'],
    run: async () => {
      try {
        const r = await apiFetch('/api/refresh_catalog', { method: 'POST', timeoutMs: 60000 });
        const j = r.json();
        if (j && j.ok) { say('曲库目录已刷新'); return { message: '曲库目录已刷新，NAVI 页签里重新进入即可看到。' }; }
        const err = (j && j.error) || ('HTTP ' + r.status);
        say('刷新失败：' + err);
        return { message: '刷新失败：' + err };
      } catch (e) {
        say('刷新失败：' + e.message);
        return { message: '刷新失败：' + e.message };
      }
    },
  });

  // ============================================================ 无限续播（追队列版）
  // 第一版用的是 Folia 的私人 FM：接管 omni.getPersonalFm + setIsFmMode(true)。
  // 续播有了，但 FM 模式会把播放页的「队列」页签换成「电台」面板 —— 用户要看队列列表。
  //
  // 这版改为自己盯播放队列（不开 FM）：
  //   · 每 5 秒读一次 playback store（playQueue + currentSong）
  //   · 「当前之后剩 ≤ 2 首」时，把汽水推荐直接追加进 playQueue（去重）
  // 不碰 omni、不碰 isFmMode，队列页签保持原样。仍然需要 internals（folia 版本范围）。
  const PROVIDER_ID = 'folium.soda-music.soda';   // 宿主 id 规则：folium.<modid>.<providerid>
  const FM_BATCH = 60;                            // 每次续拉多少首
  const FM_REMAIN = 2;                            // 剩几首时触发
  const QUEUE_MAX = 100;                          // 队列上限：超过就裁掉前面序号靠前的
  const FM_TICK_MS = 10000;                       // 盯队列的间隔
  let fmTimer = null;

  /** 把汽水的推荐流歌曲转成宿主内部的 UnifiedSong（字段照 omniProviders.ts 的 toUnifiedSong） */
  const toUnified = (s) => {
    const id = String(s.id);
    const cover = s.cover
      ? base() + '/rest/getCoverArt?' + auth() + '&id=' + encodeURIComponent(s.cover) + '&size=600'
      : '';
    return {
      id,
      name: s.name || '未知曲目',
      artists: (s.artists || []).map((n, i) => ({ id: id + '#artist' + i, name: n })),
      album: Object.assign({ id: id + '#album', name: s.album || '' }, cover ? { coverUrl: cover } : {}),
      durationMs: Number(s.duration) || 0,
      sourceRef: { kind: 'online', providerId: PROVIDER_ID, mediaId: id },
    };
  };

  /** 从音源服务取一批全新的推荐歌 */
  async function feedSongs(n) {
    const r = await apiFetch('/api/feed?n=' + (n || FM_BATCH), { timeoutMs: 60000 });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = r.json();
    if (!j || !j.ok || !Array.isArray(j.songs) || !j.songs.length) return [];
    return j.songs.map(toUnified);
  }

  /**
   * 往播放队列追加。
   * 优先用宿主**公开 API**：`folium.playback.enqueue({ ref })`（song DTO 的 ref 形如
   * `online:<providerId>:<mediaId>`，见宿主 `sourceRef` 的序列化）。它需要 `playback.control` 权限。
   * 公开 API 不可用、或一首都没被接受时，才退回读取宿主 playback store 的 `setPlayQueue`。
   *
   * ⚠️ 退回路径依赖 `folium.internals`（非公开接口，已在 README 里申报），
   *    所以清单里仍有 `folia` 版本范围；等到 `folium.playback.enqueue` 在实测中稳定后可以整段删掉。
   */
  function hostPlaybackStore() {
    try {
      const internals = folium.internals;
      const pb = internals && internals.stores && internals.stores.playback;
      return (pb && typeof pb.getState === 'function') ? pb : null;
    } catch (e) { return null; }
  }
  function enqueueViaPublicApi(song) {
    try {
      const pb = folium.playback;
      if (!pb || typeof pb.enqueue !== 'function') return false;
      return !!pb.enqueue({ ref: 'online:' + PROVIDER_ID + ':' + song.id });
    } catch (e) { return false; }
  }

  /** 开启：每 10 秒盯一次队列，快到末尾就追加推荐。开关状态存在模组自己的 data 目录，重启自动恢复 */
  function enableEndless() {
    const pb = hostPlaybackStore();
    if (!pb) throw new Error('拿不到播放 store：需要在清单里声明 folia 版本范围（本模组已声明 folia 版本范围）');
    const tick = async () => {
      const st = pb.getState();
      const q = st.playQueue || [];
      if (!q.length) return;
      const cur = st.currentSong;
      const curId = cur ? String(cur.id ?? (cur.sourceRef && cur.sourceRef.mediaId) ?? '') : '';
      const ci = curId ? q.findIndex(x => String(x.id) === curId) : -1;
      const remain = ci >= 0 ? q.length - ci - 1 : q.length;
      if (remain > FM_REMAIN) return;
      const have = new Set(q.map(x => String(x.id)));
      const songs = (await feedSongs(FM_BATCH)).filter(x => !have.has(String(x.id)));
      if (!songs.length) return;
      // 先试公开 API；一首都没进去才退回内部 store（避免两条路同时追加造成重复）
      let added = 0;
      for (const s of songs) if (enqueueViaPublicApi(s)) added += 1;
      if (added === 0) {
        let nq = q.concat(songs);
        if (nq.length > QUEUE_MAX) nq = nq.slice(nq.length - QUEUE_MAX);   // 超上限：去掉前面序号靠前的
        st.setPlayQueue(nq);
        added = songs.length;
      }
      say('无限续播：已续上 ' + added + ' 首');
    };
    if (fmTimer) return;
    flagsSet('endless', 1);
    fmTimer = setInterval(() => { tick().catch(() => { }); }, FM_TICK_MS);
    tick().catch(() => { });
  }

  /** 关闭：停止盯队列，并清掉持久化的开关 */
  function disableEndless() {
    if (fmTimer) { clearInterval(fmTimer); fmTimer = null; }
    flagsDel('endless');
  }

  // 恢复持久化的无限续播开关：重启 Folia 后自动开启，不需要手动执行命令。
  // 延迟 3 秒等 playback store 就绪；tick 本身有容错，store 没就绪就下个周期再试。
  flagsGet('endless').then((v) => {
    if (String(v) !== '1') return;
    setTimeout(() => { try { enableEndless(); say('无限续播已自动恢复'); } catch (e) { } }, 3000);
  }).catch(() => { });

  folium.registries.commands.register({
    id: 'endless-on',
    label: { 'zh-CN': '开启无限续播', en: 'Enable endless radio' },
    description: {
      'zh-CN': '每 10 秒盯一次播放队列，剩 2 首时自动追加一批全新的汽水推荐（60 首、不重复）。' +
        '不开私人 FM 模式，播放页的「队列」列表保持原样。开关存在模组数据目录里，重启 Folia 后自动恢复。',
      en: 'Watch the queue every 5s and append fresh Soda recommendations when only 2 songs remain.',
    },
    keywords: ['汽水', '续播', '无限', '推荐', 'fm', 'soda', 'endless', 'radio'],
    run: async () => {
      try {
        enableEndless();
        return { message: '无限续播已开启：队列剩 ' + FM_REMAIN + ' 首时自动续上汽水推荐（每次 ' + FM_BATCH + ' 首，不重复）。' };
      } catch (e) {
        const msg = '开启失败：' + e.message;
        say(msg);
        return { message: msg };
      }
    },
  });

  folium.registries.commands.register({
    id: 'endless-off',
    label: { 'zh-CN': '关闭无限续播', en: 'Disable endless radio' },
    description: {
      'zh-CN': '停止盯队列。已追加的歌保留，播完即停。',
      en: 'Stop watching the queue. Already appended songs remain.',
    },
    keywords: ['汽水', '关闭', '续播', 'fm', 'soda', 'off'],
    run: async () => {
      disableEndless();
      say('无限续播已关闭');
      return { message: '无限续播已关闭。' };
    },
  });

  folium.registries.commands.register({
    id: 'endless-status',
    label: { 'zh-CN': '无限续播状态', en: 'Endless radio status' },
    description: {
      'zh-CN': '诊断用：查看监听是否在跑、队列长度、当前播到第几首、还剩几首。',
      en: 'Diagnostics: watcher state, queue length, current index and remaining count.',
    },
    keywords: ['汽水', '续播', '状态', '诊断', 'soda', 'status'],
    run: async () => {
      try {
        const internals = folium.internals;
        const pb = internals && internals.stores && internals.stores.playback;
        if (!pb || typeof pb.getState !== 'function') return { message: '拿不到播放 store。' };
        const st = pb.getState();
        const q = st.playQueue || [];
        const cur = st.currentSong;
        const curId = cur ? String(cur.id ?? (cur.sourceRef && cur.sourceRef.mediaId) ?? '') : '';
        const ci = curId ? q.findIndex(x => String(x.id) === curId) : -1;
        const remain = ci >= 0 ? q.length - ci - 1 : q.length;
        const lines = [
          '监听：' + (fmTimer ? '运行中' : '未开启'),
          '队列长度：' + q.length,
          '当前歌曲：' + (cur ? (cur.name || curId) : '(无)'),
          '当前序号：' + (ci >= 0 ? ci + ' / ' + (q.length - 1) : '未在队列中匹配到（id=' + (curId || '空') + '）'),
          '剩余：' + remain + ' 首（剩 ' + FM_REMAIN + ' 首触发追加）',
        ];
        if (ci === -1 && curId) lines.push('⚠️ 当前歌曲在队列里找不到 —— 这会让续播不触发，把这条发给我');
        return { message: lines.join('\n') };
      } catch (e) {
        return { message: '查询失败：' + e.message };
      }
    },
  });

  // ============================================================ 歌词优先（逐字不被在线兜底顶掉）
  // Folia 的歌词优先级是「在线匹配（网易云/酷狗/QQ）> 服务端歌词」——
  // src/components/app/playback/createLyricsSetter.ts 的 getStoredNeteaseLyrics：
  //
  //   if (song.isNavidrome) {
  //       if (song.matchedLyricsSource === 'netease' && song.matchedLyrics) return song.matchedLyrics;
  //       return null;
  //   }
  //
  // 也就是说即使我们的 Navidrome 歌词带原生逐字（cueLine），也可能被在线歌词盖掉，
  // 表现就是「歌词有、逐字动画没有」。
  //
  // 用 `lyrics.transform` 钩子纠正（官方支持改写 lines；同步执行，>16ms 会警告，所以要预取）：
  //   · 这首歌我们有原生逐字 → 换成我们的（动画回来）
  //   · 没有 / 还没取到     → 什么都不做，继续用在线兜底
  const lyricLines = new Map();   // trackId -> FoliumLine[] | null（null = 确认没有原生逐字）

  const ourSongId = (song) => {
    if (!song || !song.id) return null;
    const s = String(song.source || '');
    return (s === 'navidrome' || s === PROVIDER_ID) ? String(song.id) : null;
  };

  async function prefetchLines(id) {
    if (lyricLines.has(id)) return;
    lyricLines.set(id, null);                       // 占位，避免同一首重复请求
    try {
      const r = await apiFetch('/api/lines?id=' + encodeURIComponent(id), { timeoutMs: 20000 });
      const j = r.json();
      const lines = (j && j.ok && j.wordByWord && Array.isArray(j.lines)) ? j.lines : null;
      lyricLines.set(id, lines && lines.length ? lines : null);
      if (lines && lines.length) say('逐字歌词就绪 ' + id + '（' + lines.length + ' 行）');
    } catch (e) {
      lyricLines.set(id, null);
    }
  }

  folium.events.on('playback.songChanged', (e) => {
    const id = ourSongId(e && e.song);
    if (id) prefetchLines(id);
  });

  folium.events.on('lyrics.transform', (ev) => {
    const id = ourSongId(ev && ev.song);
    if (!id) return;
    const mine = lyricLines.get(id);
    if (mine && mine.length) {
      ev.lines = mine;                              // 我们有原生逐字 → 顶掉在线兜底
    } else if (mine === undefined) {
      prefetchLines(id);                            // 还没备好：这次先让兜底上，下次生效
    }
  });

  // ============================================================ 锁定渲染帧率
  // Folia 的限帧器在 utils/frameRateLimiter.ts，通过 useVisualizerSettingsStore 暴露，
  // 而那个 store 就在 folium.internals.stores.visualizerSettings：
  //
  //   handleSetVisualizerFrameRate: (frameRate) => {
  //       localStorage.setItem('visualizer_frame_rate', String(frameRate));   // 持久化
  //       setGlobalVisualizerFrameRate(frameRate);                            // ← 立刻换掉 rAF，实时生效
  //       set({ visualizerFrameRate: frameRate });
  //   }
  //
  // 它不像原生设置界面那样只认 60/90/120 —— 传什么用什么。
  // 但要避开 0 / 负数（`1000/0` 是 Infinity，条件永远不成立，画面会直接冻住），所以这里夹到 24–144。
  // ——— 显示器刷新率：优先问主进程（准），拿不到则在渲染端用 rAF 采样兜底 ———
  let displayHz = 0;

  /** 渲染端兜底：采样 rAF 间隔取中位数。注意它会被「正在生效的限帧器」污染，所以只是兜底。 */
  function measureHzByRaf() {
    return new Promise((resolve) => {
      const gaps = [];
      let last = 0, n = 0;
      const tick = (t) => {
        if (last) gaps.push(t - last);
        last = t;
        if (++n < 40) { try { requestAnimationFrame(tick); } catch (e) { resolve(0); } }
        else {
          gaps.sort((a, b) => a - b);
          const med = gaps[Math.floor(gaps.length / 2)] || 16.7;
          resolve(Math.round(1000 / med));
        }
      };
      try { requestAnimationFrame(tick); } catch (e) { resolve(0); }
    });
  }

  async function probeDisplay() {
    try {
      const r = await folium.rpc.call('display');
      if (r && r.hz > 0) { displayHz = Math.round(r.hz); return displayHz; }
    } catch (e) { }
    try { displayHz = await measureHzByRaf(); } catch (e) { }
    if (displayHz) say('显示器刷新率：' + displayHz + ' Hz');
    return displayHz;
  }

  /**
   * 应用帧率设置。
   *   v = 省略           → 按设置区的 vsync / frameRate 组合决定（设置项变化时走这条）
   *   v = 数字 / 'off'   → 直接用这个值（命令快捷方式走这条）
   */
  function applyFrameRateCap(v) {
    let value;
    if (v === undefined) {
      const cur = section.params.get() || {};
      if (cur.vsync !== false) {
        value = 'off';                       // 垂直同步 → 跟随显示器（Folia 的 off 就是原生 rAF）
      } else {
        const n = Number(cur.frameRate);
        value = (!Number.isFinite(n) || n <= 0) ? 'off' : Math.max(24, Math.min(240, Math.round(n)));
      }
    } else if (v === 'off') {
      value = 'off';
    } else {
      const n = Number(v);
      value = (!Number.isFinite(n) || n <= 0) ? 'off' : Math.max(24, Math.min(240, Math.round(n)));
    }
    const label = value === 'off'
      ? ('垂直同步 · 跟随显示器' + (displayHz ? ' ' + displayHz + ' Hz' : '（刷新率未探到）'))
      : (value + ' fps');

    // 警告：Folia 的限帧器带 1ms 容差（shouldProcessFrameAtRate 里 `1000/rate - 1`）。
    // 如果这个阈值仍大于显示器的帧间隔，它就会「隔一帧才放行」—— 实际帧率掉到大约一半，
    // 而且帧间隔在两个值之间来回跳，观感比不限帧还卡。
    // 例：165Hz 屏上设 120 → 阈值 7.33ms > 间隔 6.06ms → 实际只有 ~82fps。
    let warn = '';
    if (value !== 'off' && displayHz > 0) {
      const gapMs = 1000 / displayHz;
      if (1000 / value - 1 > gapMs) {
        const eff = Math.round(1000 / (Math.floor(1000 / value) || 1000 / value));
        warn = '\n⚠️ 你的显示器是 ' + displayHz + ' Hz，' + value + ' fps 与它不整除：'
          + '限帧器会隔帧放行，实际只有约 ' + eff + ' fps 而且不均匀，反而比不限帧更卡。'
          + '想要最流畅，选「垂直同步」即可。';
      }
    }

    // 首选宿主内部：它内部就是「写 localStorage + 立刻换掉 window.requestAnimationFrame」，改完即时生效。
    // 但访问 folium.internals 需要清单里声明 folia 版本范围；没声明就走下面的 localStorage 兜底。
    try {
      const vs = folium.internals && folium.internals.stores && folium.internals.stores.visualizerSettings;
      if (vs && typeof vs.getState === 'function') {
        const st = vs.getState();
        if (typeof st.handleSetVisualizerFrameRate === 'function') {
          st.handleSetVisualizerFrameRate(value);
          say('帧率上限 → ' + label + warn);
          return label + warn;
        }
      }
    } catch (e) { }

    // 兜底：直接写宿主启动时读的那个键。代价是 Folia 只在启动时读一次，得重启才生效。
    try {
      localStorage.setItem('visualizer_frame_rate', String(value));
      say('帧率上限 → ' + label + '（已保存，重启 Folia 后生效）');
      return label + '（重启 Folia 后生效）' + warn;
    } catch (e) {
      say('设置帧率失败: ' + e.message);
      return null;
    }
  }

  // 只在用户**改过**这两项时才应用 —— 否则一启动就把用户在 Folia 自带设置里调好的帧率覆盖掉了。
  try {
    const snap = () => { const v = section.params.get() || {}; return JSON.stringify([v.vsync, v.frameRate]); };
    let lastKey = snap();
    section.params.subscribe(() => {
      const key = snap();
      if (key === lastKey) return;
      lastKey = key;
      applyFrameRateCap();
    });
  } catch (e) { }

  folium.registries.commands.register({
    id: 'frame-cap',
    label: { 'zh-CN': '锁定渲染帧率', en: 'Cap frame rate' },
    description: {
      'zh-CN': '限制播放页动画的渲染帧率以缓解卡顿，**立即生效**（无需重启），也会持久化。' +
        '选「垂直同步」就是不限帧、跟随显示器刷新率（Folia 默认）。',
      en: 'Cap the player animation frame rate. Takes effect immediately.',
    },
    keywords: ['汽水', '帧率', '卡顿', '性能', '流畅', '垂直同步', 'vsync', 'fps', 'frame', 'soda'],
    params: [{
      key: 'cap', type: 'select',
      label: { 'zh-CN': '帧率上限', en: 'Frame rate cap' },
      defaultValue: 'off',
      options: [
        { value: 'off', label: { 'zh-CN': '垂直同步（跟随显示器刷新率）', en: 'V-Sync (follow display)' } },
        { value: '30', label: { 'zh-CN': '30 fps', en: '30 fps' } },
        { value: '45', label: { 'zh-CN': '45 fps', en: '45 fps' } },
        { value: '60', label: { 'zh-CN': '60 fps', en: '60 fps' } },
        { value: '90', label: { 'zh-CN': '90 fps', en: '90 fps' } },
        { value: '120', label: { 'zh-CN': '120 fps', en: '120 fps' } },
        { value: '144', label: { 'zh-CN': '144 fps', en: '144 fps' } },
        { value: '240', label: { 'zh-CN': '240 fps', en: '240 fps' } },
      ],
    }],
    run: async ({ values }) => {
      const raw = values && values.cap;
      const msg = applyFrameRateCap(raw === 'off' || raw == null ? 'off' : Number(raw));
      const hz = displayHz ? ('（你的显示器：' + displayHz + ' Hz）') : '（没探到显示器刷新率）';
      return { message: (msg ? ('渲染帧率 → ' + msg) : '设置失败，看模组面板里的日志。') + hz };
    },
  });

  // 诊断：滑动掉帧到底是「被限帧」还是「渲染跟不上」
  folium.registries.commands.register({
    id: 'diag-perf',
    label: { 'zh-CN': '诊断渲染性能（滑动卡顿）', en: 'Diagnose render performance' },
    description: {
      'zh-CN': '先报显示器刷新率和 GPU 加速状态，再实测 5 秒真实帧率。' +
        '执行后请立刻在书库界面拖动 / 滚动 —— 只有滑动时测到的帧率才有意义。',
      en: 'Report display Hz + GPU status, then measure real FPS for 5s while you scroll.',
    },
    keywords: ['汽水', '帧率', '卡顿', '掉帧', '性能', '诊断', '滑动', 'fps', 'gpu', 'soda'],
    run: async () => {
      await probeDisplay();
      let gpu = null;
      try { gpu = await folium.rpc.call('gpu'); } catch (e) { }

      // 先给 3 秒让用户关掉命令面板 / 浮层 —— 面板盖在主窗口上时 Chromium 会降频，
      // 那样测出来的不是真实帧率。
      try { folium.ui.toast('3 秒后开始测量 —— 请先关掉这个面板，回到书库准备拖动', { type: 'info', durationMs: 3000 }); } catch (e) { }
      await new Promise(r => setTimeout(r, 3000));
      try { folium.ui.toast('开始！请连续拖动 / 滚动 5 秒', { type: 'info', durationMs: 5000 }); } catch (e) { }

      const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const gaps = await new Promise((resolve) => {
        const out = []; let last = 0;
        const t0 = nowMs();
        const tick = (t) => {
          if (last) out.push(t - last);
          last = t;
          if (nowMs() - t0 < 5000) { try { requestAnimationFrame(tick); } catch (e) { resolve(out); } }
          else resolve(out);
        };
        try { requestAnimationFrame(tick); } catch (e) { resolve(out); }
      });

      const cfgNow = section.params.get() || {};
      const curSet = cfgNow.vsync !== false ? '垂直同步（跟随显示器）' : ((cfgNow.frameRate || 0) + ' fps');
      const lines = [];

      // 读 Folia **实际生效**的那个键 —— 模组设置项和它可能不一致
      // （比如用户在别处改过，或 applyFrameRateCap 没走到写 localStorage 那条路）。
      let realCap = '（没读到）';
      try {
        const v = localStorage.getItem('visualizer_frame_rate');
        realCap = (v === null || v === 'off' || v === 'auto') ? '不限帧（off = 原生 rAF）' : (v + ' fps');
      } catch (e) { }
      lines.push('Folia 实际帧率键：' + realCap + '　|　模组设置项：' + curSet);
      lines.push('主屏（主进程报的）：' + (displayHz ? displayHz + ' Hz' : '未探到'));

      // 窗口在哪块屏 / 是否可见 —— rAF 跟的是「窗口所在那块屏」，不一定是我报的主屏
      try {
        lines.push('窗口所在屏：' + screen.width + '×' + screen.height +
          ' · DPR ' + (window.devicePixelRatio || 1) + ' · 可见性 ' + document.visibilityState);
      } catch (e) { }

      if (gaps.length) {
        const sorted = gaps.slice().sort((a, b) => a - b);
        const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        const avgFps = Math.round(1000 / avg);
        const medMs = sorted[Math.floor(sorted.length / 2)];
        const minMs = sorted[0], maxMs = sorted[sorted.length - 1];
        const janky = gaps.filter(g => g > 33).length;
        const pct = Math.round(janky * 100 / gaps.length);
        lines.push('5 秒实测：平均 ' + avgFps + ' fps · 中位 ' + Math.round(1000 / medMs) + ' · 最低 ' + Math.round(1000 / maxMs));
        lines.push('帧间隔：最小 ' + minMs.toFixed(1) + 'ms · 中位 ' + medMs.toFixed(1) + 'ms · 最大 ' + maxMs.toFixed(1) + 'ms');
        lines.push('卡顿帧（>33ms）：' + janky + '/' + gaps.length + '（' + pct + '%）');

        // 判据：连「最小间隔」都超过 20ms，说明最快的帧也就这个速度 → rAF 被钉在低刷新率，不是渲染慢。
        if (minMs > 20) {
          lines.push('→ 连最快的一帧都要 ' + minMs.toFixed(0) + 'ms，帧间隔整齐贴在约 ' + Math.round(1000 / medMs) +
            'Hz 上：这是 **rAF 被钉在低刷新率**，不是渲染跑不动。多半是窗口落在了一块低刷新率的屏上' +
            '（虚拟屏 / 远程屏），或被远程控制软件限了帧。');
        } else if (minMs <= 12 && medMs > 25) {
          lines.push('→ 最快能到 ' + Math.round(1000 / minMs) + ' fps，但中位被拖到 ' + Math.round(1000 / medMs) +
            ' fps：这才是渲染负载问题（卡片太多 / 图太大）。');
        } else if (displayHz && avgFps >= displayHz - 3) {
          lines.push('→ 渲染跟得上，帧率已贴着显示器上限（' + displayHz + ' Hz）。');
        }
      } else {
        lines.push('没采到帧数据');
      }

      // —— 关键检测：rAF 是否被 Folia 的限帧器包装过；换成原生 rAF 后能不能跑满 ——
      // 这一段能一刀切开两种完全不同的病因：
      //   · 换回原生 rAF 立刻变快 → 是「限帧器还在生效」（哪怕设置里显示 off）
      //   · 换回原生 rAF 一样慢   → 不是限帧器，是 Chromium 层在节流或渲染真的慢
      try {
        const nativeRaf = window.__foliaNativeRequestAnimationFrame;
        const srcText = String(window.requestAnimationFrame || '').replace(/\s+/g, ' ').slice(0, 70);
        lines.push('限帧器痕迹：' + (nativeRaf ? '**存在**（Folia 装过，原生 rAF 被存了下来）' : '无（rAF 是原生的）'));
        lines.push('当前 rAF 函数：' + srcText);

        if (nativeRaf) {
          const saved = window.requestAnimationFrame;
          window.requestAnimationFrame = nativeRaf.bind(window);
          const nativeGaps = [];
          try {
            let l = 0;
            const t0 = nowMs();
            await new Promise((res) => {
              const tick = (t) => {
                if (l) nativeGaps.push(t - l);
                l = t;
                if (nowMs() - t0 < 3000) { try { window.requestAnimationFrame(tick); } catch (e) { res(); } }
                else res();
              };
              try { window.requestAnimationFrame(tick); } catch (e) { res(); }
            });
          } finally {
            window.requestAnimationFrame = saved;
          }
          if (nativeGaps.length) {
            const ns = nativeGaps.slice().sort((a, b) => a - b);
            const nmed = ns[Math.floor(ns.length / 2)];
            const nmin = ns[0];
            lines.push('切到原生 rAF 测 3 秒：最小 ' + nmin.toFixed(1) + 'ms · 中位 ' + nmed.toFixed(1) +
              'ms（约 ' + Math.round(1000 / nmed) + ' fps）');
            if (nmed < 10) {
              lines.push('→ ★★ 换回原生 rAF 就快了 ⇒ **限帧器还在生效**：设置显示 off，但 rAF 仍被包装。' +
                '修法：让宿主真正执行一次「帧率 = 不限」的还原（执行命令「锁定渲染帧率」并选第一项即可）。');
            } else {
              lines.push('→ 换回原生 rAF 也一样慢 ⇒ **不是限帧器**，是 Chromium 层在节流（或渲染确实慢）。');
            }
          }
        }
      } catch (e) {
        lines.push('rAF 检测失败：' + ((e && e.message) || e));
      }

      // 显示器 / 窗口落在哪块屏 —— Chromium 的 rAF 跟着「窗口所在屏的 vsync」走
      try {
        const dsp = await folium.rpc.call('display');
        if (dsp && Array.isArray(dsp.displays) && dsp.displays.length) {
          lines.push('所有显示器：' + dsp.displays.map(d =>
            (d.hz + 'Hz ' + d.w + '×' + d.h + ' ×' + d.scale + (d.primary ? '[主]' : ''))).join('  |  '));
        }
        if (dsp && Array.isArray(dsp.windows) && dsp.windows.length) {
          lines.push('窗口→所在屏：' + dsp.windows.map(w =>
            String(w.title || '(无标题)').slice(0, 14) + ' @ ' + w.hz + 'Hz').join('  |  '));
          const low = dsp.windows.filter(w => w.hz > 0 && w.hz < 60);
          if (low.length) {
            lines.push('→ ★★ 有窗口落在 **' + low[0].hz + 'Hz** 的屏上（' + String(low[0].title || '').slice(0, 16) +
              '）：Chromium 的 rAF 会跟着那块屏跑 → 这就解释了 30fps');
          }
        }
      } catch (e) { }

      // 窗口状态：测量时主窗口若没焦点、或上面盖着别的窗口，Chromium 会降频，结果不可信
      try {
        const wins = await folium.rpc.call('windows');
        if (Array.isArray(wins) && wins.length) {
          const desc = wins.map(w => (w.focused ? '★' : '') + String(w.title || '(无标题)').slice(0, 18)
            + (w.minimized ? '[最小化]' : '') + ' ' + w.bounds.width + '×' + w.bounds.height).join(' | ');
          lines.push('窗口（★ = 有焦点）：' + desc);
          if (wins.length > 1 && !wins.some(w => w.focused && /Folia/i.test(w.title || ''))) {
            lines.push('→ ⚠️ 测量时主窗口没焦点 / 上面还盖着别的窗口：Chromium 会主动降频，这个数字不能当真');
          }
        } else if (wins && wins.error) {
          lines.push('窗口状态：取不到（' + wins.error + '）');
        }
      } catch (e) { }

      if (gpu && !gpu.error) {
        lines.push('GPU：合成 ' + (gpu.gpu_compositing || '?') + ' · 光栅 ' + (gpu.rasterization || '?'));
        const devs = Array.isArray(gpu.devices) ? gpu.devices : [];
        const act = devs.filter(d => d.active).map(d => d.name || d.renderer || (d.vendorId + '/' + d.deviceId));
        const all = devs.map(d => (d.active ? '● ' : '○ ') + (d.name || d.renderer || (d.vendorId + '/' + d.deviceId)));
        if (all.length) lines.push('GPU 设备：' + all.join(' | '));
        if (act.length === 0 && devs.length) lines.push('→ ⚠️ 没有任何 GPU 被标为 active');
        // 渲染分辨率：DPR 会把实际像素翻倍，混合显卡笔记本上很容易拖死
        try {
          const dpr = window.devicePixelRatio || 1;
          const rw = Math.round(window.innerWidth * dpr), rh = Math.round(window.innerHeight * dpr);
          lines.push('渲染分辨率：' + rw + '×' + rh + '（DPR ' + dpr + '）');
          const lit = (window.innerWidth < 400 || window.innerHeight < 300);
          if (lit) lines.push('→ ⚠️ 窗口很小，不像是你在正常使用时的状态');
        } catch (e) { }
        if (gpu.gpu_compositing !== 'enabled') {
          lines.push('→ ⚠️ GPU 加速没开（' + (gpu.gpu_compositing || 'unknown') + '），这是滑动卡顿的常见根因');
        }
      } else {
        lines.push('GPU 状态没取到（' + ((gpu && gpu.error) || '未知') + '）');
      }

      const msg = lines.join('\n');
      say('性能诊断 → ' + lines.join(' | '));
      return { message: msg };
    },
  });

  // 救援入口：把「当前音源」交还给内置音源。
  // 为什么必须有：切到「汽水音乐」后，书库的「歌单」页签会被禁用（模组音源的 userLibrary/playlists 是 false），
  // 而宿主的音源切换器恰好只挂在那个页签里 —— 于是就没有任何 UI 能切回别的音源了。
  // 命令面板不依赖那个页签，所以从这里能自救。
  folium.registries.commands.register({
    id: 'release-provider',
    label: { 'zh-CN': '交还在线音源（切回网易云）', en: 'Release active online source' },
    description: {
      'zh-CN': '把「当前音源」从汽水音乐交还给网易云。用于这种情形：切到汽水之后，书库的「歌单」页签变成不可用，' +
        '而音源切换器就挂在那页签里，导致切不回来。执行后需要重启一次 Folia 生效。',
      en: 'Give the active online source back to Netease (restart Folia to apply).',
    },
    keywords: ['汽水', '音源', '切换', '交还', '恢复', '卡住', 'soda', 'provider', 'release'],
    run: async () => {
      let cur = null;
      try { cur = localStorage.getItem('active_online_provider_id'); } catch (e) { }
      if (cur !== PROVIDER_ID) {
        return { message: '当前音源是「' + (cur || '未知') + '」，不是汽水音乐，不需要交还。' };
      }
      try {
        localStorage.setItem('active_online_provider_id', 'netease');
        say('已把激活音源交还网易云');
        return { message: '已交还给网易云。**重启一次 Folia**，音源切换器就会回来了。' };
      } catch (e) {
        return { message: '交还失败：' + e.message };
      }
    },
  });

  const c0 = cfg();
  if (!c0.server || /^https?:\/\/(127\.0\.0\.1|localhost)/.test(c0.server) === false) {
    say('服务器地址不是本机（' + c0.server + '）');
  }

  /**
   * 把书库的 Navidrome 页签指到本机音源，省得手填。
   *
   * ⚠️ 这是**唯一**会写宿主配置的地方（`navidrome_config` / `navidrome_enabled`），
   *    而且只在：① 设置里「自动配置 Navidrome 页签」开着；② 用户还没配过、
   *    或者已经指向本机 —— 三个条件同时满足时才动手。用户自己配的别的 Navidrome 一律不碰。
   *    可以在设置里关掉它，关掉后请手动按提示填地址与密码。
   *    写进去的密码是**本机随机密钥**（不是用户任何账号的密码）。
   */
  function ensureNavidromePreset() {
    if (cfg().autoNavidrome === false) return false;
    try {
      const cur = localStorage.getItem('navidrome_config');
      if (cur) {
        let o = null;
        try { o = JSON.parse(cur); } catch (e) { return false; }
        if (o && o.serverUrl && !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(o.serverUrl)) return false;
        // 已经指向本机、且密码就是当前密钥 → 不用重复写
        if (o && o.serverUrl === base() && o.passwordHash === creds().pass) return false;
      }
      const c = creds();
      // 拿不到密钥（旧宿主没有 status rpc）时宁可不写：写个空密码进去只会把 Navidrome 配坏
      if (!c.pass) {
        if (!saidNoPass) { saidNoPass = true; say('拿不到本机服务密钥，先不自动配置 Navidrome —— 请按日志里的地址与密码手动填'); }
        return false;
      }
      localStorage.setItem('navidrome_config', JSON.stringify({
        serverUrl: base(), username: c.user, passwordHash: c.pass,
      }));
      localStorage.setItem('navidrome_enabled', 'true');
      localStorage.setItem('navidrome_config_origin', 'manual');
      say('已把书库的 Navidrome 指向本机音源服务');
      return true;
    } catch (e) { return false; }
  }

  // 先探显示器刷新率（后续提示/命令都会用到），再开始等服务就绪
  probeDisplay().catch(() => { });

  // 服务跑在模组 main 里，激活后要一两秒才监听端口 —— 所以带重试
  let tries = 0;
  const probe = () => {
    tries += 1;
    // /api/status 要令牌（默认的 /health 现在只回「活着」，不泄露账号/曲库信息）
    apiFetch('/api/status', { timeoutMs: 6000 })
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const h = r.json();
        const c = (h && h.catalog) || {};
        say('音源服务在线 ' + base() + ' · ' + (c.tracks || 0) + ' 曲 / ' +
          (c.playlists || 0) + ' 歌单 · 登录态 ' + (h.loggedIn ? '已就绪' : '未获取'));
        if (ensureNavidromePreset()) {
          try { folium.ui.toast('汽水音乐：已把书库的 Navidrome 指到本机音源。若 NAVI 页签还没出现，重启一次 Folia。', { type: 'info', durationMs: 9000 }); } catch (e) { }
        }
        if (h && h.loggedIn === false) {
          try { folium.ui.toast('汽水音乐：还没拿到登录态。执行「同步汽水客户端登录态」，再「刷新汽水曲库目录」。', { type: 'warn', durationMs: 9000 }); } catch (e) { }
        }

        // 自己预先说清楚这个坑：切到汽水后书库的「歌单」页签会被禁用，而切换器就挂在那个页签里。
        // 只提醒一次，免得每次启动都弹。
        try {
          const HINT_KEY = 'soda_music_release_hint_v1';
          if (localStorage.getItem('active_online_provider_id') === PROVIDER_ID
            && !localStorage.getItem(HINT_KEY)) {
            localStorage.setItem(HINT_KEY, String(Date.now()));
            folium.ui.toast('汽水音乐：当前音源是汽水。注意书库的「歌单」页签会变成不可用，' +
              '音源切换器就挂在那儿 —— 要换回别的音源，打开命令面板搜「交还」执行即可。',
              { type: 'info', durationMs: 15000 });
          }
        } catch (e) { }
      })
      .catch((e) => {
        // /api/status 不等后台初始化，所以这里失败基本就是「端口还没 listen」
        // 或「令牌还没拿到」。40 × 2 秒 = 80 秒余量（旧版 12 × 1.5 秒 ≈ 18 秒就放弃，
        // 曲库都还没拉完）。
        if (tries < 40) { setTimeout(probe, 2000); return; }
        say('音源服务没起来（' + e.message + '）—— 看模组面板里「汽水音乐」的日志');
        try { folium.ui.toast('汽水音乐：音源服务没起来，看模组面板的日志', { type: 'error', durationMs: 9000 }); } catch (e2) { }
      });
  };
  // 先等 main 把端口 / 密钥 / 令牌报上来再探活 —— 否则只能拿空令牌打一轮没意义的 401。
  // 万一 rpc 一直不回（旧宿主 / 卡住），20 秒后照样开探，别把启动流程堵死。
  let probeStarted = false;
  const startProbe = () => { if (probeStarted) return; probeStarted = true; probe(); };
  Promise.race([connReady, new Promise((r) => setTimeout(r, 20000))]).then(startProbe, startProbe);

  // 激活时如果正在放我们的歌，先备一份逐字歌词
  try {
    const cid = ourSongId(folium.playback.getState().song);
    if (cid) prefetchLines(cid);
  } catch (e) { }

  // 模组被停用 / 重载 / 卸载时，还原我们对宿主做的两处改动
  return () => {
    disableEndless();

    // 把「当前音源」交还给内置音源。
    // 为什么必须做：宿主的 OnlineProviderSwitcher 是 `if (!activeProvider) return null` ——
    // 禁用模组后我们这个 provider 就不存在了，如果 activeProviderId 还指向我们，
    // 宿主会连**整个切换器都不渲染**，用户再也没法切回网易云之类的音源。
    // （activeProviderId 是内存状态，所以这里只保证 localStorage 是对的，重启 Folia 后生效。）
    try {
      if (typeof localStorage !== 'undefined'
        && localStorage.getItem('active_online_provider_id') === PROVIDER_ID) {
        localStorage.setItem('active_online_provider_id', 'netease');
        say('已把激活音源交还给网易云（重启 Folia 后生效）');
      }
    } catch (e) { }
  };
}
