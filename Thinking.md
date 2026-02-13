# 终端滚动问题排查过程

## 问题描述

- 终端能正常启动
- 能正常输入
- 无法上下滚动
- 修复过程中还出现了半屏空白的问题

## 排查过程

### 1. 初步分析 CSS 问题

查看了 `styles.css` 文件，发现有覆盖 xterm.js 滚动样式的代码：

```css
.terminal-wrapper .xterm-viewport {
  overflow-y: auto !important;
  overflow-x: hidden !important;
  height: auto !important;
  max-height: none !important;
  position: relative !important;
}
```

这些 `!important` 样式覆盖了 xterm.js 的内部滚动机制。

**第一次修复**：注释掉这些样式，但问题依旧。

### 2. 分析终端尺寸计算问题

查看 `TerminalView.ts`，发现手动计算 rows 的方式：

```typescript
const calculateRows = (): number => {
  const containerHeight = terminalContainer.clientHeight;
  const charHeight = this.settings.terminalFontSize * 1.2;
  return Math.max(10, Math.floor(containerHeight / charHeight) - 2);
};
```

同时发现：

- 用户已安装 `xterm-addon-fit` 但未使用
- 手动计算 rows 容易出错，导致尺寸不准确

**第二次修复**：改用 FitAddon 自动调整大小。

但问题依旧，且出现半屏空白。

### 3. 根本原因发现

检查了 `main.ts`，发现**没有加载 xterm.js 的 CSS 文件**。

xterm.js 需要其核心 CSS 才能正常工作，关键样式包括：

```css
.xterm .xterm-viewport {
    overflow-y: scroll;
    position: absolute;
    right: 0;
    left: 0;
    top: 0;
    bottom: 0;
}
```

这是实现滚动的关键！

### 4. 最终解决方案

将 xterm.js 的核心 CSS 直接添加到 `styles.css` 中。

---

## 总结要点

### xterm.js 集成的关键点

1. **必须加载 xterm.js CSS**
   - 可以通过 npm 安装后复制 CSS
   - 或直接将核心 CSS 添加到插件的 styles.css 中

2. **使用 FitAddon 而非手动计算 rows**
   - 手动计算容易出错，导致尺寸问题
   - FitAddon 能自动计算准确的行列数

3. **不要覆盖 xterm.js 的默认样式**
   - 特别是 `.xterm-viewport` 的 `overflow-y` 和 `position`
   - 这些是滚动功能的核心

### 核心 CSS 样式（必须包含）

```css
.xterm {
    cursor: text;
    position: relative;
    user-select: none;
}

.xterm .xterm-viewport {
    overflow-y: scroll;
    cursor: default;
    position: absolute;
    right: 0;
    left: 0;
    top: 0;
    bottom: 0;
}

.xterm .xterm-screen {
    position: relative;
}

.xterm .xterm-screen canvas {
    position: absolute;
    left: 0;
    top: 0;
}
```

### 参考插件

- `obsidian-terminal` 插件的正确实现方式
- 使用 `@xterm/xterm` 和 `@xterm/addon-fit`
- 需要动态加载多个 addon（canvas, webgl, search 等）
