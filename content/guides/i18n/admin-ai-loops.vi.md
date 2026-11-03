Mở [Vòng lặp](/control-tower/loops) trong Trung tâm AI, mục Vận hành. Một vòng lặp theo dõi một phần công việc nhân sự, chuẩn bị việc một người cần làm và ở lần chạy tiếp theo kiểm tra xem việc đó đã xong chưa. Có sáu vòng lặp: Kết thúc thử việc, Vòng lặp trước kỳ lương, Thiếu dữ liệu nhân viên, Quên chấm công ra, Hộ chiếu sắp hết hạn và Vòng lặp chạy lương. Mỗi dòng cho biết "hoàn thành" nghĩa là gì với vòng lặp đó, cấp của nó, nó có đang bật không, lần chạy gần nhất và số thẻ nó đã chuẩn bị trong 30 ngày qua. Chu kỳ lương, ở đầu trang, theo dõi vòng lặp trước kỳ lương, vòng lặp chạy lương và vòng lặp kiểm toán qua từng tháng lương.

## Bốn cấp

Mỗi vòng lặp có cấp riêng ở từng công ty. Công ty chưa được đặt cấp sẽ ở cấp Chuẩn bị.

- Theo dõi: vòng lặp ghi lại những gì nó phát hiện cho công ty, không hiện thẻ cho ai và không thay đổi hồ sơ nào.
- Chuẩn bị: mỗi đêm, vòng lặp chỉ đọc những gì quản trị viên đã bật nó được phép xem, chuẩn bị thẻ cho đúng người (quản trị viên nhân sự, bộ phận lương hoặc chính nhân viên) và tự nó không thay đổi hồ sơ nào. Người đó thấy thẻ ở Hôm nay và hoàn tất công việc trên trang thông thường, với các bước kiểm tra và phê duyệt của chính trang đó. Ở lần chạy tiếp theo, vòng lặp kiểm tra lại: khi việc đã xong, nó đóng thẻ, và nếu việc tương tự xảy ra lần nữa, nó mở lại thẻ.
- Thực hiện trong giới hạn: vòng lặp tự thực hiện bước của mình, trong giới hạn của công ty: số thao tác tối đa mỗi đêm (không bao giờ quá 200) và thời hạn hoàn tác 3 hoặc 7 ngày. Nó báo cho người liên quan, và mọi thao tác đều có thể được hoàn tác trong thời hạn đó. Quên chấm công ra đặt giờ chấm công ra bằng giờ kết thúc ca qua chấm công và không bao giờ tạo ra giờ làm thêm; Thiếu dữ liệu nhân viên tự gửi yêu cầu cho nhân viên và không thay đổi hồ sơ nào.
- Thực hiện và kiểm tra: giống Thực hiện trong giới hạn, và bộ phận nhân sự xem xét một mẫu thao tác hằng tuần (ít nhất 10% và ít nhất 5 thao tác) thay vì từng thao tác.

Mỗi đêm một vòng lặp chuẩn bị tối đa 200 thẻ mới cho mỗi công ty và không bao giờ gọi mô hình AI.

## Thay đổi cấp

Mở một vòng lặp từ danh sách Vòng lặp để xem cấp của nó ở từng công ty bạn quản trị. Chỉ quản trị viên tập đoàn mới thay đổi được cấp, và mọi thay đổi đều được ghi lại cùng người thực hiện. Một vòng lặp lên từng cấp một, và chỉ vượt qua cấp Chuẩn bị khi bằng chứng trong 30 ngày qua đạt yêu cầu: ít nhất 200 thẻ hoặc thao tác, không vi phạm quy tắc nào, 30 ngày ở cấp hiện tại (90 ngày ở Thực hiện trong giới hạn trước khi lên Thực hiện và kiểm tra) và, với Quên chấm công ra, dưới 1% bị người khác thay đổi. Có thể hạ cấp bất cứ lúc nào. Nếu trong 7 ngày có hơn 1% thao tác tự động của nó bị người khác sửa hoặc hoàn tác, nó tự trở về cấp Chuẩn bị ở công ty đó.

## Lương, tình trạng việc làm, quyền truy cập, kỷ luật và nộp hồ sơ luôn ở cấp Chuẩn bị

Lương, tình trạng việc làm, quyền truy cập hệ thống, kỷ luật và nộp hồ sơ theo luật định luôn cần một người quyết định. Vòng lặp nào liên quan đến bất kỳ việc nào trong số đó đều ở cấp Chuẩn bị tại mọi công ty: điều này được cố định trong sản phẩm, không phải một thiết lập, và không thay đổi cấp nào có thể gỡ bỏ. Kết thúc thử việc (tình trạng việc làm), vòng lặp trước kỳ lương và vòng lặp chạy lương (lương) ở cấp Chuẩn bị, vòng lặp kiểm toán (lương và nộp hồ sơ theo luật định) cũng vậy. Hộ chiếu sắp hết hạn cũng ở cấp Chuẩn bị. Chỉ Quên chấm công ra và Thiếu dữ liệu nhân viên mới có thể vượt qua cấp Chuẩn bị.

## Bật hoặc tắt một vòng lặp

Mọi vòng lặp đều tắt cho đến khi một quản trị viên tập đoàn bật nó. Bật hoặc tắt một vòng lặp áp dụng cho mọi công ty trong tập đoàn, và quản trị viên tập đoàn bật nó trở thành người bảo trợ. Nếu người bảo trợ mất quyền quản trị, vòng lặp sẽ dừng. Công tắc dừng của công ty dừng mọi vòng lặp cùng lúc.

## Tạm dừng một vòng lặp cho một công ty

Mở một vòng lặp từ danh sách Vòng lặp. Trong phần Tạm dừng cho một công ty, quản trị viên của công ty đó có thể chọn Tạm dừng hoặc Tiếp tục. Vòng lặp bị tạm dừng sẽ không chạy và không hiện thẻ ở công ty đó; các công ty khác không bị ảnh hưởng. Để dừng một vòng lặp ở mọi nơi, quản trị viên tập đoàn sẽ tắt nó.

## Hỏi Trung tâm AI về vòng lặp

Quản trị viên có thể hỏi Trung tâm AI trong khung trò chuyện những vòng lặp nào đang bật hoặc đang tạm dừng, cấp của mỗi vòng lặp ở các công ty bạn quản trị, mỗi vòng lặp chạy gần nhất khi nào và còn bao nhiêu thẻ đang mở. Câu trả lời chỉ đưa ra số lượng và trạng thái cho các công ty bạn quản trị, không bao giờ cho biết thẻ dành cho ai và không bao giờ thay đổi vòng lặp: việc bật, tạm dừng và thay đổi cấp được thực hiện trên các trang Vòng lặp.
