# 开发规则

## 对话风格

- 回答应简短、精炼
- Commit、Issue、PR 评论和代码中不得使用 Emoji
- 不使用空洞或刻意热情的填充语（例如使用 “Thanks @user”，而不是 “Thanks so much @user!”）
- 只使用技术性表述，直接说明
- 用户提出问题时，先回答问题，再编辑文件或运行实现命令
- 回应用户反馈或分析时，先明确说明同意或不同意，再说明所做的更改

## 候选能力与测试说明

- 每次准备安装、添加、启用或测试一个 Package、Extension、Skill、Prompt、MCP、工具或其他候选能力前，必须先向用户说明该候选的作用
- 说明至少包括：解决的问题、为何现在测试、预期收益、将修改的文件或正式 Pi 状态、允许的网络与凭据范围、主要风险、验收标准和回退方式
- 未经用户明确确认，不得开始安装、启用、真实调用、正式状态修改或其他会产生副作用的测试
- 即使测试本身只读，也应先说明测试目标、输入、输出和不能证明的结论，再请求用户确认
- 一次确认只覆盖已经说明的候选、版本、资源和测试范围；扩大到真实服务、更多资源、长期保留或组合测试时必须重新说明并确认

### 以真实用途为中心的纵向测试

- 候选能力应围绕用户真正要完成的任务设计端到端测试，覆盖安装或接入、必要配置、真实调用、结果验证、失败路径、资源回收和回退；不得把“能够安装”“能够加载”或“能够列出工具”单独当作能力已经通过
- 同一用途链上的必要组件应作为一条纵向链路验证。例如 MCP 应验证 `Adapter → MCP Server → Tool 调用 → 结果与来源 → 进程回收`，不能只测试 Adapter 安装后就结束
- Skill、Prompt、Extension、Agent、工具和外部服务同样适用：必须验证它们如何改善具体任务结果，而不仅是资源发现或启动成功
- 单组件测试只用于安全准入、兼容性探针、故障定位或确认责任边界。单组件通过只代表前置门通过；只要最终用途需要其他组件，就必须继续完成纵向链路后才能评价采用价值
- 纵向测试仍应保持单一目标和清晰因果边界。不得借“完整链路”之名捆绑与目标无关的候选、扩大凭据或网络权限，或让多个变量同时变化到无法判断结果来源
- 测试记录必须分别说明组件级证据、端到端证据、真实收益、失败和残留，并明确哪些结论仍未得到证明

## 代码质量

- 进行大范围更改前、编辑尚未完整检查的文件前，以及用户要求调查或审计时，必须完整读取文件。大范围更改不得依赖搜索片段
- 除非绝对必要，否则不得使用 `any`
- 只有一个调用位置的单行 Helper 应直接内联
- 外部 API 类型应检查 node_modules，不得猜测
- **禁止行内 Import**（`await import()`、`import("pkg").Type`、动态类型 Import），只能使用顶层 Import
- 不得为了修复过时依赖导致的类型错误而删除或降级代码；应升级依赖
- 根配置检查的代码（`packages/*/src`、`packages/*/test`、`packages/coding-agent/examples`）只能使用可擦除 TypeScript 语法（Node strip-only 模式）：不得使用参数属性、`enum`、`namespace`/`module`、`import =`、`export =` 或其他需要生成 JavaScript 的语法。应使用显式字段并在 Constructor 中赋值
- 删除看起来有意保留的功能或代码前，必须先询问
- 除非用户要求，否则不要保留向后兼容性
- 禁止硬编码按键检查（例如 `matchesKey(keyData, "ctrl+x")`）。应将默认值添加到 `DEFAULT_EDITOR_KEYBINDINGS` 或 `DEFAULT_APP_KEYBINDINGS`，以保持可配置
- 禁止直接修改 `packages/ai/src/models.generated.ts`；应更新 `packages/ai/scripts/generate-models.ts` 后重新生成。即使重新生成带来与当前任务无关的上游 Model 元数据更改，也可以包含生成后的 `models.generated.ts` Diff

## 命令

- 修改代码后（不包括仅修改文档），运行 `npm run check`（保留完整输出，不使用 tail）。提交前修复所有 Error、Warning 和 Info。该命令不运行测试
- 除非用户要求，否则禁止运行 `npm run build` 或 `npm test`
- 禁止直接运行完整 Vitest Suite：当存在 Endpoint/Auth 环境变量时，其中的 E2E 测试会被激活。运行全部非 E2E 测试时，应从仓库根目录执行 `./test.sh`。否则从 Package 根目录运行指定测试：`node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`
- 创建或修改测试文件后，必须运行该测试，并迭代测试或实现直至通过
- 对于 `packages/coding-agent/test/suite/`，使用 `test/suite/harness.ts` 和 Faux Provider。不得使用真实 Provider API、Key 或付费 Token
- Issue 专属回归测试放在 `packages/coding-agent/test/suite/regressions/` 下，命名为 `<issue-number>-<short-slug>.test.ts`
- 临时脚本应使用 `write` 写入临时文件（例如 `/tmp`），运行后按需编辑，完成时删除。不得在 `bash` 命令中嵌入多行脚本
- 通常只有用户要求时才提交；但“修改前远端 Checkpoint”规则是本项目的明确例外，不需要用户为每次 Checkpoint 重复下达提交或 Push 指令

## 依赖与安装安全

- 将 npm 依赖和 Lockfile 更改视为需要审查的代码。直接外部依赖必须固定到精确版本
- 本地补充或更新依赖使用 `npm install --ignore-scripts`；干净安装或 CI 风格安装使用 `npm ci --ignore-scripts`。除非用户要求，否则不得运行 Lifecycle Script
- 依赖元数据发生变化时，使用 `npm install --package-lock-only --ignore-scripts` 刷新 `package-lock.json`
- 如果需要重新生成 `packages/coding-agent/npm-shrinkwrap.json`，运行 `node scripts/generate-coding-agent-shrinkwrap.mjs`（使用 `--check` 或 `npm run check` 验证）。带 Lifecycle Script 的新依赖必须经过审查，并在该脚本中加入显式 Allowlist；不得静默添加
- 除非设置 `PI_ALLOW_LOCKFILE_CHANGE=1`，否则 Pre-commit 会阻止提交 Lockfile。只有用户希望提交 Lockfile 更改时才能绕过

## Git

同一个 cwd 中可能同时运行多个 Pi Session，并分别修改不同文件。任何触及自身更改范围以外的未暂存、已暂存或未跟踪文件的 Git 操作，都可能覆盖其他 Session 的工作。请遵守以下规则：

### 修改前远端 Checkpoint

本节是本项目对通用 Git Skill 以及“除非用户要求，否则禁止提交”规则的项目级覆盖。用户已经明确授权：为了在每次修改前建立可回退基线，可以并且必须执行必要的 Commit 与 Push，无需再次询问是否提交。

任何文件修改、代码修改、依赖或配置修改、正式 Pi 安装状态修改之前，必须：

1. 运行 `git status -sb`，确认当前分支、暂存区、未暂存修改和未跟踪文件。
2. 运行 `git fetch origin`，刷新个人远端状态；不得用 `upstream` 代替个人 Checkpoint 远端。
3. 确认当前工作区干净，并且当前分支 `HEAD` 与对应的 `origin/<branch>` 完全一致。
4. 如果当前分支尚无对应远端分支，先将当前干净基线推送到 `origin` 并建立跟踪关系。
5. 如果存在属于已完成且已获用户确认工作的本地 Commit 或未提交修改，先按明确路径审查、验证、创建有意义的 Checkpoint Commit，并推送到 `origin`，直到本地与远端一致。
6. 如果修改来源或所有权不明确、包含其他 Session 的进行中工作、验证失败，或远端已经分叉，不得擅自打包提交、覆盖、Rebase 或 Force Push；应停止并向用户说明。
7. 对正式 Pi 状态进行安装、启用、卸载或测试前，除 Git Checkpoint 外还要记录相关设置、信任、Package、认证哈希、进程、端口和持久状态，以便执行状态级回退。

完成一个边界清晰且验证通过的修改后，默认将该修改按明确路径提交并推送到当前分支的 `origin`，使下一次修改仍从本地与远端一致的基线开始。用户明确要求暂不提交或暂不推送时，以该次指令为准；在重新同步前不得开始下一项修改。

Checkpoint 只推送到个人远端 `origin`。不得因此向官方 `upstream` 推送、创建官方 PR、改写远端历史或扩大其他远端权限。

提交：

- 只能提交本 Session 中由你修改的文件
- 使用明确路径暂存（`git add <path1> <path2>`）；禁止使用 `git add -A` 或 `git add .`
- 提交前运行 `git status`，确认只暂存了自己的文件
- `packages/ai/src/models.generated.ts` 始终可以与自己的文件一同包含
- Commit Message 格式：`{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message>`（可以有多行）。信息应明确、简洁

禁止运行（会破坏其他 Agent 的工作或绕过检查）：

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

如果 Rebase 发生冲突：

- 只解决自己修改过的文件中的冲突
- 如果冲突出现在自己未修改的文件中，中止操作并询问用户
- 禁止 Force Push

### 个人 Fork 与官方同步

本仓库采用“官方仓库只拉取、个人仓库只推送”的双远端模式：

- `upstream` 指向官方仓库 `git@github.com:earendil-works/pi.git`，只用于获取官方更新。其 push URL 已设置为 `DISABLED`，未经用户明确要求不得恢复或向官方仓库推送。
- `origin` 指向个人仓库 `git@github.com:C-Q-D/pi.git`，所有个人分支和改造只推送到该远端。
- `main` 作为官方同步分支，不添加个人改造提交，必须能够以 fast-forward 方式同步 `upstream/main`。
- `custom/main` 作为个人改造集成分支。功能开发应从 `custom/main` 创建独立分支，完成后再合入 `custom/main`。

同步官方代码前，先运行 `git status -sb`，确认当前修改和未跟踪文件。不得为同步而使用 `git stash`、`git reset --hard`、`git clean` 或覆盖其他会话的改动。如果工作区状态可能影响分支切换或合并，应停止并询问用户。

标准同步流程：

```bash
git fetch upstream

git switch main
git merge --ff-only upstream/main
git push origin main

git switch custom/main
git merge main
git push origin custom/main
```

同步规则：

- `main` 无法 fast-forward 时，不得强行合并、rebase、重置或 force push；应先检查是否混入了个人提交并向用户说明。
- 已推送的 `custom/main` 默认通过 merge 吸收 `main`，避免改写个人仓库的共享历史。
- 冲突只在 `custom/main` 或其功能分支中解决，不得通过修改官方同步分支来规避冲突。
- 未经用户明确要求，不创建面向官方仓库的 PR，不推送官方远端，也不删除个人或官方分支。
- 同步完成后，核对 `main`、`custom/main`、`origin` 和 `upstream` 的提交关系，并报告未纳入同步的本地文件。

### 构建并安装本地个人版 Pi

Windows 本机使用 [`scripts/install-local-pi.ps1`](scripts/install-local-pi.ps1) 从当前工作树构建个人版 Pi。脚本会：

1. 使用 `npm install --ignore-scripts` 准备依赖。
2. 校验离线模型数据；缺失时优先从同版本官方 GitHub 发布归档恢复并校验 SHA256，无法恢复时才调用在线模型生成。
3. 运行 `npm run check` 和 `npm run build:offline`。
4. 把 `pi-ai`、`pi-tui`、`pi-agent-core`、SQLite storage 和 `pi-coding-agent` 一起打成 tarball。
5. 创建带版本、源码提交和脏工作树时间戳的隔离发布目录。
6. 通过 `npm link --ignore-scripts` 将全局 `pi` 切换到新发布目录。
7. 在仓库外验证 `pi --version`、`pi --help` 和 `pi --list-models`。

标准安装命令：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-local-pi.ps1
```

需要额外运行完整非 E2E 测试时：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-local-pi.ps1 -RunTests
```

Windows 下官方 `test.sh` 可能受凭据隔离、路径 glob 和终端编码差异影响。未启用 `-RunTests` 不替代针对所改功能应执行的具体测试。

脚本默认把发布保存到全局 npm prefix 同级的 `pi-custom-releases`，不会删除旧版本。回退时指定旧发布目录：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-local-pi.ps1 -ActivateRelease "E:\nodejs\pi-custom-releases\<旧发布目录>"
```

个人版安装后不得运行 `pi update --self`、`pi update --all` 或针对 Pi 的全局 npm 更新；这些命令可能把全局链接替换成官方发行版。同步官方源码后，应重新运行本脚本生成并激活新的个人版。

## Issue 与 PR

贡献者准入规则（自动关闭工作流、`lgtm`/`lgtmi`、质量标准）请参阅 `CONTRIBUTING.md`。

审查 PR 时：

- 除非用户明确要求，否则不要运行 `gh pr checkout`、`git switch`，也不要以其他方式将 Worktree 移动到 PR 分支
- 使用 `gh pr view`、`gh pr diff`、`gh api`，以及针对已获取 Ref 的本地 `git show`/`git diff`，在不切换分支的情况下检查 PR 元数据、Commit 和 Patch
- 如果需要 PR 文件内容，将其获取或读取到临时文件，或使用 `git show <ref>:<path>`，不要切换分支

创建 Issue 时：

- 为受影响的 Package 添加 `pkg:*` Label（`pkg:agent`、`pkg:ai`、`pkg:coding-agent`、`pkg:tui`）；添加所有适用项

发布 Issue/PR 评论时：

- 将评论写入临时文件，并使用 `gh issue/pr comment --body-file` 发布（禁止通过 `--body` 传递多行 Markdown）
- 评论应简洁、技术化，并保持用户的语气
- 每条由 AI 发布的评论末尾，都要附上原始 Prompt 指定的 AI 生成免责声明（例如 `This comment is AI-generated by `/wr``）

通过 Commit 关闭 Issue 时：

- 在 Message 中包含 `fixes #<number>` 或 `closes #<number>`，使合并时自动关闭 Issue。对于多个 Issue，应为每个 Issue 重复关键字（`closes #1, closes #2`）；共享关键字（`closes #1, #2`）只会关闭第一个

## 使用 tmux 测试 Pi 交互模式

从仓库根目录，在受控 Terminal 中运行 TUI：

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p     # 启动后捕获
tmux send-keys -t pi-test "your prompt here" Enter
tmux send-keys -t pi-test Escape               # 特殊按键（Ctrl+O 等也可写作 C-o）
tmux kill-session -t pi-test
```

## Changelog

位置：`packages/*/CHANGELOG.md`（每个 Package 一份）。

`## [Unreleased]` 下的 Section：`### Breaking Changes`（需要迁移的 API 更改）、`### Added`、`### Changed`、`### Fixed`、`### Removed`。

规则：

- 所有新条目都应放在 `## [Unreleased]` 下。先完整读取该 Section，再追加到现有 Subsection；禁止创建重复 Subsection
- 已发布版本的 Section（例如 `## [0.12.2]`）不可变更，禁止修改

署名格式：

- 内部（来自 Issue）：`Fixed foo bar ([#123](https://github.com/earendil-works/pi-mono/issues/123))`
- 外部贡献：`Added feature X ([#456](https://github.com/earendil-works/pi-mono/pull/456) by [@username](https://github.com/username))`

## 发布

**锁步版本控制：** 所有 Package 共用一个版本，每次发布全部一起更新。`patch` = 修复 + 新增，`minor` = Breaking Change。不发布 Major 版本。

1. **更新 CHANGELOG：** 询问用户是否已在 `main` 的最新 Commit 上运行 `/cl` Prompt。如果没有，发布前必须先运行 `/cl`，审计并更新每个 Package 的 `[Unreleased]` Section。

2. **本地 Smoke Test：** 构建未发布的 Release，并从仓库外执行 Smoke Test（避免解析到 Workspace 文件）：
   ```bash
   npm run release:local -- --out /tmp/pi-local-release --force
   cd /tmp

   # Node Package 安装 Smoke Test
   /tmp/pi-local-release/node/pi --help
   /tmp/pi-local-release/node/pi --version
   /tmp/pi-local-release/node/pi --list-models
   /tmp/pi-local-release/node/pi -p "Say exactly: ok"
   /tmp/pi-local-release/node/pi

   # Bun 二进制 Smoke Test
   /tmp/pi-local-release/bun/pi --help
   /tmp/pi-local-release/bun/pi --version
   /tmp/pi-local-release/bun/pi --list-models
   /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
   /tmp/pi-local-release/bun/pi
   ```
   验证 Node 和 Bun 的启动、Model/Account 列表、交互模式启动，以及通过预期默认 Provider 执行的至少一个真实 Prompt。裸命令 `/tmp/pi-local-release/node/pi` 和 `/tmp/pi-local-release/bun/pi` 会启动交互模式；分别在 tmux 中运行，提交 Prompt，并等待 Model 回复后，才能认为交互 Smoke Test 通过。除非用户明确接受风险，否则失败会阻止发布。

3. **运行 Release 脚本：**
   ```bash
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # 修复 + 新增
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # Breaking Change
   ```
   仅在 Release 命令中使用 `npm_config_min_release_age=0`。如果当前 Workspace Package 版本刚发布不久，仓库常规的 npm 发布时间门禁可能阻止刷新 Release Lockfile。Push 前检查 Release 产生的所有 Lockfile 或 Shrinkwrap Diff。

   Release 脚本会提升所有 Package 版本、更新 Changelog、重新生成 Release Artifact、运行 `npm run check`、提交 `Release vX.Y.Z`、创建 `vX.Y.Z` Tag、添加新的 `## [Unreleased]` Changelog Section、提交 `Add [Unreleased] section for next cycle`，然后 Push `main` 和 Tag。Tag 推送后不得重新运行 Release 脚本。

4. **CI 发布 npm Package：** 推送 `vX.Y.Z` Tag 会触发 `.github/workflows/build-binaries.yml`。`publish-npm` Job 通过 GitHub Actions OIDC 和 `npm-publish` Environment 使用 npm Trusted Publishing；不需要本地 `npm publish`、`npm whoami`、OTP 或 WebAuthn 流程。

5. **CI 发布失败时：** 检查失败的 `publish-npm` Job。发布 Helper 具有幂等性，会跳过 npm 上已经存在的 Package 版本，因此修复 CI 或暂时性 npm 问题后，重新运行 Tag Workflow。不得为同一版本重新运行 `npm run release:patch` 或 `npm run release:minor`。

## 用户覆盖

如果用户指令与本文档中的任何规则冲突，在覆盖规则前必须请求用户明确确认。只有确认后才能执行用户指令。
