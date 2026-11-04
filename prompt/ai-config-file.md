The Complete Guide to AI Agent Memory Files (CLAUDE.md, AGENTS.md, and Beyond)
AI Agent 记忆文件完全指南（CLAUDE.md、AGENTS.md 及其他）
Paolo Perrone
Paolo Perrone


One file. Loaded before every conversation. That’s all it takes to turn a stateless AI coding assistant into something that actually remembers how your project works.
一个文件。在每次对话前加载。仅此而已，就能将一个无状态的 AI 编程助手转变为真正记住你项目运作方式的工具。

I figured this out the hard way. Three months into using Claude Code on a production codebase, I was still correcting the same mistakes every session. “No, we use pnpm, not npm.” “No, the test command is make test-integration, not pytest." "No, we don't use default exports here." Every correction vanished when the session ended.
我是通过艰难的方式领悟到这一点的。在生产代码库中使用 Claude Code 三个月后，我仍然在每次会话中纠正相同的错误。“不，我们用的是 pnpm，不是 npm。”“不，测试命令是 make test-integration ，不是 pytest 。”“不，我们这里不使用默认导出。”每次纠正都会在会话结束时消失。

Then I created a CLAUDE.md file. Forty lines of project context. The corrections stopped overnight.
于是我创建了一个 CLAUDE.md 文件。四十行项目背景说明。一夜之间，纠正工作停止了。

But CLAUDE.md is just one file in what’s become an entire ecosystem. There’s AGENTS.md, .cursorrules, copilot-instructions.md, CLAUDE.local.md, and now Claude’s auto-memory system. Your repo can end up looking like a markdown museum for confused bots.
但 CLAUDE.md 只是整个生态系统中一个文件。还有 AGENTS.md、.cursorrules、copilot-instructions.md、CLAUDE.local.md，以及现在 Claude 的自动记忆系统。你的代码库最终可能看起来像一个为困惑的机器人准备的 Markdown 博物馆。

This guide covers all of them. What each file does, where it goes, and (most importantly) which ones you actually need.
本指南涵盖所有内容：每个文件的作用、存放位置，以及（最重要的）你真正需要哪些文件。

The Problem: Every Tool Wants Its Own File
问题所在：每个工具都想要自己的专属文件
If you use more than one AI coding assistant (and if you’ve read my honest tier list of AI agent frameworks, you know why you might), you’ve probably noticed the mess. Claude wants CLAUDE.md. Cursor wants .cursorrules (or .cursor/rules/). GitHub Copilot wants .github/copilot-instructions.md. Windsurf wants .windsurf/rules. Google’s Jules wants JULES.md.
如果你使用不止一个 AI 编程助手（如果你读过我关于 AI 代理框架的客观分级榜单，就会明白为何可能需要多个），可能已经注意到这种混乱局面。Claude 需要 CLAUDE.md，Cursor 需要.cursorrules（或.cursor/rules/），GitHub Copilot 需要.github/copilot-instructions.md，Windsurf 需要.windsurf/rules，谷歌的 Jules 则需要 JULES.md。

The content is almost identical across all of them. Your coding standards, your build commands, your test setup, your architectural patterns. But you’re copying and pasting the same instructions into five different files.
这些文件的内容几乎完全一致：你的编码规范、构建命令、测试配置、架构模式。但你却要将相同的指令复制粘贴到五个不同的文件中。

This is the fragmentation problem that AGENTS.md was created to solve. More on that in a minute.
这正是 AGENTS.md 被创建出来要解决的碎片化问题。稍后我们会详细讨论这一点。

First, let’s understand what each file actually does.
首先，让我们理解每个文件的实际作用。

CLAUDE.md: The One That Started It All
CLAUDE.md：一切的起点
CLAUDE.md is Claude Code’s memory file. Drop it in your project root, and Claude reads it at the start of every session. Think of it as a briefing document for a new team member who has amnesia.
CLAUDE.md 是 Claude Code 的记忆文件。将其放入项目根目录，Claude 会在每次会话开始时读取它。可以把它想象成给一位患有失忆症的新团队成员的简报文件。

Where it lives (hierarchy matters):
其存放位置（层级关系至关重要）：


The hierarchy loads bottom-up. Enterprise policies load first, then your personal preferences, then project-level, then subdirectory-level. More specific instructions override broader ones.
层级结构自下而上加载。企业策略最先加载，随后是您的个人偏好，接着是项目层级，最后是子目录层级。更具体的指令会覆盖更宽泛的指令。

What actually belongs in it:
其中实际应包含的内容：

The /init command generates a starter file based on your project structure. Here’s the counterintuitive part: delete most of what it generates. The default file includes obvious things (yes, Claude, this is a TypeScript project, I can see that from the package.json). Every line in CLAUDE.md competes for attention with the actual work. (If you’ve ever wondered why most AI agents fail in production, bad context management is half the answer.)
/init 命令会根据您的项目结构生成一个初始文件。这里有个反直觉的部分：删除它生成的大部分内容。默认文件包含了许多显而易见的信息（是的，Claude，这是一个 TypeScript 项目，我从 package.json 就能看出来）。CLAUDE.md 中的每一行都在与实际工作争夺注意力。（如果您曾好奇为什么大多数 AI 智能体在生产环境中失败，糟糕的上下文管理是其中一半的原因。）

Target: under 300 lines. Focus on what Claude would get wrong without the file.
目标：控制在 300 行以内。重点说明没有该文件时 Claude 会出错的地方。

A good CLAUDE.md has four sections:
一份优秀的 CLAUDE.md 包含四个部分：

Project context. One line. “Next.js e-commerce app with Stripe integration and Postgres.”
项目背景。一行说明。"使用 Stripe 集成和 Postgres 的 Next.js 电商应用。"
Code style preferences. Not “format code properly” but “use ES modules, prefer named exports, 2-space indentation.”
代码风格偏好。不是"正确格式化代码"，而是"使用 ES 模块，优先命名导出，2 空格缩进。"
Commands. Exact strings: pnpm test:integration, make build-docker, npm run lint:fix. Claude uses these verbatim.
命令。精确字符串： pnpm test:integration 、 make build-docker 、 npm run lint:fix 。Claude 会逐字使用这些字符串。
Architecture decisions. “API routes go in /src/api/[resource]/route.ts. We use the repository pattern for database access.”
架构决策。"API 路由放在 /src/api/[资源]/route.ts 中。我们使用仓储模式进行数据库访问。"
(Everything else? Move it to separate files and use @imports.)
（其他所有内容？将其移至单独的文件并使用 @imports。）

The @imports system:  @imports 系统：

CLAUDE.md supports importing other files with @path/to/file syntax:
CLAUDE.md 支持通过 @path/to/file 语法导入其他文件：

See @README.md for project overview
See @docs/api-patterns.md for API conventions
See @package.json for available npm scripts
Imports can be recursive (referenced files can reference other files, up to 5 levels deep). This solves the “one giant file” problem. Keep your CLAUDE.md lean, move detailed guidance into separate files.
导入功能支持递归（被引用的文件可以继续引用其他文件，最多支持 5 层嵌套）。这解决了"单个巨型文件"的问题。保持你的 CLAUDE.md 简洁精炼，将详细指引移至独立文件中。

For teams, this is powerful. The frontend team owns docs/frontend-rules.md. The security team owns docs/security.md. CLAUDE.md just imports them all.
对于团队协作而言，这一功能非常强大。前端团队负责维护 docs/frontend-rules.md 文件，安全团队负责维护 docs/security.md 文件，CLAUDE.md 只需导入所有这些文件即可。

The honest limitation: CLAUDE.md is Claude-only. If your team uses Cursor or Copilot alongside Claude Code, they won’t read this file. That’s where AGENTS.md comes in.
需要坦诚说明的局限性：CLAUDE.md 仅适用于 Claude。如果你的团队同时使用 Cursor 或 Copilot 以及 Claude Code，其他工具将无法读取该文件。这正是 AGENTS.md 的用武之地。

AGENTS.md: The Universal Standard
AGENTS.md：通用标准
AGENTS.md emerged in mid-2025 from a collaboration between Sourcegraph, OpenAI, Google, Cursor, and others. It’s now maintained by the Agentic AI Foundation under the Linux Foundation. The pitch is simple: one file, any agent.
AGENTS.md 于 2025 年中期由 Sourcegraph、OpenAI、Google、Cursor 等公司合作推出。目前由 Linux 基金会旗下的 Agentic AI 基金会维护。其理念很简单：一个文件，适用于任何智能体。

It’s supported by Claude Code, Cursor, GitHub Copilot, Gemini CLI, Windsurf, Aider, Zed, Warp, RooCode, and a growing list of others.
它已获得 Claude Code、Cursor、GitHub Copilot、Gemini CLI、Windsurf、Aider、Zed、Warp、RooCode 以及越来越多的其他工具的支持。

How it works:  运作原理：

Drop an AGENTS.md in your project root. It’s standard Markdown, no special schema, no YAML frontmatter required. The closest AGENTS.md to the file being edited takes precedence, and explicit user prompts override everything.
在项目根目录中放置一个 AGENTS.md 文件。它采用标准 Markdown 格式，无需特殊架构，也无需 YAML 前置元数据。距离被编辑文件最近的 AGENTS.md 文件具有优先权，而明确的用户提示将覆盖所有规则。

# AGENTS.md

## Project Overview
E-commerce platform built with Next.js 14, Postgres, and Stripe.

## Build & Test
- Install: `pnpm install`
- Dev: `pnpm dev`
- Test: `pnpm test`
- Lint: `pnpm lint:fix`

## Code Standards
- Use TypeScript strict mode
- Prefer named exports over default exports
- API routes follow REST conventions in /src/api/

## Testing Requirements
- All PRs must include tests
- Use vitest for unit tests, playwright for e2e
AGENTS.md vs CLAUDE.md vs README:
AGENTS.md、CLAUDE.md 与 README 的对比：


They’re complementary, not competing. README is for humans, AGENTS.md is the universal agent brief, CLAUDE.md adds Claude-specific instructions on top.
它们是互补关系，而非竞争关系。README 面向人类用户，AGENTS.md 是通用智能体指南，而 CLAUDE.md 则在基础上添加了专为 Claude 设计的指令。

My recommendation: If you use multiple AI tools, put your shared instructions in AGENTS.md and keep CLAUDE.md for Claude-specific features like @imports and the /init workflow. If you only use Claude Code, CLAUDE.md alone is fine.
我的建议是：如果您使用多种 AI 工具，请将共享指令放入 AGENTS.md 中，并将 CLAUDE.md 专门用于 Claude 特有的功能，例如@imports 和/init 工作流。如果您仅使用 Claude Code，单独使用 CLAUDE.md 即可。

The Other Memory Files (Quick Reference)
其他记忆文件（快速参考）
Not every tool has adopted AGENTS.md yet, and some have features that go beyond what AGENTS.md covers.
并非所有工具都已采用 AGENTS.md，部分工具的功能已超越 AGENTS.md 的覆盖范围。

.cursorrules / .cursor/rules/*.mdc: Cursor’s native format. The newer .mdc format supports YAML frontmatter with activation modes (Always, Auto Attached, Agent Requested, Manual). More granular than AGENTS.md, but Cursor-only. Cursor also reads AGENTS.md, so you can use both. Put shared rules in AGENTS.md, Cursor-specific behaviors in .cursor/rules/.
.cursorrules / .cursor/rules/*.mdc：Cursor 原生格式。较新的 .mdc 格式支持包含激活模式（始终启用、自动附加、代理请求、手动启用）的 YAML 前置元数据。比 AGENTS.md 更精细，但仅限 Cursor 使用。Cursor 同时支持读取 AGENTS.md 文件，因此可两者兼用。建议将通用规则置于 AGENTS.md，Cursor 专属行为配置则存放在.cursor/rules/目录。

.github/copilot-instructions.md: GitHub Copilot’s instruction file. Lives in the .github folder. Copilot also reads AGENTS.md now, so you may not need both.
.github/copilot-instructions.md：GitHub Copilot 的指令文件。存放于.github 文件夹中。当前 Copilot 也已支持读取 AGENTS.md 文件，因此可能无需同时维护两份文件。

.windsurfrules: Windsurf’s format. Dual structure with global_rules.md for workspace-wide instructions. Windsurf supports AGENTS.md too.
.windsurfrules：Windsurf 的格式规范。采用双重结构，其中 global_rules.md 用于工作区范围的指令。Windsurf 也支持 AGENTS.md。

CLAUDE.local.md: Your personal, project-specific preferences that don’t get committed to git. Auto-added to .gitignore. Use it for things like your sandbox URLs, preferred test data, or personal workflow quirks. (Your teammates don’t need to know you always test with the username “butts123”.)
CLAUDE.local.md：您个人针对特定项目的偏好设置，无需提交到 git。会自动添加到.gitignore 中。可用于存储沙盒 URL、偏好的测试数据或个人工作流习惯（您的同事无需知道您总是用"butts123"这个用户名进行测试）。

Claude’s Auto-Memory: The AI That Takes Its Own Notes
Claude 的自动记忆：会做笔记的人工智能
This is the newest addition and the most interesting one. Claude Code now has an auto-memory system where Claude writes notes to itself during your sessions.
这是最新加入且最有趣的功能。Claude Code 现在配备了自动记忆系统，Claude 会在会话过程中为自己撰写笔记。

It lives in ~/.claude/projects/<project>/memory/:
它位于 ~/.claude/projects/<project>/memory/ ：

memory/
├── MEMORY.md          # Index file, loaded every session
├── debugging.md       # Notes on debugging patterns
├── api-conventions.md # API design decisions
└── ...
The key difference from CLAUDE.md: you write CLAUDE.md, Claude writes MEMORY.md. You provide the instructions. Claude captures the learnings.
与 CLAUDE.md 的关键区别在于：你编写 CLAUDE.md，而 Claude 生成 MEMORY.md。你提供指令，Claude 负责记录学习成果。

Only the first 200 lines of MEMORY.md load automatically. Topic files (debugging.md, etc.) load on-demand when Claude needs them.
MEMORY.md 仅自动加载前 200 行。主题文件（如 debugging.md 等）会在 Claude 需要时按需加载。

The practical workflow:  实际工作流程如下：

When Claude discovers something about your project (“oh, this codebase uses a custom ORM wrapper”), it saves that to auto-memory. Next session, it already knows. No more repeating yourself.
当 Claude 发现关于你项目的某些信息时（"哦，这个代码库使用了自定义 ORM 封装器"），它会自动保存到记忆库中。下次会话时，它就已经知道了。无需再重复说明。

You can trigger this manually too. At the end of a productive session, ask Claude: “Update your memory files with what you learned about our codebase today.” The learnings persist.
你也可以手动触发这个功能。在富有成效的会话结束时，可以要求 Claude："请将你今天对我们代码库的了解更新到你的记忆文件中。"这些学习成果会持续保存。

To review or edit what Claude has saved, run /memory during any session.
要查看或编辑 Claude 已保存的内容，在任何会话中运行 /memory 命令。

The honest limitation: Auto-memory is still rolling out. If you don’t see it, set CLAUDE_CODE_DISABLE_AUTO_MEMORY=0 in your environment. And because Claude writes these notes, quality varies. Review them periodically, just like you'd review any documentation.
诚实的局限性：自动记忆功能仍在逐步推出中。如果你没有看到这个功能，请在环境中设置 CLAUDE_CODE_DISABLE_AUTO_MEMORY=0 。由于这些笔记是由 Claude 编写的，质量可能参差不齐。请定期检查这些笔记，就像你会审查任何文档一样。

The /init Then Delete Workflow
/init 然后删除工作流
This is the fastest way to bootstrap a memory file for any new project.
这是为任何新项目快速创建内存文件的最快方法。

Run /init in your project directory
在您的项目目录中运行 /init
Claude generates a starter CLAUDE.md based on your project structure and detected tech stack
Claude 会根据您的项目结构和检测到的技术栈生成一个初始的 CLAUDE.md 文件
Delete what you don’t need
删除不需要的内容
Step 3 is where most people go wrong. The generated file is a starting point, not a finished product. It often includes filler that doesn’t add value. (“This project uses JavaScript.” Thanks, Claude. I can see the package.json.)
第三步是大多数人出错的地方。生成的文件只是一个起点，而非成品。它通常包含没有价值的填充内容。（"这个项目使用 JavaScript。"谢谢，Claude。我能看到 package.json。）

The delete-first approach is faster than writing from scratch. You’re editing down from a reasonable draft instead of staring at a blank file.
先删除再修改的方法比从头开始编写更快。你是在一个合理的草稿基础上进行删减，而不是面对一个空白文件发呆。

After the initial setup, build your memory file organically. When Claude makes a wrong assumption (in my case, it kept importing from a deprecated internal package), don’t just correct it once. Tell Claude: “add to my CLAUDE.md: always import from @company/utils-v2, not @company/utils.” The instruction persists for future sessions.
完成初始设置后，逐步构建你的记忆文件。当 Claude 做出错误假设时（比如我的情况是它总是从一个已弃用的内部包导入），不要只纠正一次。告诉 Claude："在我的 CLAUDE.md 中添加：始终从@company/utils-v2 导入，而不是@company/utils。"这个指令会在未来的会话中持续生效。

Every few weeks, ask Claude to review and optimize your CLAUDE.md. Instructions accumulate, some become redundant, others conflict. A quick cleanup keeps things sharp.
每隔几周，请 Claude 审阅并优化你的 CLAUDE.md 文件。指令会不断累积，有些变得冗余，有些相互冲突。快速清理能让一切保持清晰。

What I Actually Use (My Setup)
我实际使用的配置（我的设置）
After experimenting with all of these on projects ranging from a document Q&A system to an internal agent that kept hallucinating company policy, here’s what I settled on:
在从文档问答系统到频繁虚构公司政策的内部智能体等多个项目中尝试了所有这些方法后，我最终确定了以下方案：

AGENTS.md in project root with shared instructions (build commands, code standards, testing requirements). This covers any AI tool my team uses.
在项目根目录中放置 AGENTS.md 文件，包含共享指令（构建命令、代码标准、测试要求）。这涵盖了我的团队使用的所有 AI 工具。

CLAUDE.md with @imports for Claude-specific behaviors. Stays lean, under 100 lines, mostly pointing to docs/ files.
CLAUDE.md 文件包含针对 Claude 特定行为的@imports 指令。保持简洁，控制在 100 行以内，主要指向 docs/目录下的文件。

CLAUDE.local.md for my personal quirks (my preferred test data, sandbox URLs, shortcut commands I use constantly).
CLAUDE.local.md 文件用于记录我的个人偏好（我常用的测试数据、沙盒 URL、频繁使用的快捷命令）。

Auto-memory enabled. I let Claude take its own notes and review them monthly.
已启用自动记忆功能。我让 Claude 自行记录笔记，并每月进行审阅。

Everything else (.cursorrules, copilot-instructions.md) I’ve replaced with symlinks to AGENTS.md. One source of truth.
其他所有文件（如.cursorrules、copilot-instructions.md）均已替换为指向 AGENTS.md 的符号链接。确保单一信息源。

# Symlink setup for multi-tool consistency
ln -sfn AGENTS.md .github/copilot-instructions.md
mkdir -p .cursor/rules && ln -sfn ../../AGENTS.md .cursor/rules/main.mdc
(Is this elegant? No. Does it prevent instruction drift across tools? Yes.)
（这优雅吗？不。它能防止不同工具间的指令漂移吗？能。）

Quick Decision Guide  快速决策指南

The Convergence is Happening
融合正在发生
Six months ago, you needed five different files for five different tools. Today, most tools read AGENTS.md. The fragmentation problem isn’t solved, but it’s getting better.
六个月前，你需要为五种不同的工具准备五个不同的文件。如今，大多数工具都能读取 AGENTS.md。碎片化问题尚未完全解决，但情况正在好转。

My bet: AGENTS.md becomes the standard the way README.md did. Not because it’s technically superior, but because the Linux Foundation backing and broad tool support create enough gravity to pull the ecosystem together. CLAUDE.md, .cursorrules, and the rest will stick around for tool-specific features, but the shared context will live in one place.
我的预测是：AGENTS.md 会成为标准，就像 README.md 那样。不是因为它在技术上更优越，而是因为 Linux 基金会的支持和广泛的工具支持产生了足够的引力，将整个生态系统凝聚在一起。CLAUDE.md、.cursorrules 和其他工具特定的配置文件会继续存在，但共享的上下文将集中在一个地方。

Until then, the symlink hack works fine. And honestly, having a memory file at all puts you ahead of most developers. I wrote an entire guide to building AI agents with LangGraph, and the number one issue people hit wasn’t the framework. It was Claude forgetting their project setup between sessions. The gap between “Claude, we use pnpm” every session and “Claude already knows” is the difference between a tool and a teammate.
在此之前，符号链接这个技巧完全够用。说实话，拥有一个记忆文件本身就已经让你领先于大多数开发者了。我写过一整篇关于用 LangGraph 构建 AI 智能体的指南，人们遇到的头号问题不是框架本身，而是 Claude 在不同会话之间忘记了他们的项目设置。每次会话都要说“Claude，我们用的是 pnpm”和“Claude 已经知道了”之间的差距，就是工具和队友之间的区别。