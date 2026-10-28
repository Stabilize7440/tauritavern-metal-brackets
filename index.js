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
const SKIP_SELECTOR = 'code, pre, script, style, textarea, .tt-metal';

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

async function bootstrap() {
    let MessageFormatter;
    try {
        ({ MessageFormatter } = await import(MODULE_PATH));
    } catch (error) {
        console.error('[MetalBrackets] 无法加载 MessageFormatter，本扩展需要 TauriTavern 1.13.0 或更新版本。', error);
        return;
    }

    if (!MessageFormatter?.addHook) {
        console.error('[MetalBrackets] MessageFormatter.addHook 不存在，扩展未启用。');
        return;
    }

    MessageFormatter.addHook(transformBrackets, {
        stage: MessageFormatter.stage.AFTER_MARKDOWN,
        order: MessageFormatter.order.NORMAL,
    });

    console.log('[MetalBrackets] 已挂载：afterMarkdown 阶段，匹配 【内容】 → 金属渐变');
}

await bootstrap();

export { transformBrackets };
