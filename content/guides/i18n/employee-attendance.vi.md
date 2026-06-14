Hướng dẫn này dành cho **nhân viên** cần ghi lại giờ làm việc của mình trong AI HR. Đến cuối hướng dẫn, bạn sẽ biết cách chấm công vào và ra trong ngày, hiểu ý nghĩa của `present`, `late`, `half_day` và `absent` trên hồ sơ của bạn, xem lại lịch sử gần đây, và yêu cầu quản lý sửa một lần chấm công bị sai. Mọi thao tác dưới đây đều diễn ra từ **Không gian làm việc của tôi** (trang `/me`) — căn cứ chính cho ngày làm việc của riêng bạn.

## Thực hiện ở đâu

Trong thanh bên trái, hãy nhấp vào **Không gian làm việc của tôi**. Trang sẽ mở ra với tên, mã nhân viên và chức vụ của bạn ở phía trên cùng. Thẻ đầu tiên ở góc trên bên trái là thẻ chấm công của bạn — tiêu đề của nó hiển thị **Hôm nay** với ngày hôm nay bên dưới. Đây là nơi bạn chấm công vào, chấm công ra, xem các ngày gần đây, và gửi yêu cầu chỉnh sửa.

**Lưu ý:** Trang **Chấm công** đầy đủ trong thanh bên là bảng chấm công toàn công ty chủ yếu được quản lý và HR sử dụng. Đối với việc chấm công hằng ngày của riêng bạn, hãy ở lại **Không gian làm việc của tôi**.

## Chấm công vào

1. Vào **Không gian làm việc của tôi**. Nhìn vào thẻ **Hôm nay** ở góc trên bên trái.
2. Nếu bạn chưa chấm công vào, bạn sẽ thấy một nút **Chấm công vào** đơn lẻ chiếm trọn chiều ngang. Hãy nhấp vào nó.
3. Thẻ sẽ cập nhật để hiển thị **Đã chấm công vào lúc** cùng với giờ chấm công vào của bạn được in đậm, kèm theo một nhãn trạng thái có màu (ví dụ `Present` hoặc `Late`).

Vậy là xong — một cú nhấp đóng dấu thời gian hiện tại làm giờ chấm công vào của bạn. Hệ thống cũng âm thầm xác định xem hôm nay là ngày làm việc bình thường, ngày nghỉ, hay ngày lễ công cộng, điều này ảnh hưởng đến cách tính làm thêm giờ sau này.

**Mẹo:** Bạn chỉ có thể chấm công vào một lần mỗi ngày. Nếu bạn nhấp **Chấm công vào** lần thứ hai, ứng dụng sẽ báo cho bạn biết rằng bạn đã chấm công vào cho hôm nay rồi.

## Chấm công ra

1. Sau khi đã chấm công vào, thẻ **Hôm nay** hiển thị nút **Chấm công ra** bên dưới giờ chấm công vào của bạn.
2. Vào cuối ngày làm việc của bạn, hãy nhấp **Chấm công ra**.
3. Thẻ sau đó hiển thị trọn ngày của bạn dưới dạng `giờ chấm công vào → giờ chấm công ra` cùng nhãn trạng thái cuối cùng.

Khi bạn chấm công ra, AI HR tính ra số giờ làm việc của bạn (trừ đi thời gian nghỉ theo lịch một khi ngày đủ dài) và bất kỳ giờ làm thêm nào, rồi khóa trạng thái cho ngày đó.

**Lưu ý:** Giờ chấm công ra của bạn phải **sau** giờ chấm công vào. Nếu không, thao tác sẽ bị từ chối.

## Ý nghĩa của các trạng thái

Mỗi ngày trên hồ sơ của bạn mang một nhãn trạng thái. Dưới đây là ý nghĩa và điều gì kích hoạt chúng:

| Trạng thái | Ý nghĩa |
| --- | --- |
| `Present` | Một ngày bình thường — bạn chấm công vào đúng giờ (hoặc làm việc vào ngày nghỉ / ngày lễ, vốn luôn được tính là có mặt). |
| `Late` | Vào ngày làm việc, bạn chấm công vào sau giờ giới hạn của công ty (mặc định là sau 09:15). |
| `Half day` | Vào ngày làm việc, bạn chấm công ra trước giờ giới hạn nửa ngày (mặc định trước 13:00) — tức là bạn về vào khoảng giờ ăn trưa. |
| `Absent` | Không có chấm công nào được ghi nhận cho một ngày làm việc mà không được bao phủ bởi phép đã duyệt, ngày lễ công cộng, hoặc ngày nghỉ. |

Một vài điều đáng biết:

- **Vắng mặt là ngầm định.** Không có nút "absent" — một ngày đơn giản hiển thị là vắng mặt khi không có hồ sơ nào cho một ngày làm việc và không có gì khác giải thích cho điều đó.
- **Phép đã duyệt, ngày lễ công cộng và ngày nghỉ không phải là vắng mặt.** Nếu bạn đang nghỉ phép đã duyệt, hoặc đó là ngày lễ công cộng hay ngày không làm việc của bạn, hệ thống sẽ gắn nhãn ngày đó tương ứng thay vì đánh dấu bạn vắng mặt.
- **Đi muộn và nửa ngày chỉ áp dụng vào ngày làm việc.** Làm việc vào ngày nghỉ hoặc ngày lễ công cộng luôn là `present`, và mọi giờ bạn bỏ ra đều được tính trọn vẹn là làm thêm giờ.

## Xem hồ sơ của bạn

Trên thẻ **Hôm nay**, hãy cuộn đến phần **Gần đây** ngay bên dưới khu vực chấm công vào. Phần này liệt kê những ngày gần nhất của bạn, mỗi ngày hiển thị:

- **ngày**,
- **số giờ làm việc** của bạn cho ngày đó (ví dụ `8h 00m`), kèm huy hiệu làm thêm giờ khi bạn ghi thêm thời gian,
- và **nhãn trạng thái** cho ngày đó.

Điều này cho bạn một lịch sử nhanh, nhìn qua là thấy về cách các ngày gần đây của bạn được phân loại mà không cần rời khỏi Không gian làm việc của tôi.

## Sửa một lần chấm công sai (yêu cầu chỉnh sửa)

Quên chấm công vào? Nhấp **Chấm công ra** sai giờ? Bạn không thể chỉnh sửa chấm công trực tiếp — thay vào đó bạn gửi một **yêu cầu chỉnh sửa** với các giờ chính xác, và **quản lý (hoặc HR) của bạn phê duyệt**. Chỉ khi họ phê duyệt thì hồ sơ của bạn mới thay đổi.

1. Trên thẻ **Hôm nay**, tìm phần **Sửa lần chấm công bị bỏ lỡ** gần phía dưới cùng và nhấp vào nó để mở rộng biểu mẫu.
2. Điền vào các trường:
   - **Ngày** — ngày bạn đang sửa (mặc định là hôm qua). Hãy chọn đúng ngày.
   - **Chấm công vào** — giờ chấm công vào chính xác (mặc định 09:00).
   - **Chấm công ra** — giờ chấm công ra chính xác (mặc định 18:00). Bạn có thể bỏ trống trường này nếu chỉ sửa giờ chấm công vào.
   - **Lý do (tùy chọn)** — một ghi chú ngắn giải thích chuyện gì đã xảy ra, ví dụ "Quên chấm công vào, đã ở công trường từ 9 giờ sáng." Điều này không bắt buộc, nhưng giúp người phê duyệt của bạn quyết định nhanh hơn.
3. Nhấp **Yêu cầu chỉnh sửa**.
4. Yêu cầu của bạn xuất hiện trong danh sách ngay bên dưới biểu mẫu với một nhãn trạng thái: `Pending` trong khi chờ quyết định, sau đó là `Approved` hoặc `Rejected` một khi quản lý của bạn xử lý.

Khi một chỉnh sửa được **phê duyệt**, AI HR dựng lại ngày đó từ các giờ bạn đề xuất — tính lại trạng thái, số giờ làm việc và làm thêm giờ để mọi thứ (bao gồm bất kỳ giờ làm thêm nào chảy vào bảng lương) vẫn chính xác. Ngày đó cũng được đánh dấu là `Corrected` ở phía sau.

**Mẹo:** **Giờ chấm công ra của bạn cũng phải sau giờ chấm công vào** trong biểu mẫu chỉnh sửa, nếu không nó sẽ bị từ chối ngay cả trước khi được gửi đi.

**Lưu ý:** Bạn không thể tự phê duyệt chỉnh sửa của chính mình — đó là chủ ý thiết kế. Nó luôn được chuyển đến một quản lý hoặc HR. Nếu yêu cầu của bạn vẫn hiển thị `Pending`, đơn giản là nó chưa được xử lý.

## Những lỗi thường gặp và khắc phục sự cố

- **"Already checked in today."** Bạn đã chấm công vào rồi. Hãy dùng **Chấm công ra** khi bạn xong việc, hoặc gửi yêu cầu chỉnh sửa nếu giờ được ghi lại bị sai.
- **Không có nút Chấm công vào xuất hiện.** Bạn có thể đã có một hồ sơ cho hôm nay. Hãy kiểm tra thẻ **Hôm nay** — nếu nó hiển thị các giờ của bạn, nghĩa là bạn đã chấm công vào rồi (và có thể đã chấm công ra).
- **Một ngày hiển thị `Absent` nhưng tôi đã làm việc.** Không có chấm công nào được ghi nhận cho ngày làm việc đó. Hãy dùng **Sửa lần chấm công bị bỏ lỡ** để gửi các giờ chính xác cho việc phê duyệt.
- **Một ngày tôi nghĩ là được nghỉ lại hiển thị kỳ lạ.** Phép đã duyệt, ngày lễ công cộng và ngày nghỉ được nhận diện tự động — nếu có điều gì trông sai, hãy kiểm tra xem phép của bạn có thực sự được duyệt không, rồi nêu vấn đề với HR.
- **Chỉnh sửa của tôi vẫn `Pending`.** Nó đang chờ quản lý hoặc HR của bạn phê duyệt hoặc từ chối. Hồ sơ của bạn sẽ không thay đổi cho đến khi họ quyết định.
- **Làm thêm giờ trông sai sau khi chỉnh sửa.** Làm thêm giờ chỉ được hoàn tất một khi có giờ chấm công ra và ngày đó được tính lại. Sau một chỉnh sửa đã được duyệt, số giờ và làm thêm giờ được tính lại mới là số liệu được tính.

**Mẹo:** Hãy tạo thói quen nhấp **Chấm công vào** khi bạn bắt đầu và **Chấm công ra** khi bạn kết thúc mỗi ngày. Hồ sơ sạch sẽ ngay trong ngày nghĩa là ít chỉnh sửa hơn, và giúp giữ cho số giờ của bạn cùng mọi giờ làm thêm chính xác cho bảng lương.
