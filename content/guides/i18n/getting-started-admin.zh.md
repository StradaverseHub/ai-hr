本指南面向首次设置 AI HR 的 HR 管理员。它会带你从一个空白数据库走向一套运转中的马来西亚 HR 体系 —— 公司架构、人员、法定档案、休假规则、角色，以及你的第一次薪资发放 —— 并按照真正可行的顺序进行。请自上而下操作：后面的步骤依赖前面的步骤（你无法在一家不存在的公司中招聘员工，也无法为一个没有 IC 号码的员工发放薪资）。

## 1. 首次登录以及身份 / 角色概念

打开应用后，你会进入 **Dashboard（仪表盘）**。左侧边栏是你的地图：Dashboard、My workspace（我的工作区）、People（人员）、Org chart（组织架构图）、Leave（休假）、Attendance（考勤）、Approvals（审批）、Performance（绩效），以及面向管理员的 **Admin（管理）** 分组（Organization 组织、Leave config 休假配置、Users & roles 用户与角色、Audit trail 审计轨迹）外加 **Payroll（薪资）**。

**身份是如何运作的。** 生产环境的登录通过 **WorkOS** 进行配置（SSO 或邀请）。在本地 / 开发环境中，你会在顶部栏看到一个小的 **Dev as（以…身份）** 下拉框 —— 它让你可以「扮演」任何已植入的主体（例如 *HR Admin · hr_admin*），以测试每个角色所看到的内容。在开始之前，请选择 `hr_admin`（或 `super_admin`）身份；Admin 和 Payroll 部分仅对这些角色显示。

**四种角色**，权限由低到高：`employee` → `manager` → `hr_admin` → `super_admin`。你将在第 7 步分配这些角色。

**注意。** 每一项更改都会连同你的身份一起记录在 **Audit trail（审计轨迹）**（`Admin → Audit trail`）中。没有任何操作是匿名的 —— 这是有意设计的。

## 2. 创建你的公司架构

在边栏中打开 **Admin → Organization**。你会看到 **Group structure（集团架构）**（一棵包含每家公司的树状图）以及其下方的 **Companies（公司）** 列表。

典型的马来西亚集团会有一家控股公司位于一家运营法律实体之上。请按此顺序搭建：

1. 滚动到 Companies 卡片底部的 **Add company（添加公司）** 表单。
2. 在 **Legal name（法定名称）** 中输入控股公司（例如 `Demo Group Holdings Bhd`）。将 **Country（国家）** 保留为 `MY`，**Currency（货币）** 保留为 `MYR`。
3. 点击 **Add company**。
4. 对你的运营实体（例如 `Demo Sdn Bhd`）重复以上操作。
5. 点击某家公司所在的行以将其**展开**。在 **Group parent（集团母公司）** 下，将运营实体的 **Parent company（母公司）** 设为控股公司，并点击 **Set parent（设置母公司）**。Group structure 树状图现在会将它们嵌套显示。

**在每个展开的公司面板内**，你还要管理它的构成模块 —— 这些模块存在于公司*内部*，而非全局：

- **Departments（部门）** —— 输入名称（例如 `Finance`、`Engineering`）并点击 **Add（添加）**。
- **Positions（职位）** —— 一个职衔（例如 `Executive`）并点击 **Add**。
- **Cost centres（成本中心）** —— 一个简短的 **Code（代码）**（例如 `HQ`）和 **Name（名称）**（例如 `Headquarters`），然后点击 **Add**。

**法定身份（MY）。** 仍在该面板内，为真正雇用员工的实体填写 **Statutory identity (MY)（法定身份（马来西亚））** 部分：**EPF employer no（EPF 雇主编号）**、**SOCSO employer code（SOCSO 雇主代码）**、**LHDN E-number（LHDN E 编号）**、**MyInvois TIN（MyInvois 税号）**、**SSM registration no（SSM 注册号）**。点击 **Save statutory identity（保存法定身份）**。一旦三个申报标识符（EPF、SOCSO、LHDN）齐备，面板标题就会显示一个 `statutory ✓` 徽章 —— 它们为每一份月度和年度报告提供数据。

**提示。** 请在*运营*公司而非控股外壳上搭建部门和职位 —— 那里才是员工被招聘进来的地方。

**关于删除与归档的说明。** 一条被引用的记录（一个有员工的部门、一家有子公司的公司）无法被删除 —— 应用会改为提供 **Archive（归档）**，从而让历史保持完整。只有未被使用的记录才会显示 **Delete（删除）** 选项。

## 3. 添加人员

在边栏中打开 **People**。你有两种方式将员工纳入系统。

### 逐个招聘

1. 在 People 页面，展开底部的 **Hire an employee（招聘员工）**。
2. 填写 **Full name（全名）**、**Email（电子邮箱）**，选择 **Company（公司）** 和 **Department（部门）**，设置 **Employment type（雇用类型）**（`Full time` 全职、`Part time` 兼职、`Contract` 合同、或 `Intern` 实习），以及 **Hire date（入职日期）**。
3. 点击 **Hire（招聘）**。常规休假（年假、病假、住院假）会根据公司政策和马来西亚法定下限自动授予。

### 批量 CSV 导入（第一天迁移）

若要一次性导入整家公司，点击 **Import CSV（导入 CSV）**（位于 People 右上方），或前往 `/people/import`。

1. 选择 **Target company（目标公司）**。
2. 将你的 CSV 粘贴到 **CSV data（CSV 数据）** 中，或点击 **Load sample（加载示例）** 查看准确的格式。展开 **Column reference（列参考）** 查看必填列与可选列。
   - **必填：** `full_name`、`email`、`department`、`hired_on`、`ic_number`、`basic_salary`。
   - **可选：** `phone`、`position`、`cost_center`、`employment_type`、`monthly_allowance`、`bank_name`、`bank_account_no`、`epf_number`、`socso_number`、`tax_number`、`tax_category`、`num_children`、`eis_eligible`、`is_resident`。
3. 点击 **Validate（校验）**。预览表会将每一行显示为 `ready`（绿色）或带有错误（红色）。部门名称会针对目标公司进行解析匹配。
4. 当预览看起来无误时，点击 **Import N valid（导入 N 条有效记录）** 以提交。绿色摘要会显示有多少条被导入、跳过或失败。

**常见陷阱。**

- `department` 必须匹配目标公司中已存在的部门（不区分大小写）—— 请先在第 2 步创建你的部门。
- `hired_on` 应为 `YYYY-MM-DD`。
- `bank_name` 和 `bank_account_no` 要么都填、要么都不填 —— 同时提供两者，或同时留空。

## 4. 设置每位员工的马来西亚法定档案

CSV 导入已经捕获了法定基本信息。要查看或为手动招聘的员工填写这些信息，打开 **People**，点击该员工的姓名，并使用 **Statutory (Malaysia)（法定（马来西亚））** 卡片：

| 字段 | 用途 |
|---|---|
| **IC number** | NRIC —— 任何法定申报都需要 |
| **EPF / KWSP number** | EPF 会员编号 |
| **SOCSO number** | PERKESO 缴款人编号 |
| **Tax number** | LHDN 税务档案号 |
| **PCB category** | `1 — Single` 单身、`2 — Married, spouse not working` 已婚配偶不工作、`3 — Married, spouse working` 已婚配偶工作 |
| **Children** | 符合条件的子女人数（影响 PCB 减免） |
| **Bank name / account no** | 用于付款汇总 |
| **EIS eligible / Resident** | 复选框；影响 EIS 和 PCB 的处理方式 |

在同一页面的 **Update pay（更新薪酬）** 下设置薪酬：输入 **Basic salary (MYR)（基本薪资（MYR））** 和任何 **monthly allowance（月度津贴）**，然后保存。

**注意。** 对于缺少 IC、税务号、EPF 或 SOCSO 编号的员工，薪资发放将无法完全就绪 —— 报告的 **Readiness（就绪度）** 检查（第 8/9 步）会准确标出是谁、缺什么。

## 5. 配置休假

打开 **Admin → Leave config**。该页面有一个 **Leave types（休假类型）** 卡片和一个 **Leave year（休假年度）** 卡片。

**休假类型与额度。** 一套马来西亚配置包会植入标准类型（年假、病假、住院假），并已接入法定下限。

1. 展开某个休假类型以查看其 **Statutory minimum (MY)（法定最低（马来西亚））**（只读 —— 即 EA 1955 按服务年限段划分的下限：未满 2 年 / 2–5 年 / 5 年以上）及其 **Company entitlements（公司额度）** 时间线。
2. 若要提供*高于*下限的额度，点击 **+ Add entitlement（添加额度）**，设置 **Days per year（每年天数）**（对年假而言还有 **Carry-cap（结转上限）**），选择 **Effective from（生效日期）**，然后点击 **Add**。授予额度始终取下限与你的政策两者中的**较大值** —— 低于最低值的数值会被记录但永不应用（你会看到一个 `below minimum` 徽章）。
3. 若要添加自定义类型，使用底部的表单：**Code（代码）**（大写，例如 `ANNUAL`）、**Name（名称）**、**Paid（带薪）** 复选框，然后点击 **Add type（添加类型）**。

**开启休假年度。** 在 **Leave year** 卡片中，设置 **Year（年度）**（默认为下一年）并点击 **Open leave year（开启休假年度）**。这会按每位在职员工当前的服务年限段过账其新额度，将未使用的年假在上限范围内结转（其余作废），并重置病假 / 住院假。该操作是幂等的 —— 重新运行会跳过任何已开启的员工。

## 6. 考勤政策

每家运营公司在创建时都会获得一份默认考勤政策，因此签到 / 签退和加班可以开箱即用。在边栏中打开 **Attendance**，查看今日打卡、状态（`present` 出勤、`late` 迟到、`half day` 半天、`absent` 缺勤）和加班。例外情况通过 **correction requests（更正请求）** 处理：忘记打卡的员工提交一份更正，由你或其经理在 **Attendance** 页面或统一的 **Approvals** 收件箱中批准或拒绝。

## 7. 分配用户角色

打开 **Admin → Users & roles**。你会看到每个现有用户及其当前的角色标签。

1. 找到该用户。
2. 在其所在行，从下拉框中选择一个 **role（角色）**（`employee`、`manager`、`hr_admin`、`super_admin`）。
3. 对于 **HR Admin** 授权，还要选择一个 **company scope（公司范围）** —— 即那家公司*及其子公司* —— 或 **Group-wide（集团范围）**。其他角色始终是集团范围的。
4. 点击 **Add role（添加角色）**。要移除一项授权，点击其标签旁边的 **×**。

**注意。** 新的登录账号本身稍后通过 WorkOS 进行配置；在这里你管理的是已存在用户的角色。一个有范围限制（被委派）的 HR 管理员只能在其自身的子树内任命另一个 `hr_admin`。

## 8. 运行你的第一批薪资

在边栏中打开 **Payroll**（**Payroll Process（薪资流程）** 标签页）。

1. 在 **Create payroll process（创建薪资流程）** 表单中，选择 **Company** 和一个以 `YYYY-MM` 表示的 **Pay period（薪资周期）**（默认为当月）。点击 **Create payroll process**。
2. 从列表中打开这个新批次。当它处于 `draft` 草稿状态时，你会看到每位员工的 **Inputs（输入项）** —— 根据需要输入 **OT（加班）**、**Bonus（奖金）**、**TP1**、**Zakat（天课）**，然后点击 **Save**（或点击 **Prefill OT（预填加班）** 从已批准的考勤中拉取加班数据）。对于在该周期内被终止雇用的任何人，会出现一条 **leaver advisory（离职提示）**。
3. 点击 **Generate payslips（生成工资单）**。批次会进入 `processed` 已处理状态，**Payslips（工资单）** 表会显示每个人的 **Gross（毛额）**、**Bonus**、**EPF**、**SOCSO**、**EIS**、**PCB** 和 **Net（净额）**，以及汇总总计（毛额、扣除额、净额、雇主成本）。
4. 复核法定扣除项。当你满意时，点击 **Close batch（关闭批次）**（状态变为 `closed`）以锁定它。已关闭的批次不可更改。

**提示。** 处理完成后，你可以从批次标题处下载一份 **Payment summary（付款汇总）** 用于手动银行上传。

## 9. 法定报告

打开 **Payroll → Reports**（**Reports（报告）** 标签页）。选择一个 **Company**、一份 **Report（报告）** 和一个 **Period（周期）**（或对年度表单选择 **Year（年度）**），然后点击 **Preview（预览）**：

| 报告 | 频率 | 涵盖范围 |
|---|---|---|
| **CP39 — MTD / PCB (LHDN)** | 月度 | 月度税务扣缴表 |
| **EPF contributions (KWSP)** | 月度 | EPF 雇员 + 雇主 |
| **SOCSO + EIS (PERKESO)** | 月度 | SOCSO 和 EIS 缴款 |
| **Form E / CP8D — annual (LHDN)** | 年度 | 年终雇主申报 |
| **Monthly statutory contributions (overview)** | 月度 | 综合快照 |

每份预览都会显示总计、一个列出任何缺少法定数据的员工的 **Readiness（就绪度）** 面板，以及明细行表。使用 **Download CSV（下载 CSV）** 导出，使用 **Record generation（记录生成）** 将本次运行登记到审计轨迹中。从某个报告行，你可以打开某位员工当年的 **EA form（EA 表单）**。页面顶部的 **Compliance worklist · CP22 / CP22A（合规工作清单 · CP22 / CP22A）** 会呈现由事件日志驱动的新雇佣与离职申报。

**注意。** 这些是 A 层报告 —— 供你据以汇缴或交给会计师的人类可读摘要。CP39 提供一份草稿 CP39 `.txt`，但标注为 *DRAFT, not for submission（草稿，不用于提交）*；逐字节精确的机构文件将在后续版本中提供。

## 你已上线 —— 检查清单

- [ ] 已以 `hr_admin` / `super_admin` 身份登录
- [ ] 已创建控股 + 运营公司，并设置了母公司
- [ ] 已为运营实体添加部门、职位、成本中心
- [ ] 已保存法定身份（EPF / SOCSO / LHDN）→ `statutory ✓` 徽章
- [ ] 已添加人员（招聘或 CSV 导入）
- [ ] 已设置每位员工的 IC、EPF、SOCSO、税务号、PCB 类别、子女、银行
- [ ] 已通过 **Update pay** 设置薪酬
- [ ] 已复核休假类型、设置额度、**开启休假年度**
- [ ] 已在 **Users & roles** 中分配角色
- [ ] 已生成、复核并**关闭**第一批薪资
- [ ] 已预览法定报告并通过干净的 **Readiness** 检查
