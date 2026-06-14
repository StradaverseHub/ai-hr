Hướng dẫn này dành cho quản trị viên HR thiết lập AI HR lần đầu tiên. Nó đưa bạn từ một cơ sở dữ liệu trống đến một bộ máy vận hành HR Malaysia đang chạy — cấu trúc công ty, nhân sự, hồ sơ pháp định, quy tắc nghỉ phép, vai trò, và lần chạy bảng lương đầu tiên của bạn — theo đúng trình tự thực sự hiệu quả. Hãy làm từ trên xuống dưới: các bước sau phụ thuộc vào các bước trước (bạn không thể tuyển người vào một công ty chưa tồn tại, và bạn không thể chạy bảng lương cho một nhân viên không có số IC).

## 1. Đăng nhập lần đầu và khái niệm danh tính / vai trò

Khi bạn mở ứng dụng, bạn sẽ đến **Dashboard**. Thanh bên trái là bản đồ của bạn: Dashboard, My workspace, People, Org chart, Leave, Attendance, Approvals, Performance, và — đối với quản trị viên — một nhóm **Admin** (Organization, Leave config, Users & roles, Audit trail) cùng với **Payroll**.

**Danh tính hoạt động như thế nào.** Các lượt đăng nhập trên môi trường production được cấp phát thông qua **WorkOS** (SSO hoặc lời mời). Trong môi trường cục bộ/phát triển, bạn sẽ thấy một menu thả xuống nhỏ **Dev as** ở thanh trên cùng — nó cho phép bạn "đóng vai" bất kỳ principal nào đã được seed (ví dụ *HR Admin · hr_admin*) để kiểm tra xem mỗi vai trò nhìn thấy gì. Hãy chọn danh tính `hr_admin` (hoặc `super_admin`) trước khi bạn bắt đầu; các phần Admin và Payroll chỉ xuất hiện với những vai trò đó.

**Bốn vai trò**, theo thứ tự quyền hạn tăng dần: `employee` → `manager` → `hr_admin` → `super_admin`. Bạn sẽ gán những vai trò này ở bước 7.

**Lưu ý.** Mọi thay đổi đều được ghi lại cùng với danh tính của bạn trong **Audit trail** (`Admin → Audit trail`). Không có gì là ẩn danh — đó là chủ đích thiết kế.

## 2. Tạo cấu trúc công ty của bạn

Trong thanh bên, mở **Admin → Organization**. Bạn sẽ thấy **Group structure** (một cây của mọi công ty) và một danh sách **Companies** bên dưới nó.

Một tập đoàn Malaysia điển hình có một công ty holding nằm trên một pháp nhân hoạt động. Hãy xây dựng theo trình tự đó:

1. Cuộn xuống biểu mẫu **Add company** ở cuối thẻ Companies.
2. Nhập công ty holding vào **Legal name** (ví dụ `Demo Group Holdings Bhd`). Để **Country** là `MY` và **Currency** là `MYR`.
3. Nhấp **Add company**.
4. Lặp lại cho pháp nhân hoạt động của bạn (ví dụ `Demo Sdn Bhd`).
5. Nhấp vào một hàng công ty để **mở rộng** nó. Dưới **Group parent**, đặt **Parent company** của pháp nhân hoạt động thành công ty holding rồi nhấp **Set parent**. Cây Group structure giờ đây sẽ lồng chúng vào nhau.

**Bên trong mỗi bảng công ty đã mở rộng**, bạn cũng quản lý các khối cấu thành của nó — những thứ này nằm *bên trong* công ty, không phải ở cấp toàn cục:

- **Departments** — gõ một tên (ví dụ `Finance`, `Engineering`) rồi nhấp **Add**.
- **Positions** — một chức danh công việc (ví dụ `Executive`) rồi nhấp **Add**.
- **Cost centres** — một **Code** ngắn (ví dụ `HQ`) và một **Name** (ví dụ `Headquarters`), rồi **Add**.

**Danh tính pháp định (MY).** Vẫn ở bên trong bảng, hãy điền phần **Statutory identity (MY)** cho pháp nhân thực sự tuyển dụng nhân sự: **EPF employer no**, **SOCSO employer code**, **LHDN E-number**, **MyInvois TIN**, **SSM registration no**. Nhấp **Save statutory identity**. Phần đầu của bảng sẽ hiển thị một huy hiệu `statutory ✓` khi cả ba mã định danh nộp hồ sơ (EPF, SOCSO, LHDN) đã hiện diện — chúng cung cấp dữ liệu cho mọi báo cáo hàng tháng và hàng năm.

**Mẹo.** Hãy xây dựng các phòng ban và chức vụ trên công ty *hoạt động*, không phải vỏ holding — đó là nơi nhân sự được tuyển dụng.

**Lưu ý về xóa so với lưu trữ.** Một bản ghi đang được tham chiếu (một phòng ban có nhân viên, một công ty có công ty con) không thể bị xóa — thay vào đó ứng dụng đề xuất **Archive** để lịch sử vẫn còn nguyên vẹn. Chỉ một bản ghi không được sử dụng mới hiển thị tùy chọn **Delete**.

## 3. Thêm nhân sự

Mở **People** trong thanh bên. Bạn có hai cách để đưa nhân sự vào.

### Tuyển từng người một

1. Trên trang People, mở rộng **Hire an employee** ở dưới cùng.
2. Điền **Full name**, **Email**, chọn **Company** và **Department**, đặt **Employment type** (`Full time`, `Part time`, `Contract`, hoặc `Intern`), và **Hire date**.
3. Nhấp **Hire**. Nghỉ phép tiêu chuẩn (thường niên, ốm, nằm viện) được cấp tự động dựa trên chính sách của công ty và mức sàn pháp định Malaysia.

### Nhập CSV hàng loạt (di chuyển dữ liệu ngày đầu tiên)

Để onboard cả một công ty cùng lúc, nhấp **Import CSV** (góc trên bên phải của People), hoặc truy cập `/people/import`.

1. Chọn **Target company**.
2. Dán CSV của bạn vào **CSV data**, hoặc nhấp **Load sample** để xem định dạng chính xác. Mở rộng **Column reference** để xem các cột bắt buộc so với tùy chọn.
   - **Bắt buộc:** `full_name`, `email`, `department`, `hired_on`, `ic_number`, `basic_salary`.
   - **Tùy chọn:** `phone`, `position`, `cost_center`, `employment_type`, `monthly_allowance`, `bank_name`, `bank_account_no`, `epf_number`, `socso_number`, `tax_number`, `tax_category`, `num_children`, `eis_eligible`, `is_resident`.
3. Nhấp **Validate**. Một bảng xem trước hiển thị mỗi hàng là `ready` (xanh lá) hoặc có lỗi (đỏ). Tên phòng ban được đối chiếu với công ty mục tiêu.
4. Khi bản xem trước trông đúng, nhấp **Import N valid** để xác nhận. Một bản tóm tắt màu xanh lá cho biết có bao nhiêu được nhập, bỏ qua, hoặc thất bại.

**Các lỗi thường gặp.**

- `department` phải khớp với một phòng ban đã tồn tại trong công ty mục tiêu (không phân biệt chữ hoa/thường) — hãy tạo các phòng ban của bạn ở bước 2 trước.
- `hired_on` nên ở định dạng `YYYY-MM-DD`.
- `bank_name` và `bank_account_no` là cả-hai-hoặc-không — cung cấp cả hai hoặc để trống cả hai.

## 4. Thiết lập hồ sơ pháp định Malaysia của từng nhân viên

Nhập CSV đã thu thập sẵn các thông tin pháp định cơ bản. Để xem lại hoặc điền chúng cho một nhân viên được tuyển thủ công, mở **People**, nhấp vào tên người đó, và sử dụng thẻ **Statutory (Malaysia)**:

| Trường | Dùng để làm gì |
|---|---|
| **IC number** | NRIC — bắt buộc cho bất kỳ việc nộp hồ sơ pháp định nào |
| **EPF / KWSP number** | Số thành viên EPF |
| **SOCSO number** | Số người đóng góp PERKESO |
| **Tax number** | Số hồ sơ thuế LHDN |
| **PCB category** | `1 — Single`, `2 — Married, spouse not working`, `3 — Married, spouse working` |
| **Children** | Số con đủ điều kiện (ảnh hưởng đến mức miễn giảm PCB) |
| **Bank name / account no** | Cho bản tóm tắt thanh toán |
| **EIS eligible / Resident** | Các ô đánh dấu; ảnh hưởng đến cách xử lý EIS và PCB |

Đặt lương trên cùng trang dưới mục **Update pay**: nhập **Basic salary (MYR)** và bất kỳ **monthly allowance** nào, rồi lưu.

**Lưu ý.** Bảng lương sẽ chưa hoàn toàn sẵn sàng cho một nhân viên thiếu IC, số thuế, số EPF hoặc SOCSO — bước kiểm tra **Readiness** của báo cáo (bước 8/9) sẽ chỉ ra chính xác ai và thiếu cái gì.

## 5. Cấu hình nghỉ phép

Mở **Admin → Leave config**. Trang này có một thẻ **Leave types** và một thẻ **Leave year**.

**Loại nghỉ phép và quyền lợi.** Một gói Malaysia seed các loại tiêu chuẩn (thường niên, ốm, nằm viện) với mức sàn pháp định đã được kết nối sẵn.

1. Mở rộng một loại nghỉ phép để xem **Statutory minimum (MY)** của nó (chỉ đọc — mức sàn theo EA 1955 theo dải thâm niên: dưới 2 / 2–5 / 5+ năm) và dòng thời gian **Company entitlements** của nó.
2. Để cung cấp *nhiều hơn* mức sàn, nhấp **+ Add entitlement**, đặt **Days per year** (và, đối với nghỉ phép thường niên, một **Carry-cap**), chọn **Effective from**, rồi **Add**. Việc cấp luôn áp dụng giá trị **lớn hơn** giữa mức sàn và chính sách của bạn — một giá trị dưới mức tối thiểu được ghi lại nhưng không bao giờ được áp dụng (bạn sẽ thấy một huy hiệu `below minimum`).
3. Để thêm một loại tùy chỉnh, hãy dùng biểu mẫu ở dưới cùng: **Code** (chữ in hoa, ví dụ `ANNUAL`), **Name**, ô đánh dấu **Paid**, rồi **Add type**.

**Mở năm nghỉ phép.** Trong thẻ **Leave year**, đặt **Year** (mặc định là năm tiếp theo) rồi nhấp **Open leave year**. Thao tác này hạch toán quyền lợi mới của mọi nhân viên đang hoạt động theo dải thâm niên hiện tại của họ, chuyển nghỉ phép thường niên chưa dùng sang lên đến mức trần (phần còn lại bị hủy), và đặt lại nghỉ ốm/nằm viện. Nó có tính idempotent — chạy lại sẽ bỏ qua bất kỳ ai đã được mở.

## 6. Chính sách chấm công

Mỗi công ty hoạt động được cấp một chính sách chấm công mặc định khi nó được tạo, nên check-in/check-out và làm thêm giờ hoạt động ngay lập tức. Mở **Attendance** trong thanh bên để xem các lần chấm công hôm nay, các trạng thái (`present`, `late`, `half day`, `absent`) và làm thêm giờ. Các trường hợp ngoại lệ được xử lý thông qua **correction requests**: một nhân viên quên chấm công vào sẽ gửi một yêu cầu chỉnh sửa, và bạn hoặc quản lý của họ phê duyệt hoặc từ chối nó từ trang **Attendance** hoặc hộp thư **Approvals** hợp nhất.

## 7. Gán vai trò người dùng

Mở **Admin → Users & roles**. Bạn sẽ thấy mọi người dùng hiện có cùng với các thẻ vai trò hiện tại của họ.

1. Tìm người dùng.
2. Trong hàng của họ, chọn một **role** từ menu thả xuống (`employee`, `manager`, `hr_admin`, `super_admin`).
3. Đối với việc cấp quyền **HR Admin**, hãy chọn thêm một **company scope** — công ty đó *và các công ty con của nó* — hoặc **Group-wide**. Các vai trò khác luôn áp dụng toàn tập đoàn.
4. Nhấp **Add role**. Để gỡ bỏ một lần cấp quyền, nhấp **×** bên cạnh thẻ của nó.

**Lưu ý.** Bản thân các lượt đăng nhập mới được cấp phát qua WorkOS sau này; ở đây bạn đang quản lý vai trò cho những người dùng đã tồn tại. Một quản trị viên HR có phạm vi (được ủy quyền) chỉ có thể bổ nhiệm một `hr_admin` khác trong cây con của chính mình.

## 8. Chạy lô bảng lương đầu tiên của bạn

Mở **Payroll** trong thanh bên (tab **Batches**).

1. Trong biểu mẫu **Create batch**, chọn **Company** và một **Pay period** ở định dạng `YYYY-MM` (mặc định là tháng hiện tại). Nhấp **Create batch**.
2. Mở lô mới từ danh sách. Trong khi nó ở trạng thái `draft`, bạn sẽ thấy **Inputs** cho từng nhân viên — nhập **OT**, **Bonus**, **TP1**, **Zakat** khi cần và **Save** (hoặc nhấp **Prefill OT** để kéo dữ liệu làm thêm giờ từ chấm công đã được phê duyệt). Một **leaver advisory** xuất hiện cho bất kỳ ai bị chấm dứt hợp đồng trong kỳ.
3. Nhấp **Generate payslips**. Lô chuyển sang `processed` và bảng **Payslips** hiển thị **Gross**, **Bonus**, **EPF**, **SOCSO**, **EIS**, **PCB**, và **Net** của mỗi người, cùng với các tổng chính (gross, các khoản khấu trừ, net, chi phí của người sử dụng lao động).
4. Xem lại các khoản khấu trừ pháp định. Khi bạn hài lòng, nhấp **Close batch** (trạng thái `closed`) để khóa nó. Một lô đã đóng là bất biến.

**Mẹo.** Sau khi xử lý, bạn có thể tải xuống một **Payment summary** để tải lên ngân hàng thủ công từ phần đầu của lô.

## 9. Báo cáo pháp định

Mở **Payroll → Reports** (tab **Reports**). Chọn một **Company**, một **Report**, và một **Period** (hoặc **Year** cho các biểu mẫu hàng năm), rồi nhấp **Preview**:

| Báo cáo | Tần suất | Bao gồm |
|---|---|---|
| **CP39 — MTD / PCB (LHDN)** | Hàng tháng | Bảng kê khấu trừ thuế hàng tháng |
| **EPF contributions (KWSP)** | Hàng tháng | EPF người lao động + người sử dụng lao động |
| **SOCSO + EIS (PERKESO)** | Hàng tháng | Đóng góp SOCSO và EIS |
| **Form E / CP8D — annual (LHDN)** | Hàng năm | Tờ khai của người sử dụng lao động cuối năm |
| **Monthly statutory contributions (overview)** | Hàng tháng | Ảnh chụp tổng hợp |

Mỗi bản xem trước hiển thị các tổng, một bảng **Readiness** liệt kê bất kỳ nhân viên nào thiếu dữ liệu pháp định, và bảng các hàng. Dùng **Download CSV** để xuất, và **Record generation** để ghi lại lần chạy vào audit trail. Từ một hàng báo cáo, bạn có thể mở **EA form** của một nhân viên riêng lẻ cho năm đó. **Compliance worklist · CP22 / CP22A** ở đầu trang hiển thị các hồ sơ tuyển mới và chấm dứt hợp đồng được điều khiển bởi nhật ký sự kiện.

**Lưu ý.** Đây là các báo cáo Layer-A — các bản tóm tắt mà con người đọc được để nộp tiền từ đó hoặc giao cho kế toán của bạn. Một bản nháp CP39 `.txt` có sẵn cho CP39 nhưng được đánh dấu *DRAFT, not for submission*; các tệp chính xác đến từng byte của cơ quan sẽ đến trong một bản phát hành sau.

## Bạn đã hoạt động — danh sách kiểm tra

- [ ] Đã đăng nhập với tư cách `hr_admin` / `super_admin`
- [ ] Đã tạo công ty holding + công ty hoạt động, đã đặt parent
- [ ] Đã thêm phòng ban, chức vụ, trung tâm chi phí vào pháp nhân hoạt động
- [ ] Đã lưu danh tính pháp định (EPF / SOCSO / LHDN) → huy hiệu `statutory ✓`
- [ ] Đã thêm nhân sự (tuyển hoặc nhập CSV)
- [ ] Đã đặt IC, EPF, SOCSO, số thuế, hạng PCB, số con, ngân hàng của từng nhân viên
- [ ] Đã đặt lương qua **Update pay**
- [ ] Đã xem lại các loại nghỉ phép, đặt quyền lợi, **đã mở năm nghỉ phép**
- [ ] Đã gán vai trò trong **Users & roles**
- [ ] Đã tạo, xem lại, và **đóng** lô bảng lương đầu tiên
- [ ] Đã xem trước các báo cáo pháp định với một lần kiểm tra **Readiness** sạch
