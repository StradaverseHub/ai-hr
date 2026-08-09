本指南面向负责马来西亚法定申报的人力资源管理员和合规专员。它将引导您了解 **Payroll → Reports** 界面上的所有内容：每月的 EPF/KWSP、SOCSO/PERKESO、EIS 和 PCB 数据；每位员工的年度 EA 表格；Form E / CP8D 雇主申报表；CP39 月度 MTD 文本文件；CP22 / CP22A 新入职及离职工作清单；以及 CSV 和银行付款导出文件。最重要的是，它阐明了**什么是可直接提交的文件，什么是草稿或参考性摘要**——这样您就能清楚地知道哪些可以直接交给 LHDN、KWSP 和 PERKESO，哪些还需要先经人工核查。

您需要拥有 `hr_admin` 或 `super_admin` 角色。报表按**法人实体（公司）**申报，因此您生成的所有内容都仅限于您所选定的公司范围。

## 进入 Reports 界面

1. 在左侧边栏中，打开 **Payroll**。
2. 在 Payroll 区域顶部，点击 **Reports** 选项卡。页面标题显示为 **Payroll · Statutory & compliance reports**。

在顶部，您会看到 **Compliance worklist · CP22 / CP22A** 卡片，然后是一条解释报表层级的琥珀色横幅，接着是 **Generate report** 表单，最底部则是 **Recent generations** 审计表格。

> **注意——Layer-A 横幅。** 此处的大多数报表都属于 **Layer-A**：即一份供您据以汇缴或交给会计师的人类可读摘要。横幅说得很明确：*"Byte-exact agency files (CP39 / KWSP / PERKESO / bank) come in a later slice, each sourced + verified."*（逐字节精确的机构文件将在后续阶段推出，每一个都经过来源核实与验证。）请将屏幕上的表格和 CSV 导出文件视为可靠的工作摘要，而非机构的正式上传文件——下面提到的两个例外（CP39 .txt 和付款摘要）除外。

## 生成月度法定报表

**Generate report** 表单有四个控件：**Company**、**Report**、**Period (YYYY-MM)**（年度报表则为 **Year (YYYY)**），以及一个 **Preview** 按钮。

1. 选择 **Company**（您要为其申报的法人实体）。
2. 选择一个 **Report**。月度选项包括：
   - `Monthly statutory contributions (overview)` — 一览所有缴款：Gross、EPF (EE+ER)、SOCSO (EE+ER)、EIS (EE+ER) 和 PCB。
   - `CP39 — MTD / PCB (LHDN)`
   - `EPF contributions (KWSP)` — 以 Borang A 为基准，分为 Employee / Employer / Total。
   - `SOCSO + EIS (PERKESO)` — 以 ASSIST 为基准，含 EE 和 ER 列。
3. 以 `YYYY-MM` 格式输入 **Period**，例如 `2026-07`。
4. 点击 **Preview**。

页面会根据该公司在该周期的**薪资批次（payroll batch）**汇总报表。您会看到标题总额方块（每个金额列一个），然后是一张每位员工占一行的表格。

> **提示。** 如果您看到 *"No payroll batch found for … Run payroll for this period first."*（未找到……的薪资批次。请先运行此周期的薪资。），那只是因为该公司在该月份没有批次。请返回主 **Payroll** 界面，运行并处理该批次，然后再回到此处。

### 解读就绪检查

在表格上方可能会出现一个红框：**"N employee(s) missing identifiers needed to file."**（N 名员工缺少申报所需的标识信息。）这会列出在该报表中必填 ID 为空白的员工——例如缺少 `Tax no`、`EPF no` 或 `SOCSO no`。缺失值也会在表格中显示为空的红色单元格。请在申报前修正这些问题：在 **People** 下打开该人员，补全其法定身份信息，然后重新运行预览。一份干净的报表不会有红框。

## 导出并记录月度报表

在报表标题行中，您会找到两到三个操作：

- **Download CSV** — 精确导出屏幕上的列和行，文件名形如 `my.cp39_2026-07.csv`。这是供您发送给会计师或与机构门户对账的工作文件。
- **Record generation** — 保存一份只可追加的 `statutory report` 工件，并标记其法定表格版本。当您已审核数据并希望留下"此报表已为该公司及周期生成"的审计记录时，请使用此功能。它**不会**向任何机构提交任何内容。
- **CP39 .txt — DRAFT, not for submission** — 仅在 CP39 报表的就绪检查通过后才会出现（见下文）。

每一次记录的生成都会进入页面底部的 **Recent generations** 表格，显示报表类型、周期、状态（`draft`）、行数以及所使用的 **Tables ver.**——这是您的可复现性追溯线索。

## CP39 月度 PCB 文件

CP39 是向 LHDN 提交的月度 MTD/PCB 报表。屏幕为您提供两样东西：

1. **CP39 表格 + CSV**（Layer-A）— Employee、Tax no、IC、MTD / PCB，并附有合计。用于审核和对账。
2. **CP39 .txt 下载**（Layer-B）— 一份符合 LHDN e-Data PCB 字节布局（Exhibit 4）的定宽文本文件，适合上传至 e-PCB 门户。

要获取 `.txt`：选择 `CP39 — MTD / PCB (LHDN)` 报表，预览某个周期，并**确保没有就绪错误**。当就绪检查通过后，标题中会出现一个标有 **CP39 .txt — DRAFT, not for submission** 的琥珀色按钮。点击即可下载。

> **重要——这是一份草稿（DRAFT）。** 按钮标签、工具提示以及文件自身的页头都这样说明：*"DRAFT until verified against e-PCB Plus."*（在 e-PCB Plus 中核实之前为草稿。）请打开它，将合计与屏幕上的数据进行核对，并在实际的 **e-PCB Plus** 门户中核实后，再将其视为提交件。每次下载都会作为独立的法定工件和领域事件被记录，因此您拥有每一份所拉取草稿的记录。

## 年度 EA 表格（每位员工 · C.P.8A）

EA 表格是每位员工的年度薪酬报表（Statement of Remuneration）。

1. 在 **Generate report** 中，选择 `Form E / CP8D — annual (LHDN)`。周期字段会切换为 **Year (YYYY)**——输入例如 `2026`。
2. 点击 **Preview** 以加载 CP8D 表格（每位员工占一个编号行）。
3. 在表格中点击某位**员工的姓名**，以打开其 **EA (C.P.8A)** 报表。

EA 页面显示：**A · Employee particulars**（姓名、TIN、IC、EPF no.、SOCSO no.、MTD 类别、子女、雇佣期间）、**B · Employment income (cash)**（含加班费的总薪资、奖金、津贴、薪酬总额）、**D · Total deductions**（MTD/PCB）、**E · Contributions**（EPF/KWSP、SOCSO、EIS——员工承担部分）以及 **F · Tax-exempt allowances**（免税津贴）。使用 **Print** 按钮（右上角）生成 PDF 或纸质副本交给员工。

> **注意——员工可自助办理。** 每位员工都可从 **My workspace** 打开自己的 EA（EA 链接至 `/payroll/reports/ea/…?year=2026`），因此您无需为每个人都打印一份。

> **EA 不包含哪些内容。** 蓝色免责声明已明确说明。这些数据仅涵盖现金薪酬、EPF、SOCSO/EIS 和 MTD。**实物福利（Benefits-in-kind）、居住住宿价值、ESOS、酬金（gratuity）、免税津贴、zakat 和 CP38 不在薪资系统中追踪**，会显示为 `not tracked`。请在申报前补充其中任何一项。这是一份生成的工作报表，不能替代官方的 LHDN 表格。

## Form E / CP8D（年度雇主申报表）

列出员工的同一份 `Form E / CP8D — annual (LHDN)` 预览，同时也为您提供雇主申报表：

- 顶部的**汇总方块**即 **Form E Part A 人数统计**：截至 12 月 31 日在职、须缴 MTD、新入职、已离职。
- **CP8D 表格**是按员工列示的明细表：No.、Employee、TIN、IC、Cat.、Children、Gross remuneration、EPF、MTD/PCB、SOCSO——以及合计。
- **Download CSV** 交给您的税务代理，或 **Record generation** 用于审计追溯。

> **重要——同样的范围注意事项。** 此报表上的蓝色提示警告它仅涵盖薪资派生的数据。**实物福利、居住住宿、ESOS、免税津贴、zakat 和 CP38 不在此处**——请在 **MyTax / e-CP8D** 中补充后再申报。

## CP22 / CP22A 工作清单（新入职与离职）

页面顶部的 **Compliance worklist · CP22 / CP22A** 卡片由事件日志中的入职/离职生命周期驱动。它会浮现即将到期的 LHDN 通知，以免有所遗漏：

| 列 | 含义 |
| --- | --- |
| **Employee** | 通知所涉及的人员 |
| **Form** | `CP22`（新入职）或 `CP22A`（离职） |
| **Reason** | `New hire`（新入职）或 `Cessation`（离职） |
| **Event date** | 入职日期或离职日期 |
| **Notify by** | 截止期限（入职后 30 天；离职前 ≥30 天） |
| **Status** | `overdue`（红色，逾期）、`due soon`（琥珀色，7 天内）或 `upcoming`（灰色，即将到来） |

条目按逾期优先排序。当没有待办事项时，您会看到 **"Nothing due."**（无待办事项。）

> **重要——这仅为提示性质。** 正如卡片所述：*"File in MyTax; this surfaces what's outstanding."*（请在 MyTax 中申报；此处仅浮现尚未处理的事项。）应用**绝不会自动提交** CP22/CP22A。请将该工作清单作为提醒，然后自行在 MyTax 中申报。目前尚无"标记为已申报"功能，因此条目在其截止期限过后只会自动淡出相关性窗口。

### 下载 CP22 表格本身

工作清单中的每一行**新入职**记录都带有 **Download CP22** 按钮，LHDN 分区上的 **CP22 / CP22A notices** 行则在 **Open worklist** 旁边提供 **Download blank CP22**。

下载得到的是 LHDN 官方发布的 **CP22 (Pin. 1/2020)** 表格原页——版面相同、措辞相同、同样是马来文与英文双语——只是在其上叠加了可输入的栏位。**33 个栏位中有 26 个已根据您现有的记录填好**：公司名称、地址、E 号码与电话；新员工的姓名、职位、入职日期、预计雇用期限、住家与通讯地址、电话、电子邮件、所得税号码、身份证号码、护照号码、性别、公民身份、出生日期与婚姻状况；记录中若有配偶，则包括配偶姓名与身份证号码；每月基本薪金与固定月度津贴；以及签名栏中的今日日期。

**有七个栏位留空**，因为系统中根本没有存放这些信息：顶部的 LHDN 分行地址、税务代理勾选框、曾向 LHDNM 登记的旧护照号码、配偶的所得税号码、不固定报酬及其金额确定的日期、在马来西亚的前雇主，以及签名栏本身。

> **所有栏位都保持可输入——包括已填好的那 26 个。** 文件未被扁平化，因此您可以在签名前更正任何内容，并在下载的文件中补齐其余七项。系统不会回存任何内容：它只是读取您本就维护的记录并交给您一个文件。

记录中没有的内容一律**留空而非填错**——绝不猜测税号、身份证号码或配偶资料。签名栏中您自己的姓名与职位，会在您在系统中拥有自己的员工记录时填入，否则留空。**CP22A 尚未涵盖**，因此那些行显示破折号而非按钮。若要为超出清单所涵盖 60 天窗口的旧入职补办申报，请使用空白副本。

## 银行付款摘要（手动银行上传）

**payment summary**（付款摘要）是一份中性的 员工 / 银行 / 账户 / 实发工资 CSV，用于上传至您的银行。它由**已处理或已关闭**的薪资批次生成（请从主 **Payroll** 界面的该批次中下载，而非从 Reports 表单下载）。仅限管理员使用；该导出会作为领域事件记录在批次上。

> **注意——这不是 giro 文件。** 这是一份普通的 CSV，**而非**逐字节精确的银行专用 giro 文件。如果批次尚未就绪，您会收到清晰的"未就绪（not ready）"消息，告知您应如何处理；完成批次处理后再试一次。

## 速查：可直接提交 vs 草稿/参考性

| 输出 | 它是什么 | 状态 |
| --- | --- | --- |
| 月度表格 + **Download CSV**（缴款、CP39、EPF、SOCSO/EIS） | 人类可读的 Layer-A 摘要 | **参考性**——据以汇缴 / 交给会计师 |
| **CP39 .txt** | LHDN e-Data PCB 字节布局（Exhibit 4） | **草稿**——请先在 e-PCB Plus 中核实 |
| 每位员工的 **EA (C.P.8A)** | 薪酬报表，可打印 | **参考性**——仅含现金项目；请补充 BIK 等 |
| **Form E / CP8D** 表格 + CSV | 年度雇主申报表 | **参考性**——请在 MyTax / e-CP8D 中完成 |
| **CP22 / CP22A** 工作清单 | 申报提醒 | **参考性**——请在 MyTax 中申报；绝不自动提交 |
| **Payment summary** CSV | 银行上传清单 | 可用于**手动**银行上传（非 giro 文件） |
| **Record generation** | 只可追加的审计工件 | 一份审计记录——**而非**提交件 |

## 故障排除与常见陷阱

- **"No payroll batch found …"** — 请先为该公司和周期运行薪资，然后再次预览。
- **红色"missing identifiers"框 / 空的红色单元格** — 在申报前于 **People** 下补全该员工的 IC、Tax no、EPF no 或 SOCSO no。
- **没有 CP39 .txt 按钮** — 它仅在 CP39 报表**零**就绪错误时才出现。请先清除红框。
- **EA / CP8D 合计看起来偏低** — 请记住实物福利、住宿、ESOS、酬金、免税津贴、zakat 和 CP38 不被追踪；请在申报前于 MyTax 中补充。
- **申报了错误公司的数据** — 每份报表都按法人实体划分。导出前请仔细核对 **Company** 选择器。
- **"Record generation" 似乎没有任何可见变化** — 它是一项审计操作，而非提交。请在页面底部的 **Recent generations** 中确认。
