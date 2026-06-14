Hướng dẫn này dành cho quản trị viên HR (`hr_admin` và `super_admin`), những người thiết lập và duy trì quy tắc nghỉ phép và chấm công cho công ty của họ trong AI HR. Đến cuối hướng dẫn, bạn sẽ biết cách định nghĩa các loại nghỉ phép, xếp chồng các chính sách quyền lợi của công ty lên trên mức sàn pháp định của Malaysia, sửa hoặc xóa một chính sách, mở một năm nghỉ phép mới có chuyển tiếp, và hiểu cách hoạt động của các loại ngày chấm công và yêu cầu chỉnh sửa. Tất cả các màn hình này đều yêu cầu vai trò quản trị viên — nhân viên và quản lý sẽ hoàn toàn không thấy phần cấu hình Nghỉ phép.

## Cấu hình nghỉ phép

Trên thanh bên trái, dưới mục **Admin**, nhấp vào **Leave config**. Bạn sẽ đến trang **Cấu hình nghỉ phép**, được tổ chức thành hai thẻ: **Loại nghỉ phép & quyền lợi** ở trên cùng và **Năm nghỉ phép** ở dưới cùng.

### Mức sàn pháp định hoạt động như thế nào

AI HR đi kèm với gói quốc gia Malaysia (Đạo luật Việc làm 1955, Employment Act 1955) tích hợp sẵn. Các mức tối thiểu pháp định **không thể cấu hình** — chúng đến từ gói này và được phân theo dải dựa trên số năm phục vụ đã hoàn thành (`<2` / `2–5` / `5+` năm). Các chính sách của công ty bạn xếp chồng *lên trên* mức sàn này.

Quy tắc then chốt, được lặp lại xuyên suốt giao diện: **việc cấp quyền áp dụng giá trị lớn hơn giữa mức sàn pháp định và chính sách của công ty bạn.** Một chính sách thấp hơn mức tối thiểu sẽ được ghi nhận và hiển thị với huy hiệu `below minimum`, nhưng nó không bao giờ thực sự được áp dụng — nhân viên vẫn nhận được mức theo pháp định.

Các dải của gói là:

| Loại nghỉ phép | `<2 yrs` | `2–5 yrs` | `5+ yrs` | Cách tính |
| --- | --- | --- | --- | --- |
| `ANNUAL` | 8 | 12 | 16 | Ngày làm việc |
| `SICK` (ngoại trú) | 14 | 18 | 22 | Ngày theo lịch |
| `HOSPITALIZATION` | 60 | 60 | 60 | Ngày theo lịch |
| `MATERNITY` | 98 | 98 | 98 | Ngày theo lịch |
| `PATERNITY` | 7 | 7 | 7 | Ngày theo lịch |

**Lưu ý:** Nghỉ phép năm được **tính theo tỷ lệ** trong năm tuyển dụng; nghỉ ốm và nhập viện được cấp **đầy đủ** (chúng là quyền lợi theo từng năm lịch, không tính theo tỷ lệ cho người gia nhập giữa năm).

### Thêm một loại nghỉ phép

1. Cuộn xuống biểu mẫu ở cuối thẻ **Loại nghỉ phép & quyền lợi**.
2. Nhập một **Code** — chữ cái, chữ số hoặc dấu gạch dưới, được lưu dưới dạng chữ in hoa (ví dụ `SICK`). Mã là khóa ngữ nghĩa mà mức sàn, quyền cấp thường trực và chuyển tiếp dùng để khớp, nên nó quan trọng: gõ `annual` và nó được chuẩn hóa thành `ANNUAL` để không bao giờ âm thầm bỏ lỡ mức sàn EA.
3. Nhập một **Name** (ví dụ `Sick Leave`).
4. Để **Paid** được tích chọn trừ khi đây là loại không lương.
5. Nhấp **Add type**.

Loại mới xuất hiện trong danh sách phía trên dưới dạng một hàng thu gọn hiển thị tên, mã và số ngày/năm có hiệu lực của nó.

### Đọc một hàng loại nghỉ phép

Mỗi loại nghỉ phép là một **hàng có thể mở rộng**. Nhấp vào nó để mở rộng. Bên phải hàng thu gọn bạn sẽ thấy **quyền lợi có hiệu lực** (`days/yr`) và một trong hai huy hiệu:

- `policy` (màu ngọc lục bảo) — chính sách của công ty bạn **cao hơn** mức sàn và là chính sách được áp dụng.
- `below minimum` (màu hổ phách) — chính sách đang hoạt động của bạn *thấp hơn* mức sàn, nên mức sàn được áp dụng thay thế.

Mở rộng hàng sẽ hiển thị: các điều khiển cấp loại (**Rename**, cùng với **Archive**/**Unarchive**/**Delete**), dòng **Statutory minimum (MY)** chỉ đọc, và dòng thời gian **Company entitlements**.

**Mẹo:** Một loại đang được sử dụng chỉ có thể được **Archived** (nó vẫn được tham chiếu bởi các yêu cầu và mục sổ cái trong quá khứ); một loại không được tham chiếu ở đâu cả sẽ hiển thị **Delete** thay thế. Các loại đã lưu trữ hiển thị mờ với huy hiệu `archived`.

### Trình chỉnh sửa quyền lợi nội tuyến

Các chính sách quyền lợi được **gắn ngày hiệu lực** và được chỉnh sửa nội tuyến trên hàng của loại — không có biểu mẫu chính sách riêng biệt, tách rời nào. Mô hình tư duy:

- **Add** một quyền lợi gắn ngày mới để thay đổi mọi thứ **về sau**.
- **Edit** một quyền lợi hiện có để **sửa** một giá trị gõ nhầm (cùng ngày hiệu lực).
- **Remove** một quyền lợi để ngừng nó điều khiển các lần cấp quyền trong tương lai.

Để thêm một quyền lợi:

1. Mở rộng loại nghỉ phép.
2. Nhấp **+ Add entitlement**.
3. Điền **Days / year**.
4. Chỉ với nghỉ phép năm, đặt **Carry cap** — số ngày chưa sử dụng tối đa được chuyển sang năm nghỉ phép tiếp theo (mặc định `0`). Các loại không phải nghỉ phép năm không hiển thị trường này; chuyển tiếp của chúng luôn bằng không.
5. Đặt **Effective from** (một ngày). Chính sách đang hoạt động mới nhất là chính sách được áp dụng hôm nay.
6. Nhấp **Add**.

Để sửa một chính sách, nhấp **Edit** trên dòng chính sách, thay đổi **Days / year** (hoặc **Carry cap** / **Effective from**), và nhấp **Save**. Để ngừng một chính sách điều khiển các lần cấp quyền trong tương lai, nhấp **Remove** và xác nhận.

**Lưu ý:** Việc xóa một quyền lợi là an toàn — các lần cấp quyền trong quá khứ vẫn được giữ lại vì sổ cái nghỉ phép tham chiếu *loại* nghỉ phép, không phải chính sách. Việc xóa chỉ ngừng hàng đó cung cấp cho các lần cấp quyền trong tương lai.

Dòng chính sách đang hoạt động mang huy hiệu `active`; một chính sách đã bị thay thế hiển thị phạm vi `from … to …` của nó. Thông báo `none` / "No company policy — the statutory floor applies" có nghĩa là chỉ có mức theo pháp định đang có hiệu lực cho loại đó.

## Ngày lễ chính thức

Ngày lễ chính thức đến từ gói quốc gia Malaysia và tự động điều khiển hai việc — không có trình chỉnh sửa ngày lễ riêng nào cần duy trì:

- **Nghỉ phép theo ngày làm việc** (nghỉ phép năm) **loại trừ** các ngày cuối tuần và ngày lễ chính thức khỏi việc đếm ngày, nên việc xin nghỉ vắt qua một ngày lễ chính thức không tiêu tốn một ngày nghỉ phép năm.
- Trên trang **Attendance**, một ngày không có chấm công vào một ngày lễ chính thức hiển thị viên ngữ cảnh `Holiday` thay vì được tính là vắng mặt, và bất kỳ công việc nào được ghi nhận trong ngày đó đều được coi là tăng ca ngày lễ.

## Mở một năm nghỉ phép mới

Vào đầu mỗi năm lịch, bạn phải **mở năm nghỉ phép** để ghi nhận các quyền lợi mới của mọi người. Trong thẻ **Leave year** trên trang Leave config:

1. Trường **Year** mặc định là năm tiếp theo. Điều chỉnh nếu cần.
2. Nhấp **Open leave year**.

Điều gì xảy ra:

- Mỗi nhân viên **đang hoạt động** được tuyển dụng trước ngày 1 tháng 1 của năm đó nhận được các quyền lợi thường trực mới của họ (`ANNUAL`, `SICK`, `HOSPITALIZATION`) tại **dải thâm niên hiện tại** của họ — vì vậy các nâng cấp dải 2 năm và 5 năm diễn ra tự động ở đây, được giải quyết là `max(statutory floor, policy)`.
- **Chuyển tiếp:** nghỉ phép năm chưa sử dụng được chuyển tiếp tối đa đến **Carry cap** của chính sách; bất cứ phần nào vượt quá đều bị mất (điều 60E kỳ vọng nghỉ phép được sử dụng trong năm). Nghỉ ốm và nhập viện **đặt lại** — chúng không chuyển tiếp.
- Thao tác này có tính **lũy đẳng** (idempotent) và an toàn để chạy lại: những nhân viên đã được mở cho năm đó sẽ bị bỏ qua, và bất kỳ ai được tuyển dụng *trong* năm đó đều đã được bao phủ bởi lần cấp quyền theo tỷ lệ khi tuyển dụng của họ, nên họ cũng bị bỏ qua ở đây.

**Mẹo:** Chạy việc này một lần vào gần đầu năm. Nếu bạn thêm một quyền lợi gắn ngày lùi về sau đó, bạn có thể mở lại năm một cách an toàn — những nhân viên đã được cấp quyền sẽ không bị tính hai lần.

## Chấm công

Trên thanh bên, nhấp vào **Attendance**. Trang này có ba phần: lưới ngày (mặc định là **Today**, điều hướng bằng bộ chọn ngày), **Correction requests** (chỉ khi có một số đang chờ xử lý), và **Month summary**.

### Chính sách chấm công và phân loại loại ngày

Mỗi công ty có một chính sách chấm công xác định lịch làm việc: **work start** / **work end**, **break minutes**, ngưỡng đi trễ (`Late after`), điểm cắt nửa ngày, và **working days** (mặc định Thứ Hai–Thứ Sáu). Ở những nơi công ty chưa tùy chỉnh, các giá trị mặc định hợp lý được áp dụng (09:00–18:00, nghỉ 60 phút, trễ sau 09:15, nửa ngày trước 13:00).

Khi ai đó chấm công vào, ngày đó được **phân loại và đóng băng** trên bản ghi là một trong ba loại ngày:

- `workday` — một ngày làm việc theo lịch. Chỉ ở đây một lần chấm công vào mới có thể là **trễ** (sau ngưỡng) hoặc một ngày ngắn được tính là **nửa ngày**.
- `rest_day` — một ngày thường/cuối tuần không làm việc theo lịch. Bất kỳ công việc nào đều là tăng ca *toàn bộ*.
- `holiday` — một ngày lễ chính thức. Bất kỳ công việc nào đều là tăng ca *toàn bộ*.

Trong lưới ngày, những nhân viên không có bản ghi trong một ngữ cảnh không làm việc hiển thị một viên ngữ cảnh — `On leave`, `Holiday`, hoặc `Rest day` — để một ngày trống một cách hợp lệ không bị đọc là vắng mặt. Tăng ca vào ngày nghỉ và ngày lễ được gắn nhãn `RD` / `PH`.

**Month summary** tổng hợp điều này theo từng nhân viên: số đếm **Present / Late / Half day / Leave / Absent**, tổng **Hours** và **Overtime** (chia theo loại ngày trong chú giải công cụ), cùng với các **Flags** tuân thủ: `OT > 104h` (mức trần tăng ca hằng tháng theo pháp định) và `45h+ week` (mang tính chỉ báo). Vắng mặt chỉ tính các ngày làm việc đã trôi qua — nó không bao giờ đánh dấu các ngày trong tương lai hoặc các ngày trước khi tuyển dụng là vắng mặt.

### Yêu cầu chỉnh sửa chấm công

Nếu một lần chấm công bị sai hoặc bị thiếu, một nhân viên (hoặc quản lý của họ) đưa ra một **yêu cầu chỉnh sửa** đề xuất giờ chấm công vào đúng và giờ chấm công ra tùy chọn. Là một quản trị viên, bạn xử lý những yêu cầu này trong thẻ **Correction requests**, thẻ này xuất hiện khi có yêu cầu đang chờ xử lý.

1. Mỗi hàng hiển thị **Employee**, **Date**, các giờ **Proposed**, và **Reason**.
2. Nhấp **Approve** để sửa đổi ngày đó, hoặc **Reject** để từ chối.

**Việc phê duyệt tính lại toàn bộ ngày thông qua bộ máy thời gian** — trạng thái, số phút làm việc và tăng ca được tính lại từ các lần chấm công được đề xuất và lịch của công ty, nên tăng ca đã chỉnh sửa chảy vào bảng lương. Bản ghi được đóng dấu `Corrected`.

**Lưu ý:** Bạn **không thể phê duyệt yêu cầu chỉnh sửa của chính mình** — các hàng của chính bạn hiển thị `your request` thay vì các nút thao tác. Hãy nhờ một quản trị viên khác hoặc quản lý của nhân viên xử lý nó. Hệ thống cũng thực thi điều này ở phía máy chủ.

## Những lỗi thường gặp

- **Chính sách dưới mức sàn không làm gì cả.** Đặt nghỉ phép năm thành 5 ngày khi mức sàn EA là 8 sẽ ghi nhận một chính sách `below minimum` không bao giờ được áp dụng. Dùng các con số mức sàn ở trên làm cơ sở của bạn.
- **Quên carry cap.** Một quyền lợi nghỉ phép năm mới mặc định carry cap của nó là `0` — các ngày chưa sử dụng sẽ bị mất khi mở năm tiếp theo trừ khi bạn đặt một cap.
- **"Edit" so với "Add" quyền lợi.** Edit chỉ *sửa* một giá trị tại cùng một ngày hiệu lực. Để thay đổi quyền lợi *về sau* (ví dụ tăng lên 18 ngày kể từ tháng Một năm sau), hãy **Add** một quyền lợi gắn ngày mới thay thế.
- **Mở năm quá sớm.** Các nâng cấp dải được giải quyết tại thâm niên của nhân viên tính đến ngày 1 tháng 1, nên hãy mở năm *cho* năm đó — chạy lại sau đó là an toàn.
- **Ngày chấm công trống bị gắn cờ là vắng mặt.** Kiểm tra viên ngữ cảnh: `On leave` yêu cầu một yêu cầu nghỉ phép **đã được phê duyệt** bao phủ ngày đó; nghỉ phép đang chờ xử lý sẽ không ngăn chặn việc vắng mặt.
