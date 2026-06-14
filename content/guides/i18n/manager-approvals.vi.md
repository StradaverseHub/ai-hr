Hướng dẫn này dành cho **người quản lý nhân sự** — bất kỳ ai có vai trò `manager` và có nhân viên báo cáo trực tiếp. Nó dẫn bạn qua hộp thư **Approvals** hợp nhất, nơi mọi yêu cầu từ tuyến báo cáo của bạn chờ một quyết định duy nhất: yêu cầu nghỉ phép, yêu cầu chỉnh sửa chấm công, và (đối với quản trị viên) thay đổi hồ sơ. Đến cuối, bạn sẽ biết cách phê duyệt hoặc từ chối từng loại, hiểu chính xác bạn có thể thấy yêu cầu của ai, vì sao bạn không thể quyết định yêu cầu của chính mình, và mỗi cú nhấp làm gì ở phía sau — như trừ số dư phép hoặc sửa đổi bản ghi chấm công.

## Mở hộp thư Approvals của bạn

Trong thanh bên trái, nhấp **Approvals**. Trang này chỉ hiển thị với người quản lý và quản trị viên; nếu bạn không có nhân viên báo cáo hoặc vai trò quản trị, bạn sẽ không thấy mục menu này.

Ở trên cùng, bạn sẽ thấy một **PageHeader** có tiêu đề **Approvals**. Bên dưới tiêu đề là một bộ đếm trực tiếp:

- Nếu không có việc gì cần làm, nó hiển thị **"Nothing waiting on you"**.
- Nếu không, nó hiển thị **"3 items awaiting a decision"** (hoặc **"1 item awaiting a decision"** cho một mục duy nhất) — tổng số đang chạy trên tất cả các phần.

Hộp thư là một màn hình duy nhất với các thẻ xếp chồng. Tiêu đề mỗi thẻ hiển thị tên phần và một phù hiệu số lượng để bạn có thể thấy ngay công việc nằm ở đâu:

| Phần | Nội dung chứa |
| --- | --- |
| **Leave requests** | Yêu cầu nghỉ phép đang chờ xử lý từ nhân viên báo cáo của bạn |
| **Attendance corrections** | Yêu cầu sửa giờ vào / giờ ra của một ngày |
| **Profile changes (bank / tax)** | Chỉnh sửa chi tiết ngân hàng và thuế — **chỉ quản trị viên** (với tư cách quản lý thông thường bạn sẽ không thấy thẻ này) |

**Lưu ý:** Chỉ các mục **đang chờ xử lý** xuất hiện ở đây. Khi bạn đã quyết định một yêu cầu, nó sẽ rời khỏi hộp thư — không có tab "đã quyết định" trên trang này. Để xem lại các quyết định trước đây, hãy dùng **Audit trail** (quản trị viên) hoặc chế độ xem **History** của từng bản ghi.

## Bạn có thể thấy yêu cầu của ai (phạm vi tuyến báo cáo)

Bạn chỉ luôn thấy các yêu cầu từ **tuyến báo cáo của chính mình** — những người báo cáo cho bạn về mặt hành chính. Hệ thống thực thi điều này theo hai lớp, nên bạn không bao giờ phải lọc thủ công:

- **Khả năng hiển thị** được cắt gọn bởi bảo mật cấp hàng: một người quản lý đọc các hàng của nhân viên mình, một nhân viên chỉ đọc hàng của chính họ, một quản trị viên thấy mọi thứ trong phạm vi. Danh sách trên trang này đã được lọc trước khi đến tay bạn.
- **Quyền quyết định** là một lớp kiểm tra thứ hai, chặt chẽ hơn (xem bên dưới).

**Mẹo:** Nếu yêu cầu của một đồng nghiệp không hiển thị, lý do phổ biến nhất là bạn không phải là **người quản lý hành chính đang hoạt động** của họ. Tuyến báo cáo phải có hiệu lực *hôm nay* — một tuyến được đặt ngày trong tương lai, đã kết thúc, hoặc đã bị thay thế sẽ không đưa yêu cầu của họ vào hộp thư của bạn. Hãy đề nghị quản trị viên HR của bạn xác nhận tuyến báo cáo trên **Org chart** hoặc trong **Admin → Organization**.

## Quy tắc không tự phê duyệt

Bạn **không thể quyết định yêu cầu của chính mình**. Nếu một trong các yêu cầu của chính bạn xuất hiện trong danh sách — ví dụ, bạn đã nộp một yêu cầu chỉnh sửa chấm công cho chính mình — cột hành động sẽ không hiển thị nút. Thay vào đó, bạn sẽ thấy nhãn mờ **"your request"** ở vị trí mà **Approve** / **Reject** thường xuất hiện.

Lớp bảo vệ này nằm ở tầng dịch vụ, không chỉ ở giao diện người dùng, nên không thể vượt qua. Nghỉ phép và chỉnh sửa của chính bạn phải do quản lý *của bạn* hoặc một quản trị viên HR quyết định.

**Lưu ý:** Có một ngoại lệ cố ý: một `super_admin` giữ lại lối thoát dành cho quản trị viên duy nhất và *có thể* tự phê duyệt, để một đội quản trị một người ở công ty nhỏ không bị chặn vĩnh viễn. Các quản lý thông thường và người dùng `hr_admin` không bao giờ có thể làm vậy.

## Phê duyệt hoặc từ chối yêu cầu nghỉ phép

Thẻ **Leave requests** hiển thị một bảng với các cột sau: **Employee**, **Type**, **Dates**, **Days**, và **Action**.

1. Đọc hàng: cột **Dates** hiển thị khoảng thời gian dưới dạng `start → end`, và **Days** hiển thị tổng số đã tính (các loại phép tính theo ngày làm việc đã loại trừ cuối tuần và ngày lễ).
2. Trong cột **Action**, nhấp **Approve** hoặc **Reject**.
3. Quyết định được gửi ngay lập tức và hàng biến mất khỏi hộp thư.

**Approve làm gì ở phía sau:** phê duyệt một yêu cầu nghỉ phép thực hiện ba việc một cách nguyên tử trong một giao dịch:

- Nó kiểm tra **số dư dự kiến** của nhân viên cho loại phép đó. Nếu việc phê duyệt sẽ đẩy số dư xuống dưới không, quyết định bị chặn với thông báo **"Leave rejected: insufficient balance"** và không có gì thay đổi.
- Nếu đủ số dư, nó ghi một **khoản trừ** vào sổ cái nghỉ phép chỉ-thêm cho số ngày được yêu cầu (có hiệu lực vào ngày bắt đầu nghỉ), nên số dư giảm đúng bằng số đó.
- Nó chuyển trạng thái yêu cầu thành `approved`, đóng dấu ai đã quyết định và khi nào, và ghi quyết định vào nhật ký sự kiện.

Sau khi được phê duyệt, những ngày đó cũng được tính là **on leave** trên các chế độ xem **Attendance** cho những ngày liên quan — nên nhân viên sẽ không bị đánh dấu vắng mặt.

**Reject làm gì:** trạng thái chuyển thành `rejected` và quyết định được ghi lại. **Không có số dư nào bị động đến** — từ chối không bao giờ trừ hay cộng ngày.

**Cạm bẫy phổ biến — "insufficient balance":** nếu Approve thất bại do số dư, thường có nghĩa là quyền lợi của nhân viên chưa được cấp, hoặc họ đã dùng hết. Bạn không thể ghi đè số dư từ màn hình này; hãy chuyển nó đến quản trị viên HR của bạn, người có thể ghi một điều chỉnh nghỉ phép.

## Phê duyệt hoặc từ chối chỉnh sửa chấm công

Khi giờ chấm của nhân viên bị sai (quên chấm vào, chấm ra muộn, v.v.), họ nêu một yêu cầu chỉnh sửa từ không gian làm việc của mình. Nó rơi vào thẻ **Attendance corrections** của bạn.

Các cột của bảng là: **Employee**, **Date**, **Proposed**, **Reason**, và **Action**.

1. Kiểm tra cột **Proposed** — nó hiển thị các giờ được yêu cầu dưới dạng `HH:MM` (và `HH:MM → HH:MM` khi có cả giờ ra).
2. Đọc **Reason** mà nhân viên đưa ra (hiển thị `—` nếu họ để trống).
3. Nhấp **Approve** hoặc **Reject**.

**Approve làm gì ở phía sau:** phê duyệt không chỉ đóng dấu xác nhận các giờ — nó **xây dựng lại bản ghi chấm công thông qua bộ máy thời gian**. Giờ vào/giờ ra được đề xuất được phân loại lại theo loại ngày (ngày làm việc, ngày nghỉ, hoặc ngày lễ) và được suy ra lại thành một trạng thái (`present`, `late`, hoặc `half_day`) cùng với **số phút làm việc và số phút làm thêm giờ**. Bản ghi đã sửa đó được ghi vào ngày (thay thế bất kỳ hàng hiện có nào cho ngày đó) và đánh dấu **"Corrected"**. Vì giờ làm thêm được tính lại tại đây, một chỉnh sửa đã phê duyệt chảy thẳng vào hệ thống lương — nên việc nhập đúng giờ rất quan trọng.

**Reject làm gì:** chỉnh sửa được đánh dấu `rejected` và ghi lại; bản ghi chấm công gốc được giữ nguyên không động đến.

**Mẹo:** Việc phân loại làm thêm giờ tuân theo các quy tắc EA 1955 của Malaysia — làm việc vào ngày nghỉ hoặc ngày lễ được tính là làm thêm giờ toàn bộ và sau đó được quy đổi thành tiền theo mức phí cao hơn trong hệ thống lương. Vì vậy phê duyệt một chỉnh sửa cho ngày nghỉ có thể làm tăng lương của ai đó một cách hợp lệ. Hãy kiểm tra tính hợp lý của các giờ **Proposed** so với **Reason** trước khi phê duyệt.

## Thay đổi hồ sơ (chỉ quản trị viên)

Nếu bạn cũng giữ vai trò quản trị, một thẻ thứ ba — **Profile changes (bank / tax)** — sẽ xuất hiện. Nó liệt kê các chỉnh sửa tự phục vụ đang chờ xử lý đối với các trường nhạy cảm, hiển thị tên nhân viên và mỗi thay đổi được đề xuất dưới dạng `field → new value`. Nhấp **Approve** hoặc **Reject** theo cùng cách. Các quản lý thông thường không thấy thẻ này; thay đổi ngân hàng và thuế được dành riêng cho quản trị viên HR vì chúng cấp dữ liệu cho các khoản khấu trừ theo luật định và các tệp thanh toán.

## Tham khảo nhanh: mỗi quyết định làm gì

| Loại yêu cầu | Approve | Reject |
| --- | --- | --- |
| **Leave** | Kiểm tra số dư → trừ sổ cái → đánh dấu `approved`; các ngày giờ tính là on-leave trên Attendance | Đánh dấu `rejected`; **không** thay đổi số dư |
| **Attendance correction** | Suy ra lại ngày qua bộ máy thời gian, ghi bản ghi đã sửa (kèm OT cho hệ thống lương), đánh dấu `approved` | Đánh dấu `rejected`; bản ghi gốc không bị động đến |
| **Profile change** (quản trị viên) | Áp dụng giá trị ngân hàng/thuế mới, đánh dấu `approved` | Đánh dấu `rejected`; không áp dụng thay đổi nào |

## Khắc phục sự cố

- **"You cannot decide your own ..."** — bạn đã cố hành động trên yêu cầu của chính mình. Điều này là dự kiến; nó phải đi đến quản lý của bạn hoặc một quản trị viên HR. (Chỉ `super_admin` mới có thể tự phê duyệt.)
- **"Only an admin or the administrative manager can decide this ..."** — bạn không phải là người quản lý hành chính *đang hoạt động* của đối tượng. Hãy xác nhận tuyến báo cáo có hiệu lực hôm nay và không bị thay thế.
- **"... is already approved / rejected"** — ai đó (thường là một quản trị viên, hoặc chính bạn ở tab khác) đã quyết định nó rồi. Hãy làm mới trang; nó hẳn đã rời khỏi hộp thư.
- **Một yêu cầu không bao giờ đến với tôi** — kiểm tra tuyến báo cáo trên **Org chart**. Nếu nó được đặt ngày trong tương lai hoặc đã kết thúc, hãy đề nghị quản trị viên HR của bạn sửa nó trong **Admin → Organization**.

**Lưu ý:** Mỗi quyết định bạn đưa ra đều được ghi vào nhật ký kiểm toán/sự kiện với bạn là người thực hiện thực sự — các phê duyệt ở đây có trách nhiệm giải trình, không ẩn danh. Nếu bạn cần xem lại ai đã quyết định điều gì, đó là nơi để tra cứu.
