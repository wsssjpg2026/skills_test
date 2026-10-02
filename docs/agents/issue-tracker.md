# Issue tracker: GitHub

本仓库的 issue 与 spec 发布在 GitHub Issues：`wsssjpg2026/skills_test`。所有操作用 `gh` CLI。

> **注意**：本地工作目录不是该仓库的 clone，`gh` 无法从 git remote 推断仓库——
> 所有命令必须显式带 `-R wsssjpg2026/skills_test`。

## Conventions

- **创建 issue**：`gh issue create -R wsssjpg2026/skills_test --title "..." --body-file <file>`（长正文写进文件再引用，避免 heredoc 转义问题）
- **读 issue**：`gh issue view -R wsssjpg2026/skills_test <number> --comments`
- **列出 issue**：`gh issue list -R wsssjpg2026/skills_test --state open --json number,title,labels --jq '[.[] | {number, title, labels: [.labels[].name]}]'`（按需加 `--label`、`--state` 过滤）
- **评论**：`gh issue comment -R wsssjpg2026/skills_test <number> --body "..."`
- **打/去标签**：`gh issue edit -R wsssjpg2026/skills_test <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close -R wsssjpg2026/skills_test <number> --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: no.** （若将来要把外部 PR 当作功能请求纳入 triage 队列，把本开关改为 `yes`；`/triage` 读取此开关。）

开启后 PR 走与 issue 相同的标签和状态，用 `gh pr` 等价命令；GitHub 的 issue 与 PR 共享编号空间，裸 `#42` 需用 `gh pr view 42` 与 `gh issue view 42` 先分辨。

## When a skill says "publish to the issue tracker"

创建一个 GitHub issue（带 `-R wsssjpg2026/skills_test`）。

## When a skill says "fetch the relevant ticket"

运行 `gh issue view -R wsssjpg2026/skills_test <number> --comments`。

## Wayfinding operations

供 `/wayfinder` 使用。**map** 是单个 issue，子 ticket 为其 child issues。

- **Map**：单个标签为 `wayfinder:map` 的 issue，正文承载 Notes / Decisions-so-far / Fog。`gh issue create -R wsssjpg2026/skills_test --label wayfinder:map`
- **子 ticket**：作为 GitHub sub-issue 关联到 map（`gh api` sub-issues 端点）；不可用时加入 map 正文的 task list 并在子 ticket 正文顶部写 `Part of #<map>`。标签 `wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）。认领后 assign 给驱动的 dev。
- **阻塞关系**：优先用 GitHub 原生 issue dependencies：`gh api --method POST repos/wsssjpg2026/skills_test/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是 blocker 的数字 database id（`gh api repos/wsssjpg2026/skills_test/issues/<n> --jq .id`，不是 `#number` 也不是 `node_id`）。不可用时回退为子 ticket 正文顶部的 `Blocked by: #<n>, #<n>` 行。所有 blocker 关闭即解除阻塞。
- **Frontier 查询**：列出 map 的 open 子 ticket，去掉有 open blocker 或已有 assignee 的，按 map 顺序取第一个。
- **认领**：`gh issue edit -R wsssjpg2026/skills_test <n> --add-assignee @me`（会话的第一个写操作）。
- **解决**：`gh issue comment` 写答案 → `gh issue close` → 在 map 的 Decisions-so-far 追加上下文指针（gist + 链接）。
