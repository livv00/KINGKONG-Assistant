/**
 * I18N 国际化核心模块
 *
 * 设计原理：
 * 1. 以"中文原文"作为 key，各语言包提供"中文→目标语言"的映射
 * 2. applyLanguage 遍历 DOM 所有文本节点，按映射表替换
 * 3. MutationObserver 监听 DOM 变化，自动翻译新增节点（覆盖动态生成文本）
 * 4. t(zhText) 函数供 JS 代码动态翻译字符串
 * 5. 说明书用多语言版本切换
 *
 * 性能优化：
 * - 移除 characterData 监听，避免滚动/重渲染时频繁触发
 * - 使用 requestAnimationFrame 批量处理 MutationObserver 回调
 * - 缓存排序后的 key 列表，避免 tHTML 每次重新排序
 * - 去重待翻译节点（跳过已包含在其他待翻译节点中的子节点）
 */
const I18N = (function () {
  let _lang = 'zh-CN';          // 当前语言
  let _dict = {};               // 当前语言的翻译映射 { 中文: 译文 }
  let _observer = null;         // MutationObserver
  let _applying = false;        // 防止递归
  let _pendingNodes = [];       // 待翻译的节点队列
  let _rafScheduled = false;    // RAF 是否已调度
  let _sortedKeys = null;       // 缓存排序后的 key 列表

  // 支持的语言列表
  const LANGUAGES = [
    { code: 'zh-CN', name: '中文',     flag: '🇨🇳' },
    { code: 'en-US', name: 'English',  flag: '🇬🇧' },
    { code: 'ja-JP', name: '日本語',   flag: '🇯🇵' },
    { code: 'ko-KR', name: '한국어',   flag: '🇰🇷' },
    { code: 'fr-FR', name: 'Français', flag: '🇫🇷' },
    { code: 'de-DE', name: 'Deutsch',  flag: '🇩🇪' },
    { code: 'es-ES', name: 'Español',  flag: '🇪🇸' },
    { code: 'ru-RU', name: 'Русский',  flag: '🇷🇺' },
  ];

  /**
   * 翻译函数：中文 → 当前语言
   * @param {string} zh 中文原文
   * @returns {string} 翻译后的文本
   */
  function t(zh) {
    if (!zh || typeof zh !== 'string') return zh;
    if (_lang === 'zh-CN') return zh;
    return _dict[zh.trim()] || _dict[zh] || zh;
  }

  /**
   * 获取排序后的 key 列表（缓存）
   * 按长度降序排列，跳过单字 key
   */
  function _getSortedKeys() {
    if (_sortedKeys) return _sortedKeys;
    _sortedKeys = Object.keys(_dict)
      .filter(function (k) { return k.length >= 2; })
      .sort(function (a, b) { return b.length - a.length; });
    return _sortedKeys;
  }

  /**
   * 翻译 HTML 片段（用于 innerHTML 赋值前的预处理）
   * 简单实现：遍历字符串中的中文片段逐个替换
   */
  function tHTML(html) {
    if (!html || typeof html !== 'string') return html;
    if (_lang === 'zh-CN' || Object.keys(_dict).length === 0) return html;
    let result = html;
    // 使用缓存的排序 key 列表
    const keys = _getSortedKeys();
    for (let i = 0; i < keys.length; i++) {
      const zh = keys[i];
      // 快速检查：key 是否存在于文本中，避免无谓的 split/join
      if (result.indexOf(zh) === -1) continue;
      result = result.split(zh).join(_dict[zh]);
    }
    return result;
  }

  /**
   * 翻译单个文本节点
   */
  function _translateTextNode(text) {
    if (!text || _lang === 'zh-CN') return text;
    const trimmed = text.trim();
    if (!trimmed) return text;
    // 精确匹配
    if (_dict[text]) return _dict[text];
    if (_dict[trimmed]) {
      // 保留前后空白
      const leading = text.match(/^\s*/)[0];
      const trailing = text.match(/\s*$/)[0];
      return leading + _dict[trimmed] + trailing;
    }
    // 模糊匹配：文本中包含中文 key
    if (/[\u4e00-\u9fff]/.test(text)) {
      return tHTML(text);
    }
    return text;
  }

  /**
   * 递归遍历 DOM 树翻译所有文本节点
   */
  function _walkDOM(root) {
    if (!root) return;
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          // 跳过 script/style/textarea/input 内的文本
          const parent = node.parentNode;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'INPUT') {
            return NodeFilter.FILTER_REJECT;
          }
          // 语言选择器的 OPTION：保留国旗 emoji + 本国文字不翻译
          // 其它普通下拉框 <select> 的 <option>：正常翻译
          if (tag === 'OPTION') {
            let sel = parent;
            while (sel && sel.tagName !== 'SELECT') sel = sel.parentNode;
            if (sel && sel.id === 'languageSelect') return NodeFilter.FILTER_REJECT;
            // 自定义下拉语言面板（.custom-lang-dropdown）也整体跳过
            let p = parent;
            while (p && p.classList && !p.classList.contains('custom-lang-dropdown') && !p.classList.contains('custom-lang-select-wrap')) p = p.parentNode;
            if (p && p.classList && (p.classList.contains('custom-lang-dropdown') || p.classList.contains('custom-lang-select-wrap'))) {
              return NodeFilter.FILTER_REJECT;
            }
          }
          if (!/[\u4e00-\u9fff]/.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );
    const batch = [];
    let node;
    while ((node = walker.nextNode())) {
      batch.push(node);
    }
    // 批量替换，避免逐个修改触发 MutationObserver
    for (const n of batch) {
      const original = n.nodeValue;
      const translated = _translateTextNode(original);
      if (translated !== original) {
        n._i18n_original = original; // 记录原文，方便切回中文
        n.nodeValue = translated;
      }
    }
  }

  /**
   * 翻译 placeholder / title / data-tooltip / data-i18n 属性
   *  data-i18n="中文key" → 把元素的 textContent 替换为对应译文
   */
  function _walkAttributes(root) {
    if (!root || _lang === 'zh-CN') return;
    const elements = root.querySelectorAll
      ? root.querySelectorAll('[placeholder],[title],[data-tooltip],[data-i18n]')
      : [];
    for (const el of elements) {
      // 普通属性
      for (const attr of ['placeholder', 'title', 'data-tooltip']) {
        const val = el.getAttribute(attr);
        if (val && /[\u4e00-\u9fff]/.test(val)) {
          const translated = _translateTextNode(val);
          if (translated !== val) {
            if (!el._i18n_orig_attrs) el._i18n_orig_attrs = {};
            el._i18n_orig_attrs[attr] = val;
            el.setAttribute(attr, translated);
          }
        }
      }
      // data-i18n 属性：属性值是"中文 key"，把元素 textContent 替换成译文
      const k = el.getAttribute('data-i18n');
      if (k && /[\u4e00-\u9fff]/.test(k)) {
        const translated = _translateTextNode(k);
        if (translated !== k) {
          if (!el._i18n_orig_attrs) el._i18n_orig_attrs = {};
          el._i18n_orig_attrs['__textContent__'] = el.textContent;
          el.setAttribute('data-i18n-applied', translated);
          el.textContent = translated;
        }
      }
    }
    // document.title 也要翻译（包含中文时）
    if (root === document.body && document.title && /[\u4e00-\u9fff]/.test(document.title)) {
      const translated = _translateTextNode(document.title);
      if (translated !== document.title) {
        document._i18n_orig_title = document.title;
        document.title = translated;
      }
    }
  }

  /**
   * 恢复所有文本节点为中文原文（切回中文时用）
   */
  function _restoreOriginal(root) {
    if (!root) return;
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node._i18n_original !== undefined) return NodeFilter.FILTER_ACCEPT;
          return NodeFilter.FILTER_REJECT;
        },
      }
    );
    const batch = [];
    let node;
    while ((node = walker.nextNode())) batch.push(node);
    for (const n of batch) {
      n.nodeValue = n._i18n_original;
      delete n._i18n_original;
    }
    // 恢复属性
    const els = root.querySelectorAll
      ? root.querySelectorAll('[placeholder],[title],[data-tooltip],[data-i18n]')
      : [];
    for (const el of els) {
      if (el._i18n_orig_attrs) {
        for (const [attr, val] of Object.entries(el._i18n_orig_attrs)) {
          if (attr === '__textContent__') {
            // data-i18n 反推
            el.textContent = val;
          } else {
            el.setAttribute(attr, val);
          }
        }
        delete el._i18n_orig_attrs;
        if (el.hasAttribute('data-i18n-applied')) el.removeAttribute('data-i18n-applied');
      }
    }
    if (root === document.body && document._i18n_orig_title) {
      document.title = document._i18n_orig_title;
      delete document._i18n_orig_title;
    }
  }

  /**
   * 公开 API：翻译单个节点（及其子树）—— 右键菜单 / 动态列表 / 模态 innerHTML 后调用
   * 立即同步翻译，不经过 RAF 队列
   */
  function translateNode(node) {
    if (!node) return;
    if (_lang === 'zh-CN') return;
    const root = (node.nodeType === Node.ELEMENT_NODE) ? node : node.parentNode;
    if (!root) return;
    _applying = true;
    _walkDOM(root);
    _walkAttributes(root);
    _applying = false;
  }

  /**
   * 应用语言到整个页面
   * @param {string} lang 语言代码
   * @param {object} dict 该语言的翻译映射
   */
  function applyLanguage(lang, dict) {
    _applying = true;
    // 停止 observer 防止递归
    if (_observer) _observer.disconnect();
    // 清空待处理队列
    _pendingNodes = [];
    _rafScheduled = false;

    _lang = lang;
    _dict = dict || {};
    _sortedKeys = null; // 使缓存失效，下次 tHTML 重新生成

    const root = document.body;

    if (lang === 'zh-CN') {
      // 切回中文：恢复原文
      _restoreOriginal(root);
    } else {
      // 先恢复原文（从其他语言切过来时）
      _restoreOriginal(root);
      // 再应用新语言
      _walkDOM(root);
      _walkAttributes(root);
    }

    // 更新 html lang 属性
    document.documentElement.lang = lang;

    // 持久化
    try {
      localStorage.setItem('appLanguage', lang);
    } catch (_) {}

    // 本方案下运行时不再切换语言（主窗口切换语言会提示用户重启软件生效）
    // 因此不再向主进程广播 i18n-language-changed，避免子窗口间 IPC 二级放大效应

    // 重启 observer：
    // - 主窗口：保留 observer 运行时监听，用于自动翻译动态生成的中文内容（右键菜单、模态框等）
    // - 子窗口：启动翻译完成后会主动调用 I18N.shutdownObserver() 立即关闭，避免运行时开销
    //   （子窗口如 ARTNET 触发的 UDP 数据频繁修改 textContent 会触发 mutation，关闭后无此开销）
    _startObserver();

    _applying = false;
  }

  /**
   * 显式关闭 MutationObserver（供子窗口启动翻译完成后调用）
   * 关闭后该窗口不再监听 DOM 变化，运行时动态生成的中文内容不会被自动翻译
   * 如需翻译，由生成代码主动调用 I18N.translateNode(node)
   */
  function shutdownObserver() {
    if (_observer) { _observer.disconnect(); _observer = null; }
    _pendingNodes = [];
    _rafScheduled = false;
  }

  /**
   * 启动 MutationObserver，自动翻译新增 DOM 节点
   * 性能优化：
   * - 仅监听 childList（不监听 characterData），避免滚动时频繁触发
   * - 使用 requestAnimationFrame 批量处理，一帧内多次 mutation 合并为一次遍历
   * - 去重：跳过已包含在其他待翻译节点中的子节点
   */
  function _startObserver() {
    if (_observer) _observer.disconnect();
    if (_lang === 'zh-CN') return;

    _observer = new MutationObserver(function (mutations) {
      if (_applying) return;
      let hasNew = false;
      for (const mut of mutations) {
        if (mut.type === 'childList') {
          for (const node of mut.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              _pendingNodes.push(node);
              hasNew = true;
            }
          }
        }
      }
      if (hasNew && !_rafScheduled) {
        _rafScheduled = true;
        requestAnimationFrame(function () {
          _rafScheduled = false;
          const nodes = _pendingNodes;
          _pendingNodes = [];
          if (nodes.length === 0) return;

          // 去重：移除被其他待翻译节点包含的子节点（父节点遍历时会覆盖子节点）
          const toProcess = [];
          for (const node of nodes) {
            // 跳过已脱离 DOM 的节点
            if (!node.isConnected) continue;
            let isChild = false;
            for (const other of nodes) {
              if (other !== node && other.contains && other.contains(node)) {
                isChild = true;
                break;
              }
            }
            if (!isChild) toProcess.push(node);
          }

          if (toProcess.length === 0) return;
          _applying = true;
          for (const node of toProcess) {
            _walkDOM(node);
            _walkAttributes(node);
          }
          _applying = false;
        });
      }
    });

    // 仅监听 childList + subtree，不监听 characterData
    // characterData 会在滚动/重渲染时产生大量 mutation，导致卡顿
    _observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  /**
   * 获取当前语言
   */
  function getCurrent() {
    return _lang;
  }

  /**
   * 是否中文
   */
  function isZh() {
    return _lang === 'zh-CN';
  }

  /**
   * 初始化：从 localStorage 恢复语言偏好
   */
  function init() {
    try {
      const saved = localStorage.getItem('appLanguage');
      if (saved && saved !== 'zh-CN') {
        // 加载语言包并应用
        _loadAndApply(saved);
      }
    } catch (_) {}
  }

  /**
   * 动态加载语言包并应用
   */
  function _loadAndApply(lang) {
    if (lang === 'zh-CN') {
      applyLanguage('zh-CN', {});
      return;
    }
    // 尝试从全局语言包对象获取
    if (typeof window.I18N_LANGUAGES !== 'undefined' && window.I18N_LANGUAGES[lang]) {
      applyLanguage(lang, window.I18N_LANGUAGES[lang]);
    } else {
      console.warn('[I18N] 语言包未加载:', lang);
    }
  }

  /**
   * 切换语言（供设置面板调用）
   */
  function changeLanguage(lang) {
    _loadAndApply(lang);
  }

  /**
   * 获取语言列表
   */
  function getLanguages() {
    return LANGUAGES;
  }

  return {
    t,
    tHTML,
    applyLanguage,
    changeLanguage,
    getCurrent,
    isZh,
    getLanguages,
    init,
    translateNode,
    shutdownObserver,
    get dict() { return _dict; },
    get lang() { return _lang; },
  };
})();

// 暴露到全局
window.I18N = I18N;
