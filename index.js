/**
 * 金属括号强调 (Metal Brackets)
 *
 * 把正文里的 【内容】 渲染成带金属渐变的强调文字。
 *
 * ── 为什么不用正则扩展 ────────────────────────────────────────────────
 * SillyTavern 的正则扩展跑在 converter.makeHtml() 之前（script.js:2568），
 * 拿到的还是纯文本，分不清代码块边界。文本里若有 ```\n【道具】\n```，
 * 正则会把它也替换成 <span>，然后 markdown 把整块当代码转义，
 * 页面上就会直接显示 span 字面量。
 * 这里用 MessageFormatter 的 afterMarkdown 阶段（script.js:2656，
 * markdown 之后、DOMPurify 之前），拿到的是 HTML，可以跳过 code/pre。
 *
 * ── 为什么用 data 属性而不是 class ───────────────────────────────────
 * SillyTavern 的 MESSAGE_SANITIZE（scripts/chats.js:1918）会给消息里
 * 所有非白名单 class 加 custom- 前缀，而本 hook 跑在 sanitize 之前，
 * 写下的 class 到 DOM 里会变成 custom-x，选择器全部落空。
 * data-* 属性不受这个钩子影响（DOMPurify 默认 ALLOW_DATA_ATTR 为 true）。
 *
 * ── 为什么括号留在 DOM 里 ────────────────────────────────────────────
 * 直接删掉括号会让「关掉某个符号」无法回滚，也让「显示括号」这类选项
 * 做不了。这里保留成 <span data-tt-bracket>，靠 CSS 隐藏，
 * 配置改了重新生成样式即可，不需要重渲染消息。
 */

import { extension_settings, getContext } from '../../../extensions.js';

const SETTINGS_KEY = 'tt_metal_brackets';
const STYLE_ID = 'tt-metal-brackets-style';
const MARK_ATTR = 'data-tt-metal';
const BRACKET_ATTR = 'data-tt-bracket';
const TAG = '[MetalBrackets]';

/** 处理时跳过的祖先元素。mark 本身也跳过，保证幂等 */
const SKIP_SELECTOR = `code, pre, script, style, textarea, [${MARK_ATTR}]`;

/**
 * 内置色板。每个样式 6 个色标，顺序是「亮 → 主 → 暗 → 最暗 → 次亮 → 高光」，
 * 最后自动回到第一个颜色闭合循环，形成金属反光的明暗节奏。
 */
const STYLE_PRESETS = {
    cinnabar: { name: '朱砂', colors: ['#ffd9d0', '#e05058', '#8e1a20', '#6b1218', '#b83038', '#ff9d90'] },
    jade: { name: '青玉', colors: ['#d9f7f0', '#5cc7ae', '#237a6c', '#1a6b60', '#3aa08b', '#8ee6d2'] },
    gold: { name: '暗金', colors: ['#fff0c8', '#e0b050', '#94661a', '#7d5510', '#bc8a2e', '#ffe49a'] },
    rose: { name: '玫瑰金', colors: ['#ffe6ec', '#e084a2', '#a3405e', '#8a2f4f', '#c96486', '#ffcad8'] },
};

const cloneStyles = () => JSON.parse(JSON.stringify(STYLE_PRESETS));

const DEFAULT_SETTINGS = {
    enabled: true,
    maxLength: 60,
    angle: 115,
    period: 3,
    weight: 600,
    showBracket: false,
    rules: [{ open: '【', close: '】', style: 'cinnabar' }],
    styles: cloneStyles(),
};

// ─────────────────────────── 配置 ───────────────────────────

function getSettings() {
    const stored = extension_settings[SETTINGS_KEY];
    if (!stored || typeof stored !== 'object') {
        extension_settings[SETTINGS_KEY] = {};
    }
    const target = extension_settings[SETTINGS_KEY];

    // 逐字段补齐，兼容旧配置和新增字段
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (target[key] === undefined) {
            target[key] = key === 'styles' ? cloneStyles() : structuredClone(value);
        }
    }
    // 补上后来新增的内置样式（用户可能删了某个 key）
    for (const [key, preset] of Object.entries(STYLE_PRESETS)) {
        if (!target.styles[key]) target.styles[key] = { ...preset, colors: [...preset.colors] };
    }
    if (!Array.isArray(target.rules) || target.rules.length === 0) {
        target.rules = [{ open: '【', close: '】', style: 'cinnabar' }];
    }
    return target;
}

function saveSettings() {
    getContext().saveSettingsDebounced();
}

// ─────────────────────────── 匹配 ───────────────────────────

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeCharClass = (s) => String(s).replace(/[\\\]^*-]/g, '\\$&');

/**
 * 把所有符号规则编译成一条正则。
 *
 * 每条规则贡献一个捕获组，匹配后用「哪个组非 undefined」反查规则序号 ——
 * m[1] 对应 rules[0] 的内容，m[2] 对应 rules[1]，以此类推。
 *
 * @param {Array<{open: string, close: string}>} rules
 * @param {number} maxLength
 * @returns {{ re: RegExp, rules: Array<{open: string, close: string, style: string}> } | null}
 */
function compileRules(rules, maxLength) {
    const valid = rules.filter((r) => r && r.open && r.close && r.open !== r.close);
    if (valid.length === 0) return null;

    // 开符号长的排前面，避免 【 抢走 【【 的匹配
    valid.sort((a, b) => b.open.length - a.open.length);

    // 内容里不允许出现任何一个开/闭符号，避免跨嵌套错位
    const excluded = escapeCharClass([...new Set(valid.flatMap((r) => [...r.open, ...r.close]).filter(Boolean))].join(''));
    const body = excluded ? `[^${excluded}\\n]{1,${maxLength}}` : `[^\\n]{1,${maxLength}}`;

    const source = valid.map((r) => `${escapeRe(r.open)}(${body})${escapeRe(r.close)}`).join('|');
    return { re: new RegExp(source, 'g'), rules: valid };
}

/**
 * 把一段 HTML 里的符号包裹内容替换成带标记的 span。
 * @param {string} html
 * @param {object} cfg
 * @returns {string}
 */
function transformBrackets(html, cfg = getSettings()) {
    if (typeof html !== 'string' || !cfg.enabled) return html;

    const compiled = compileRules(cfg.rules, Math.max(1, Number(cfg.maxLength) || 60));
    if (!compiled) return html;

    // 短路：不含任何一个开符号就直接返回，绝大多数消息走这条路
    if (!compiled.rules.some((r) => html.includes(r.open))) return html;

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);

    /** @type {Text[]} */
    const targets = [];
    while (walker.nextNode()) {
        const node = /** @type {Text} */ (walker.currentNode);
        if (!compiled.rules.some((r) => node.nodeValue.includes(r.open))) continue;
        if (node.parentElement?.closest(SKIP_SELECTOR)) continue;
        targets.push(node);
    }
    if (targets.length === 0) return html;

    const { re, rules } = compiled;

    for (const node of targets) {
        const source = node.nodeValue;
        const frag = doc.createDocumentFragment();
        let cursor = 0;
        let matched = false;

        re.lastIndex = 0;
        let m;
        while ((m = re.exec(source)) !== null) {
            if (m[0].length === 0) { re.lastIndex++; continue; }

            const ruleIndex = rules.findIndex((_, i) => m[i + 1] !== undefined);
            if (ruleIndex < 0) continue;
            const rule = rules[ruleIndex];

            matched = true;
            if (m.index > cursor) frag.append(source.slice(cursor, m.index));

            const span = doc.createElement('span');
            span.setAttribute(MARK_ATTR, rule.style || 'cinnabar');

            const openMark = doc.createElement('span');
            openMark.setAttribute(BRACKET_ATTR, '');
            openMark.textContent = rule.open;
            span.append(openMark);

            span.append(m[ruleIndex + 1]);

            const closeMark = doc.createElement('span');
            closeMark.setAttribute(BRACKET_ATTR, '');
            closeMark.textContent = rule.close;
            span.append(closeMark);

            frag.append(span);
            cursor = m.index + m[0].length;
        }

        if (!matched) continue;
        frag.append(source.slice(cursor));
        node.replaceWith(frag);
    }

    return doc.body.innerHTML;
}

// ─────────────────────────── 样式 ───────────────────────────

function gradientOf(colors, angle) {
    const c = colors;
    return `linear-gradient(${angle}deg, ${c[0]} 0%, ${c[1]} 26%, ${c[2]} 44%, ${c[3]} 50%, ${c[4]} 56%, ${c[5]} 74%, ${c[0]} 100%)`;
}

/**
 * 按当前配置生成整张样式表。
 * 配置变了重建 style 内容即可 —— 不需要重渲染任何消息。
 */
function buildStylesheet(cfg) {
    const gradVars = Object.entries(cfg.styles)
        .map(([key, s]) => `[${MARK_ATTR}="${key}"] { --tt-grad: ${gradientOf(s.colors, cfg.angle)}; }`)
        .join('\n');

    // 括号：隐藏 / 弱化显示。两种形态都靠 CSS 切换，DOM 里始终保留原文
    const bracketRule = cfg.showBracket
        ? `opacity: 0.5; font-size: 0.72em; letter-spacing: 0;`
        : `display: none;`;

    return `
:root {
    --tt-period: ${cfg.period}em;
    --tt-weight: ${cfg.weight};
}

${gradVars}

:is([${MARK_ATTR}], .tt-metal, .custom-tt-metal) {
    background-image: var(--tt-grad);
    background-size: var(--tt-period) 100%;
    background-repeat: repeat-x;
    -webkit-background-clip: text !important;
    background-clip: text !important;
    -webkit-text-fill-color: transparent !important;
    color: transparent !important;
    text-shadow: none !important;
    font-weight: var(--tt-weight);
}

:is([${BRACKET_ATTR}], .tt-bracket, .custom-tt-bracket) {
    ${bracketRule}
}

@media print, (forced-colors: active) {
    :is([${MARK_ATTR}], .tt-metal, .custom-tt-metal) {
        background-image: none !important;
        -webkit-text-fill-color: currentColor !important;
        color: inherit !important;
        font-weight: 700;
    }
    :is([${BRACKET_ATTR}], .tt-bracket, .custom-tt-bracket) {
        display: inline !important;
        opacity: 1 !important;
        font-size: 1em !important;
    }
}

/* ── 设置面板 ── */
.tt-metal-settings .tt-row { display: flex; align-items: center; gap: 0.35em; margin: 0.4em 0; }
.tt-metal-settings .tt-row > label { flex: 0 0 5em; opacity: 0.85; }
.tt-metal-settings .tt-row > input[type="range"] { flex: 1 1 auto; min-width: 4em; width: auto; }
.tt-metal-settings .tt-row > .tt-val { flex: 0 0 3.2em; text-align: right; opacity: 0.7; font-variant-numeric: tabular-nums; }
.tt-metal-settings .tt-rule {
    display: flex; align-items: center; gap: 0.35em; margin: 0.3em 0;
    padding: 0.3em 0.4em; border-radius: 0.4em;
    background: color-mix(in srgb, var(--SmartThemeBodyColor, #fff) 5%, transparent);
}
.tt-metal-settings .tt-rule .tt-sym { flex: 0 0 2.8em; width: 2.8em; text-align: center; padding-left: 0.3em; padding-right: 0.3em; }
.tt-metal-settings .tt-rule select { flex: 1 1 auto; min-width: 4em; }
.tt-metal-settings .tt-rule .tt-del { flex: 0 0 auto; cursor: pointer; opacity: 0.55; padding: 0 0.2em; }
.tt-metal-settings .tt-rule .tt-del:hover { opacity: 1; }
.tt-metal-settings .tt-swatches { display: flex; gap: 0.2em; align-items: center; flex-wrap: wrap; }
.tt-metal-settings .tt-swatches input[type="color"] {
    width: 1.5em; height: 1.5em; padding: 0; border: none; border-radius: 0.25em;
    background: none; cursor: pointer; flex: 0 0 auto;
}
.tt-metal-settings .tt-swatch-label { flex: 0 0 3.6em; opacity: 0.85; }
.tt-metal-settings .tt-hint { font-size: 0.85em; opacity: 0.55; margin-top: 0.4em; }
.tt-metal-settings .tt-add-rule { display: inline-flex; align-items: center; gap: 0.3em; margin-top: 0.3em; }
.tt-metal-settings hr { margin: 0.8em 0; opacity: 0.2; }
`;
}

function injectStyle(cfg) {
    let el = document.getElementById(STYLE_ID);
    if (!el) {
        el = document.createElement('style');
        el.id = STYLE_ID;
        document.head.appendChild(el);
    }
    el.textContent = buildStylesheet(cfg);
}

// ─────────────────────────── 设置面板 ───────────────────────────

const STYLE_OPTIONS = () =>
    Object.entries(getSettings().styles)
        .map(([key, s]) => `<option value="${key}">${s.name || key}</option>`)
        .join('');

function rulesHtml() {
    const cfg = getSettings();
    return cfg.rules
        .map(
            (r, i) => `
        <div class="tt-rule" data-index="${i}">
            <input class="text_pole tt-sym" type="text" maxlength="3" value="${r.open}" title="开符号">
            <input class="text_pole tt-sym" type="text" maxlength="3" value="${r.close}" title="闭符号">
            <select class="text_pole">${STYLE_OPTIONS()}</select>
            <div class="tt-del fa-solid fa-trash-can" title="删除"></div>
        </div>`,
        )
        .join('');
}

function swatchRow(styleKey, styleDef) {
    const colors = styleDef.colors
        .map((c, i) => `<input type="color" value="${c}" data-style="${styleKey}" data-color="${i}">`)
        .join('');
    return `<div class="tt-row"><span class="tt-swatch-label">${styleDef.name || styleKey}</span><div class="tt-swatches">${colors}</div></div>`;
}

function panelHtml() {
    const cfg = getSettings();
    return `
    <div class="tt-metal-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>金属括号强调</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label">
                    <input id="tt_metal_enabled" type="checkbox">
                    <span>启用</span>
                </label>

                <div class="tt-hint">符号规则（开符号 / 闭符号 / 样式）</div>
                <div id="tt_metal_rules">${rulesHtml()}</div>
                <div id="tt_metal_add_rule" class="menu_button tt-add-rule" title="添加一组符号">
                    <i class="fa-solid fa-plus"></i><span>添加符号</span>
                </div>

                <hr>
                <div class="tt-row">
                    <label>渐变角度</label>
                    <input id="tt_metal_angle" type="range" min="0" max="180" step="5">
                    <span class="tt-val" id="tt_metal_angle_v"></span>
                </div>
                <div class="tt-row">
                    <label>扫描周期</label>
                    <input id="tt_metal_period" type="range" min="1" max="8" step="0.5">
                    <span class="tt-val" id="tt_metal_period_v"></span>
                </div>
                <div class="tt-row">
                    <label>字重</label>
                    <input id="tt_metal_weight" type="range" min="300" max="800" step="100">
                    <span class="tt-val" id="tt_metal_weight_v"></span>
                </div>
                <div class="tt-row">
                    <label>长度上限</label>
                    <input id="tt_metal_maxlen" type="range" min="10" max="120" step="5">
                    <span class="tt-val" id="tt_metal_maxlen_v"></span>
                </div>
                <label class="checkbox_label">
                    <input id="tt_metal_show_bracket" type="checkbox">
                    <span>显示括号</span>
                </label>

                <hr>
                <div class="tt-hint">色板（亮 → 主 → 暗 → 最暗 → 次亮 → 高光）</div>
                <div id="tt_metal_styles">
                    ${Object.entries(cfg.styles).map(([k, s]) => swatchRow(k, s)).join('')}
                </div>
            </div>
        </div>
    </div>`;
}

/** 只重建样式：颜色/角度/周期/字重/括号显隐都走这条路，零重渲染 */
function refreshStyle() {
    injectStyle(getSettings());
}

/** 重建样式 + 整个聊天重渲染：只有符号规则和启用状态需要 */
async function refreshAll() {
    refreshStyle();
    try {
        const { reloadCurrentChat } = await import('../../../script.js');
        await reloadCurrentChat();
    } catch (error) {
        console.error(TAG, '重渲染聊天失败，请手动刷新页面。', error);
    }
}

function syncControls() {
    const cfg = getSettings();
    $('#tt_metal_enabled').prop('checked', !!cfg.enabled);
    $('#tt_metal_angle').val(cfg.angle);
    $('#tt_metal_angle_v').text(`${cfg.angle}°`);
    $('#tt_metal_period').val(cfg.period);
    $('#tt_metal_period_v').text(`${cfg.period}em`);
    $('#tt_metal_weight').val(cfg.weight);
    $('#tt_metal_weight_v').text(String(cfg.weight));
    $('#tt_metal_maxlen').val(cfg.maxLength);
    $('#tt_metal_maxlen_v').text(String(cfg.maxLength));
    $('#tt_metal_show_bracket').prop('checked', !!cfg.showBracket);
    $('#tt_metal_rules .tt-rule').each(function () {
        const i = Number($(this).attr('data-index'));
        const rule = cfg.rules[i];
        if (!rule) return;
        $(this).find('select').val(rule.style);
    });
}

function bindPanel() {
    $('#tt_metal_enabled').on('input', async function () {
        getSettings().enabled = !!$(this).prop('checked');
        saveSettings();
        await refreshAll();
    });

    $('#tt_metal_angle').on('input', function () {
        getSettings().angle = Number($(this).val());
        $('#tt_metal_angle_v').text(`${getSettings().angle}°`);
        saveSettings();
        refreshStyle();
    });

    $('#tt_metal_period').on('input', function () {
        getSettings().period = Number($(this).val());
        $('#tt_metal_period_v').text(`${getSettings().period}em`);
        saveSettings();
        refreshStyle();
    });

    $('#tt_metal_weight').on('input', function () {
        getSettings().weight = Number($(this).val());
        $('#tt_metal_weight_v').text(String(getSettings().weight));
        saveSettings();
        refreshStyle();
    });

    $('#tt_metal_maxlen').on('input', function () {
        getSettings().maxLength = Number($(this).val());
        $('#tt_metal_maxlen_v').text(String(getSettings().maxLength));
        saveSettings();
        refreshStyle();
    });

    $('#tt_metal_show_bracket').on('input', function () {
        getSettings().showBracket = !!$(this).prop('checked');
        saveSettings();
        refreshStyle();
    });

    // 符号编辑：改完要重渲染，用 change 而不是 input，避免打字过程中反复重载
    $('#tt_metal_rules').on('change input', 'select', async function () {
        const i = Number($(this).closest('.tt-rule').attr('data-index'));
        getSettings().rules[i].style = $(this).val();
        saveSettings();
        await refreshAll();
    });

    $('#tt_metal_rules').on('change', 'input.tt-sym', async function () {
        const i = Number($(this).closest('.tt-rule').attr('data-index'));
        const rule = getSettings().rules[i];
        if (!rule) return;
        const inputs = $(this).closest('.tt-rule').find('input.tt-sym');
        rule.open = String($(inputs[0]).val() || '').trim();
        rule.close = String($(inputs[1]).val() || '').trim();
        saveSettings();
        await refreshAll();
    });

    $('#tt_metal_rules').on('click', '.tt-del', async function () {
        const rule = $(this).closest('.tt-rule');
        const i = Number(rule.attr('data-index'));
        if (getSettings().rules.length <= 1) return;
        getSettings().rules.splice(i, 1);
        saveSettings();
        $('#tt_metal_rules').html(rulesHtml());
        syncControls();
        await refreshAll();
    });

    $('#tt_metal_add_rule').on('click', async function () {
        getSettings().rules.push({ open: '', close: '', style: 'jade' });
        saveSettings();
        $('#tt_metal_rules').html(rulesHtml());
        syncControls();
    });

    $('#tt_metal_styles').on('input', 'input[type="color"]', function () {
        const styleKey = $(this).attr('data-style');
        const colorIndex = Number($(this).attr('data-color'));
        const target = getSettings().styles[styleKey];
        if (!target) return;
        target.colors[colorIndex] = $(this).val();
        saveSettings();
        refreshStyle();
    });
}

// ─────────────────────────── 启动 ───────────────────────────

async function bootstrap() {
    const cfg = getSettings();
    injectStyle(cfg);

    let MessageFormatter;
    try {
        ({ MessageFormatter } = await import('../../../message-formatter.js'));
    } catch (error) {
        console.error(TAG, '无法加载 MessageFormatter，本扩展需要 TauriTavern 1.13.0 或更新版本。', error);
        return;
    }
    if (!MessageFormatter?.addHook) {
        console.error(TAG, 'MessageFormatter.addHook 不存在，扩展未启用。');
        return;
    }

    MessageFormatter.addHook((html) => transformBrackets(html), {
        stage: MessageFormatter.stage.AFTER_MARKDOWN,
        order: MessageFormatter.order.NORMAL,
    });

    const html = panelHtml();
    $('#extensions_settings2').append(html);
    syncControls();
    bindPanel();

    console.log(
        TAG,
        `已挂载 | 规则 ${cfg.rules.length} 组 | 样式 ${Object.keys(cfg.styles).length} 套 | 启用=${cfg.enabled}`,
    );
}

$(async () => {
    try {
        await bootstrap();
    } catch (error) {
        console.error(TAG, '初始化失败', error);
    }
});

export { transformBrackets, buildStylesheet, compileRules, getSettings };
