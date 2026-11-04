https://medium.com/data-science-collective/youre-using-ai-to-write-code-you-re-not-using-it-to-review-code-728e5ec2576e

You’re Using AI to Write Code. You’re Not Using It to Review Code.
你正在用 AI 写代码，却没有用它来审查代码。
7 prompts for the security, architecture, and documentation work you keep skipping
你总是跳过的安全、架构和文档工作的 7 个提示
Paolo Perrone
Paolo Perrone

Follow
9 min read
·
Jan 14, 2026
1,153


25





Last month I shipped a feature that passed code review, passed tests, and broke production within 4 hours.
上个月，我发布了一个功能，它通过了代码审查，通过了测试，却在四小时内就导致了生产环境崩溃。

The bug? A SQL injection vulnerability in code I’d written six months ago. Code that had been reviewed twice. Code that AI helped me write faster.
问题出在哪里？是我六个月前写的一段代码中存在 SQL 注入漏洞。这段代码曾被审查过两次，而且是在 AI 的帮助下更快地完成的。

That’s when I realized: I’d been using AI to write code faster while ignoring the work that actually prevents disasters. Security audits, architecture reviews, documentation updates. All the stuff that keeps getting pushed to “later.”
那一刻我意识到：我一直在用 AI 来加速代码编写，却忽视了真正能预防灾难的工作——安全审计、架构审查、文档更新。所有这些事情总是被推到“以后再说”。

AI coding tools have gotten good enough that the “write code faster” problem is basically solved. Copilot, Claude, ChatGPT–pick your tool, paste your prompt, get working code. Most developers have this part figured out.
AI 编程工具已经足够成熟，基本解决了"快速编写代码"的问题。无论是 Copilot、Claude 还是 ChatGPT——任选一款工具，粘贴你的提示词，就能获得可运行的代码。大多数开发者都已掌握这部分技能。

What they haven’t figured out is what to do next.
他们尚未解决的，是接下来该做什么。

Writing code quickly doesn’t help when your architecture is a mess, your auth code hasn’t been security reviewed in months, and your documentation is six sprints out of date. That’s where teams actually lose time–on the work that keeps getting pushed to “later.”
当你的架构一团糟、认证代码数月未经安全审查、文档落后六个迭代周期时，快速编写代码毫无助益。团队真正浪费时间的地方，恰恰是那些被不断推延到"以后"处理的工作。

I wrote about the speed techniques in Part 1. This piece is about using AI for security audits, architecture decisions, and documentation — the work that matters but never feels urgent enough to actually do.
我在第一部分中探讨了提速技巧。本文则将聚焦如何运用 AI 进行安全审计、架构决策和文档维护——这些工作至关重要，却总因不够紧迫而被搁置。


Seven prompts across three tiers — daily habits at the bottom, big wins at the top.
Level 1: Session Starters (Use These Every Day)
第一级：会话启动器（每日使用）
These three techniques pay off immediately. Context for every session. Docs while the code is fresh. Reviews before your teammates see it.
这三种技巧能立即见效。为每次会话提供上下文。在代码记忆犹新时编写文档。在队友查看前进行审查。

Technique #1: The Context Dump
技巧一：上下文转储
Time Saved: 30–60 minutes per session
每次会话节省时间：30-60 分钟

Every AI conversation starts with amnesia. You re-explain your stack. Re-describe your patterns. Get generic answers that ignore your constraints.
每次与 AI 对话都始于失忆状态。你需要重新解释技术栈，再次描述开发模式，得到的却是忽视你具体限制的通用答案。

The Context Dump fixes this in 60 seconds.
上下文转储功能能在 60 秒内解决这个问题。

How it works:  运作原理：
Here's my project context:

Project: [Name] - [One-line description]

Stack: [Frontend] + [Backend] + [Database]

Current focus: [What you're building this session]
Key files:
- [path/to/main/file] - [what it does]
- [path/to/config] - [relevant settings]

Conventions:
- [Naming patterns]
- [Error handling approach]
- [Testing strategy]

Known constraints:
- [Performance requirements]
- [Security considerations]
- [Technical debt to work around]

I'm about to [specific task]. Keep this context for our session.
Why it works:  为何有效：
Every answer becomes tailored to YOUR project. The AI knows your stack, your patterns, your constraints. It becomes a teammate who’s been on the project for months instead of a stranger you just met.
每个回答都针对你的项目量身定制。AI 了解你的技术栈、开发模式和约束条件。它就像一位已在项目中工作数月的队友，而非刚刚结识的陌生人。

Pro Tips:  专业提示：
Save your Context Dump as a markdown file. Paste it at the start of each session.
将上下文摘要保存为 Markdown 文件。在每次会话开始时粘贴使用。
Update it weekly as your project evolves.
随着项目进展，每周更新上下文摘要。
The “Known constraints” section prevents AI from suggesting solutions that won’t work in your environment.
"已知限制"部分可防止 AI 提出在您环境中无法实施的解决方案。
For long sessions, remind AI of key context mid-conversation: “Remember, we’re using PostgreSQL, not MySQL.”
对于长时间会话，可在对话中途提醒 AI 关键上下文："请记住，我们使用的是 PostgreSQL 而非 MySQL。"
Technique #2: The Documentation Generator
技巧二：文档生成器
Time Saved: 2–4 hours per module
节省时间：每个模块可节省 2-4 小时

Documentation is always “next sprint” until a new hire spends three days figuring out what your auth module does. AI can generate docs that actually help — not the boilerplate kind that restates function names, but the kind that saves that new hire three days.
文档编写总是被安排到"下一个冲刺"，直到新员工花了三天时间才弄明白你的认证模块是做什么的。人工智能可以生成真正有用的文档——不是那种重复函数名称的模板化内容，而是能为新员工节省三天时间的那种。

How it works:  运作原理：
Generate documentation for this code:

[Paste your code]

Include:
1. Overview: What this module does and why it exists
2. Quick Start: How to use it in 3 steps or less
3. API Reference: Every public function with params, returns, and examples
4. Common Patterns: The 3 most common use cases with code
5. Gotchas: Edge cases, limitations, and things that will bite you
6. Related: What other modules this works with

Write for a developer who's new to this codebase but not new to coding.
Why it works:  为何有效：
The “Gotchas” section is the key. AI identifies edge cases and limitations you’ve internalized but never documented. It finds the things that would take a new developer three frustrated hours to discover on their own.
"注意事项"部分是关键。人工智能能识别出那些你已内化但从未记录的特殊情况和限制。它能发现那些会让新开发人员独自摸索三个小时才能发现的棘手问题。

Pro Tips:  专业提示：
Generate docs immediately after writing code, while your intent is still fresh
在编写代码后立即生成文档，趁你的意图还清晰时
Ask for “examples that would make sense to a junior developer”
要求提供“对初级开发人员有意义的示例”
Include the “Related” section to help devs navigate your codebase
包含“相关”部分，以帮助开发者浏览你的代码库
Review and edit the output. AI gets structure right, but you know the nuances.
审查并编辑输出内容。人工智能能把握结构，但您更了解其中的细微差别。
Technique #3: The Code Review Partner
技巧三：代码审查伙伴
Time Saved: 1–2 hours per PR
节省时间：每个拉取请求可节省 1-2 小时

Code reviews are valuable but slow. AI can do the first pass, catching issues before your human reviewers even look at it.
代码审查很有价值但过程缓慢。人工智能可以进行初步审查，在人工审查员查看之前发现问题。

How it works:  工作原理：
Review this code as a senior developer:

[Paste your code or diff]

Check for:
1. Bugs: Logic errors, off-by-one, null handling, race conditions
2. Security: Injection risks, auth issues, data exposure
3. Performance: N+1 queries, unnecessary loops, memory leaks
4. Maintainability: Naming, complexity, duplication
5. Edge cases: What inputs would break this?

For each issue:
- Severity: Critical / High / Medium / Low
- Line number or section
- What's wrong
- How to fix it

Be harsh. I'd rather fix issues now than in production. 
Why it works:  为何有效：
Without “Be harsh,” AI gives you the diplomatic review. You want the brutal one. The review that catches what you missed after staring at the code for three hours.
如果没有“严厉一点”的指令，AI 只会给出温和的审查。而你需要的是不留情面的版本——那种能揪出你盯着代码三小时都没发现的漏洞的审查。

Pro Tips:  专业建议：
Run this BEFORE pushing for human review. Don’t waste reviewers’ time on obvious issues
在提交人工审核前运行此检查。不要将审核者的时间浪费在明显问题上
Include your project’s conventions: “We use early returns, not nested ifs.”
包含你项目的约定规范："我们使用提前返回，而非嵌套 if 语句"
Ask for security review separately if the code handles auth or user data
如果代码涉及身份验证或用户数据处理，请单独申请安全审查
Use the severity ratings to prioritize fixes
利用严重性评级来确定修复优先级
Run this before every PR. Your human reviewers will notice.
在每次提交 PR 前运行此检查，你的代码审查员会注意到差异。

Level 2: Catch Problems Early (2–5 hours saved weekly)
第二级：及早发现问题（每周节省 2-5 小时）
Security review? “Next sprint.” Architecture check? “After launch.” Performance audit? “When it becomes a problem.”
安全审查？"下个冲刺周期再说。"架构检查？"等上线后再看。"性能审计？"等出问题再处理。"

These prompts turn “later” into “before lunch.” Run them weekly and you’ll stop firefighting.
这些提示词能将"以后再说"变成"午饭前搞定"。每周运行它们，你就能告别救火式工作模式。

Technique #4: The Architecture Advisor
技巧四：架构顾问
Time Saved: 2–6 hours of design decisions
节省时间：2-6 小时的设计决策时间

Before you write code, run your architecture by AI. It won’t make the decision for you, but it’ll surface tradeoffs you hadn’t considered.
在编写代码前，先让 AI 审视你的架构。它不会替你做出决定，但会揭示你未曾考虑过的权衡取舍。

How it works:  运作原理：
I'm designing [feature/system]. Help me evaluate my approach.

Context:
- Scale: [Expected users/requests/data volume]
- Team: [Size and experience level]
- Timeline: [Deadline or runway]
- Existing stack: [What we already use]

My current plan:
[Describe your approach]

Evaluate:
1. What are the top 3 risks with this approach?
2. What would break first at 10x scale?
3. What's the simplest version I could ship first?
4. What alternatives should I consider?
5. What would you do differently if you had [more time / less time]?

Be specific. I want tradeoffs, not best practices.
Why it works:  为什么有效：
“I want tradeoffs, not best practices” is the line that matters. Without it, you get generic architecture advice. With it, AI analyzes YOUR specific constraints and surfaces what actually matters for your situation.
“我需要权衡利弊，而非最佳实践”是关键所在。没有这句话，你只会得到泛泛的架构建议。有了它，人工智能会分析你的具体限制条件，并揭示出对你实际情况真正重要的因素。

“What would break first at 10x scale?” forces thinking about your specific system, not theoretical patterns.
“在规模扩大十倍时，什么会最先崩溃？”这个问题迫使你思考自己的具体系统，而非理论模式。

“What’s the simplest version?” prevents overengineering.
“最简单的版本是什么？”这个问题可以防止过度设计。

Pro Tips:  专业提示：
Do this BEFORE writing code — not after you’ve committed to an approach
在编写代码之前进行此操作——而不是在你已经确定方案之后
Include your timeline constraint — it changes everything
包含你的时间线限制——这会改变一切
Ask follow-up questions about specific tradeoffs
针对具体权衡提出后续问题
Use this for database schema design, API contracts, and system boundaries
适用于数据库模式设计、API 合约及系统边界定义
Technique #5: The Security Auditor
技巧五：安全审计员
Time Saved: 3–5 hours of security review
节省时间：3 至 5 小时的安全审查

When was your last real security review? Not the checkbox compliance stuff — an actual look at your auth code for injection risks and privilege escalation. For most teams, the honest answer is “never” or “we should do that.” AI won’t replace a proper pentest, but it catches the OWASP Top 10 vulnerabilities — the ones behind 90% of breaches — in the time it takes to grab coffee.
你上一次进行真正的安全审查是什么时候？不是那种打勾应付合规的表面功夫——而是真正审视你的认证代码，查找注入风险和权限提升漏洞。对于大多数团队来说，诚实的回答是“从未”或“我们该做但还没做”。AI 虽无法替代专业的渗透测试，但它能在你喝杯咖啡的时间里，揪出 OWASP 十大安全漏洞——这些漏洞导致了 90%的数据泄露事件。

How it works:  工作原理：
Security audit this code:
[Paste code that handles auth, user input, or sensitive data]

Check for:
1. Injection: SQL, NoSQL, command, LDAP
2. Auth/AuthZ: Session handling, privilege escalation, token issues
3. Data exposure: Logging secrets, error messages, API responses
4. Input validation: Missing sanitization, type coercion, length limits
5. Cryptography: Weak algorithms, hardcoded secrets, improper key handling

For each finding:
- Severity: Critical / High / Medium / Low
- Attack scenario: How would someone exploit this?
- Fix: Specific code change needed
- Reference: Relevant OWASP/CWE if applicable

Assume an attacker with knowledge of our stack.
Why it works:  为何有效：
“Assume an attacker with knowledge of our stack” shifts AI from theoretical risks to practical exploits. The “Attack scenario” forces it to think like a hacker.
“假设攻击者了解我们的技术栈”这一指令将 AI 的关注点从理论风险转向实际攻击手段。“攻击场景”部分则迫使 AI 像黑客一样思考。

Pro Tips:  专业建议：
Run this on auth code, payment handling, and anything touching user data
在身份验证代码、支付处理以及任何涉及用户数据的部分运行此检查
Don’t skip “Logging secrets” — it’s the most common issue I see
不要跳过“日志记录中的敏感信息”——这是我遇到的最常见问题
Ask for both the vulnerability AND the fix
同时要求提供漏洞描述和修复方案
This doesn’t replace penetration testing — it catches the obvious stuff
这不能替代渗透测试——它只能发现明显的问题
Technique #6: The Performance Profiler
技巧 #6：性能分析器
Time Saved: 2–4 hours of optimization
节省时间：2-4 小时的优化

Last month I had an endpoint taking 3 seconds to load. I assumed it was the database. Ran this prompt and AI pointed to a list comprehension two files away — a helper function calling a property getter 400 times per request. Each getter hit the database.
上个月，我有一个端点需要 3 秒才能加载。我以为是数据库的问题。运行这个提示后，AI 指向了两个文件之外的一个列表推导式——一个辅助函数在每个请求中调用属性获取器 400 次。每个获取器都会访问数据库。

I’d been staring at the wrong file. AI read everything with fresh eyes.
我一直在盯着错误的文件。AI 以全新的视角审视了所有内容。

How it works:  工作原理：
Analyze this code for performance issues:
[Paste code]

Context:
- This runs [how often: per request / batch job / etc.]
- Data size: [typical input size]
- Current pain point: [what feels slow]

Find:
1. Time complexity issues (O(n²) operations, unnecessary loops)
2. Database problems (N+1 queries, missing indexes, over-fetching)
3. Memory issues (large allocations, leaks, caching opportunities)
4. I/O bottlenecks (blocking calls, sequential when could be parallel)
5. Quick wins (simple changes with big impact)

For each issue:
- Impact: High / Medium / Low
- Current behavior
- Suggested fix with code
- Expected improvement

Focus on the 20% of changes that give 80% of the gains.
Why it works:  为何有效：
“Focus on the 20% of changes that give 80% of the gains” prevents AI from giving you a 50-item optimization list. You want the high-impact fixes first.
“聚焦带来 80%收益的 20%关键改动”能避免 AI 生成包含 50 项优化的冗长清单。您需要优先处理那些高影响力的修复方案。

Pro Tips:  专业建议：
Include your “current pain point” — it helps AI prioritize what matters to you
包含你的“当前痛点”——这有助于 AI 优先处理对你重要的事项
Always ask about caching opportunities. Often the biggest win.
始终询问缓存优化机会。这通常是最大的性能提升点。
For database code, ask specifically about indexes.
对于数据库代码，务必专门询问索引优化。
Validate suggestions with actual profiling before shipping. AI identifies candidates; you confirm they matter.
在部署前通过实际性能分析验证建议。AI 识别潜在优化项，由你确认其实际价值。
Level 3: The Big Wins (4–8 hours saved per use)
第三级：重大胜利（每次使用节省 4-8 小时）
New codebase. Major migration. The kind of work that usually means a week of context-gathering before you write a single line.
新代码库。重大迁移。这类工作通常意味着在编写一行代码之前需要花费一周时间收集背景信息。

You won’t need these often. But when you do, they compress days into hours.
你不会经常需要这些。但当你需要时，它们能将数天的工作压缩到数小时内完成。

Technique #7: The Migration Assistant
技巧七：迁移助手
Time Saved: 4–8 hours per migration
每次迁移节省时间：4-8 小时

Migrations are tedious. Upgrading frameworks, moving databases, changing APIs. AI can handle the mechanical parts while you focus on the tricky edge cases.
迁移工作繁琐乏味。升级框架、迁移数据库、更改 API。AI 可以处理机械重复的部分，让你专注于棘手的边缘情况。

Last migration this saved me: 6 hours on a Rails 6→7 upgrade.
上次迁移为我节省：Rails 6→7 升级中节省 6 小时

How it works:  运作原理：
Help me migrate from [Old] to [New].

Current setup:
[Describe what you have, paste sample code]

Target:
[Describe where you want to be]

Constraints:
- Must maintain backwards compatibility for [duration]
- Cannot have downtime longer than [limit]
- Must preserve [specific data/behavior]

Generate:
1. Migration checklist (ordered steps)
2. Code transformations for common patterns
3. Breaking changes to watch for
4. Rollback plan
5. Validation tests to confirm migration worked

Start with the riskiest parts first.
Why it works:  为什么有效：
“Start with the riskiest parts first” is key. AI will identify what’s most likely to break, so you tackle it early when you have time to fix issues.
“从风险最高的部分开始”是关键。AI 会识别最可能出问题的部分，这样你就能在还有时间修复问题时尽早处理。

Pro Tips:  专业提示：
Include sample code from your actual codebase
包含你实际代码库中的示例代码
Ask for the rollback plan upfront. You’ll need it
提前索要回滚计划。你会需要它的
Run validation tests before AND after migration
在迁移前后都要运行验证测试
For database migrations, always ask about data integrity checks
对于数据库迁移，务必询问数据完整性检查
Bonus: The Full Codebase Analysis
额外提示：完整的代码库分析
Time Saved: 1–2 days for new codebases
节省时间：新代码库可节省 1-2 天

Joining a new project? Inheriting legacy code? AI can give you a codebase tour in minutes instead of days wandering through folders.
刚加入新项目？接手遗留代码？AI 能在几分钟内带你游览代码库，无需耗费数日翻阅文件夹。

How it works:  工作原理：
Analyze this codebase structure:

[Paste your directory tree or file list]

Tell me:
1. Architecture: What pattern is this? (MVC, microservices, monolith, etc.)
2. Entry points: Where does execution start?
3. Core modules: What are the 5 most important files/folders?
4. Data flow: How does data move through the system?
5. Dependencies: What external services/APIs does this rely on?
6. Red flags: What looks concerning from a maintenance perspective?
7. Where to start: If I need to [specific task], which files should I look at first?

Explain like I'm a senior dev who's never seen this codebase.
Then paste key files and ask:
随后粘贴关键文件并询问：

Now explain [specific file] in detail:
- What does it do?
- What depends on it?
- What does it depend on?
- What are the gotchas?
Why it works:  为什么有效：
“Where to start” is the money question. Instead of wandering through folders, you know exactly which files to read for your specific task.
“从哪里开始”是关键问题。与其在文件夹中漫无目的地寻找，您能确切知道针对特定任务需要阅读哪些文件。

Pro Tips:  专业建议：
Start with the directory structure, then drill into specific files
先从目录结构入手，再深入查看具体文件
Ask about the “Red flags” — AI spots patterns humans miss after staring at code for years
询问"危险信号"——AI 能发现人类多年审视代码后仍会遗漏的模式
Use this when onboarding to a new team or inheriting legacy code
适用于加入新团队或接手遗留代码时
Combine with The Documentation Generator to create onboarding docs for future devs
结合文档生成器为未来开发者创建入职文档
The Real Win  真正的制胜法宝
The techniques in Part 1 were about getting faster at what you already do. These are about expanding what you’re willing to take on.
第一部分的技术旨在让你在现有工作上提速。而接下来的内容，则是关于拓展你愿意承担的任务范围。

That security audit you’ve been putting off for three sprints? You could run it tomorrow morning before standup. That legacy codebase nobody wants to touch? You could have a working map of it by lunch.
那个你已经拖延了三个冲刺周期的安全审计？你可以在明天站会前完成它。那个没人愿意碰的遗留代码库？午餐前你就能绘制出一份可用的结构图。

The barrier was never skill. It was the sheer tedium of doing it manually. Remove the tedium and you start doing work that compounds — cleaner architecture, fewer vulnerabilities, documentation that actually helps the next person.
障碍从来不是技能，而是手动操作的极度乏味。消除这种乏味，你就能开始从事那些能产生复合效应的工作——更清晰的架构、更少的漏洞、真正能帮助后来者的文档。

If any of these surface something nasty in your codebase, I’d like to hear about it.
如果这些方法在你的代码库中发现了任何棘手问题，我很乐意听听具体情况。

Part 3 is in the works: debugging, test generation, and techniques for production systems where mistakes cost money. Let me know in the comments if that’s something you’d find useful — it helps me know what to prioritize.
第三部分正在制作中：调试、测试生成以及针对生产系统的技术，这些系统中的错误会带来经济损失。请在评论区告诉我这是否对你有用——这有助于我确定优先事项。