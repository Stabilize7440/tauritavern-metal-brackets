# 金属括号强调 (Metal Brackets)

把正文里的 `【内容】` 渲染成朱砂色金属渐变强调文字，括号本身不显示。

字重和颜色本身已经足够表达强调，留着括号反而多一层噪声。

![效果](docs/preview.png)

## 依赖

- **TauriTavern 1.13.0+**

依赖 TauriTavern 在 `scripts/message-formatter.js` 提供的 `MessageFormatter` 钩子系统，原生 SillyTavern 没有这套 API，装了也不会生效。

## 安装

把整个目录放进：

```
<TauriTavern 数据目录>/extensions/third-party/tauritavern-metal-brackets/
```

例如 `F:\AITools\Chat\TauriTavern\TTdata\extensions\third-party\`。

然后重启 TauriTavern（或在扩展面板里重载）。控制台出现这行就说明挂上了：

```
[MetalBrackets] 已挂载：afterMarkdown 阶段，匹配 【内容】 → 金属渐变
```

## 为什么不用「正则」扩展

SillyTavern 的正则扩展跑在 `converter.makeHtml()` **之前**（`script.js:2568`），拿到的还是纯文本，**分不清代码块边界**。

如果正文里有：

````
```
【道具】的合成配方
```
````

正则会把里面的 `【道具】` 也替换成 `<span>`，然后 markdown 把整块当代码转义，页面上就会直接显示 `<span class="tt-metal">` 这段字面量。

SillyTavern 自己的引号处理正则都显式写了 `` ```...``` `` 排除，就是为了绕这个坑。

本扩展改用 `afterMarkdown` 阶段（`script.js:2656`，markdown 转换之后、DOMPurify 之前），拿到的已经是 HTML，用同步 `DOMParser` 遍历文本节点，遇到 `<code>` / `<pre>` / `<script>` / `<style>` 直接跳过，只处理真正的正文。

## 匹配规则

```
/【([^】\n]{1,60})】/g
```

- 最多 60 字，超长不处理（避免整段被吞）
- 不跨行
- 必须成对闭合
- 已经处理过的文本里没有 `【`，天然幂等，重复渲染不会叠加包裹

**已知不处理**：`【<strong>强调</strong>道具】` 这种括号和被包内容跨了 HTML 标签的情况 —— `【` 和 `】` 落在不同文本节点里，逐节点扫描看不到完整的一对。正常写作里极少出现。

## 调样式

样式内联在 `index.js` 顶部的 `CSS` 常量里（没有独立 style.css，原因见下面的陷阱 3）：

```css
.tt-metal,
.custom-tt-metal {
    /* 换颜色：改这条渐变的色标 */
    background-image: linear-gradient(115deg, #ffd9d0 0%, #e05058 26%, ...);

    /* 扫描周期。3em ≈ 3 个字号宽完成一次明暗循环。
       调到 1.5em 以下会变成每个字一个周期，碎成噪点；
       调到 6em 以上长句会退化成平滑过渡 */
    background-size: 3em 100%;

    /* 字重。想更弱就 500，更强 700 */
    font-weight: 600;
}
```

改渐变色标时注意保持「亮 → 暗 → 亮」的节奏，这是金属反光的来源。全亮会像荧光笔，全暗会融进深色背景。

## ⚠️ 三个坑

写这套东西时踩到的，改的时候别踩回去：

**1. 必须用 `background-image`，不能用 `background` 简写**

```css
/* 错的：background 简写会把 background-clip 重置回 border-box */
background: linear-gradient(...);
-webkit-background-clip: text;

/* 对的 */
background-image: linear-gradient(...);
-webkit-background-clip: text;
```

写成简写的结果是整段文字变成一块彩色矩形。

**2. 必须显式 `text-shadow: none`**

很多主题（比如常见的「双色盒子」）用 `shadow_width: 0` 表达「无阴影」，实际生成的是：

```css
text-shadow: rgb(34, 34, 34) 0px 0px 0px;
```

这是在字形同一位置盖一层模糊半径为 0 的**实心暗色**。渲染顺序是「背景 → text-shadow → 文字填充」，而 `background-clip: text` 用的是背景层，会被这层实心投影整个压暗 —— 所有渐变都变成一片深灰。

**3. class 会被 SillyTavern 加上 `custom-` 前缀**

`scripts/chats.js:1918` 的 `uponSanitizeAttribute` 钩子：

```js
case 'class': {
    data.attrValue = data.attrValue.split(' ').map((v) => {
        if (v.startsWith('fa-') || v.startsWith('note-') || v === 'monospace') return v;
        return 'custom-' + v;      // ← tt-metal 变成 custom-tt-metal
    }).join(' ');
}
```

`afterMarkdown` 钩子跑在 `DOMPurify.sanitize()` **之前**，所以 JS 里写下的 `class="tt-metal"` 到了 DOM 里会变成 `class="custom-tt-metal"`。

症状很有迷惑性：**括号消失了但颜色没变** —— 因为文本已经被改写（钩子生效了），只是 CSS 选择器全落空。

所以选择器必须写两份：

```css
.tt-metal,
.custom-tt-metal { ... }
```

同理，JS 里判断「是否已处理过」的跳过选择器也要带上 `.custom-tt-metal`。

## 为什么 CSS 内联在 JS 里

不依赖 manifest 的 `css` 字段，减少一条可能失效的加载路径 —— 出问题时只需要怀疑 JS 一处。样式就 40 行，内联的维护成本可以接受。

## 许可

MIT
