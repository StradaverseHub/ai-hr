# Translation review: Pay Item PCB help strings (f2f0c1282)

Prepared 14 November 2026 by the build agent, who is not a native speaker of any locale below.
Status: **awaiting native-speaker review.** Nothing in this sheet is an approval.

## Why this sheet exists

Commit f2f0c1282 (13 Nov 2026) rewrote six help strings on the Pay Item form
(`app/admin/pay-components/statutory-config.tsx`, namespace `payComponents` in `messages/<locale>.json`) to state the
rules the payroll engine applies since owner decisions A/B of 13 Nov 2026:

- Remuneration Type and Exemption Type are used for PCB (income tax) only.
- EPF, SOCSO, EIS and SKBBK are decided by the EPF, EPF Bonus 2012 and SOCSO/EIS ticks alone, on the whole amount.
- Only EPF Bonus 2012 puts money on the EPF bonus stream; a bonus under it is not SOCSO/EIS/SKBBK wages.

The non-English text was agent-translated. Following docs/KNOWLEDGE-BASE-MAINTENANCE.md ("Review translations
against the changed source"), each locale needs a reader of that language to check it against the English below.

## How to review

For each string, read the English, then your locale. In the "Reviewer" column write **OK** or the corrected text,
then sign the table at the end. Keep these terms exactly as written in every locale, because they are on-screen
checkbox, agency or LHDN document names: `EPF`, `EPF Bonus 2012`, `SOCSO/EIS` (the checkbox label is English in every
locale), `SKBBK`, `PCB`, `LP`, `RM`, `LHDN`, and the Malay document title
*Spesifikasi Pengiraan PCB 2026 Menggunakan Pengiraan Berkomputer*. In Bahasa Melayu the agencies may be written
PERKESO (SOCSO) and SIP (EIS), as the current text does.

Field names used inside the tooltips must match the field labels on the same screen:

| Key | English (source) | Bahasa Melayu | Chinese (Simplified) | Tamil | Thai | Vietnamese |
|---|---|---|---|---|---|---|
| `sectionEpfConfig` | EPF Configuration | Konfigurasi EPF | EPF 配置 | EPF உள்ளமைவு | การตั้งค่า EPF | Cấu hình EPF |
| `epfBonus2012Label` | EPF Bonus 2012 | EPF Bonus 2012 | EPF Bonus 2012 | EPF Bonus 2012 | EPF Bonus 2012 | EPF Bonus 2012 |
| `sectionPcbConfig` | PCB Configuration | Konfigurasi PCB | PCB 配置 | PCB உள்ளமைவு | การตั้งค่า PCB | Cấu hình PCB |
| `remunerationTypeLabel` | Remuneration Type | Jenis Saraan | 薪酬类型 | ஊதிய வகை | ประเภทค่าตอบแทน | Loại thù lao |
| `exemptionTypeLabel` | Exemption Type | Jenis Pengecualian | 豁免类型 | விலக்கு வகை | ประเภทการยกเว้น | Loại miễn trừ |

## Strings

### 1. `payComponents.pcbConfigTip`

Where: PCB Configuration section tooltip (beside "PCB Configuration").

| Locale | Text | Reviewer |
|---|---|---|
| English (source) | Classifies this pay code for Monthly Tax Deduction (PCB, income tax) only, per the LHDN Spesifikasi Pengiraan PCB 2026 Menggunakan Pengiraan Berkomputer. It does not change EPF, SOCSO, EIS or SKBBK. | n/a (source) |
| Bahasa Melayu | Mengklasifikasikan kod gaji ini untuk Potongan Cukai Bulanan (PCB, cukai pendapatan) sahaja, mengikut Spesifikasi Pengiraan PCB 2026 Menggunakan Pengiraan Berkomputer (LHDN). Ia tidak mengubah EPF, PERKESO, SIP atau SKBBK. |  |
| Chinese (Simplified) | 仅为月度扣税（PCB，所得税）对此工资代码分类，依据 LHDN《Spesifikasi Pengiraan PCB 2026 Menggunakan Pengiraan Berkomputer》。它不会改变 EPF、SOCSO、EIS 或 SKBBK。 |  |
| Tamil | LHDN Spesifikasi Pengiraan PCB 2026 Menggunakan Pengiraan Berkomputer படி மாதாந்திர வரி பிடித்தத்திற்காக (PCB, வருமான வரி) மட்டுமே இந்த ஊதியக் குறியீட்டை வகைப்படுத்துகிறது. இது EPF, SOCSO, EIS அல்லது SKBBK-ஐ மாற்றாது. |  |
| Thai | จัดประเภทรหัสจ่ายนี้สำหรับการหักภาษีรายเดือน (PCB ภาษีเงินได้) เท่านั้น ตาม LHDN Spesifikasi Pengiraan PCB 2026 Menggunakan Pengiraan Berkomputer ไม่เปลี่ยนแปลง EPF, SOCSO, EIS หรือ SKBBK |  |
| Vietnamese | Chỉ phân loại mã lương này cho khấu trừ thuế hàng tháng (PCB, thuế thu nhập) theo LHDN Spesifikasi Pengiraan PCB 2026 Menggunakan Pengiraan Berkomputer. Không thay đổi EPF, SOCSO, EIS hay SKBBK. |  |

### 2. `payComponents.pcbScopeHint`

Where: Visible hint under the PCB tick (shown only when PCB is ticked).

| Locale | Text | Reviewer |
|---|---|---|
| English (source) | Remuneration Type and Exemption Type are used for PCB (income tax) only. EPF, SOCSO, EIS and SKBBK are decided by the EPF, EPF Bonus 2012 and SOCSO/EIS ticks alone, on the whole amount. Only EPF Bonus 2012 puts this pay code's money on the EPF bonus stream. | n/a (source) |
| Bahasa Melayu | Jenis Saraan dan Jenis Pengecualian digunakan untuk PCB (cukai pendapatan) sahaja. EPF, PERKESO, SIP dan SKBBK ditentukan oleh tanda EPF, EPF Bonus 2012 dan SOCSO/EIS sahaja, ke atas keseluruhan jumlah. Hanya EPF Bonus 2012 meletakkan wang kod gaji ini dalam aliran bonus EPF. |  |
| Chinese (Simplified) | 薪酬类型和豁免类型仅用于 PCB（所得税）。EPF、SOCSO、EIS 和 SKBBK 只由 EPF、EPF Bonus 2012 和 SOCSO/EIS 勾选决定，并按全额计算。只有 EPF Bonus 2012 会把此工资代码的金额计入 EPF 花红部分。 |  |
| Tamil | ஊதிய வகையும் விலக்கு வகையும் PCB (வருமான வரி)க்கு மட்டுமே பயன்படுகின்றன. EPF, SOCSO, EIS மற்றும் SKBBK ஆகியவை EPF, EPF Bonus 2012 மற்றும் SOCSO/EIS தேர்வுகளால் மட்டுமே, முழுத் தொகையின் மீது தீர்மானிக்கப்படுகின்றன. இந்த ஊதியக் குறியீட்டின் பணத்தை EPF போனஸ் பிரிவில் வைப்பது EPF Bonus 2012 மட்டுமே. |  |
| Thai | ประเภทค่าตอบแทนและประเภทการยกเว้นใช้สำหรับ PCB (ภาษีเงินได้) เท่านั้น EPF, SOCSO, EIS และ SKBBK กำหนดโดยการติ๊ก EPF, EPF Bonus 2012 และ SOCSO/EIS เท่านั้น โดยคิดจากเต็มจำนวน มีเพียง EPF Bonus 2012 ที่นำเงินของรหัสจ่ายนี้เข้าส่วนโบนัสของ EPF |  |
| Vietnamese | Loại thù lao và Loại miễn trừ chỉ dùng cho PCB (thuế thu nhập). EPF, SOCSO, EIS và SKBBK chỉ do các dấu tích EPF, EPF Bonus 2012 và SOCSO/EIS quyết định, trên toàn bộ số tiền. Chỉ EPF Bonus 2012 đưa tiền của mã lương này vào phần thưởng của EPF. |  |

### 3. `payComponents.remunerationTypeTip`

Where: Tooltip beside "Remuneration Type".

| Locale | Text | Reviewer |
|---|---|---|
| English (source) | Used for PCB (income tax) only: how the pay code enters the PCB calculation (LHDN PCB 2026 specification) — Normal remuneration, Additional remuneration, or an Optional Deduction that reduces the monthly tax. It does not decide EPF, SOCSO, EIS or SKBBK: Additional remuneration with EPF ticked is normal EPF wages unless EPF Bonus 2012 is ticked. | n/a (source) |
| Bahasa Melayu | Digunakan untuk PCB (cukai pendapatan) sahaja: cara kod gaji ini masuk dalam pengiraan PCB (spesifikasi LHDN PCB 2026) — Saraan biasa, Saraan tambahan, atau Potongan Pilihan yang mengurangkan cukai bulanan. Ia tidak menentukan EPF, PERKESO, SIP atau SKBBK: Saraan tambahan dengan EPF ditanda ialah upah EPF biasa kecuali EPF Bonus 2012 ditanda. |  |
| Chinese (Simplified) | 仅用于 PCB（所得税）：此工资代码进入 PCB 计算的方式（LHDN PCB 2026 规范）——正常薪酬、附加薪酬，或减少月度税额的可选扣除。它不决定 EPF、SOCSO、EIS 或 SKBBK：勾选了 EPF 的附加薪酬属于 EPF 普通工资，除非勾选了 EPF Bonus 2012。 |  |
| Tamil | PCB (வருமான வரி)க்கு மட்டுமே பயன்படுகிறது: PCB கணக்கீட்டில் இந்த ஊதியக் குறியீடு நுழையும் விதம் (LHDN PCB 2026 விவரக்குறிப்பு) — சாதாரண ஊதியம், கூடுதல் ஊதியம், அல்லது மாத வரியைக் குறைக்கும் விருப்பக் கழிவு. இது EPF, SOCSO, EIS அல்லது SKBBK-ஐத் தீர்மானிக்காது: EPF தேர்வு செய்யப்பட்ட கூடுதல் ஊதியம், EPF Bonus 2012 தேர்வு செய்யப்படாவிட்டால், சாதாரண EPF சம்பளமாகும். |  |
| Thai | ใช้สำหรับ PCB (ภาษีเงินได้) เท่านั้น: วิธีที่รหัสจ่ายเข้าการคำนวณ PCB (ข้อกำหนด LHDN PCB 2026) — ค่าตอบแทนปกติ ค่าตอบแทนเพิ่มเติม หรือรายการหักตามเลือกที่ลดภาษีรายเดือน ไม่ได้กำหนด EPF, SOCSO, EIS หรือ SKBBK: ค่าตอบแทนเพิ่มเติมที่ติ๊ก EPF ถือเป็นค่าจ้าง EPF ปกติ เว้นแต่จะติ๊ก EPF Bonus 2012 |  |
| Vietnamese | Chỉ dùng cho PCB (thuế thu nhập): cách mã lương vào phép tính PCB (đặc tả LHDN PCB 2026) — Thù lao bình thường, Thù lao bổ sung, hoặc Khấu trừ tùy chọn làm giảm thuế hàng tháng. Không quyết định EPF, SOCSO, EIS hay SKBBK: Thù lao bổ sung có tích EPF là tiền lương EPF thông thường, trừ khi tích EPF Bonus 2012. |  |

### 4. `payComponents.exemptionTypeTip`

Where: Tooltip beside "Exemption Type".

| Locale | Text | Reviewer |
|---|---|---|
| English (source) | Used for PCB (income tax) only: the LHDN exemption or optional-deduction code with its yearly limit (RM). An exempt amount is left out of PCB only; EPF, SOCSO, EIS and SKBBK still count the whole amount when their ticks are on. The list follows the selected Remuneration Type: PCB codes for Normal/Additional, LP codes for Optional Deduction. | n/a (source) |
| Bahasa Melayu | Digunakan untuk PCB (cukai pendapatan) sahaja: kod pengecualian atau potongan pilihan LHDN dengan had tahunannya (RM). Jumlah yang dikecualikan hanya dikeluarkan daripada PCB; EPF, PERKESO, SIP dan SKBBK masih mengira keseluruhan jumlah apabila tandanya dipilih. Senarai mengikut Jenis Saraan yang dipilih: kod PCB untuk Biasa/Tambahan, kod LP untuk Potongan Pilihan. |  |
| Chinese (Simplified) | 仅用于 PCB（所得税）：LHDN 豁免或可选扣除代码及其年度限额（RM）。豁免金额只从 PCB 中扣除；勾选了相应项目时，EPF、SOCSO、EIS 和 SKBBK 仍按全额计算。列表随所选薪酬类型变化：正常/附加用 PCB 代码，可选扣除用 LP 代码。 |  |
| Tamil | PCB (வருமான வரி)க்கு மட்டுமே பயன்படுகிறது: ஆண்டு வரம்புடன் (RM) LHDN விலக்கு அல்லது விருப்பக் கழிவு குறியீடு. விலக்கப்பட்ட தொகை PCB-இலிருந்து மட்டுமே நீக்கப்படுகிறது; அவற்றின் தேர்வுகள் இருந்தால் EPF, SOCSO, EIS மற்றும் SKBBK முழுத் தொகையையும் கணக்கிடும். பட்டியல் தேர்ந்தெடுத்த ஊதிய வகையைப் பின்பற்றுகிறது: சாதாரண/கூடுதலுக்கு PCB குறியீடுகள், விருப்பக் கழிவுக்கு LP குறியீடுகள். |  |
| Thai | ใช้สำหรับ PCB (ภาษีเงินได้) เท่านั้น: รหัสยกเว้นหรือรายการหักตามเลือกของ LHDN พร้อมวงเงินต่อปี (RM) จำนวนที่ได้รับยกเว้นจะถูกตัดออกจาก PCB เท่านั้น EPF, SOCSO, EIS และ SKBBK ยังคงนับเต็มจำนวนเมื่อติ๊กไว้ รายการเปลี่ยนตามประเภทค่าตอบแทนที่เลือก: รหัส PCB สำหรับปกติ/เพิ่มเติม รหัส LP สำหรับรายการหักตามเลือก |  |
| Vietnamese | Chỉ dùng cho PCB (thuế thu nhập): mã miễn trừ hoặc khấu trừ tùy chọn của LHDN với hạn mức hàng năm (RM). Khoản được miễn chỉ bị loại khỏi PCB; EPF, SOCSO, EIS và SKBBK vẫn tính toàn bộ số tiền khi đã tích. Danh sách theo Loại thù lao đã chọn: mã PCB cho Bình thường/Bổ sung, mã LP cho Khấu trừ tùy chọn. |  |

### 5. `payComponents.epfConfigTip`

Where: EPF Configuration section tooltip.

| Locale | Text | Reviewer |
|---|---|---|
| English (source) | Controls how this pay code feeds the EPF (KWSP) contribution. The EPF tick alone decides whether the amount is EPF wages; the PCB Remuneration Type and Exemption Type do not change it. EPF Bonus 2012 marks it as a bonus payment under the EPF bonus contribution rules. | n/a (source) |
| Bahasa Melayu | Mengawal cara kod gaji ini menyumbang kepada caruman EPF (KWSP). Hanya tanda EPF yang menentukan sama ada jumlah itu upah EPF; Jenis Saraan dan Jenis Pengecualian PCB tidak mengubahnya. EPF Bonus 2012 menandakannya sebagai bayaran bonus di bawah peraturan caruman bonus EPF. |  |
| Chinese (Simplified) | 控制此工资代码如何计入 EPF（KWSP）缴纳基数。是否属于 EPF 工资只由 EPF 勾选决定；PCB 的薪酬类型和豁免类型不会改变它。EPF Bonus 2012 将其标记为按 EPF 花红缴纳规则处理的花红。 |  |
| Tamil | இந்த ஊதியக் குறியீடு EPF (KWSP) பங்களிப்பில் எவ்வாறு சேர்கிறது என்பதைக் கட்டுப்படுத்துகிறது. தொகை EPF சம்பளமா என்பதை EPF தேர்வு மட்டுமே தீர்மானிக்கிறது; PCB ஊதிய வகையும் விலக்கு வகையும் அதை மாற்றாது. EPF Bonus 2012 இதை EPF போனஸ் பங்களிப்பு விதிகளின் கீழ் போனஸ் கட்டணமாகக் குறிக்கிறது. |  |
| Thai | ควบคุมวิธีที่รหัสจ่ายนี้เข้าฐานเงินสมทบ EPF (KWSP) การติ๊ก EPF เพียงอย่างเดียวเป็นตัวกำหนดว่าจำนวนนี้เป็นค่าจ้าง EPF หรือไม่ ประเภทค่าตอบแทนและประเภทการยกเว้นของ PCB ไม่เปลี่ยนแปลงสิ่งนี้ โดย EPF Bonus 2012 ระบุว่าเป็นการจ่ายโบนัสตามกฎเงินสมทบโบนัสของ EPF |  |
| Vietnamese | Kiểm soát cách mã lương này vào cơ sở đóng góp EPF (KWSP). Chỉ dấu tích EPF quyết định khoản này có phải là tiền lương EPF hay không; Loại thù lao và Loại miễn trừ PCB không thay đổi điều đó. EPF Bonus 2012 đánh dấu đây là khoản thưởng theo quy tắc đóng góp thưởng của EPF. |  |

### 6. `payComponents.epfBonus2012Tip`

Where: Tooltip beside "EPF Bonus 2012".

| Locale | Text | Reviewer |
|---|---|---|
| English (source) | Treat this pay code as a bonus payment for EPF. This is the only setting that puts money on the EPF bonus stream, and a bonus under it is not SOCSO, EIS or SKBBK wages even when SOCSO/EIS is ticked. The amount is added to the month's wage and the EPF statutory table is read once for the total, so the employer rate follows the whole month (EPF Bonus 2012 rules). Requires EPF to be ticked. | n/a (source) |
| Bahasa Melayu | Anggap kod gaji ini sebagai bayaran bonus untuk EPF. Inilah satu-satunya tetapan yang meletakkan wang dalam aliran bonus EPF, dan bonus di bawahnya bukan upah PERKESO, SIP atau SKBBK walaupun SOCSO/EIS ditanda. Jumlah itu ditambah kepada upah bulan tersebut dan jadual berkanun EPF dirujuk sekali bagi jumlah keseluruhan, jadi kadar majikan mengikut keseluruhan bulan (peraturan EPF Bonus 2012). EPF mesti ditanda. |  |
| Chinese (Simplified) | 将此工资代码视为 EPF 花红。这是唯一会把金额计入 EPF 花红部分的设置；即使勾选了 SOCSO/EIS，按此设置处理的花红也不属于 SOCSO、EIS 或 SKBBK 工资。该金额并入当月工资后，按合计金额查一次 EPF 法定表，因此雇主费率取决于整个月（EPF Bonus 2012 规则）。须先勾选 EPF。 |  |
| Tamil | இந்த ஊதியக் குறியீட்டை EPF-க்கு போனஸ் கட்டணமாகக் கருதவும். EPF போனஸ் பிரிவில் பணத்தை வைக்கும் ஒரே அமைப்பு இதுவே; SOCSO/EIS தேர்வு செய்யப்பட்டிருந்தாலும் இதன் கீழ் உள்ள போனஸ் SOCSO, EIS அல்லது SKBBK சம்பளம் அல்ல. அத்தொகை அம்மாதத்தின் ஊதியத்துடன் சேர்க்கப்பட்டு, மொத்தத்திற்கு EPF சட்டப்பூர்வ அட்டவணை ஒரு முறை பார்க்கப்படுகிறது; எனவே முதலாளி விகிதம் முழு மாதத்தையும் பின்பற்றுகிறது (EPF Bonus 2012 விதிகள்). EPF தேர்வு செய்யப்பட்டிருக்க வேண்டும். |  |
| Thai | ถือว่ารหัสจ่ายนี้เป็นการจ่ายโบนัสสำหรับ EPF นี่เป็นการตั้งค่าเดียวที่นำเงินเข้าส่วนโบนัสของ EPF และโบนัสภายใต้การตั้งค่านี้ไม่ถือเป็นค่าจ้าง SOCSO, EIS หรือ SKBBK แม้จะติ๊ก SOCSO/EIS ไว้ จำนวนนี้จะถูกรวมเข้ากับค่าจ้างของเดือนนั้น แล้วอ่านตารางกฎหมาย EPF เพียงครั้งเดียวจากยอดรวม อัตรานายจ้างจึงเป็นไปตามทั้งเดือน (กฎ EPF Bonus 2012) ต้องติ๊ก EPF ก่อน |  |
| Vietnamese | Coi mã lương này là khoản thưởng cho EPF. Đây là thiết lập duy nhất đưa tiền vào phần thưởng của EPF, và khoản thưởng theo thiết lập này không phải là tiền lương SOCSO, EIS hay SKBBK kể cả khi đã tích SOCSO/EIS. Khoản này được cộng vào tiền lương của tháng và bảng luật định EPF được tra một lần cho tổng số, nên tỷ lệ của chủ lao động theo cả tháng (quy tắc EPF Bonus 2012). Cần tích EPF. |  |

## Build-agent observations (not a native review)

- No string was changed in this pass. The agent found no clearly wrong term: the field names inside the tooltips
  match each locale's field labels (table above), agency and checkbox names are kept, and Bahasa Melayu uses the
  standard PERKESO / SIP names. Fluency, register and natural word choice are left to the reviewers.
- Points for a reviewer's specific attention:
  - **zh**: "bonus" is rendered 花红 (the usual Malaysian Chinese term) and the EPF bonus stream as "EPF 花红部分".
    Confirm this reads naturally to Malaysian HR users (rather than 奖金).
  - **ta / th / vi**: "EPF bonus stream" is rendered as a "section/part" of EPF (பிரிவு / ส่วน / phần). Confirm it
    is understood as the bonus part of the EPF calculation, not a separate EPF account.
  - **all locales**: "normal EPF wages" (upah EPF biasa / EPF 普通工资 / சாதாரண EPF சம்பளம் / ค่าจ้าง EPF ปกติ /
    tiền lương EPF thông thường): confirm it reads as ordinary monthly wages for EPF.
- Accuracy against the engine: with the statutory follow-ups of 14 Nov 2026 (branch
  `claude/statutory-followups-20261114`) the sentence "Only EPF Bonus 2012 puts this pay code's money on the EPF
  bonus stream" holds for every pay item, including legacy items with no Remuneration Type. Before that change a
  legacy item ticked EPF but not SOCSO/EIS was still charged on the EPF bonus stream, so the hint overstated the
  rule for those items. No wording change is needed.

## Sign-off

| Locale | Reviewer (name) | Date | Result (OK, or corrections listed above) |
|---|---|---|---|
| Bahasa Melayu (ms) | | | |
| Chinese (zh) | | | |
| Tamil (ta) | | | |
| Thai (th) | | | |
| Vietnamese (vi) | | | |

After review: apply corrections to `messages/<locale>.json` (namespace `payComponents`, keys above), leave the
English unchanged unless the owner approves a source change, and run `test/pcb-scope-hint-20261113.dom.test.tsx`
and the i18n key-parity checks.
