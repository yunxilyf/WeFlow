# WeFlow

WeFlow 是一个**完全本地**的微信**实时**聊天记录查看、分析与导出工具。它可以实时获取你的微信聊天记录并将其导出，还可以根据你的聊天记录为你生成独一无二的分析报告

---

<p align="center">
  <img src="app.png" alt="WeFlow" width="90%">
</p>

---

<p align="center">
<a href="https://github.com/hicccc77/WeFlow/stargazers">
<img src="https://img.shields.io/github/stars/hicccc77/WeFlow?style=flat-square" alt="Stargazers">
</a>
<a href="https://github.com/hicccc77/WeFlow/network/members">
<img src="https://img.shields.io/github/forks/hicccc77/WeFlow?style=flat-square" alt="Forks">
</a>
<a href="https://github.com/hicccc77/WeFlow/issues">
<img src="https://img.shields.io/github/issues/hicccc77/WeFlow?style=flat-square" alt="Issues">
</a>
<a href="https://t.me/+hn3QzNc4DbA0MzNl">
<img src="https://img.shields.io/badge/Telegram%20交流群-点击加入-0088cc?style=flat-square&logo=telegram&logoColor=0088cc&labelColor=white" alt="Telegram">
</a>
</p>

> [!TIP]
> 如果导出聊天记录后，想深入分析聊天内容可以试试 [ChatLab](https://chatlab.fun/)

# 加入微信交流群

> 🎉 扫码加入微信群，与其他 WeFlow 用户一起交流问题和使用心得。

<p align="center">
  <img src="2wm.png" alt="WeFlow 微信交流群二维码（一群）" width="220" style="margin-right: 16px;">
  <img src="3wm.png" alt="WeFlow 微信交流群二维码（二群）" width="220">
</p>
<p align="center">一群满了加二群</p>

## 主要功能

- 本地实时查看聊天记录
- 统计分析与群聊画像
- 年度报告与可视化概览
- 导出聊天记录为 HTML 等格式
- 本地解密与数据库管理

> [!NOTE]
> ⚠️ 本工具仅适配微信 **4.0 及以上**版本，请确保你的微信版本符合要求

## 快速开始

若你只想使用成品版本，可前往 Release 下载并安装。

## 面向开发者

如果你想从源码构建或为项目贡献代码，请遵循以下步骤：

```bash
# 1. 克隆项目到本地
git clone https://github.com/hicccc77/WeFlow.git
cd WeFlow

# 2. 安装项目依赖
npm install

# 3. 运行应用（开发模式）
npm run dev

# 4. 打包可执行文件
npm run build
```

打包产物在 `release` 目录下。

## 技术栈

- **前端**: React 19 + TypeScript + Zustand
- **桌面**: Electron 39
- **构建**: Vite + electron-builder
- **数据库**: better-sqlite3 + WCDB DLL
- **样式**: SCSS + CSS Variables

## 项目结构

```
WeFlow/
├── electron/              # Electron 主进程
│   ├── main.ts           # 主进程入口
│   ├── preload.ts        # 预加载脚本
│   └── services/         # 后端服务
│       ├── chatService.ts      # 聊天数据服务
│       ├── wcdbService.ts      # 数据库服务
│       └── ...
├── src/                   # React 前端
│   ├── components/       # 通用组件
│   ├── pages/            # 页面组件
│   ├── stores/           # Zustand 状态管理
│   ├── services/         # 前端服务
│   └── types/            # TypeScript 类型定义
├── public/               # 静态资源
└── resources/            # 打包资源
```

## 致谢

- [密语 CipherTalk](https://github.com/ILoveBingLu/miyu) 为本项目提供了基础框架


## Star History

<a href="https://www.star-history.com/#hicccc77/WeFlow&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=hicccc77/WeFlow&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=hicccc77/WeFlow&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=hicccc77/WeFlow&type=date&legend=top-left" />
 </picture>
</a>

<div align="center">

---

**请负责任地使用本工具，遵守相关法律法规**

我们总是在向前走，却很少有机会回头看看

</div>
