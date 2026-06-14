Hướng dẫn này dành cho quản trị viên HR và cán bộ tuân thủ chịu trách nhiệm về việc nộp hồ sơ theo luật định của Malaysia. Nó dẫn dắt bạn qua mọi thứ trên màn hình **Payroll → Reports**: các số liệu EPF/KWSP, SOCSO/PERKESO, EIS và PCB hằng tháng; biểu mẫu EA hằng năm cho mỗi nhân viên; tờ khai của người sử dụng lao động Form E / CP8D; tệp văn bản MTD hằng tháng CP39; danh sách công việc CP22 / CP22A cho việc tuyển mới và chấm dứt; cùng các bản xuất CSV và thanh toán ngân hàng. Quan trọng nhất, nó giải thích **đâu là tệp sẵn sàng để nộp so với bản nháp hoặc bản tóm tắt mang tính tư vấn** — để bạn biết chính xác mình có thể trao gì cho LHDN, KWSP và PERKESO, và đâu là thứ vẫn cần con người kiểm tra trước.

Bạn sẽ cần vai trò `hr_admin` hoặc `super_admin`. Báo cáo được nộp **theo từng pháp nhân (công ty)**, vì vậy mọi thứ bạn tạo ra đều giới hạn trong công ty bạn chọn.

## Đi đến màn hình Reports

1. Trong thanh bên trái, mở **Payroll**.
2. Dọc theo phần trên cùng của khu vực Payroll, nhấp vào tab **Reports**. Tiêu đề trang hiển thị là **Payroll · Statutory & compliance reports**.

Ở trên cùng, bạn sẽ thấy thẻ **Compliance worklist · CP22 / CP22A**, sau đó là một biểu ngữ màu hổ phách giải thích lớp báo cáo, rồi đến biểu mẫu **Generate report**, và ở dưới cùng là bảng kiểm toán **Recent generations**.

> **Lưu ý — biểu ngữ Layer-A.** Hầu hết các báo cáo ở đây đều là **Layer-A**: một bản tóm tắt mà con người có thể đọc được, bạn dùng để nộp hoặc trao cho kế toán của mình. Biểu ngữ nói rõ điều đó: *"Byte-exact agency files (CP39 / KWSP / PERKESO / bank) come in a later slice, each sourced + verified."* Hãy xem các bảng trên màn hình và bản xuất CSV như một bản tóm tắt làm việc đáng tin cậy, chứ không phải tệp tải lên chính thức của cơ quan — với hai ngoại lệ được nêu dưới đây (CP39 .txt và bản tóm tắt thanh toán).

## Tạo báo cáo theo luật định hằng tháng

Biểu mẫu **Generate report** có bốn điều khiển: **Company**, **Report**, **Period (YYYY-MM)** (hoặc **Year (YYYY)** đối với báo cáo hằng năm), và một nút **Preview**.

1. Chọn **Company** (pháp nhân mà bạn đang nộp hồ sơ cho).
2. Chọn một **Report**. Các tùy chọn hằng tháng là:
   - `Monthly statutory contributions (overview)` — mọi khoản đóng góp trong một cái nhìn tổng quan: Gross, EPF (EE+ER), SOCSO (EE+ER), EIS (EE+ER) và PCB.
   - `CP39 — MTD / PCB (LHDN)`
   - `EPF contributions (KWSP)` — trên cơ sở Borang A, chia thành Employee / Employer / Total.
   - `SOCSO + EIS (PERKESO)` — trên cơ sở ASSIST, với các cột EE và ER.
3. Nhập **Period** dưới dạng `YYYY-MM`, ví dụ `2026-07`.
4. Nhấp **Preview**.

Trang sẽ tổng hợp báo cáo từ **lô bảng lương (payroll batch)** của công ty đó cho kỳ này. Bạn sẽ thấy các ô tổng tiêu đề (mỗi cột tiền một ô), rồi đến một bảng với mỗi nhân viên một hàng.

> **Mẹo.** Nếu bạn thấy *"No payroll batch found for … Run payroll for this period first."*, thì đơn giản là không có lô nào cho công ty và tháng đó. Hãy quay lại màn hình **Payroll** chính, chạy và xử lý lô đó, rồi quay lại đây.

### Đọc kiểm tra mức độ sẵn sàng

Phía trên bảng, một hộp màu đỏ có thể xuất hiện: **"N employee(s) missing identifiers needed to file."** Hộp này liệt kê những nhân viên có ID bắt buộc bị bỏ trống cho báo cáo đó — ví dụ thiếu `Tax no`, `EPF no`, hoặc `SOCSO no`. Các giá trị bị thiếu cũng hiển thị dưới dạng các ô đỏ trống trong bảng. Hãy sửa những điều này trước khi nộp: mở người đó dưới mục **People**, hoàn thiện danh tính theo luật định của họ, chạy lại bản xem trước. Một báo cáo sạch sẽ không có hộp màu đỏ.

## Xuất và ghi nhận báo cáo hằng tháng

Trong hàng tiêu đề báo cáo, bạn sẽ tìm thấy hai hoặc ba hành động:

- **Download CSV** — xuất chính xác các cột và hàng trên màn hình, được đặt tên như `my.cp39_2026-07.csv`. Đây là tệp làm việc để gửi cho kế toán của bạn hoặc đối chiếu với các cổng thông tin của cơ quan.
- **Record generation** — lưu một hiện vật `statutory report` chỉ-thêm (append-only) và đóng dấu nó bằng phiên bản các bảng theo luật định. Hãy dùng cái này khi bạn đã rà soát các số liệu và muốn có một bản ghi kiểm toán rằng "báo cáo này đã được tạo cho công ty và kỳ này." Nó **không** nộp bất cứ thứ gì cho bất kỳ cơ quan nào.
- **CP39 .txt — DRAFT, not for submission** — chỉ xuất hiện cho báo cáo CP39 khi mức độ sẵn sàng đã sạch (xem bên dưới).

Mỗi lần tạo được ghi nhận đều rơi vào bảng **Recent generations** ở dưới cùng, hiển thị loại báo cáo, kỳ, trạng thái (`draft`), số hàng và **Tables ver.** đã sử dụng — dấu vết khả năng tái lập của bạn.

## Tệp PCB hằng tháng CP39

CP39 là bản kê khai MTD/PCB hằng tháng gửi LHDN. Màn hình cung cấp cho bạn hai thứ:

1. **Bảng CP39 + CSV** (Layer-A) — Employee, Tax no, IC, MTD / PCB, kèm tổng cộng. Dùng cái này để rà soát và đối chiếu.
2. **Tải xuống CP39 .txt** (Layer-B) — một tệp văn bản độ rộng cố định theo bố cục byte LHDN e-Data PCB (Exhibit 4), phù hợp để tải lên cổng e-PCB.

Để lấy `.txt`: chọn báo cáo `CP39 — MTD / PCB (LHDN)`, xem trước một kỳ, và **đảm bảo không có lỗi sẵn sàng**. Khi mức độ sẵn sàng đã sạch, một nút màu hổ phách có nhãn **CP39 .txt — DRAFT, not for submission** sẽ xuất hiện trong tiêu đề. Nhấp để tải xuống.

> **Quan trọng — đây là BẢN NHÁP (DRAFT).** Nhãn nút, chú giải công cụ, và chính phần đầu của tệp đều nói như vậy: *"DRAFT until verified against e-PCB Plus."* Hãy mở nó ra, kiểm tra hợp lý các tổng cộng so với số liệu trên màn hình, và xác minh nó trong cổng **e-PCB Plus** trực tiếp trước khi bạn coi nó như một bản nộp. Mỗi lần tải xuống được ghi nhật ký như hiện vật theo luật định và sự kiện miền của riêng nó, vì vậy bạn có bản ghi của mọi bản nháp đã được kéo ra.

## Biểu mẫu EA hằng năm (mỗi nhân viên · C.P.8A)

Biểu mẫu EA là Bản kê khai Thù lao hằng năm của mỗi nhân viên.

1. Trong **Generate report**, chọn `Form E / CP8D — annual (LHDN)`. Trường kỳ chuyển sang **Year (YYYY)** — nhập ví dụ `2026`.
2. Nhấp **Preview** để tải bảng CP8D (mỗi nhân viên một hàng được đánh số).
3. Nhấp vào **tên một nhân viên** trong bảng để mở bản kê khai **EA (C.P.8A)** của họ.

Trang EA hiển thị: **A · Employee particulars** (tên, TIN, IC, EPF no., SOCSO no., loại MTD, số con, thời gian làm việc), **B · Employment income (cash)** (lương gộp bao gồm làm thêm giờ, tiền thưởng, phụ cấp, tổng thù lao gộp), **D · Total deductions** (MTD/PCB), **E · Contributions** (EPF/KWSP, SOCSO, EIS — phần của nhân viên), và **F · Tax-exempt allowances**. Dùng nút **Print** (góc trên bên phải) để tạo bản PDF hoặc bản giấy trao cho nhân viên.

> **Lưu ý — nhân viên có thể tự phục vụ.** Mỗi nhân viên có thể mở EA của riêng mình từ **My workspace** (EA liên kết tới `/payroll/reports/ea/…?year=2026`), nên bạn không phải in cho từng người.

> **Những gì EA KHÔNG bao gồm.** Tuyên bố miễn trừ màu xanh nói rõ điều đó. Các số liệu chỉ bao gồm thù lao bằng tiền mặt, EPF, SOCSO/EIS và MTD. **Lợi ích bằng hiện vật (Benefits-in-kind), giá trị chỗ ở, ESOS, trợ cấp thôi việc (gratuity), phụ cấp miễn thuế, zakat và CP38 không được theo dõi trong payroll** và hiển thị là `not tracked`. Hãy thêm bất kỳ khoản nào trong số này trước khi nộp. Đây là một bản kê khai làm việc được tạo ra, không phải vật thay thế cho biểu mẫu LHDN chính thức.

## Form E / CP8D (tờ khai của người sử dụng lao động hằng năm)

Cùng bản xem trước `Form E / CP8D — annual (LHDN)` liệt kê các nhân viên cũng cung cấp cho bạn tờ khai của người sử dụng lao động:

- **Các ô tóm tắt** ở trên cùng là **số đầu người của Form E Part A**: Đang hoạt động tính đến 31 Th12, Chịu MTD, Tuyển mới, Đã chấm dứt.
- **Bảng CP8D** là biểu mỗi nhân viên: No., Employee, TIN, IC, Cat., Children, Gross remuneration, EPF, MTD/PCB, SOCSO — cộng với các tổng cộng.
- **Download CSV** để trao cho đại lý thuế của bạn, hoặc **Record generation** cho dấu vết kiểm toán.

> **Quan trọng — cùng cảnh báo về phạm vi.** Ghi chú màu xanh trên báo cáo này cảnh báo rằng nó chỉ bao gồm các số liệu phát sinh từ payroll. **Lợi ích bằng hiện vật, chỗ ở, ESOS, phụ cấp miễn thuế, zakat và CP38 không có ở đây** — hãy thêm chúng vào **MyTax / e-CP8D** trước khi nộp.

## Danh sách công việc CP22 / CP22A (tuyển mới & chấm dứt)

Thẻ **Compliance worklist · CP22 / CP22A** ở đầu trang được điều khiển bởi vòng đời tuyển dụng/chấm dứt trong nhật ký sự kiện. Nó làm nổi bật các thông báo LHDN sắp đến hạn, để không gì bị lọt:

| Cột | Ý nghĩa |
| --- | --- |
| **Employee** | Thông báo dành cho ai |
| **Form** | `CP22` (tuyển mới) hoặc `CP22A` (chấm dứt) |
| **Reason** | `New hire` (tuyển mới) hoặc `Cessation` (chấm dứt) |
| **Event date** | Ngày tuyển dụng, hoặc ngày chấm dứt |
| **Notify by** | Hạn chót (30 ngày sau khi tuyển; ≥30 ngày trước khi chấm dứt) |
| **Status** | `overdue` (đỏ), `due soon` (hổ phách, trong vòng 7 ngày), hoặc `upcoming` (xám) |

Các mục được sắp xếp quá hạn (overdue) trước. Khi không có gì đang chờ, bạn sẽ thấy **"Nothing due."**

> **Quan trọng — đây chỉ mang tính tư vấn.** Như thẻ nêu rõ: *"File in MyTax; this surfaces what's outstanding."* Ứng dụng **không bao giờ tự động nộp** CP22/CP22A. Hãy dùng danh sách công việc làm lời nhắc của bạn, rồi tự nộp trong MyTax. Hiện chưa có "mark as filed", vì vậy một mục chỉ đơn giản hết hiệu lực khỏi cửa sổ liên quan sau hạn chót của nó.

## Bản tóm tắt thanh toán ngân hàng (tải lên ngân hàng thủ công)

**payment summary** là một CSV trung lập gồm nhân viên / ngân hàng / tài khoản / lương thực nhận để tải lên ngân hàng của bạn. Nó được tạo từ một lô bảng lương **đã xử lý hoặc đã đóng** (tải xuống từ lô đó trên màn hình **Payroll** chính, không phải từ biểu mẫu Reports). Chỉ dành cho quản trị viên; bản xuất được ghi nhật ký như một sự kiện miền trên lô.

> **Lưu ý — không phải tệp giro.** Đây là một CSV thông thường, **không phải** một tệp giro riêng cho ngân hàng chính xác đến từng byte. Nếu một lô chưa sẵn sàng, bạn sẽ nhận được một thông báo "not ready" rõ ràng cho bạn biết phải làm gì; hoàn thành xử lý lô và thử lại.

## Tham khảo nhanh: sẵn sàng để nộp vs bản nháp/tư vấn

| Đầu ra | Nó là gì | Trạng thái |
| --- | --- | --- |
| Các bảng hằng tháng + **Download CSV** (đóng góp, CP39, EPF, SOCSO/EIS) | Bản tóm tắt Layer-A con người đọc được | **Tư vấn** — nộp từ đó / trao cho kế toán |
| **CP39 .txt** | Bố cục byte LHDN e-Data PCB (Exhibit 4) | **BẢN NHÁP** — xác minh trong e-PCB Plus trước |
| **EA (C.P.8A)** mỗi nhân viên | Bản kê khai thù lao, có thể in | **Tư vấn** — chỉ các khoản tiền mặt; thêm BIK v.v. |
| Bảng **Form E / CP8D** + CSV | Tờ khai của người sử dụng lao động hằng năm | **Tư vấn** — hoàn tất trong MyTax / e-CP8D |
| Danh sách công việc **CP22 / CP22A** | Lời nhắc nộp hồ sơ | **Tư vấn** — nộp trong MyTax; không bao giờ tự động nộp |
| CSV **Payment summary** | Danh sách tải lên ngân hàng | Sẵn sàng để tải lên ngân hàng **thủ công** (không phải tệp giro) |
| **Record generation** | Hiện vật kiểm toán chỉ-thêm | Một bản ghi kiểm toán — **không phải** một bản nộp |

## Khắc phục sự cố & những cạm bẫy thường gặp

- **"No payroll batch found …"** — chạy payroll cho công ty và kỳ đó trước, rồi xem trước lại.
- **Hộp "missing identifiers" màu đỏ / các ô đỏ trống** — hoàn thiện IC, Tax no, EPF no hoặc SOCSO no của nhân viên dưới mục **People** trước khi nộp.
- **Không có nút CP39 .txt** — nó chỉ xuất hiện cho báo cáo CP39 với **không** có lỗi sẵn sàng nào. Hãy xóa hộp đỏ trước.
- **Tổng cộng EA / CP8D trông thấp** — hãy nhớ lợi ích bằng hiện vật, chỗ ở, ESOS, trợ cấp thôi việc, phụ cấp miễn thuế, zakat và CP38 không được theo dõi; thêm chúng vào MyTax trước khi nộp.
- **Nộp số liệu của nhầm công ty** — mỗi báo cáo là theo từng pháp nhân. Hãy kiểm tra lại bộ chọn **Company** trước khi bạn xuất.
- **"Record generation" trông như không làm gì** — đó là một hành động kiểm toán, không phải một bản nộp. Hãy xác nhận nó trong **Recent generations** ở dưới cùng trang.
