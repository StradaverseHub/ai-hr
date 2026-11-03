Mở [Vòng lặp](/control-tower/loops) trong Trung tâm AI, mục Vận hành. Một vòng lặp theo dõi một phần công việc nhân sự, chuẩn bị việc một người cần làm và ở lần chạy tiếp theo kiểm tra xem việc đó đã xong chưa. Có năm vòng lặp: Kết thúc thử việc, Dữ liệu lương sẵn sàng, Thiếu dữ liệu nhân viên, Quên chấm công ra và Hộ chiếu sắp hết hạn. Mỗi dòng cho biết "hoàn thành" nghĩa là gì với vòng lặp đó, cấp của nó, nó có đang bật không, lần chạy gần nhất và số thẻ nó đã chuẩn bị trong 30 ngày qua.

## Chỉ chuẩn bị, không bao giờ tự hành động

Mọi vòng lặp đều hoạt động ở cấp Chuẩn bị. Mỗi đêm, vòng lặp chỉ đọc những gì quản trị viên đã bật nó được phép xem, chuẩn bị thẻ cho đúng người (quản trị viên nhân sự, bộ phận lương hoặc chính nhân viên) và tự nó không thay đổi hồ sơ nào. Người đó thấy thẻ ở Hôm nay và hoàn tất công việc trên trang thông thường, với các bước kiểm tra và phê duyệt của chính trang đó. Ở lần chạy tiếp theo, vòng lặp kiểm tra lại: khi việc đã xong, nó đóng thẻ, và nếu việc tương tự xảy ra lần nữa, nó mở lại thẻ. Mỗi đêm một vòng lặp chuẩn bị tối đa 200 thẻ mới cho mỗi công ty và không bao giờ gọi mô hình AI.

Không vòng lặp nào tự hành động. Lương, tình trạng việc làm, quyền truy cập, kỷ luật và nộp hồ sơ theo luật định luôn cần một người quyết định: vòng lặp chỉ chuẩn bị công việc và chỉ đến trang nơi một người đưa ra quyết định.

## Bật hoặc tắt một vòng lặp

Mọi vòng lặp đều tắt cho đến khi một quản trị viên tập đoàn bật nó. Bật hoặc tắt một vòng lặp áp dụng cho mọi công ty trong tập đoàn, và quản trị viên tập đoàn bật nó trở thành người bảo trợ. Nếu người bảo trợ mất quyền quản trị, vòng lặp sẽ dừng. Công tắc dừng của công ty dừng mọi vòng lặp cùng lúc.

## Tạm dừng một vòng lặp cho một công ty

Mở một vòng lặp từ danh sách Vòng lặp. Trong phần Tạm dừng cho một công ty, quản trị viên của công ty đó có thể chọn Tạm dừng hoặc Tiếp tục. Vòng lặp bị tạm dừng sẽ không chạy và không hiện thẻ ở công ty đó; các công ty khác không bị ảnh hưởng. Để dừng một vòng lặp ở mọi nơi, quản trị viên tập đoàn sẽ tắt nó.

## Hỏi Trung tâm AI về vòng lặp

Quản trị viên có thể hỏi Trung tâm AI trong khung trò chuyện những vòng lặp nào đang bật hoặc đang tạm dừng, mỗi vòng lặp chạy gần nhất khi nào và còn bao nhiêu thẻ đang mở. Câu trả lời chỉ đưa ra số lượng và trạng thái cho các công ty bạn quản trị, không bao giờ cho biết thẻ dành cho ai và không bao giờ thay đổi vòng lặp: việc bật và tạm dừng được thực hiện trên trang Vòng lặp.
