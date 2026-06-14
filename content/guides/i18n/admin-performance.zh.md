本指南面向在 AI HR 中执行绩效评估的人力资源管理员（`hr_admin` 和 `super_admin`）。读完之后，你将知道如何创建一个评估周期，将它走完整个生命周期（`draft` → `open` → `calibration` → `closed`），理解自评和经理评估如何汇入单一的总体评分，精确控制员工何时能看到自己的评分，以及如何把经理的加薪/奖金建议转化为真实的薪酬变更——而绩效模块本身从不直接触碰薪资。

## 在哪里找到它

在左侧边栏，点击 **Performance**。页面标题显示为 **Performance**，副标题为 *Review cycles, appraisals, and merit recommendations*。

- **管理员**会看到完整的 **Review cycles** 表格，以及 **+ New review cycle** 面板。
- **经理**会看到一张 **Reviews awaiting you** 卡片，列出他们仍需定稿的评估。

如果你同时也管理下属，这两个视图会在同一页面上一起出现。

## 创建评估周期

一个*周期*是面向一组员工的一轮评估的容器。

1. 在 **Performance** 页面，点击 **+ New review cycle** 展开表单。
2. 填写各字段：

| 字段 | 作用 |
|---|---|
| **Name** | 自由文本，例如 `2026 Annual`。 |
| **Scope** | `Group-wide (all companies)` 或某一家公司。决定哪些人会被快照纳入。 |
| **Period start** / **Period end** | 评估的时间窗口。默认为当前公历年（1 Jan → 31 Dec）。结束日期不得早于开始日期。 |
| **Merit pool (optional)** | 保持为 `No pool`，或设置一个软性预算——`% of payroll` 或 `RM (monthly)`——并填入一个数值（例如 `3.5`）。 |
| **Only include staff hired before (optional)** | 把晚入职的员工排除在本轮之外。 |
| **Exclude employees on probation** | 默认勾选。 |

3. 点击 **Create cycle (draft)**。

周期会以 `draft` 状态创建。此时尚无人被评估——打开它（下一步）才会生成真正的评估记录。

**注意——评分量表。** 每个周期都使用单一的总体评分，采用带标签的 1–5 量表：`1 · Below`、`2 · Meets`、`3 · Strong`、`4 · Exceeds`、`5 · Outstanding`。每位员工只有一个总体分数，而非一篮子能力项。

**注意——加薪池是软性上限。** 它是校准时的指导线，而非硬性限制。建议值允许超出它；预算条只会变红，让你看出已经超支。

## 生命周期：draft → open → calibration → closed

在 **Review cycles** 表格中点击周期名称即可打开它。状态以徽章形式位于页面标题处，生命周期按钮会根据当前状态出现在其旁边。

### 1. Draft

草稿会显示一张提示卡，说明打开它将会做什么。点击 **Open cycle** 开始。

**"Open cycle" 会做什么：** 它把每一位在范围内、在职的员工（按你的设置排除试用期与晚入职者）各快照成一条评估记录，将每个人的**行政线经理**设为评审人，并启动自评阶段。周期进入 `open`。在此之前已离职的员工不会被纳入。

**提示：** 在打开之前，先在 **Org chart** 中把汇报线理顺——这才决定了谁评审谁。如果某位经理在周期中途变动，你可以重新指向单条评估（见*重新指派评审人*）。

### 2. Open

这是活跃的评估阶段。自评和经理评估只能在周期处于 `open` 时编辑。从这里，标题处提供：

- **Move to calibration**——冻结编辑，进入校准复核。
- **Release ratings**——打开可见性闸门（见下文）。
- **Close**——结束该周期。

### 3. Calibration

在任何内容发布之前，用这个阶段来审视评分分布。在周期页面上你会看到两张卡片：

- **Rating distribution**——每个量表刻度一根柱，显示有多少条*已定稿*的总体评分落在那里。健康的分布通常不会全是 `4` 和 `5`。
- **Merit budget**——已用对比加薪池（按月），旁边还有 **Recommended bonuses (one-off)**。在池内时柱条为绿色，超出某一金额时变红（**over by**）。

你在校准阶段仍可以 **Release ratings** 或 **Close**。

### 4. Closed

终止状态。从 `open` 或 `calibration` 点击 **Close**。

## 自评与经理评估如何流转

每位员工的评估会经过这些状态（在周期 **Reviews** 表格的 **Status** 列中可见）：

`self_review` → `manager_review` → `submitted` → `acknowledged`

1. **Self-review**——员工打开自己的评估（从 **My workspace** / `/me`）并提交自评分和评语。这会把它推进到 `manager_review`。
2. **Manager review**——评审人填写经理评分、**单一总体评分**、评语，以及（可选的）加薪百分比和/或奖金建议。提交后进入 `submitted`。
3. **Acknowledged**——在你发布评分之后，员工确认已经看到，将其推进到 `acknowledged`。

**注意——不会卡住。** 即使员工从未自评，经理也可以定稿。仍停在 `self_review` 的评估会出现在经理的 **Reviews awaiting you** 列表中，因此不会有任何东西被卡住。

在周期页面上，**Review cycles** 的进度列读作 `ack / done / total`（已确认 / 经理已定稿 / 总数）。

### 重新指派评审人

如果评审人设错了（例如组织变动），打开该条单独的评估并重新指派。你不能在已关闭的周期上重新指派，也不能在已是 `submitted`/`acknowledged` 的评估上重新指派，并且员工永远不能被设为自己的评审人。

## 发布闸门

这是最需要理解的控制项：**在你发布周期之前，员工无法看到自己的经理评分或总体分数。** 在此之前，被评估人只能看到自己的自评。薪酬建议*永远*对员工不可见。

发布方法：

1. 在周期页面（状态为 `open` 或 `calibration`），点击 **Release ratings**。
2. 会出现一条确认提示：*"Release ratings to employees? Every employee will be able to see their manager rating and overall score. This cannot be undone."*
3. 用 **Release ratings** 确认。

发布之后，标题会显示 `ratings released`，只有到那时员工才能 **acknowledge** 自己的评估。

**提示：** 先校准，后发布。一旦发布便无法撤销，所以在按下扳机之前先检查分布卡片和预算卡片。

## 薪酬操作——经理建议，你来执行

绩效模块**从不直接写入薪酬**。经理在评估上*建议*加薪和奖金；管理员通过既有的、经过测试的薪资引擎*执行*该建议。这种分离是刻意为之。

在周期页面上，当存在待处理的建议时，会出现一张 **Pay recommendations to enact** 卡片。其说明文字为：*"Enacting applies the change through payroll: a merit % becomes an effective-dated salary increase; a bonus is staged into a draft batch and taxed as additional remuneration. Performance never writes pay directly."*

对于每一行，你会看到该员工、建议的 `merit X% (on RM …)` 和/或 `bonus RM …`，以及执行所需的输入项：

- **Merit**——选择一个**生效**日期（默认为周期结束日的次日）。执行时，系统会通过薪酬管理创建一笔带生效日期的加薪；新的基本工资 = 当前基本工资 × (1 + merit%)。
- **Bonus**——选择一个**奖金批次**（员工所属公司的一个草稿薪资批次）。奖金会被纳入该批次，并按**附加报酬（MTD）**计税。

然后：

1. 点击 **Enact**。
2. 确认：*"Enact pay for {employee}? This applies a real pay change through payroll — an effective-dated raise and/or a taxed bonus. It cannot be undone here."*

若想改为拒绝某条建议，点击 **Decline**。

**常见陷阱**

- **"Bonus needs a draft batch."** 如果该员工所属公司没有打开的草稿薪资批次，该行会显示这一提示，并附带一个 **create one in Payroll** 链接。前往 **Payroll**，创建一个草稿批次，然后返回并执行。
- **批次所属公司错误。** 奖金批次必须属于与该员工相同的公司，否则执行会被阻止。
- **生效日期过早。** 加薪的生效日期必须落在该员工当前薪酬记录开始之*后*，否则会被拒绝。
- **没有当前薪酬。** 你不能对一个档案中没有当前薪酬的人执行加薪。
- **已离职员工。** 不能为已离职的员工执行薪酬变更。

**注意——加薪池仅供参考。** 执行并不强制约束加薪池。预算卡片会为已执行的行恢复加薪前的工资基数，因此随着加薪落地，*已用对比池*的数字仍保持稳定。

## 疑难解答

- **不能两次打开一个周期。** 打开只能从 `draft` 进行；已是 `open`/`calibration`/`closed` 的周期不会重新快照。
- **某条评估不让我编辑。** 自评和经理评估只能在周期处于 `open` 时编辑。无法把它从校准退回——请先定稿再校准。
- **某位员工说看不到自己的评分。** 确认该周期已**发布**（标题显示 `ratings released`）。在发布之前看不到是按设计如此。
- **每个操作都会被记录。** 周期与评估的状态转换、发布以及执行都会写入审计轨迹——如果你需要确认谁在何时做了什么，请见 **Admin → Audit trail**（`/admin/audit`）。
