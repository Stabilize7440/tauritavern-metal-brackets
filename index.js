/**
 * 金属括号强调 —— 把 【内容】 渲染成带金属渐变的强调文字，括号本身不显示。
 *
 * 为什么不用正则扩展：
 *   正则扩展跑在 converter.makeHtml() 之前（script.js:2568），拿到的还是纯文本，
 *   分不清代码块边界。文本里若有 ```\n【道具】\n``` 这种，正则会把它也替换掉，
 *   然后 markdown 把整块当代码转义，页面上就会直接显示 <span> 字面量。
 *   SillyTavern 自己的引号正则都显式写了 ```...``` 排除，就是绕这个坑。
 *
 * 这里用 TauriTavern 的 MessageFormatter 钩子，挂在 afterMarkdown 阶段
 * （script.js:2656，markdown 转换之后、DOMPurify 之前），拿到的已经是 HTML，
 * 可以遍历文本节点、跳过 code/pre，只处理真正的正文。
 */

const MATCH = /【([^】\n]{1,60})】/g;
const CLASS_NAME = 'tt-metal';
// SillyTavern 的 MESSAGE_SANITIZE（scripts/chats.js:1918）会给所有非白名单 class
// 加 custom- 前缀，所以实际落到 DOM 里的是 custom-tt-metal，两个都要匹配
const CLASS_SELECTOR = '.tt-metal, .custom-tt-metal';
const SKIP_SELECTOR = 'code, pre, script, style, textarea, .tt-metal, .custom-tt-metal';
const STYLE_ID = 'tt-metal-brackets-style';

/**
 * 样式内联在这里而不是放 style.css + manifest 的 css 字段：
 * manifest 的 css 在部分 TauriTavern 版本里不会加载，
 * 结果就是钩子生效（括号消失）但颜色没变 —— 文字继承了正文的 -webkit-text-fill-color。
 *
 * 两个必须注意的 CSS 陷阱：
 *
 * 1. 必须写 background-image，不能用 background 简写。
 *    background 简写会把 background-clip 重置回 border-box，
 *    结果整段文字变成一块彩色矩形。
 *
 * 2. 必须显式 text-shadow: none。
 *    很多主题（包括常见的「双色盒子」）用 text-shadow: 0 0 0 <深色>
 *    来表达「无阴影」，这实际是在字形同一位置盖一层实心暗色。
 *    渲染顺序是「背景 → text-shadow → 文字填充」，
 *    background-clip: text 用的是背景层，会被这层实心投影整个压暗。
 *
 * 3. background-size 用 em 而不是 px，周期跟着字号缩放。
 *    1.5em 以下会变成每个字一个周期，碎成噪点。
 *
 * 4. 选择器同时写 .tt-metal 和 .custom-tt-metal。
 *    SillyTavern 的 MESSAGE_SANITIZE（scripts/chats.js:1918）会给消息里
 *    所有非白名单（fa- / note- / monospace）的 class 加 custom- 前缀，
 *    而 afterMarkdown 钩子跑在 sanitize 之前，写下的 class 会被改掉。
 */
const CSS = `
.tt-metal,
.custom-tt-metal {
    background-image: linear-gradient(
        115deg,
        #ffd9d0 0%,
        #e05058 26%,
        #8e1a20 44%,
        #6b1218 50%,
        #b83038 56%,
        #ff9d90 74%,
        #ffd9d0 100%
    );
    background-size: 3em 100%;
    background-repeat: repeat-x;
    -webkit-background-clip: text !important;
    background-clip: text !important;
    -webkit-text-fill-color: transparent !important;
    color: transparent !important;
    text-shadow: none !important;
    font-weight: 600;
}

@media print {
    .tt-metal,
    .custom-tt-metal {
        background-image: none !important;
        -webkit-text-fill-color: currentColor !important;
        color: inherit !important;
        font-weight: 700;
    }
}

@media (forced-colors: active) {
    .tt-metal,
    .custom-tt-metal {
        background-image: none !important;
        -webkit-text-fill-color: currentColor !important;
        color: inherit !important;
        font-weight: 700;
    }
}
`;

function injectStyle() {
    if (document.getElementById(STYLE_ID)) return false;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
    return true;
}

/**
 * 把一段 HTML 里的 【xxx】 替换成 <span class="tt-metal">xxx</span>。
 * 括号被丢弃，只保留内容 —— 颜色和字重本身就足够表达强调。
 *
 * 天然幂等：处理过的文本里已经不含 【，再次调用不会重复包裹。
 * @param {string} html
 * @returns {string}
 */
function transformBrackets(html) {
    if (typeof html !== 'string' || !html.includes('【')) {
        return html;
    }

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);

    /** @type {Text[]} */
    const targets = [];
    while (walker.nextNode()) {
        const node = /** @type {Text} */ (walker.currentNode);
        if (!node.nodeValue.includes('【')) continue;
        if (node.parentElement?.closest(SKIP_SELECTOR)) continue;
        targets.push(node);
    }
    if (targets.length === 0) return html;

    for (const node of targets) {
        const source = node.nodeValue;
        const frag = doc.createDocumentFragment();
        let cursor = 0;
        let matched = false;

        MATCH.lastIndex = 0;
        let m;
        while ((m = MATCH.exec(source)) !== null) {
            matched = true;
            if (m.index > cursor) {
                frag.append(source.slice(cursor, m.index));
            }
            const span = doc.createElement('span');
            span.className = CLASS_NAME;
            span.textContent = m[1];
            frag.append(span);
            cursor = m.index + m[0].length;
        }

        if (!matched) continue;
        frag.append(source.slice(cursor));
        node.replaceWith(frag);
    }

    return doc.body.innerHTML;
}

const MODULE_PATH = '../../../message-formatter.js';
const TAG = '[MetalBrackets]';

async function bootstrap() {
    // 先注入样式：manifest 的 css 字段不可靠，这一步不能跳过
    injectStyle();

    let MessageFormatter;
    try {
        ({ MessageFormatter } = await import(MODULE_PATH));
    } catch (error) {
        console.error(TAG, '无法加载 MessageFormatter，本扩展需要 TauriTavern 1.13.0 或更新版本。', error);
        return;
    }

    if (!MessageFormatter?.addHook) {
        console.error(TAG, 'MessageFormatter.addHook 不存在，扩展未启用。');
        return;
    }

    MessageFormatter.addHook(transformBrackets, {
        stage: MessageFormatter.stage.AFTER_MARKDOWN,
        order: MessageFormatter.order.NORMAL,
    });

    // 自检：确认样式真的挂上了、能命中已存在的强调文字
    const styleLoaded = !!document.getElementById(STYLE_ID);
    const existing = document.querySelectorAll(CLASS_SELECTOR).length;
    console.log(TAG, `已挂载 | 样式注入=${styleLoaded} | 页面现有强调=${existing} | stage=afterMarkdown`);
    if (existing > 0) {
        const first = document.querySelector(CLASS_SELECTOR);
        const cs = getComputedStyle(first);
        console.log(TAG, '首个强调元素：', {
            className: first.className,
            backgroundImage: cs.backgroundImage.slice(0, 60),
            backgroundClip: cs.webkitBackgroundClip || cs.backgroundClip,
            textFillColor: cs.webkitTextFillColor,
            textShadow: cs.textShadow,
        });
    }
}

await bootstrap();

export { transformBrackets, injectStyle };
