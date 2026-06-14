Hướng dẫn này dành cho quản trị viên HR và cán bộ tính lương chạy bảng lương hàng tháng của Malaysia trong AI HR. Đến cuối hướng dẫn, bạn sẽ biết cách thiết lập hồ sơ pháp định của nhân viên, tạo và xử lý một đợt (batch) bảng lương, đọc hiểu cách tính EPF/KWSP, SOCSO/PERKESO, EIS/SIP và PCB/MTD, xử lý tiền thưởng, làm thêm giờ, nghỉ không lương và tính theo tỷ lệ, đóng một đợt để nó trở nên không thể thay đổi, và hành động theo khuyến nghị lương cuối cùng cho người nghỉ việc. Bạn cần vai trò **hr_admin** hoặc **super_admin** để truy cập mô-đun Payroll.

## Trước khi chạy bảng lương: hồ sơ pháp định

Mọi con số trên phiếu lương đều được điều khiển bởi hồ sơ pháp định của nhân viên. Hãy thiết lập nó trước, vì bất kỳ ai thiếu dữ liệu bắt buộc vẫn sẽ xuất hiện trong đợt nhưng với các khoản khấu trừ không đầy đủ.

1. Trong thanh bên trái, nhấp **People**, sau đó nhấp tên nhân viên để mở trang chi tiết của họ.
2. Tìm thẻ **Statutory (Malaysia)** (cột bên phải, cạnh **Compensation**).
3. Điền vào các trường, sau đó nhấp **Save statutory**.

### Các trường trên thẻ Statutory (Malaysia)

| Trường | Ghi chú |
| --- | --- |
| **IC number** | Bắt buộc. 12 chữ số (ví dụ `900101011234`). Được xác thực và duy nhất cho mỗi tenant — khoảng trắng và dấu gạch ngang được tự động loại bỏ. |
| **EPF number** | Số thành viên KWSP. |
| **SOCSO number** | Số PERKESO. |
| **Tax number** | Số thuế thu nhập (PCB) của LHDN. |
| **PCB category** | `1 — Single`, `2 — Married, spouse not working`, hoặc `3 — Married, spouse working`. Điều khiển khoản miễn giảm MTD. Mặc định là `1`. |
| **Children (PCB relief)** | Số con đủ điều kiện cho khoản miễn giảm PCB. |
| **Bank** / **Bank account** | Được sử dụng bởi việc xuất bản tóm tắt thanh toán. |
| **EIS eligible** | Hộp kiểm. Bỏ chọn cho nhân viên ngoài phạm vi bảo hiểm SIP (ví dụ đóng góp lần đầu sau tuổi 57 không có lịch sử trước đó). |
| **Tax resident** | Hộp kiểm. Bỏ chọn cho người không cư trú — họ trả **30% MTD** cố định mà không có khoản miễn giảm nào. |

### TP3 / số dư đầu kỳ (chỉ dành cho người áp dụng giữa năm)

Phần **Previous employment this year (TP3 / opening balances)** khởi tạo các bộ tích lũy PCB để MTD chính xác khi bạn áp dụng AI HR giữa năm hoặc tuyển một người đã làm việc ở nơi khác trong năm dương lịch này. Lấy các con số từ **Form TP3** của nhân viên (hoặc hệ thống lương trước khi di chuyển dữ liệu của bạn):

- **Applies to year** — năm dương lịch mà các số dư này thuộc về (ví dụ `2026`). Số dư chỉ được sử dụng khi nó khớp với năm trả lương của đợt.
- **Accumulated net remuneration (Y−K)**
- **EPF claimed toward relief (K)**
- **PCB already deducted (X)**

**Lưu ý:** Các con số TP3 không bao giờ được in trên phiếu lương hoặc mẫu EA. Chúng chỉ cung cấp cho phép tính PCB lũy kế.

**Mẹo:** Bản thân tiền lương nằm trên thẻ **Compensation** bên cạnh. Sử dụng **Update pay** ở đó để đặt **Basic salary (MYR)** và **Allowance** trước khi chạy bảng lương — việc tính theo tỷ lệ và tất cả các cơ sở pháp định đều đọc bản ghi lương thưởng hiện tại.

## Tạo một đợt bảng lương

1. Trong thanh bên trái, nhấp **Payroll**. Bạn sẽ đến tab **Batches**, liệt kê mọi đợt với **Period**, **Company**, **Employees**, **Net pay** và **Status** của nó.
2. Ở cuối bảng các đợt, sử dụng biểu mẫu tạo:
   - **Company** — chọn công ty để chạy.
   - **Pay period** — gõ `YYYY-MM` (ví dụ `2026-05`). Mặc định là tháng hiện tại.
3. Nhấp **Create batch**.

Đợt mới mở ở trạng thái `Draft`. **Lưu ý:** chỉ có thể tồn tại một đợt cho mỗi công ty cho mỗi kỳ trả lương — lần thử thứ hai cho cùng một kỳ sẽ bị từ chối.

## Đợt nháp: dữ liệu đầu vào, làm thêm giờ, tiền thưởng

Mở đợt từ danh sách. Khi nó là `Draft`, bạn sẽ thấy một tuyên bố miễn trừ trách nhiệm tuân thủ màu hổ phách, **khuyến nghị người nghỉ việc** (nếu có), và **trình chỉnh sửa đầu vào** liệt kê mọi nhân viên đang làm việc trong kỳ.

### Làm thêm giờ, tiền thưởng, TP1 và zakat (theo từng nhân viên)

Mỗi hàng trong bảng đầu vào có bốn trường số cộng với **Save**:

- **OT** — số tiền làm thêm giờ nhập thủ công (RM).
- **Bonus** — thù lao bổ sung (RM) chẳng hạn như tiền thưởng theo hợp đồng hoặc, đối với người nghỉ việc, là phép năm được quy đổi thành tiền.
- **TP1** — khoản khấu trừ TP1 của nhân viên (các khoản miễn giảm thuế được phê duyệt làm giảm PCB).
- **Zakat** — zakat đã trả, bù trừ vào PCB.

Nhập giá trị và nhấp **Save** trên hàng đó. Cột **unpaid days** ngoài cùng bên phải chỉ đọc.

**Mẹo — điền trước làm thêm giờ từ chấm công:** thay vì gõ OT, hãy nhấp **Prefill OT** phía trên bảng. AI HR đọc chấm công đã được phân loại cho kỳ và quy đổi thành tiền theo mức lương thông thường của Luật Lao động (ORP = lương tháng ÷ 26): 1.5× vào ngày làm việc, quy tắc nửa ngày/cả ngày nghỉ cộng 2×, và quy tắc ngày lễ cộng 3×. Nhân viên có thu nhập trên **RM4,000** không đủ điều kiện hưởng OT theo luật định và sẽ bị bỏ qua — hãy trả bất kỳ OT ex-gratia nào cho họ bằng cách gõ thủ công vào trường **OT**. Các giá trị **Bonus** hiện có được bảo toàn bởi việc điền trước; bạn vẫn có thể ghi đè bất kỳ con số nào sau đó.

### Nghỉ không lương và tính theo tỷ lệ (tự động)

Bạn không cần nhập những thứ này:

- **Nghỉ không lương** được tự động suy ra từ các yêu cầu `approved` trên loại nghỉ không lương **bắt đầu** trong kỳ. Nó khấu trừ theo mức thông thường (lương cơ bản tháng ÷ số ngày trong tháng). Đây là nguồn sự thật duy nhất được chia sẻ với mô-đun Leave — không nhập trùng.
- **Tính theo tỷ lệ** cho người vào và nghỉ giữa tháng là tự động: lương cơ bản và phụ cấp được điều chỉnh theo số ngày dương lịch được thuê trong tháng (cơ sở tháng không trọn vẹn EA 1955 s.18A). Phiếu lương hiển thị **số ngày làm việc** so với tổng số của tháng.

## Tạo phiếu lương

1. Với đợt ở trạng thái `Draft`, nhấp **Generate payslips** (góc trên bên phải của trang đợt).
2. Đợt chuyển sang `Processed`, bảng phiếu lương theo từng nhân viên được điền đầy, và bốn tổng số xuất hiện: **Total gross**, **Total deductions**, **Total net**, **Total employer cost**.

Bảng phiếu lương hiển thị **Gross**, **Bonus**, **EPF**, **SOCSO**, **EIS**, **PCB** và **Net** cho từng nhân viên. Nhân viên được tính theo tỷ lệ được đánh dấu nội tuyến với con số ngày làm việc của họ.

### Cách tính từng dòng pháp định

| Khoản đóng góp | Cơ sở | Ghi chú |
| --- | --- | --- |
| **EPF / KWSP** | Cơ bản + phụ cấp + **tiền thưởng**, **không bao gồm** làm thêm giờ | Hiển thị cả phần của nhân viên và người sử dụng lao động. |
| **SOCSO / PERKESO** | Bao gồm làm thêm giờ, **không bao gồm** tiền thưởng | Nhân viên từ **60 tuổi trở lên** chuyển sang Hạng mục thứ hai (chỉ người sử dụng lao động). |
| **EIS / SIP** | Bao gồm làm thêm giờ, **không bao gồm** tiền thưởng | Bảo hiểm áp dụng cho độ tuổi 18–60; kết thúc ở tuổi 60 hoặc khi bỏ chọn **EIS eligible**. |
| **PCB / MTD** | Bao gồm làm thêm giờ và **tiền thưởng** (phương pháp chênh lệch thù lao bổ sung) | Sử dụng phương pháp lũy kế của LHDN: hạng mục PCB, số con, TP1, zakat và các bộ tích lũy lũy kế từ đầu năm đến nay (được khởi tạo bởi TP3). Người không cư trú: cố định 30%. |

**Lưu ý:** Các bộ tích lũy PCB lũy kế từ đầu năm đến nay được xây dựng lại bằng cách phát lại các phiếu lương trước đó của năm thuế này theo thứ tự, vì vậy hãy luôn xử lý các tháng **theo trình tự** trong một năm dương lịch để có MTD chính xác.

## Đóng đợt (tính không thể thay đổi)

1. Với đợt ở trạng thái `Processed`, xem lại các tổng số và phiếu lương.
2. Nhấp **Close batch**.
3. Trạng thái trở thành `Closed`.

**Một đợt đã đóng là không thể thay đổi** — phiếu lương và tổng số được đóng băng để kiểm toán. Bạn không còn có thể chỉnh sửa đầu vào, điền trước OT, hoặc tạo lại. Nếu bạn phát hiện lỗi sau khi đóng, hãy sửa nó trong kỳ tiếp theo.

**Mẹo:** xuất tệp ngân hàng từ các đợt `Processed` hoặc `Closed` — bản tải xuống **Payment summary** (góc trên bên phải, một khi đã qua `Draft`) tạo ra một CSV trung lập gồm nhân viên, IC, ngân hàng, tài khoản và lương ròng để tải lên thủ công vào cổng ngân hàng của bạn. Các hàng thiếu chi tiết ngân hàng được đánh dấu trong bản xuất.

## Khuyến nghị lương cuối cùng cho người nghỉ việc

Khi bạn chấm dứt một người (trên trang chi tiết **People** của họ, thẻ **Terminate**) và ngày cuối cùng của họ rơi vào trong kỳ của một đợt, đợt nháp sẽ hiển thị một khuyến nghị **người nghỉ việc** liệt kê **phép năm chưa sử dụng**, **ORP mỗi ngày** (cơ bản ÷ 26), và một số tiền trả thay thế **được đề xuất** (EA 1955 s.60E).

**Đây chỉ là khuyến nghị — không có tự động trả.** Nếu bạn chọn trả khoản đó, hãy gõ số tiền vào trường **Bonus** của nhân viên đó trong trình chỉnh sửa đầu vào trước khi tạo phiếu lương. AI HR cố tình để quyết định cho bạn vì cách xử lý EPF/PCB đối với việc quy đổi phép thành tiền phụ thuộc vào chính sách của bạn.

## Những lỗi thường gặp

- **Thiếu IC number** — `Save statutory` bị từ chối nếu IC không phải 12 chữ số. Sửa trước khi chạy bảng lương.
- **Chưa đặt lương thưởng** — một nhân viên không có lương cơ bản hiện tại không thể quy đổi thành tiền; hãy đặt nó qua **Update pay** trước.
- **Chạy các tháng không theo thứ tự** — phá vỡ PCB lũy kế. Xử lý tháng Một → tháng Mười Hai theo trình tự.
- **Người thu nhập cao và OT** — bất kỳ ai trên RM4,000 đều bị **Prefill OT** bỏ qua; nhập bất kỳ OT tùy ý nào theo cách thủ công.
- **Chỉnh sửa sau khi đóng** — không thể. Xác minh các tổng số trước khi nhấp **Close batch**.
- **Đợt trùng lặp** — một đợt cho mỗi công ty cho mỗi `YYYY-MM`; kiểm tra danh sách trước khi tạo.
