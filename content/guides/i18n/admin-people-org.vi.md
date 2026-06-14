Hướng dẫn này dành cho quản trị viên HR (`hr_admin` và `super_admin`), những người quản lý hồ sơ nhân sự và cơ cấu tổ chức trong AI HR. Đến cuối hướng dẫn, bạn sẽ có thể thiết lập công ty, phòng ban, chức danh và trung tâm chi phí; tuyển dụng và nhập khẩu nhân viên; duy trì lương thưởng, hồ sơ pháp định Malaysia và tuyến báo cáo của từng người; thực hiện điều chuyển có ngày hiệu lực; và chấm dứt việc làm — tất cả từ màn hình **People** và **Admin → Organization**.

## Trước khi bắt đầu: công ty, phòng ban, chức danh, trung tâm chi phí

Mọi nhân viên đều được tuyển dụng *vào* một công ty và được phân vào một phòng ban của công ty đó, vì vậy hãy xây dựng cơ cấu trước.

1. Trong thanh bên trái, mở **Admin → Organization**. Bạn sẽ đến một trang có tiêu đề **Organization** với ba khu vực: **Group structure** (cây chỉ-đọc của tất cả các pháp nhân), **Companies**, và biểu mẫu thêm công ty ở dưới cùng.
2. Danh sách **Companies** hiển thị một bảng có thể mở rộng cho mỗi pháp nhân. Tiêu đề mỗi bảng hiển thị số đăng ký, huy hiệu quốc gia (ví dụ `MY`), một bản tóm tắt số lượng như `2 dept · 3 pos · 1 cc`, và — đối với các công ty Malaysia — một huy hiệu `Statutory complete` (xanh lá) hoặc `Statutory partial` (hổ phách).

### Thêm công ty

Ở dưới cùng của thẻ **Companies**, điền **Legal name**, **Country** (mã hai chữ cái, mặc định là `MY`) và **Currency** (ba chữ cái, mặc định là `MYR`), rồi nhấp **Add company**.

### Chỉnh sửa công ty và danh tính pháp định của nó

Nhấp vào một bảng công ty để mở rộng. Bên trong bạn sẽ thấy:

- **Details** — chỉnh sửa **Legal name**, **Reg. no**, **Country**, **Currency**, rồi **Save details**.
- **Group parent** — chọn một **Parent company** (hoặc `None (group root)`) để lồng pháp nhân này dưới một pháp nhân khác, rồi **Set parent**. Đây chính là cái vẽ nên cây **Group structure**.
- **Statutory identity (MY)** — đối với các công ty Malaysia, ghi nhận **EPF employer no.**, **SOCSO employer code**, **LHDN E-number**, **MyInvois TIN** và **SSM registration no.**, rồi **Save statutory identity**.

> **Note** Huy hiệu sẵn sàng xanh/hổ phách phụ thuộc vào ba định danh: **EPF employer no.**, **SOCSO employer code** và **LHDN E-number**. Các tờ khai và báo cáo lương phụ thuộc vào những thông tin này, vì vậy hãy điền chúng trước lần chạy lương đầu tiên của bạn.

### Phòng ban, chức danh và trung tâm chi phí

Mỗi bảng công ty được mở rộng có ba cột ở dưới cùng:

- **Departments** — nhập tên và nhấp **Add**.
- **Positions** — nhập chức danh và nhấp **Add**.
- **Cost centres** — nhập một **Code** và một **Name**, rồi **Add**.

Để thay đổi một mục hiện có, hãy dùng trình chỉnh sửa nội dòng trên hàng của nó. Việc xóa bỏ có hai cấp:

| Trạng thái | Điều khiển hiển thị | Ý nghĩa |
| --- | --- | --- |
| Không được tham chiếu ở đâu cả | **Delete** | Xóa cứng — an toàn vì không có gì trỏ tới nó. |
| Đang được sử dụng (đã gán cho nhân viên) | **Archive** | Ẩn mềm; các phân công và lịch sử hiện có vẫn nguyên vẹn. |

Cùng một logic áp dụng ở cấp công ty: một công ty **đang được sử dụng** sẽ cung cấp **Archive company**; một công ty không được tham chiếu sẽ cung cấp **Delete company** (kèm hộp thoại xác nhận). Các hàng đã lưu trữ hiển thị mờ đi và có thể được khôi phục bằng **Unarchive**.

## Tuyển dụng một nhân viên

1. Trong thanh bên, nhấp **People**. Bạn sẽ thấy bảng nhân viên (Name, Department, Company, Status, Hired) với một hộp tìm kiếm và số lượng nhân viên.
2. Cuộn xuống bảng **Hire an employee** ở dưới cùng và mở rộng nó.
3. Điền **Full name**, **Email**, **Company**, **Department**, **Employment type** (`Full-time`, `Part-time`, `Contract` hoặc `Intern`) và **Hire date** (mặc định là hôm nay).
4. Nhấp **Hire**. Người mới xuất hiện trong bảng và được cấp một mã nhân viên tự động. Khi tuyển dụng, các quyền nghỉ phép thường lệ (nghỉ phép năm, nghỉ ốm, nghỉ nằm viện) được cấp theo gói quốc gia của công ty — nghỉ phép năm được tính theo tỷ lệ cho số tháng còn lại trong năm tuyển dụng.

> **Tip** Cả hai menu thả xuống **Company** và **Department** đều được điền từ **Admin → Organization**. Nếu thiếu một phòng ban, hãy thêm nó ở đó trước.

## Trang chi tiết nhân viên

Nhấp vào bất kỳ tên nào trong bảng **People** để mở hồ sơ của người đó. Phần đầu trang hiển thị mã nhân viên, email, công ty, ngày tuyển dụng và một huy hiệu trạng thái của họ. Với tư cách quản trị viên, bạn có thể chỉnh sửa các phần sau.

### Thông tin cá nhân

Chỉnh sửa **Full name**, **Email** và **Phone** (dùng định dạng `+60…`), rồi **Save details**. Một hồ sơ cá nhân được chia sẻ qua tất cả các việc làm của cá nhân đó, vì vậy điều này cập nhật danh tính chuẩn của họ ở mọi nơi.

### Lương thưởng — "Update pay"

Thẻ **Compensation** hiển thị lương cơ bản hiện tại, phụ cấp và ngày nó có hiệu lực. Để thay đổi, hãy nhập **Basic salary (MYR)** và **Allowance** mới rồi nhấp **Update pay**. Lịch sử lương được bảo tồn — một bản ghi mới có ngày hiệu lực được tạo thay vì ghi đè lên con số cũ.

> **Note** Biểu mẫu **Update pay** bị ẩn khi một nhân viên đã bị chấm dứt.

### Pháp định (Malaysia)

Duy trì các trường mà lương và tờ khai phụ thuộc vào:

- **IC number**, **EPF number**, **SOCSO number**, **Tax number** (LHDN).
- **PCB category** — `1` Độc thân, `2` Đã kết hôn/vợ-chồng không đi làm, `3` Đã kết hôn/vợ-chồng đi làm.
- Số lượng **Children (PCB relief)**.
- **Bank** và **Bank account** để thanh toán.
- Các hộp kiểm **EIS eligible** và **Tax resident**.

Bên dưới đó, mục **TP3** ghi nhận các con số từ chủ lao động trước của người gia nhập giữa năm — **Applies to year**, **Net remuneration**, **EPF claimed** và **PCB paid** — để MTD được tính chính xác. Nhấp **Save statutory** khi hoàn tất.

### Lịch sử phân công và lịch sử thay đổi

**Assignment history** liệt kê mọi giai đoạn phòng ban/chức danh với các ngày valid-from → valid-to (hàng hiện tại được tô sáng và kết thúc ở `Present`). **Change history** là dấu vết kiểm toán của các chỉnh sửa đối với hồ sơ này. Cùng nhau, chúng cho phép bạn tái dựng chính xác điều gì là đúng vào bất kỳ ngày nào trong quá khứ — không có gì bị ghi đè tại chỗ.

## Tuyến báo cáo (hành chính, chức năng, dự án, đường chấm)

Thẻ **Reporting lines** có hai cột: **Reports to** (các quản lý của người này) và **Direct reports**.

1. Để thêm một tuyến, dùng biểu mẫu ở dưới cùng: chọn một **Manager** và một **Line type**, rồi **Add reporting line**.
2. Các tùy chọn **Line type**:

| Loại | Dùng cho |
| --- | --- |
| `Administrative` | Người quản lý chính, tuyến liền. |
| `Functional` | Trưởng bộ phận chức năng/chuyên môn. |
| `Project` | Một dự án hoặc phân công tạm thời. |
| `Dotted` | Một mối quan hệ phụ, mang tính tư vấn. |

3. Để kết thúc một mối quan hệ, nhấp vào **×** bên cạnh một người quản lý trong **Reports to**.

> **Note** Các tuyến hành chính được kiểm tra chu trình: nếu người quản lý đã báo cáo (trực tiếp hoặc gián tiếp) cho người này, tuyến đó bị từ chối để ngăn một vòng lặp. Các loại tuyến khác cho phép chồng chéo ma trận.

## Điều chuyển có ngày hiệu lực

Dùng thẻ **Transfer** để chuyển ai đó sang một phòng ban mới kể từ một ngày được chọn.

1. Chọn **New department** và một **Effective date** (mặc định là hôm nay).
2. Nhấp **Transfer**.

Phân công hiện tại được đóng vào ngày đó và một phân công mới được mở — nên bảng **Assignment history** hiển thị một dòng thời gian gọn gàng, không chồng chéo. Báo cáo và lương sau đó đọc bất kỳ phân công nào đang có hiệu lực vào một ngày nhất định.

## Chấm dứt việc làm

Trong thẻ **Terminate**, chọn một **Termination date** (mặc định là hôm nay) và nhấp **Terminate employment**. Một hộp thoại xác nhận yêu cầu bạn xác nhận bằng tên. Khi chấm dứt, phân công đang mở được đóng vào ngày đó, và các biểu mẫu **Update pay**, **Transfer**, **Terminate** và thêm-tuyến-báo-cáo biến mất đối với hồ sơ đó. Huy hiệu trạng thái của người đó chuyển thành `terminated`.

> **Tip** Việc chấm dứt không xóa bất cứ thứ gì — phiếu lương, lịch sử nghỉ phép và mẫu EA vẫn còn khả dụng cho các mục đích pháp định và thanh toán lương cuối cùng.

## Nhập khẩu CSV (chạy thử, rồi cam kết)

Để tiếp nhận nhiều người cùng lúc — chẳng hạn một đợt di chuyển ngày đầu — hãy dùng trình nhập khẩu.

1. Trên trang **People**, nhấp **Import CSV** (góc trên bên phải; chỉ dành cho quản trị viên). Trang **Import employees** mở ra.
2. Chọn **Target company** (mặc định là công ty đang hoạt động của bạn, hoặc pháp nhân có nhiều phòng ban nhất).
3. Dán các hàng của bạn vào **CSV data**, hoặc nhấp **Load sample** để chèn một mẫu mà bạn có thể chỉnh sửa.
4. Mở rộng **Column reference** để xem những gì được nhận diện:
   - **Required:** `full_name`, `email`, `department`, `hired_on`, `ic_number`, `basic_salary`
   - **Optional:** `phone`, `position`, `cost_center`, `employment_type`, `monthly_allowance`, `bank_name`, `bank_account_no`, `epf_number`, `socso_number`, `tax_number`, `tax_category`, `num_children`, `eis_eligible`, `is_resident`
5. Nhấp **Validate**. Đây là một lần chạy thử — chưa có gì được ghi. Bảng **Preview** hiển thị mỗi hàng là `Ready` (xanh lá, đôi khi kèm cảnh báo hổ phách) hoặc với các lỗi của nó màu đỏ, cộng với một số đếm ở tiêu đề các hàng sẵn sàng so với các hàng có lỗi. Các cột bị thiếu được đánh dấu ở trên cùng.
6. Sửa mọi vấn đề trong CSV của bạn và **Validate** lại (bất kỳ chỉnh sửa nào cũng xóa bản xem trước trước đó, nên bạn luôn nhập chính xác cái bạn đã kiểm tra lần cuối).
7. Khi bạn hài lòng, nhấp **Import N valid** để cam kết. Chỉ các hàng hợp lệ được ghi; các hàng không hợp lệ bị bỏ qua. Biểu ngữ kết quả báo cáo số lượng đã nhập / đã bỏ qua / thất bại và liệt kê mọi thất bại theo hàng.
8. Nhấp **View people** để xem những người mới gia nhập, hoặc **Import another** để xóa và bắt đầu lại.

> **Note** Các giá trị phòng ban, chức danh và trung tâm chi phí trong CSV được khớp với danh mục của **Target company** theo tên/mã, vì vậy hãy đảm bảo những thứ đó tồn tại trong **Admin → Organization** trước. `bank_name` và `bank_account_no` nên được cung cấp cùng nhau.

## Những lỗi thường gặp

- **"Add company" / các menu thả xuống trống.** Xây dựng công ty và phòng ban trong **Admin → Organization** trước khi tuyển dụng hoặc nhập khẩu.
- **Huy hiệu hổ phách "Statutory partial".** Một công ty Malaysia thiếu một trong các định danh chủ lao động EPF / SOCSO / LHDN — mở rộng bảng và hoàn thành **Statutory identity (MY)** trước khi chạy lương.
- **Không thể xóa một phòng ban/chức danh/công ty.** Nó được tham chiếu bởi nhân viên hoặc lịch sử, nên chỉ có **Archive** được cung cấp. Hãy lưu trữ thay vì cố ép xóa.
- **Tuyến báo cáo bị từ chối.** Bạn đã tạo một chu trình hành chính — hãy chọn một loại tuyến khác hoặc một người quản lý chưa nằm dưới người này.
- **Các hàng nhập khẩu bị bỏ qua.** Kiểm tra danh sách thất bại trong biểu ngữ kết quả; các nguyên nhân phổ biến là thiếu một cột bắt buộc, một tên phòng ban không xác định, hoặc một giá trị `ic_number` / `hired_on` sai định dạng.
- **Các chỉnh sửa không có hiệu lực với một nhân viên đã bị chấm dứt.** Các điều khiển lương, điều chuyển và tuyến báo cáo bị ẩn có chủ ý sau khi chấm dứt.
