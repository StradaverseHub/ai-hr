本指南面向负责 AI HR 中人员档案与组织结构的 HR 管理员（`hr_admin` 和 `super_admin`）。读完之后，您将能够设置公司、部门、职位和成本中心；招聘和导入员工；维护每位人员的薪酬、马来西亚法定档案和汇报线；执行带生效日期的调动；并终止雇佣关系——所有操作都在 **People** 和 **Admin → Organization** 屏幕中完成。

## 开始之前：公司、部门、职位、成本中心

每位员工都是被招聘*进入*某家公司，并被分配到该公司的某个部门，因此请先搭建好结构。

1. 在左侧边栏中，打开 **Admin → Organization**。您将进入一个标题为 **Organization** 的页面，其中包含三个区域：**Group structure**（所有法律实体的只读树状图）、**Companies** 以及底部的添加公司表单。
2. **Companies** 列表为每个法律实体显示一个可展开的面板。每个面板标题显示注册号、国家徽章（例如 `MY`）、类似 `2 dept · 3 pos · 1 cc` 的数量摘要，以及——对于马来西亚公司——一个 `Statutory complete`（绿色）或 `Statutory partial`（琥珀色）徽章。

### 添加公司

在 **Companies** 卡片底部，填写 **Legal name**、**Country**（两位字母代码，默认为 `MY`）和 **Currency**（三位字母，默认为 `MYR`），然后点击 **Add company**。

### 编辑公司及其法定身份

点击公司面板以将其展开。在其中您会找到：

- **Details** — 编辑 **Legal name**、**Reg. no**、**Country**、**Currency**，然后点击 **Save details**。
- **Group parent** — 选择一个 **Parent company**（或 `None (group root)`）以将此实体嵌套在另一个实体之下，然后点击 **Set parent**。这就是绘制 **Group structure** 树状图的依据。
- **Statutory identity (MY)** — 对于马来西亚公司，记录 **EPF employer no.**、**SOCSO employer code**、**LHDN E-number**、**MyInvois TIN** 和 **SSM registration no.**，然后点击 **Save statutory identity**。

> **Note** 绿色/琥珀色的就绪徽章取决于三个标识符：**EPF employer no.**、**SOCSO employer code** 和 **LHDN E-number**。薪资申报和报表都依赖这些信息，因此请在首次发放薪资之前填写完整。

### 部门、职位和成本中心

每个展开的公司面板底部有三列：

- **Departments** — 输入名称并点击 **Add**。
- **Positions** — 输入职位名称并点击 **Add**。
- **Cost centres** — 输入 **Code** 和 **Name**，然后点击 **Add**。

要更改现有条目，请使用其行内的内联编辑器。移除分为两层：

| 状态 | 显示的控件 | 含义 |
| --- | --- | --- |
| 未在任何地方被引用 | **Delete** | 硬删除——安全，因为没有任何内容指向它。 |
| 正在使用中（已分配给员工） | **Archive** | 软隐藏；现有的分配和历史记录保持完整。 |

同样的逻辑适用于公司层级：**正在使用**的公司提供 **Archive company**；未被引用的公司提供 **Delete company**（带确认对话框）。已归档的行显示为灰暗状态，可通过 **Unarchive** 恢复。

## 招聘员工

1. 在边栏中，点击 **People**。您将看到员工表格（Name、Department、Company、Status、Hired），并带有搜索框和员工数量。
2. 滚动到底部的 **Hire an employee** 面板并展开它。
3. 填写 **Full name**、**Email**、**Company**、**Department**、**Employment type**（`Full-time`、`Part-time`、`Contract` 或 `Intern`）和 **Hire date**（默认为今天）。
4. 点击 **Hire**。新人员将出现在表格中并自动获得一个员工编号。招聘时，将根据公司所在国家/地区的政策包授予常规休假额度（年假、病假、住院假）——年假按入职年份剩余月份按比例计算。

> **Tip** **Company** 和 **Department** 两个下拉列表都来自 **Admin → Organization**。如果缺少某个部门，请先在那里添加。

## 员工详情页

点击 **People** 表格中的任意姓名，即可打开该人员的档案。标题显示其员工编号、电子邮箱、公司、入职日期和状态徽章。作为管理员，您可以编辑以下部分。

### 个人详情

编辑 **Full name**、**Email** 和 **Phone**（使用 `+60…` 格式），然后点击 **Save details**。一份人员档案在该个人的所有雇佣关系之间共享，因此此更新会在各处更新其规范身份。

### 薪酬 — "Update pay"

**Compensation** 卡片显示当前的基本工资、津贴及其生效日期。要更改，请输入新的 **Basic salary (MYR)** 和 **Allowance** 并点击 **Update pay**。薪酬历史会被保留——系统会创建一条新的带生效日期的记录，而不是覆盖旧数字。

> **Note** 员工被终止雇佣后，**Update pay** 表单将被隐藏。

### 法定（马来西亚）

维护薪资和申报所依赖的字段：

- **IC number**、**EPF number**、**SOCSO number**、**Tax number**（LHDN）。
- **PCB category** — `1` 单身，`2` 已婚/配偶不工作，`3` 已婚/配偶工作。
- **Children (PCB relief)** 数量。
- 用于付款的 **Bank** 和 **Bank account**。
- **EIS eligible** 和 **Tax resident** 复选框。

下方的 **TP3** 部分用于记录年中入职者前雇主的数据——**Applies to year**、**Net remuneration**、**EPF claimed** 和 **PCB paid**——以便正确计算 MTD。完成后点击 **Save statutory**。

### 分配历史和变更历史

**Assignment history** 列出每个部门/职位时段及其 valid-from → valid-to 日期（当前行被高亮显示，并以 `Present` 结束）。**Change history** 是对此档案所做编辑的审计追踪。两者结合，让您能够准确重建过去任意日期的真实情况——任何内容都不会被就地覆盖。

## 汇报线（行政、职能、项目、虚线）

**Reporting lines** 卡片有两列：**Reports to**（此人的经理）和 **Direct reports**。

1. 要添加一条汇报线，请使用底部的表单：选择一位 **Manager** 和一个 **Line type**，然后点击 **Add reporting line**。
2. **Line type** 选项：

| 类型 | 用于 |
| --- | --- |
| `Administrative` | 主要的、实线的经理。 |
| `Functional` | 职能/专业负责人。 |
| `Project` | 项目或临时分配。 |
| `Dotted` | 次要的、咨询性的关系。 |

3. 要结束一段关系，请点击 **Reports to** 中经理旁边的 **×**。

> **Note** 行政汇报线会进行循环检查：如果该经理已经（直接或间接）向此人汇报，则该汇报线会被拒绝，以防止形成回路。其他汇报线类型允许矩阵式重叠。

## 带生效日期的调动

使用 **Transfer** 卡片可将某人从所选日期起调动到新部门。

1. 选择 **New department** 和 **Effective date**（默认为今天）。
2. 点击 **Transfer**。

当前分配会在该日期关闭，并开启一条新分配——因此 **Assignment history** 表格会显示一条干净、不重叠的时间线。汇报和薪资随后会读取在任意给定日期生效的那条分配。

## 终止雇佣

在 **Terminate** 卡片中，选择一个 **Termination date**（默认为今天）并点击 **Terminate employment**。确认对话框会要求您按姓名确认。终止时，已开启的分配会在该日期关闭，并且该档案的 **Update pay**、**Transfer**、**Terminate** 以及添加汇报线表单都会消失。该人员的状态徽章将切换为 `terminated`。

> **Tip** 终止不会删除任何内容——薪资单、休假历史和 EA 表格仍可用于法定和最终薪资目的。

## CSV 导入（先试运行，再提交）

如需一次性入职大量人员——例如首日迁移——请使用导入工具。

1. 在 **People** 页面，点击 **Import CSV**（右上角；仅限管理员）。**Import employees** 页面将打开。
2. 选择 **Target company**（默认为您当前活动的公司，或部门数量最多的实体）。
3. 将您的行粘贴到 **CSV data** 中，或点击 **Load sample** 放入一个可编辑的模板。
4. 展开 **Column reference** 以查看可识别的内容：
   - **Required:** `full_name`、`email`、`department`、`hired_on`、`ic_number`、`basic_salary`
   - **Optional:** `phone`、`position`、`cost_center`、`employment_type`、`monthly_allowance`、`bank_name`、`bank_account_no`、`epf_number`、`socso_number`、`tax_number`、`tax_category`、`num_children`、`eis_eligible`、`is_resident`
5. 点击 **Validate**。这是一次试运行——尚未写入任何内容。**Preview** 表格会将每行显示为 `Ready`（绿色，有时带有琥珀色警告）或以红色显示其错误，并附带就绪行与含错误行的标题计数。缺失的列会在顶部标记。
6. 修复 CSV 中的任何问题并再次 **Validate**（任何编辑都会清除之前的预览，因此您导入的始终正是您上次检查过的内容）。
7. 满意后，点击 **Import N valid** 以提交。只有有效行会被写入；无效行会被跳过。结果横幅会报告已导入/已跳过/失败的数量，并按行列出任何失败项。
8. 点击 **View people** 查看新入职者，或点击 **Import another** 清空并重新开始。

> **Note** CSV 中的部门、职位和成本中心值会按名称/代码与 **Target company** 的目录进行匹配，因此请确保这些先在 **Admin → Organization** 中存在。`bank_name` 和 `bank_account_no` 应一并提供。

## 常见问题

- **"Add company" / 下拉列表为空。** 在招聘或导入之前，请先在 **Admin → Organization** 中搭建公司和部门。
- **琥珀色 "Statutory partial" 徽章。** 某家马来西亚公司缺少 EPF / SOCSO / LHDN 雇主标识符之一——展开该面板并在发放薪资前完成 **Statutory identity (MY)**。
- **无法删除部门/职位/公司。** 它被员工或历史记录引用，因此只提供 **Archive**。请归档而不是强制删除。
- **汇报线被拒绝。** 您创建了一个行政循环——请选择不同的汇报线类型，或选择一位尚未处于此人之下的经理。
- **导入行被跳过。** 检查结果横幅中的失败列表；常见原因是缺少必填列、未知的部门名称，或格式错误的 `ic_number` / `hired_on` 值。
- **对已终止员工的编辑未生效。** 薪酬、调动和汇报线控件在终止后会被有意隐藏。
