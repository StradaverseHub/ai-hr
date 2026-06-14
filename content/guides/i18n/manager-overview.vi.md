Hướng dẫn này dành cho **người quản lý nhân sự** — bất kỳ ai có vai trò `manager` (và cũng áp dụng cho `hr_admin` và `super_admin`, những người thấy mọi thứ mà một người quản lý thấy và hơn thế nữa). Nó hướng dẫn bạn qua những gì thay đổi khi bạn có thể quản lý một nhóm: phần **Manage** mới trong thanh bên, cách **Dashboard** và **Org chart** cung cấp cho bạn thông tin trực tiếp về nhân sự của mình, cùng một nhịp điệu hằng ngày/hằng tuần đơn giản để không có gì đang chờ bạn xử lý bị bỏ sót.

## Phần Manage mở khóa những gì

Khi tài khoản của bạn có vai trò người quản lý, một nhóm mới sẽ xuất hiện trong thanh bên trái dưới tiêu đề **Manage**, nằm giữa các trang dùng hằng ngày (Dashboard, My workspace, People, Org chart, Leave, Attendance) và các công cụ chỉ dành cho quản trị viên. Nó chứa hai mục:

| Mục | Dẫn đến đâu | Dùng để làm gì |
| --- | --- | --- |
| **Approvals** | `/approvals` | Một hộp thư đến duy nhất cho mọi yêu cầu đang chờ quyết định của bạn |
| **Performance** | `/performance` | Các đánh giá đang chờ bạn, cùng các chu kỳ đánh giá (quản trị viên) |

**Lưu ý:** Nếu bạn không thấy tiêu đề **Manage**, tài khoản của bạn chưa được cấp vai trò người quản lý. Hãy yêu cầu một quản trị viên HR thiết lập tại **Admin → Users & roles**. Cả hai trang đều bị giới hạn quyền truy cập — mở chúng mà không có vai trò sẽ chuyển hướng bạn trở lại Dashboard.

**Mẹo:** Thanh bên có thể được thu gọn thành một dải chỉ có biểu tượng bằng cách dùng nút điều khiển **Collapse** ở dưới cùng. Di chuột qua bất kỳ biểu tượng nào để xem nhãn của nó. Lựa chọn của bạn được ghi nhớ giữa các lần truy cập.

### Approvals — hộp thư đến để ra quyết định của bạn

Trong thanh bên trái, nhấp vào **Approvals**. Trang này tập hợp mọi thứ cần một câu trả lời có/không từ bạn vào một nơi. Phần đầu trang cho bạn biết có bao nhiêu mục đang chờ (ví dụ, *"3 items awaiting a decision"*), hoặc *"Nothing waiting on you"* khi bạn đã xử lý xong. Nó được sắp xếp thành các thẻ:

1. **Yêu cầu nghỉ phép (Leave requests)** — mỗi hàng hiển thị **Employee**, **Type** của ngày nghỉ, **Dates** (bắt đầu → kết thúc), và số **Days**. Trong cột **Action**, nhấp **Approve** hoặc **Reject**.
2. **Chỉnh sửa chấm công (Attendance corrections)** — khi ai đó yêu cầu sửa giờ vào/ra, bạn sẽ thấy **Employee**, **Date**, các giờ **Proposed**, và **Reason** của họ. Một lần nữa, **Approve** hoặc **Reject** trong cột **Action**.
3. **Thay đổi hồ sơ (ngân hàng / thuế) (Profile changes (bank / tax))** — thẻ này chỉ xuất hiện đối với quản trị viên HR. Nó liệt kê các thay đổi được đề xuất đối với các thông tin nhạy cảm như thông tin ngân hàng hoặc thuế.

Bạn chỉ thấy các yêu cầu của những người trong phạm vi của mình — danh sách được tự động cắt gọn xuống còn những gì bạn được phép xử lý.

**Lưu ý:** Bạn không thể phê duyệt yêu cầu của chính mình. Nếu một hàng là của chính bạn, các nút hành động được thay thế bằng nhãn *"your request"* — phải có người khác quyết định nó. Việc cấm tự phê duyệt này là có chủ đích trong thiết kế.

**Mẹo:** Một thẻ trống chỉ đơn giản hiển thị *"No pending leave."* hoặc *"No pending corrections."* — đó là dấu hiệu mọi thứ ổn, không phải lỗi.

### Performance — đánh giá và chu kỳ

Trong thanh bên trái, nhấp vào **Performance**. Phụ đề ghi *"Review cycles, appraisals, and merit recommendations."* Những gì bạn thấy phụ thuộc vào vai trò của bạn:

- **Với tư cách người quản lý,** phần quan trọng là **Reviews awaiting you** — một thẻ được tô sáng màu hổ phách liệt kê đánh giá của từng nhân viên báo cáo trực tiếp, được gắn thẻ với tên chu kỳ và một huy hiệu đếm số. Nhấp **Review →** trên một hàng để mở bản đánh giá của người đó và hoàn thành nó.
- **Với tư cách quản trị viên HR,** bạn còn thấy thêm bảng **Review cycles** (Cycle, Period, Status, Progress, Pending pay) và một biểu mẫu **+ New review cycle** để khởi chạy một chu kỳ trên toàn tập đoàn hoặc cho một công ty, tùy chọn kèm theo một quỹ xét thưởng (merit pool).

Cột **Progress** sử dụng chú giải *ack / done / total* — đã xác nhận, đã gửi, và tổng số đánh giá — để quản trị viên có thể thấy ngay một chu kỳ đã tiến triển đến đâu.

**Mẹo:** Nếu thẻ **Reviews awaiting you** không hiển thị, nghĩa là hiện chưa có gì được giao cho bạn — nó chỉ xuất hiện khi bạn có các đánh giá đang chờ.

## Nắm bắt nhóm của bạn trong nháy mắt

Hai trang giúp bạn nhận thức tình hình trước cả khi mở hộp thư đến.

### Dashboard

**Dashboard** (mục đầu tiên trong thanh bên, hoặc nhấp vào logo **AI HR**) là bản tổng quan buổi sáng của bạn. Dọc theo phía trên là bốn thẻ thống kê — mỗi thẻ đều có thể nhấp được và nhảy thẳng đến trang liên quan:

- **Headcount** → People
- **Pending leave** (*Awaiting approval*) → Leave
- **Companies** → Organization
- **Latest payroll** → Payroll

Bên dưới đó, dòng thời gian **Planned absences** là chế độ xem hữu ích nhất đối với người quản lý: một dải 14 ngày cho biết ai nghỉ và nghỉ khi nào, để bạn có thể phát hiện những khoảng trống về nhân lực trước khi phê duyệt thêm ngày nghỉ. Dùng mũi tên trước/sau hoặc bộ chọn ngày để di chuyển cửa sổ thời gian.

Xuống thấp hơn nữa bạn sẽ thấy:

- **Onboarding** — ai mới gia nhập gần đây (60 ngày qua).
- **Upcoming events** — các ngày lễ công cộng sắp tới, kèm theo còn bao nhiêu ngày nữa.
- **Attendance** — phân bổ của hôm nay giữa **Present / Late / Half day / Absent** dưới dạng số đếm và một thanh màu.
- **Recent activity** — một luồng trực tiếp từ nhật ký sự kiện về những gì đang diễn ra trong phạm vi của bạn.

**Mẹo:** Thẻ **Pending leave** là cách kiểm tra nhanh nhất mỗi sáng — nếu nó khác không, hãy đến ngay **Approvals**.

### Org chart

Trong thanh bên trái, nhấp vào **Org chart** để xem cấu trúc báo cáo của bạn dưới dạng cây. Phần đầu trang hiển thị số nhân sự đang xem. Màu của mỗi đường kết nối mã hóa một mối quan hệ báo cáo khác nhau: **direct** (hành chính), functional, project, và **dotted-line**. Một người có một người quản lý trực tiếp (cây) nhưng có thể có nhiều đường liên kết chéo.

Bạn có thể **search** một người, **zoom in/out**, đặt lại mức thu phóng, và **expand or collapse** các nhân viên báo cáo của một người quản lý để tập trung vào một nhánh. Đây là cách nhanh nhất để xác nhận ai báo cáo cho ai trước khi quyết định nghỉ phép hoặc một bản đánh giá.

## Quy trình làm việc hằng ngày / hằng tuần của bạn

Một nhịp điệu đơn giản giúp bạn luôn kiểm soát mọi việc:

**Mỗi sáng (2 phút)**

1. Mở **Dashboard**. Liếc qua **Pending leave** và dải **Planned absences**.
2. Nếu có gì đang chờ, hãy nhấp **Approvals** và xử lý hết các thẻ **Leave requests** và **Attendance corrections** — **Approve** hoặc **Reject** từng mục, kiểm tra chế độ xem **Planned absences** trước để phát hiện xung đột về nhân lực.

**Trong một chu kỳ đánh giá**

3. Kiểm tra **Performance** → **Reviews awaiting you**. Mở từng mục qua **Review →** và hoàn thành nó trước khi chu kỳ đóng lại.

**Hằng tuần**

4. Mở **Org chart** để xác nhận cấu trúc nhóm của bạn là hiện hành — báo cáo bất kỳ khoảng trống nào cho một quản trị viên HR.
5. Quét qua **Recent activity** trên Dashboard để phát hiện bất cứ điều gì bất thường trong phạm vi của bạn.

## Những lỗi thường gặp

- **"Tôi không thấy Approvals hoặc Performance."** Bạn chưa có vai trò người quản lý — hãy yêu cầu một quản trị viên HR (Admin → Users & roles).
- **"Ngày nghỉ của chính tôi không có nút bấm."** Đúng vậy — bạn không thể phê duyệt yêu cầu của chính mình; hàng đó hiển thị *"your request"* thay vào đó. Phải có người khác quyết định.
- **"Hộp thư đến Approvals trông trống rỗng."** Các thẻ trống nghĩa là không có gì đang chờ — đó là điều tốt, không phải lỗi.
- **"Tôi không thấy thẻ Profile changes."** Thẻ đó chỉ dành cho quản trị viên HR; người quản lý phê duyệt nghỉ phép và chỉnh sửa chấm công.
- **"Một yêu cầu tôi mong đợi lại không có ở đó."** Bạn chỉ thấy các mục trong phạm vi của mình. Nếu nó thực sự bị thiếu, hãy xác nhận người đó báo cáo cho bạn trên **Org chart**, hoặc kiểm tra bộ chuyển đổi công ty ở thanh trên cùng.

Để biết toàn bộ chi tiết về từng khu vực, hãy xem các hướng dẫn chuyên sâu hơn: hướng dẫn **Approvals** để ra quyết định về nghỉ phép và chỉnh sửa, và hướng dẫn **Performance** để thực hiện đánh giá và đề xuất xét thưởng.
