// ==UserScript==
// @name         淘宝商品主图/详情一键导出
// @namespace    https://aisoft.local/tb-export
// @version      1.0.1
// @description  导出淘宝/天猫商品主图、详情图与商品描述到自选本地目录
// @author       Kou
// @match        https://item.taobao.com/*
// @match        https://detail.tmall.com/*
// @match        https://detail.tmall.hk/*
// @match        https://chaoshi.detail.tmall.com/*
// @match        https://world.tmall.com/*
// @match        https://world.taobao.com/*
// @match        https://item.taobao.hk/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        unsafeWindow
// @connect      alicdn.com
// @connect      taobao.com
// @connect      tmall.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

/**
 * 淘宝/天猫商品导出脚本（单文件，无外部依赖）
 *
 * 功能：抓取当前商品页的主图、详情图、商品描述文字，
 * 通过 File System Access API 保存到用户自选的本地目录。
 *
 * 目录结构：
 *   <用户选择的目录>/
 *     秋季爆款女装.txt            （商品信息 + 描述 + 图片地址清单）
 *     秋季爆款女装主图/主图_01.jpg ...
 *     秋季爆款女装详情/详情_01.jpg ...
 */
(function () {
  'use strict';

  // ==================== 全局配置 ====================

  /** 集中配置：超时 / 并发 / 重试 / 滚动等参数 */
  const CONFIG = {
    TIMEOUT: 30000,            // 单次网络请求超时（毫秒）
    CONCURRENCY: 3,            // 图片下载并发数
    RETRY: 2,                  // 单张图片失败重试次数
    RETRY_BASE_DELAY: 800,     // 重试基础间隔（毫秒），逐次递增
    SCROLL_TIMES: 3,           // 自动滚动次数（触发懒加载）
    SCROLL_INTERVAL: 800,      // 每次滚动间隔（毫秒）
    TAB_WAIT: 1500,            // 点击详情 tab 后的等待时间（毫秒）
    MAX_LOG_LINES: 200,        // 面板日志最多保留行数
    MAX_NAME_LEN: 80,          // 文件/目录名最大长度
    MIN_IMG_SIZE: 1024,        // 小于该字节数的图片仅警告不重试（小图≠下载失败）
    FALLBACK_MAIN_SCAN_LIMIT: 10 // 主图全页扫描兜底上限
  };

  /** 运行时状态 */
  const state = {
    busy: false,        // 是否有任务进行中（防重复点击）
    dirHandle: null     // 已保存的根目录句柄
  };

  // ==================== 通用工具 ====================

  /**
   * 睡眠指定毫秒
   * @param {number} ms 毫秒数
   * @returns {Promise<void>}
   */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 提取错误对象的可读信息
   * @param {*} e 错误对象
   * @returns {string}
   */
  function errMsg(e) {
    if (!e) return '未知错误';
    if (e.message) return e.message;
    return String(e);
  }

  /**
   * 数字补零到两位
   * @param {number} n
   * @returns {string}
   */
  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  /**
   * 字节数格式化为 KB/MB
   * @param {number} bytes
   * @returns {string}
   */
  function fmtSize(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + 'MB';
    return Math.round(bytes / 1024) + 'KB';
  }

  /**
   * HTML 实体解码（借助 textarea，安全且简单）
   * @param {string} s
   * @returns {string}
   */
  function decodeEntities(s) {
    try {
      const ta = document.createElement('textarea');
      ta.innerHTML = String(s || '');
      return ta.value;
    } catch (e) {
      return String(s || '');
    }
  }

  /**
   * 数组去重（保持原顺序）
   * @param {string[]} list
   * @returns {string[]}
   */
  function dedupe(list) {
    const seen = new Set();
    const out = [];
    for (const u of list) {
      if (u && !seen.has(u)) {
        seen.add(u);
        out.push(u);
      }
    }
    return out;
  }

  /**
   * 阿里 CDN 图片 URL 还原为原图地址
   * 处理：补全协议、去掉缩放后缀（_60x60q90.jpg / _.webp / _sum.jpg）、去掉查询参数
   * @param {string} u 原始 URL
   * @returns {string} 还原后的 URL；非法输入返回空串
   */
  function toOriginalUrl(u) {
    if (!u) return '';
    let s = String(u).trim();
    if (!s) return '';
    // 过滤 data:/blob:/base64 等非远程地址
    if (/^(data:|blob:|base64,)/i.test(s)) return '';
    // 补全协议
    if (s.startsWith('//')) s = 'https:' + s;
    if (!/^https?:\/\//i.test(s)) return '';
    // 去掉 # 与 ? 之后的内容（alicdn 图片不需要查询参数）
    s = s.split('#')[0].split('?')[0];
    // 去掉 _.webp 尾巴（先处理，保证复合后缀 q90.jpg_.webp 也能逐步还原）：
    // abc.jpg_.webp -> abc.jpg
    s = s.replace(/_\.(webp)$/i, '');
    // 去掉"锚定在主扩展名之后"的缩放/标记后缀（单条正则统一覆盖）：
    // abc.jpg_60x60q90.jpg / abc.jpg_430x430q90.jpg / abc.jpg_b.jpg / abc.jpg_q90.jpg
    // / abc.jpg_sum.jpg / abc.jpg_s120.jpg -> abc.jpg；
    // 而 O1CN01_300x300.jpg、O1CN01_b.jpg（标记前没有主扩展名，属文件名一部分）保持原样
    s = s.replace(/(\.(?:jpe?g|png|webp|gif))_[a-z0-9]*(?:\.(?:jpe?g|png|webp|gif))$/i, '$1');
    return s;
  }

  // ==================== 日志 ====================

  const logBuffer = [];

  /**
   * 写日志：同时输出到控制台与悬浮面板
   * @param {string} msg 日志内容
   * @param {boolean} [isErr] 是否为错误（面板红色显示）
   */
  function log(msg, isErr) {
    const now = new Date();
    const ts = pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds());
    const line = { msg: String(msg), err: !!isErr, ts: ts };
    logBuffer.push(line);
    if (logBuffer.length > CONFIG.MAX_LOG_LINES) logBuffer.shift();
    try { console.log('[淘宝导出] ' + msg); } catch (e) { /* 忽略控制台异常 */ }
    ui.appendLog(line);
  }

  // ==================== 信息提取：标题 ====================

  /**
   * 深度搜索对象中的 title 字段（用于 __INITIAL_STATE__）
   * @param {*} node 当前节点
   * @param {string[]} out 结果收集数组
   * @param {number} depth 当前深度
   * @param {WeakSet} visited 已访问对象集合（防循环引用）
   */
  function deepFindTitle(node, out, depth, visited) {
    if (out.length || !node || depth > 8) return;
    if (typeof node !== 'object') return;
    try {
      if (visited.has(node)) return;
      visited.add(node);
    } catch (e) { return; }
    if (Array.isArray(node)) {
      for (const n of node) {
        deepFindTitle(n, out, depth + 1, visited);
        if (out.length) return;
      }
      return;
    }
    try {
      for (const k of Object.keys(node)) {
        const v = node[k];
        if ((k === 'title' || k === 'itemTitle') && typeof v === 'string' && v.trim()) {
          out.push(v);
          return;
        }
      }
      for (const k of Object.keys(node)) {
        deepFindTitle(node[k], out, depth + 1, visited);
        if (out.length) return;
      }
    } catch (e) { /* 遍历失败则跳过该节点 */ }
  }

  /**
   * 清洗标题：去掉站点后缀、多余空白，解码 HTML 实体（保留【】）
   * @param {string} t 原始标题
   * @returns {string}
   */
  function cleanTitle(t) {
    let s = decodeEntities(String(t || '')).trim();
    // 分隔符集：连字符 - – —、下划线 _、竖线 |、空白、间隔号 ·
    // （注意：用 + 而非 *——* 会把"正品淘宝网"这种无分隔符结尾的合法词也当后缀吃掉）
    const suffixes = [
      /[-–—_|\s·]+淘宝网\s*$/i,
      /[-–—_|\s·]+淘宝\s*$/i,
      /[-–—_|\s·]+天猫Tmall\.com\s*$/i,
      /[-–—_|\s·]+tmall\.com天猫\s*$/i,
      /[-–—_|\s·]+天猫\s*$/i,
      /[-–—_|\s·]+tmall\.com\s*$/i
    ];
    // 后缀可能叠加，循环去除直到没有变化
    let changed = true;
    while (changed) {
      changed = false;
      for (const re of suffixes) {
        const ns = s.replace(re, '');
        if (ns !== s) { s = ns; changed = true; }
      }
    }
    s = s.replace(/\s+/g, ' ').trim();
    // 兜底：去掉残留的尾随分隔符（如 "秋季爆款女装_" / "秋季爆款女装-" / "秋季爆款女装·"）
    s = s.replace(/[\s\-–—_|·]+$/, '').trim();
    return s;
  }

  /**
   * 提取商品标题（多级降级链，逐个尝试，取到非空即用）
   * @returns {string}
   */
  function extractTitle() {
    const chain = [
      () => document.querySelector('#J_Title .tb-main-title')?.textContent,
      () => document.querySelector('h1.tb-main-title')?.getAttribute('data-title'),
      () => document.querySelector('.tb-detail-hd h1')?.textContent,
      () => document.querySelector('#J_DetailMeta h1')?.textContent,
      () => document.querySelector('meta[property="og:title"]')?.getAttribute('content'),
      () => {
        // __INITIAL_STATE__ 深搜 title
        let st = null;
        try { st = unsafeWindow.__INITIAL_STATE__; } catch (e) { /* 跨沙箱访问失败 */ }
        if (!st) { try { st = window.__INITIAL_STATE__; } catch (e) { /* 忽略 */ } }
        const out = [];
        if (st) deepFindTitle(st, out, 0, new WeakSet());
        return out[0];
      },
      () => document.title
    ];
    for (const fn of chain) {
      try {
        const v = fn();
        if (v && String(v).trim()) return cleanTitle(v);
      } catch (e) { /* 单个来源失败继续下一个 */ }
    }
    return '未命名宝贝';
  }

  // ==================== 信息提取：主图 ====================

  /**
   * 深度搜索对象中名为 images/auctionImages/mainPic/pics 的字符串数组字段
   * @param {*} node 当前节点
   * @param {string[]} out 结果收集数组
   * @param {number} depth 当前深度
   * @param {WeakSet} visited 已访问对象集合
   */
  function deepCollectImageArrays(node, out, depth, visited) {
    if (!node || depth > 8 || typeof node !== 'object') return;
    try {
      if (visited.has(node)) return;
      visited.add(node);
    } catch (e) { return; }
    if (Array.isArray(node)) {
      for (const n of node) deepCollectImageArrays(n, out, depth + 1, visited);
      return;
    }
    try {
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (/^(images|auctionImages|mainPic|pics)$/.test(k) &&
            Array.isArray(v) && v.length > 0 &&
            v.every((x) => typeof x === 'string' && x.length > 0)) {
          for (const x of v) out.push(x);
        } else {
          deepCollectImageArrays(v, out, depth + 1, visited);
        }
      }
    } catch (e) { /* 遍历失败则跳过该节点 */ }
  }

  /**
   * 全页 img 扫描兜底提取主图候选
   * @returns {string[]}
   */
  function scanMainImagesFromPage() {
    const urls = [];
    try {
      const imgs = document.querySelectorAll('img');
      for (const img of imgs) {
        if (urls.length >= CONFIG.FALLBACK_MAIN_SCAN_LIMIT) break;
        const u = img.getAttribute('data-src') || img.getAttribute('src') || '';
        if (!u) continue;
        // 仅认阿里 CDN 图片
        if (!/(^|\.)alicdn\.com/i.test(u.replace(/^https?:/i, '').replace(/^\/\//, ''))) continue;
        if (!/(imgextra|bao\/uploaded)/.test(u)) continue;
        const w = img.naturalWidth || img.width || 0;
        if (w < 300) continue;
        urls.push(u);
      }
    } catch (e) { /* 忽略 */ }
    return urls;
  }

  /**
   * 提取主图 URL（多源合并去重，保持顺序，并还原为原图地址）
   * 来源：缩略图列表 / 主图 img / og:image / TShop.Setup / __INITIAL_STATE__ / 全页扫描兜底
   * @returns {string[]}
   */
  function extractMainImages() {
    const raw = [];
    // 1) 缩略图列表
    try {
      document.querySelectorAll('#J_UlThumb li img').forEach((img) => {
        const u = img.getAttribute('data-src') || img.getAttribute('src') || '';
        if (u) raw.push(u);
      });
    } catch (e) { /* 忽略 */ }
    // 2) 主图
    try {
      const booth = document.querySelector('#J_ImgBooth');
      if (booth) {
        const u = booth.getAttribute('src') || booth.getAttribute('data-src') || '';
        if (u) raw.push(u);
      }
    } catch (e) { /* 忽略 */ }
    // 3) og:image
    try {
      const meta = document.querySelector('meta[property="og:image"]');
      if (meta) {
        const u = meta.getAttribute('content') || '';
        if (u) raw.push(u);
      }
    } catch (e) { /* 忽略 */ }
    // 4) TShop.Setup 返回对象
    try {
      const setup = unsafeWindow.TShop?.Setup?.();
      if (setup) {
        const collectKeys = (obj, keys) => {
          if (!obj) return;
          for (const k of keys) {
            const v = obj[k];
            if (Array.isArray(v)) {
              for (const x of v) { if (typeof x === 'string' && x) raw.push(x); }
            }
          }
        };
        collectKeys(setup, ['auctionImages']);
        collectKeys(setup.itemDO, ['images']);
        collectKeys(setup.item, ['images']);
      }
    } catch (e) { /* TShop 结构变化则跳过 */ }
    // 5) __INITIAL_STATE__ 深搜
    try {
      let st = null;
      try { st = unsafeWindow.__INITIAL_STATE__; } catch (e1) { /* 沙箱访问失败 */ }
      if (!st) { try { st = window.__INITIAL_STATE__; } catch (e2) { /* 忽略 */ } }
      if (st) deepCollectImageArrays(st, raw, 0, new WeakSet());
    } catch (e) { /* 忽略 */ }
    // 6) 兜底：全页扫描
    if (raw.length === 0) {
      const scanned = scanMainImagesFromPage();
      for (const u of scanned) raw.push(u);
      if (scanned.length) log('主图来自全页扫描兜底（' + scanned.length + ' 张）');
    }
    // 还原原图 + 去重
    return dedupe(raw.map(toOriginalUrl).filter(Boolean));
  }

  // ==================== 信息提取：详情图 ====================

  /** 详情容器选择器列表 */
  const DESC_SELECTORS = ['#J_DivItemDesc img', '#description img', '.descV8-container img', '.desc-root img', '#J_DescContent img'];
  /** 详情容器（整块）选择器列表 */
  const DESC_BLOCK_SELECTORS = ['#J_DivItemDesc', '#description', '.descV8-container', '.desc-root', '#J_DescContent'];

  /**
   * 在指定 document 中收集详情图 URL
   * @param {Document} rootDoc 页面或 iframe 的 document
   * @returns {string[]}
   */
  function collectDescImgsInDoc(rootDoc) {
    const urls = [];
    for (const sel of DESC_SELECTORS) {
      try {
        rootDoc.querySelectorAll(sel).forEach((img) => {
          const u = img.getAttribute('data-src') || img.getAttribute('src') ||
                    img.getAttribute('data-ks-lazyload') || '';
          if (u) urls.push(u);
        });
      } catch (e) { /* 选择器失效则跳过 */ }
    }
    return urls;
  }

  /**
   * 取详情区域的 HTML（用于提取文字描述）
   * @returns {string}
   */
  function getDescDomHtml() {
    for (const sel of DESC_BLOCK_SELECTORS) {
      try {
        const el = document.querySelector(sel);
        if (el && el.innerHTML && el.innerHTML.trim().length > 20) return el.innerHTML;
      } catch (e) { /* 忽略 */ }
    }
    // 尝试同源 iframe 内的详情
    try {
      const ifr = document.querySelector('#J_DescIfr');
      if (ifr && ifr.contentDocument) {
        const el = ifr.contentDocument.querySelector('#J_DivItemDesc, #description, .descV8-container, .desc-root, #J_DescContent, body');
        if (el && el.innerHTML && el.innerHTML.trim().length > 20) return el.innerHTML;
      }
    } catch (e) { /* 跨域 iframe 不可读，跳过 */ }
    return '';
  }

  /**
   * DOM 直读详情图（含同源 #J_DescIfr iframe 递归）
   * @returns {string[]}
   */
  function collectDescFromDom() {
    const urls = collectDescImgsInDoc(document);
    try {
      const ifr = document.querySelector('#J_DescIfr');
      if (ifr && ifr.contentDocument) {
        const inner = collectDescImgsInDoc(ifr.contentDocument);
        for (const u of inner) urls.push(u);
      }
    } catch (e) { /* 跨域 iframe 不可读，跳过 */ }
    return urls;
  }

  /**
   * 获取详情数据接口地址 descUrl（多来源尝试）
   * @returns {string} 找不到返回空串
   */
  function getDescUrl() {
    const cands = [];
    // 1) TShop.Setup 的 apiDescUrl / descUrl
    try {
      const setup = unsafeWindow.TShop?.Setup?.();
      if (setup) {
        if (typeof setup.apiDescUrl === 'string') cands.push(setup.apiDescUrl);
        if (typeof setup.descUrl === 'string') cands.push(setup.descUrl);
      }
    } catch (e) { /* 忽略 */ }
    // 2) g_config.descUrl
    try {
      const g = unsafeWindow.g_config;
      if (g && typeof g.descUrl === 'string') cands.push(g.descUrl);
    } catch (e) { /* 忽略 */ }
    // 3) 页面源码正则
    try {
      const html = document.documentElement.outerHTML;
      const m = html.match(/(\/\/dsc\.alicdn\.com\/desc\/[^"'\s]+)/);
      if (m) cands.push(m[1]);
    } catch (e) { /* 忽略 */ }
    // 4) 详情 iframe 的 src
    try {
      const ifr = document.querySelector('#J_DescIfr');
      if (ifr && typeof ifr.src === 'string' && ifr.src.length > 10) cands.push(ifr.src);
    } catch (e) { /* 忽略 */ }
    for (const c of cands) {
      if (typeof c === 'string' && c.length > 10) {
        return c.startsWith('//') ? 'https:' + c : c;
      }
    }
    return '';
  }

  /**
   * 从详情接口返回的文本中提取图片 URL 列表
   * 先整体反转义（\/、\u002F、%2F、%3A），再用两种正则提取
   * @param {string} txt 接口返回的原始文本
   * @returns {string[]}
   */
  function extractImageUrlsFromText(txt) {
    const out = [];
    try {
      let t = String(txt || '');
      t = t.replace(/\\\//g, '/')
           .replace(/\\u002[fF]/g, '/')
           .replace(/\\"/g, '"')
           .replace(/\\'/g, "'")
           .replace(/%2F/gi, '/')
           .replace(/%3A/gi, ':');
      // 1) 引号包裹的完整图片地址
      const re1 = /["']((?:https?:)?\/\/[^"'\s<>]+?\.(?:jpg|jpeg|png|webp|gif)(?:[^"'\s<>]*))["']/gi;
      let m;
      while ((m = re1.exec(t)) !== null) {
        // 清理捕获串末尾可能残留的转义反斜杠
        out.push(m[1].replace(/\\+$/, ''));
      }
      // 2) img 标签 src 属性
      const re2 = /<img[^>]+src=["']([^"']+)["']/gi;
      while ((m = re2.exec(t)) !== null) {
        out.push(m[1].replace(/\\+$/, ''));
      }
    } catch (e) { /* 忽略 */ }
    // 两轮正则会对同一个 img 标签的 src 各命中一次，这里先去重，
    // 保证调用方日志里的 N 与最终写入的文件数一致
    return dedupe(out);
  }

  /**
   * 从详情接口文本中提取 desc 变量内的 HTML 字符串（用于文字描述）
   * @param {string} txt 接口返回的原始文本
   * @returns {string}
   */
  function extractHtmlFromDescText(txt) {
    try {
      const t = String(txt || '');
      const m = t.match(/(?:var\s+desc|window\.desc)\s*=\s*["']([\s\S]+?)["']\s*[;\n]/);
      if (m && m[1]) {
        return m[1].replace(/\\\//g, '/')
                   .replace(/\\u002[fF]/g, '/')
                   .replace(/\\"/g, '"')
                   .replace(/%2F/gi, '/')
                   .replace(/%3A/gi, ':');
      }
    } catch (e) { /* 忽略 */ }
    return '';
  }

  /**
   * 全页扫描兜底提取详情图
   * 条件：URL 命中 alicdn/taobao/tmall；容器命中 desc/detail/content；或 naturalWidth>=480；
   * 排除已收集的主图、排除宽或高 < 200 的小图标
   * @param {Set<string>} excludeSet 已收集主图集合（原图地址）
   * @returns {string[]}
   */
  function scanDescFromAllImages(excludeSet) {
    const urls = [];
    try {
      document.querySelectorAll('img').forEach((img) => {
        const u = img.getAttribute('data-src') || img.getAttribute('src') || '';
        if (!u) return;
        if (!/alicdn\.com|taobao|tmall/i.test(u)) return;
        if (excludeSet.has(toOriginalUrl(u))) return;
        const w = img.naturalWidth || img.width || 0;
        const h = img.naturalHeight || img.height || 0;
        // 排除小图标（已加载且宽或高 < 200）
        if (w > 0 && h > 0 && (w < 200 || h < 200)) return;
        // 容器命中 desc/detail/content，或本身是大图（>=480）
        let container = null;
        try {
          container = img.closest('[id*="desc" i], [class*="desc" i], [id*="detail" i], [class*="detail" i], [id*="content" i], [class*="content" i]');
        } catch (e) { container = null; }
        if (!container && w < 480) return;
        urls.push(u);
      });
    } catch (e) { /* 忽略 */ }
    return urls;
  }

  /**
   * 提取详情图（三级降级链：DOM 直读 → descUrl 异步拉取 → 全页扫描兜底）
   * @param {Set<string>} mainImageSet 主图集合（用于兜底时排除）
   * @returns {Promise<{images: string[], html: string}>}
   */
  async function extractDescInfo(mainImageSet) {
    let images = [];
    let html = getDescDomHtml();

    // 第一级：DOM 直读
    const domUrls = collectDescFromDom();
    if (domUrls.length > 0) {
      for (const u of domUrls) images.push(u);
      log('详情图来自 DOM 直读（' + domUrls.length + ' 张）');
    }

    // 第二级：descUrl 异步拉取（淘宝详情图真正来源）
    if (images.length === 0) {
      const descUrl = getDescUrl();
      if (descUrl) {
        log('尝试从 descUrl 拉取详情: ' + descUrl);
        try {
          const txt = await gmGetText(descUrl);
          const urls = extractImageUrlsFromText(txt);
          if (urls.length > 0) {
            for (const u of urls) images.push(u);
            log('详情图来自 descUrl 接口（' + urls.length + ' 张）');
          }
          if (!html) html = extractHtmlFromDescText(txt) || txt;
        } catch (e) {
          log('descUrl 拉取失败: ' + errMsg(e), true);
        }
      } else {
        log('未找到 descUrl，尝试兜底扫描');
      }
    }

    // 第三级：全页扫描兜底
    if (images.length === 0) {
      const scanned = scanDescFromAllImages(mainImageSet);
      for (const u of scanned) images.push(u);
      if (scanned.length) log('详情图来自全页扫描兜底（' + scanned.length + ' 张）');
    }

    // 还原原图 + 去重
    images = dedupe(images.map(toOriginalUrl).filter(Boolean));
    return { images: images, html: html };
  }

  // ==================== 信息提取：其他字段 ====================

  /**
   * 从当前 URL 中提取商品 ID（id 参数）
   * @returns {string}
   */
  function getItemId() {
    try {
      const m = location.search.match(/[?&]id=(\d+)/);
      if (m) return m[1];
      const m2 = location.pathname.match(/(\d{6,})/);
      if (m2) return m2[1];
    } catch (e) { /* 忽略 */ }
    return '';
  }

  /**
   * 提取店铺名称
   * @returns {string}
   */
  function extractShopName() {
    const sels = ['.shop-name', '.tb-shop-name', '.slogo-shopname', '.shop-name a', '.tb-shop-slogan', 'meta[property="og:site_name"]'];
    for (const sel of sels) {
      try {
        const el = document.querySelector(sel);
        let t = '';
        if (el && el.tagName === 'META') t = el.getAttribute('content') || '';
        else t = el?.textContent || '';
        t = decodeEntities(t).replace(/\s+/g, ' ').trim();
        if (t) return t;
      } catch (e) { /* 忽略 */ }
    }
    return '';
  }

  /**
   * 提取当前价格
   * @returns {string}
   */
  function extractPrice() {
    const sels = ['.tb-rmb-num', '.tm-price', '.tm-price-span', '.tm-promo-price .tm-price', '.p-price .price', '.tb-detail-price .price', '.price'];
    for (const sel of sels) {
      try {
        const el = document.querySelector(sel);
        const t = el?.textContent?.replace(/\s+/g, ' ').trim();
        if (t) return t;
      } catch (e) { /* 忽略 */ }
    }
    return '';
  }

  /**
   * 提取商品参数列表（材质、颜色分类等）
   * @returns {string[]} 每行形如 "材质: 棉"
   */
  function extractAttributes() {
    const lines = [];
    const seen = new Set();
    const sel = '#J_AttrUL li, #attributes li, .attributes-list li, .tm-clear .tb-attributes li, .basic-info .attrs li';
    try {
      document.querySelectorAll(sel).forEach((li) => {
        const t = decodeEntities(li.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t) return;
        const m = t.match(/^([^:：]{1,30})\s*[:：]\s*(.+)$/);
        const line = m ? (m[1].trim() + ': ' + m[2].trim()) : t;
        if (!seen.has(line)) {
          seen.add(line);
          lines.push(line);
        }
      });
    } catch (e) { /* 忽略 */ }
    return lines;
  }

  /**
   * HTML 转纯文本：去掉 script/style，压缩空白与连续空行
   * @param {string} html
   * @returns {string}
   */
  function htmlToText(html) {
    try {
      const div = document.createElement('div');
      div.innerHTML = String(html || '');
      div.querySelectorAll('script, style').forEach((n) => n.remove());
      let t = div.textContent || '';
      t = t.replace(/[\t ]+/g, ' ').replace(/\n[ \t]*/g, '\n').replace(/\n{2,}/g, '\n').trim();
      return t;
    } catch (e) {
      return '';
    }
  }

  // ==================== 页面预热（懒加载触发） ====================

  /**
   * 预热页面：尝试点击详情 tab，自动滚动到底部数次触发懒加载
   */
  async function preparePage() {
    // 尝试点击详情 tab
    try {
      const nodes = document.querySelectorAll('a, li, span, div');
      for (const el of nodes) {
        const t = (el.textContent || '').trim();
        if ((t === '图文详情' || t === '宝贝详情' || t === '详情') && el.offsetParent !== null) {
          el.click();
          log('已尝试点击详情标签: ' + t);
          break;
        }
      }
    } catch (e) { /* 忽略 */ }
    await sleep(CONFIG.TAB_WAIT);
    // 自动滚动到底部数次
    for (let i = 0; i < CONFIG.SCROLL_TIMES; i++) {
      try {
        window.scrollTo(0, document.documentElement.scrollHeight);
      } catch (e) { /* 忽略 */ }
      await sleep(CONFIG.SCROLL_INTERVAL);
    }
    try { window.scrollTo(0, 0); } catch (e) { /* 忽略 */ }
  }

  // ==================== 网络请求 ====================

  /**
   * GM_xmlhttpRequest GET（纯文本）
   * @param {string} url
   * @returns {Promise<string>}
   */
  function gmGetText(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        timeout: CONFIG.TIMEOUT,
        // 注：不手动设置 Referer——它是浏览器禁止修改的头，TM 会静默丢弃并告警
        onload: (res) => {
          if (res.status >= 200 && res.status < 300 && res.responseText) resolve(res.responseText);
          else reject(new Error('HTTP ' + res.status));
        },
        onerror: () => reject(new Error('网络错误')),
        ontimeout: () => reject(new Error('请求超时'))
      });
    });
  }

  /**
   * GM_xmlhttpRequest GET 图片为 blob（绕过 CORS）
   * @param {string} url 图片地址
   * @returns {Promise<Blob>}
   */
  function gmFetchBlob(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        timeout: CONFIG.TIMEOUT,
        responseType: 'blob',
        // 注：不手动设置 Referer（禁止头会被丢弃）；Accept 非禁止头可保留
        headers: {
          'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8'
        },
        onload: (res) => {
          const blob = res.response;
          if (res.status < 200 || res.status >= 300) {
            reject(new Error('HTTP ' + res.status));
            return;
          }
          if (!blob || blob.size === 0) {
            reject(new Error('空响应体'));
            return;
          }
          // Content-Type：优先 blob.type，其次解析响应头
          let ct = blob.type || '';
          if (!ct) {
            const m = String(res.responseHeaders || '').match(/content-type:\s*([^\r\n;]+)/i);
            if (m) ct = m[1].trim();
          }
          // 仅在明确是文本型响应（反爬返回的 HTML/JSON 等）时才判失败触发重试；
          // application/octet-stream 与空 type 一样放行（部分 CDN 用它返图），交给 size 与 pickExt 判定
          if (/^text\/|\/json/i.test(ct)) {
            reject(new Error('非图片内容（Content-Type: ' + ct + '）'));
            return;
          }
          // 小图但确为图片：接受并警告，不做无谓重试
          if (blob.size < CONFIG.MIN_IMG_SIZE) {
            log('⚠ 图片较小（' + blob.size + 'B），可能是占位图，按原样保存');
          }
          resolve(blob);
        },
        onerror: () => reject(new Error('网络错误')),
        ontimeout: () => reject(new Error('请求超时'))
      });
    });
  }

  /**
   * 带 retries 的图片下载（失败重试，间隔递增）
   * @param {string} url
   * @returns {Promise<Blob>}
   */
  async function fetchBlobWithRetry(url) {
    let lastErr = null;
    for (let i = 0; i <= CONFIG.RETRY; i++) {
      if (i > 0) await sleep(CONFIG.RETRY_BASE_DELAY * i);
      try {
        return await gmFetchBlob(url);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('下载失败');
  }

  /**
   * 根据 blob 的 Content-Type 或 URL 后缀判定扩展名
   * @param {string} url
   * @param {Blob} blob
   * @returns {string} jpg/jpeg/png/webp/gif，默认 jpg
   */
  function pickExt(url, blob) {
    const ct = (blob && blob.type) || '';
    if (ct.indexOf('png') >= 0) return 'png';
    if (ct.indexOf('webp') >= 0) return 'webp';
    if (ct.indexOf('gif') >= 0) return 'gif';
    if (ct.indexOf('jpeg') >= 0) return 'jpg';
    const m = String(url || '').split('?')[0].match(/\.(jpe?g|png|webp|gif)$/i);
    if (m) {
      const ext = m[1].toLowerCase();
      return ext === 'jpeg' ? 'jpg' : ext;
    }
    return 'jpg';
  }

  /**
   * 仅从 URL 后缀判定扩展名（降级下载模式使用）
   * @param {string} url
   * @returns {string}
   */
  function urlExt(url) {
    const m = String(url || '').split('?')[0].match(/\.(jpe?g|png|webp|gif)$/i);
    if (m) {
      const ext = m[1].toLowerCase();
      return ext === 'jpeg' ? 'jpg' : ext;
    }
    return 'jpg';
  }

  /**
   * 简单并发池：以 workerCount 个并发依次执行任务数组
   * @param {Array<Function>} tasks 返回 Promise 的任务数组
   * @param {number} workerCount 并发数
   */
  async function runPool(tasks, workerCount) {
    let idx = 0;
    const workers = [];
    for (let w = 0; w < workerCount; w++) {
      workers.push((async () => {
        while (idx < tasks.length) {
          const my = idx;
          idx++;
          try {
            await tasks[my]();
          } catch (e) { /* 任务内部已记录日志，这里兜底防止中断 */ }
        }
      })());
    }
    await Promise.all(workers);
  }

  // ==================== IndexedDB（持久化目录句柄） ====================

  const IDB_NAME = 'tb-export';
  const IDB_STORE = 'handles';

  /**
   * 打开 IndexedDB（库名 tb-export，store handles）
   * @returns {Promise<IDBDatabase>}
   */
  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        try { req.result.createObjectStore(IDB_STORE); } catch (e) { /* 已存在 */ }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    });
  }

  /**
   * 写入键值
   * @param {string} key
   * @param {*} val
   * @returns {Promise<void>}
   */
  async function idbSet(key, val) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB 写入失败'));
    });
  }

  /**
   * 读取键值
   * @param {string} key
   * @returns {Promise<*>}
   */
  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const r = tx.objectStore(IDB_STORE).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error('IndexedDB 读取失败'));
    });
  }

  // ==================== 文件系统 ====================

  /**
   * 取 showDirectoryPicker 函数（优先页面真实 window，避免非法调用）
   * @returns {Function|null} 不支持时返回 null
   */
  function getShowDirectoryPicker() {
    try {
      if (typeof unsafeWindow !== 'undefined' && typeof unsafeWindow.showDirectoryPicker === 'function') {
        return unsafeWindow.showDirectoryPicker.bind(unsafeWindow);
      }
    } catch (e) { /* 沙箱限制 */ }
    try {
      if (typeof window.showDirectoryPicker === 'function') {
        return window.showDirectoryPicker.bind(window);
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }

  /**
   * Windows 文件名清洗：替换非法字符 \ / : * ? " < > | 与换行制表符，
   * 压缩空白、去首尾点与空格、截断到 80 字符
   * @param {string} s 原始名称
   * @returns {string} 合法名称，空则返回 "未命名宝贝"
   */
  function sanitizeName(s) {
    let t = String(s || '');
    // 替换 Windows 非法字符与全部控制字符（\u0000-\u001f 含换行制表符，另含 DEL \u007f）
    t = t.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_');
    t = t.replace(/\s+/g, ' ').trim();
    // 按码点截断（Array.from 按 Unicode 码点切分，避免截断 Emoji 代理对产生孤立代理项）
    t = Array.from(t).slice(0, CONFIG.MAX_NAME_LEN).join('');
    t = t.replace(/[.\s]+$/, '').trim();
    return t || '未命名宝贝';
  }

  /**
   * 解析/选择保存根目录：
   * 优先复用 IndexedDB 中的句柄（校验权限，必要时在用户手势内请求授权），
   * 否则弹出系统目录选择框，并把句柄存入 IndexedDB
   * @returns {Promise<FileSystemDirectoryHandle|null>} 失败/取消返回 null
   */
  async function resolveRootDir() {
    const picker = getShowDirectoryPicker();
    if (!picker) return null;
    // 已有句柄：校验权限
    if (state.dirHandle) {
      try {
        if ((await state.dirHandle.queryPermission({ mode: 'readwrite' })) === 'granted') {
          return state.dirHandle;
        }
      } catch (e) { /* 句柄失效则重新选择 */ }
      try {
        if ((await state.dirHandle.requestPermission({ mode: 'readwrite' })) === 'granted') {
          return state.dirHandle;
        }
      } catch (e) { /* 授权失败则重新选择 */ }
    }
    // 弹出目录选择框
    try {
      const handle = await picker({ mode: 'readwrite', id: 'tbItemExport' });
      // IndexedDB 只用于“记住目录”，写失败（隐私模式/禁站点数据）不应影响本次导出
      try {
        await idbSet('root', handle);
      } catch (e) {
        log('目录已选，但无法记住（下次需重新选择）: ' + errMsg(e), true);
      }
      state.dirHandle = handle;
      ui.setDirName(handle.name);
      log('已选择保存目录: ' + handle.name);
      return handle;
    } catch (e) {
      if (e && e.name === 'AbortError') {
        log('已取消选择目录');
      } else {
        log('❌ 选择目录失败: ' + errMsg(e), true);
      }
      return null;
    }
  }

  /**
   * 把一组图片下载并写入指定目录，按序号命名（前缀_01.ext）
   * @param {string[]} urls 图片地址列表
   * @param {FileSystemDirectoryHandle} dirHandle 目标目录句柄
   * @param {string} prefix 文件名前缀（主图 / 详情）
   * @param {Function} onOne 每完成一张的回调（用于进度条）
   * @returns {Promise<{ok: number, fail: number}>}
   */
  async function saveImagesToDir(urls, dirHandle, prefix, onOne) {
    let ok = 0;
    let fail = 0;
    const tasks = urls.map((u, i) => async () => {
      try {
        const blob = await fetchBlobWithRetry(u);
        const ext = pickExt(u, blob);
        const name = prefix + '_' + pad2(i + 1) + '.' + ext;
        const fh = await dirHandle.getFileHandle(name, { create: true });
        const ws = await fh.createWritable();
        try {
          await ws.write(blob);
        } finally {
          // write 抛错（磁盘满/配额超限）时也必须 close，避免残留 0 字节文件；
          // close 自身的失败吞掉，不掩盖 write 的原始异常
          try { await ws.close(); } catch (eClose) { /* 忽略 close 失败 */ }
        }
        ok++;
        log('✔ 已保存 ' + name + '（' + fmtSize(blob.size) + '）');
      } catch (e) {
        fail++;
        log('✘ 保存失败 ' + prefix + '_' + pad2(i + 1) + ': ' + errMsg(e), true);
      }
      if (onOne) onOne();
    });
    await runPool(tasks, CONFIG.CONCURRENCY);
    return { ok: ok, fail: fail };
  }

  // ==================== 降级下载（GM_download） ====================

  /**
   * 用 GM_download 下载单个文件到浏览器默认下载目录（可带子目录）
   * @param {string} url
   * @param {string} name 相对下载目录的文件名（可含子目录）
   * @returns {Promise<void>}
   */
  function gmDownload(url, name) {
    return new Promise((resolve) => {
      try {
        GM_download({
          url: url,
          name: name,
          onerror: (err) => {
            log('✘ 下载失败: ' + name + '（' + (err && err.error ? err.error : '未知') + '）', true);
            resolve();
          },
          ontimeout: () => {
            log('✘ 下载超时: ' + name, true);
            resolve();
          },
          onload: () => {
            log('✔ 已下载 ' + name);
            resolve();
          }
        });
      } catch (e) {
        log('✘ GM_download 异常: ' + errMsg(e), true);
        resolve();
      }
    });
  }

  /**
   * 用 <a download> + Blob URL 下载文本文件（降级模式的 txt）
   * @param {string} text 文本内容（UTF-8 + BOM）
   * @param {string} filename 文件名
   */
  function downloadTextViaAnchor(text, filename) {
    const blob = new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /**
   * 降级模式：全部通过浏览器下载完成导出
   * @param {{title:string, mainImages:string[], descImages:string[]}} info
   * @param {string} text txt 文本内容
   * @param {string} safe 清洗后的文件名（不含扩展名）
   */
  async function fallbackDownload(info, text, safe) {
    log('降级模式：文件将保存到浏览器默认下载目录');
    downloadTextViaAnchor(text, safe + '.txt');
    log('✔ 已触发下载 ' + safe + '.txt');
    const all = [];
    info.mainImages.forEach((u, i) => {
      all.push({ url: u, name: safe + '主图/主图_' + pad2(i + 1) + '.' + urlExt(u) });
    });
    info.descImages.forEach((u, i) => {
      all.push({ url: u, name: safe + '详情/详情_' + pad2(i + 1) + '.' + urlExt(u) });
    });
    let handled = 0;
    ui.progress(0, all.length);
    const tasks = all.map((item) => async () => {
      await gmDownload(item.url, item.name);
      handled++;
      ui.progress(handled, all.length);
    });
    await runPool(tasks, CONFIG.CONCURRENCY);
    log('===== 降级下载完成 =====');
    try {
      GM_notification({ title: '淘宝导出完成', text: '已下载到浏览器默认下载目录' });
    } catch (e) { /* 通知失败不影响主流程 */ }
  }

  // ==================== txt 内容拼装 ====================

  /**
   * 拼装 txt 文本内容
   * @param {{title:string, itemId:string, shopName:string, price:string,
   *          attrs:string[], mainImages:string[], descImages:string[]}} info 商品信息
   * @param {string} descHtml 详情 HTML（用于提取文字描述）
   * @returns {string}
   */
  function buildTxt(info, descHtml) {
    const now = new Date();
    const ts = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate()) +
               ' ' + pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds());
    const descText = htmlToText(descHtml) || '未获取到文字描述';
    const L = [];
    L.push('【宝贝名称】' + info.title);
    L.push('【商品链接】' + location.href.split('#')[0]);
    L.push('【商品ID】' + (info.itemId || '未获取'));
    L.push('【店铺名称】' + (info.shopName || '未获取'));
    L.push('【当前价格】' + (info.price || '未获取'));
    L.push('【抓取时间】' + ts);
    L.push('');
    L.push('===== 商品参数 =====');
    if (info.attrs.length > 0) {
      for (const a of info.attrs) L.push(a);
    } else {
      L.push('未获取');
    }
    L.push('');
    L.push('===== 宝贝描述 =====');
    L.push(descText);
    L.push('');
    L.push('===== 主图地址（共 ' + info.mainImages.length + ' 张）=====');
    info.mainImages.forEach((u, i) => L.push((i + 1) + '. ' + u));
    L.push('');
    L.push('===== 详情图地址（共 ' + info.descImages.length + ' 张）=====');
    info.descImages.forEach((u, i) => L.push((i + 1) + '. ' + u));
    return L.join('\r\n');
  }

  // ==================== 主流程 ====================

  /**
   * 主入口：抓取当前宝贝并保存
   */
  async function run() {
    if (state.busy) return;
    state.busy = true;
    ui.setBusy(true);
    try {
      log('===== 开始抓取 =====');
      const picker = getShowDirectoryPicker();

      // 1) 先在用户手势内解析保存目录（选择/授权弹窗需要用户激活）
      let root = null;
      if (picker) {
        root = await resolveRootDir();
        if (!root) {
          log('❌ 未获得保存目录，任务中止', true);
          return;
        }
      }

      // 2) 页面预热：点详情 tab + 滚动触发懒加载
      log('正在滚动页面触发懒加载…');
      await preparePage();

      // 3) 提取各字段
      const itemId = getItemId();
      const title = extractTitle();
      log('宝贝名称: ' + title);
      const mainImages = extractMainImages();
      log('主图候选 ' + mainImages.length + ' 张');
      const desc = await extractDescInfo(new Set(mainImages));
      log('详情图候选 ' + desc.images.length + ' 张');
      ui.setStats(mainImages.length, desc.images.length);

      if (mainImages.length === 0 && desc.images.length === 0) {
        log('❌ 未抓取到任何图片，页面结构可能已改版', true);
      }

      const info = {
        title: title,
        itemId: itemId,
        shopName: extractShopName(),
        price: extractPrice(),
        attrs: extractAttributes(),
        mainImages: mainImages,
        descImages: desc.images
      };
      const text = buildTxt(info, desc.html);
      const safe = sanitizeName(title);

      if (root) {
        // 4) File System Access API 写入
        const mainDir = await root.getDirectoryHandle(safe + '主图', { create: true });
        const descDir = await root.getDirectoryHandle(safe + '详情', { create: true });

        // txt（UTF-8 with BOM，Windows 记事本不乱码）
        const txtHandle = await root.getFileHandle(safe + '.txt', { create: true });
        const ws = await txtHandle.createWritable();
        try {
          await ws.write(new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' }));
        } finally {
          // 同图片写入：write 抛错也必须 close，避免残留 0 字节 txt
          try { await ws.close(); } catch (eClose) { /* 忽略 close 失败 */ }
        }
        log('✔ 已写入 ' + safe + '.txt');

        // 图片（并发 3，单张失败不中断）
        const total = mainImages.length + desc.images.length;
        let handled = 0;
        const onOne = () => {
          handled++;
          ui.progress(handled, total);
        };
        ui.progress(0, total);
        const r1 = await saveImagesToDir(mainImages, mainDir, '主图', onOne);
        const r2 = await saveImagesToDir(desc.images, descDir, '详情', onOne);
        log('===== 完成：主图 ' + r1.ok + '/' + mainImages.length +
            '，详情 ' + r2.ok + '/' + desc.images.length + ' =====');
        try {
          GM_notification({
            title: '淘宝导出完成',
            text: safe + '：主图 ' + r1.ok + ' 张，详情 ' + r2.ok + ' 张'
          });
        } catch (e) { /* 通知失败不影响主流程 */ }
      } else {
        // 5) 降级：GM_download 到默认下载目录
        await fallbackDownload(info, text, safe);
      }
    } catch (e) {
      log('❌ 发生异常: ' + errMsg(e) + (e && e.stack ? ' | ' + e.stack : ''), true);
    } finally {
      state.busy = false;
      ui.setBusy(false);
    }
  }

  // ==================== UI（Shadow DOM 悬浮面板） ====================

  const ui = (function () {
    let els = {};
    let ready = false;

    /**
     * 创建悬浮面板（Shadow DOM 隔离样式）
     */
    function init() {
      try {
        const host = document.createElement('div');
        host.id = 'tbExportRoot';
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = [
          '<style>',
          ':host { all: initial; }',
          '* { box-sizing: border-box; margin: 0; padding: 0; font-family: "Microsoft YaHei", "PingFang SC", Arial, sans-serif; }',
          '.panel { position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; width: 320px; background: #fff; border: 1px solid #e3e3e3; border-radius: 10px; box-shadow: 0 4px 18px rgba(0,0,0,.18); font-size: 13px; color: #333; overflow: hidden; }',
          '.head { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: linear-gradient(135deg,#ff5000,#ff7a00); color: #fff; font-weight: bold; }',
          '.head .min { background: rgba(255,255,255,.25); color: #fff; border: none; border-radius: 4px; width: 22px; height: 22px; cursor: pointer; font-size: 14px; line-height: 1; }',
          '.head .min:hover { background: rgba(255,255,255,.45); }',
          '.body { padding: 10px 12px 12px; }',
          '.warn { background: #fff3e0; border: 1px solid #ffb74d; color: #b26500; border-radius: 6px; padding: 6px 8px; margin-bottom: 8px; font-size: 12px; }',
          '.row { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }',
          '.dir { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #666; font-size: 12px; background: #f5f5f5; border-radius: 4px; padding: 5px 8px; }',
          '.btn { border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }',
          '.btn.small { padding: 5px 10px; background: #eee; color: #333; }',
          '.btn.small:hover { background: #ddd; }',
          '.btn.primary { display: block; width: 100%; padding: 9px 0; background: #ff5000; color: #fff; font-weight: bold; }',
          '.btn.primary:hover { background: #e64800; }',
          '.btn:disabled { opacity: .5; cursor: not-allowed; }',
          '.stats { margin-top: 8px; font-size: 12px; color: #888; }',
          '.bar { margin-top: 6px; height: 8px; background: #f0f0f0; border-radius: 4px; overflow: hidden; }',
          '.fill { height: 100%; width: 0%; background: #ff5000; transition: width .2s; }',
          '.barText { margin-top: 4px; font-size: 11px; color: #999; }',
          '.logs { margin-top: 8px; height: 110px; overflow-y: auto; background: #fafafa; border: 1px solid #eee; border-radius: 6px; padding: 6px 8px; font-size: 11px; line-height: 1.6; font-family: Consolas, monospace; word-break: break-all; }',
          '.logs .err { color: #d93026; }',
          '.logs .t { color: #bbb; margin-right: 4px; }',
          '</style>',
          '<div class="panel">',
          '  <div class="head"><span>淘宝导出</span><button class="min" id="btnCollapse" title="折叠/展开">—</button></div>',
          '  <div class="body" id="panelBody">',
          '    <div class="warn" id="warn" style="display:none"></div>',
          '    <div class="row"><span class="dir" id="dirName" title="当前保存目录">未选择</span><button class="btn small" id="btnPick">选择目录</button></div>',
          '    <button class="btn primary" id="btnRun">① 抓取并保存当前宝贝</button>',
          '    <div class="stats" id="stats">主图 0 张 / 详情 0 张</div>',
          '    <div class="bar"><div class="fill" id="barFill"></div></div>',
          '    <div class="barText" id="barText">就绪</div>',
          '    <div class="logs" id="logs"></div>',
          '  </div>',
          '</div>'
        ].join('');
        document.documentElement.appendChild(host);

        els = {
          body: shadow.getElementById('panelBody'),
          warn: shadow.getElementById('warn'),
          dirName: shadow.getElementById('dirName'),
          btnPick: shadow.getElementById('btnPick'),
          btnRun: shadow.getElementById('btnRun'),
          btnCollapse: shadow.getElementById('btnCollapse'),
          stats: shadow.getElementById('stats'),
          barFill: shadow.getElementById('barFill'),
          barText: shadow.getElementById('barText'),
          logs: shadow.getElementById('logs')
        };

        // 主按钮
        els.btnRun.addEventListener('click', () => run());
        // 选择目录按钮
        els.btnPick.addEventListener('click', async () => {
          if (state.busy) return;
          await resolveRootDir();
        });
        // 折叠按钮
        els.btnCollapse.addEventListener('click', () => {
          const hidden = els.body.style.display === 'none';
          els.body.style.display = hidden ? '' : 'none';
          els.btnCollapse.textContent = hidden ? '—' : '□';
        });

        ready = true;
      } catch (e) {
        try { console.error('[淘宝导出] 面板创建失败: ' + errMsg(e)); } catch (e2) { /* 忽略 */ }
      }
    }

    /**
     * 追加一条日志到面板（自动滚到底，最多保留 200 行）
     * @param {{msg:string, err:boolean, ts:string}} line
     */
    function appendLog(line) {
      if (!ready) return;
      try {
        const div = document.createElement('div');
        if (line.err) div.className = 'err';
        const t = document.createElement('span');
        t.className = 't';
        t.textContent = '[' + line.ts + '] ';
        div.appendChild(t);
        div.appendChild(document.createTextNode(line.msg));
        els.logs.appendChild(div);
        while (els.logs.childNodes.length > CONFIG.MAX_LOG_LINES) {
          els.logs.removeChild(els.logs.firstChild);
        }
        els.logs.scrollTop = els.logs.scrollHeight;
      } catch (e) { /* 忽略渲染异常 */ }
    }

    /**
     * 设置当前目录名显示
     * @param {string} name
     */
    function setDirName(name) {
      if (!ready) return;
      try {
        els.dirName.textContent = name || '未选择';
        els.dirName.title = name || '未选择';
      } catch (e) { /* 忽略 */ }
    }

    /**
     * 更新统计行
     * @param {number} n 主图数量
     * @param {number} m 详情图数量
     */
    function setStats(n, m) {
      if (!ready) return;
      try { els.stats.textContent = '主图 ' + n + ' 张 / 详情 ' + m + ' 张'; } catch (e) { /* 忽略 */ }
    }

    /**
     * 更新进度条
     * @param {number} done 已处理数
     * @param {number} total 总数
     */
    function progress(done, total) {
      if (!ready) return;
      try {
        const pct = total > 0 ? Math.round((done / total) * 100) : 100;
        els.barFill.style.width = pct + '%';
        els.barText.textContent = '进度 ' + done + '/' + total + '（' + pct + '%）';
      } catch (e) { /* 忽略 */ }
    }

    /**
     * 设置忙状态（禁用/启用按钮，防重复点击）
     * @param {boolean} b
     */
    function setBusy(b) {
      if (!ready) return;
      try {
        els.btnRun.disabled = b;
        els.btnPick.disabled = b;
        els.btnRun.textContent = b ? '正在处理，请稍候…' : '① 抓取并保存当前宝贝';
      } catch (e) { /* 忽略 */ }
    }

    /**
     * 显示黄色警告条
     * @param {string} text
     */
    function showWarn(text) {
      if (!ready) return;
      try {
        els.warn.textContent = text;
        els.warn.style.display = '';
      } catch (e) { /* 忽略 */ }
    }

    return {
      init: init,
      appendLog: appendLog,
      setDirName: setDirName,
      setStats: setStats,
      progress: progress,
      setBusy: setBusy,
      showWarn: showWarn
    };
  })();

  // ==================== 启动 ====================

  /**
   * 初始化：创建面板、恢复上次目录、注册菜单、检测降级
   */
  (async function bootstrap() {
    ui.init();

    // 恢复 IndexedDB 中的目录句柄
    try {
      const h = await idbGet('root');
      if (h) {
        state.dirHandle = h;
        let granted = false;
        try {
          granted = (await h.queryPermission({ mode: 'readwrite' })) === 'granted';
        } catch (e) { granted = false; }
        ui.setDirName(h.name + (granted ? '' : '（点击抓取时需重新授权）'));
        log('已恢复上次保存目录: ' + h.name);
      }
    } catch (e) { /* 无历史句柄或 IndexedDB 不可用 */ }

    // 检测 File System Access API 支持
    if (!getShowDirectoryPicker()) {
      ui.showWarn('当前浏览器不支持选择目录（需 Chrome/Edge 111+），将降级为下载到浏览器默认下载目录');
      log('⚠ 未检测到 showDirectoryPicker，将使用 GM_download 降级模式', true);
    }

    // 回放启动前的日志（如有）
    for (const line of logBuffer) ui.appendLog(line);

    // 注册油猴菜单
    try {
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('抓取当前宝贝', () => run());
      }
    } catch (e) { /* 菜单注册失败不影响 */ }

    log('脚本已就绪，在商品详情页点击「① 抓取并保存当前宝贝」开始');
  })();
})();
