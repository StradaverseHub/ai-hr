Mở [Chu kỳ lương](/control-tower/loops/payroll-cycle) trong Trung tâm AI, mục Vận hành › Vòng lặp. Ba vòng lặp đưa bảng lương của từng công ty từ dữ liệu đầu vào đến kiểm toán, mỗi lần một tháng: vòng lặp trước kỳ lương, vòng lặp chạy lương và vòng lặp kiểm toán. Trang này cho biết trạng thái của từng vòng lặp ở mỗi công ty bạn quản lý, so sánh ba chu kỳ gần nhất và các vòng lặp về nhân sự.

## Ba vòng lặp

Vòng lặp trước kỳ lương kiểm tra mọi dữ liệu đầu vào từ đầu kỳ lương đến ngày chốt của công ty: bảng chấm công, làm thêm giờ, nghỉ phép và ngày nghỉ không lương, yêu cầu hoàn ứng, nhân viên mới vào và nghỉ việc, số tài khoản ngân hàng, EPF, SOCSO và mã số thuế, thay đổi lương, thiết lập lương, và các mục kiểm tra mà vòng lặp kiểm toán phát hiện vấn đề hai tháng liền. Mỗi mục kiểm tra liên kết đến trang nơi sửa các mục của nó.

Vòng lặp chạy lương bắt đầu từ ngày chốt và kiểm tra từng lần chạy: thay đổi lương thực nhận của từng người so với ngưỡng biến động lương thực nhận của công ty, giải thích theo nguyên nhân; các kiểm tra bất thường; EPF, SOCSO, EIS và PCB có dùng quy định hiện hành không; và tổng tệp ngân hàng có bằng lương thực nhận không. Mở [Vòng lặp chạy lương](/control-tower/loops/payroll-cycle/salary) để xem kiểm tra của từng lần chạy và ghi nhận một cờ biến động lương thực nhận là dự kiến hay là vấn đề thật. Việc ghi nhận không thay đổi lương.

Vòng lặp kiểm toán làm việc sau ngày trả lương. Mở [Vòng lặp kiểm toán](/control-tower/loops/loop_payroll_audit) để xem phiếu lương đã phát hành và đã mở, từng tệp theo luật định đã chuẩn bị và đã nộp, tệp ngân hàng, các điều chỉnh sau lần chạy, các phát hiện kiểm soát và bộ hồ sơ kiểm toán cho kiểm toán viên của bạn.

## Luôn có một người quyết định

Cả ba vòng lặp đều ở mức Chuẩn bị tại mọi công ty. Lương chỉ do dịch vụ tính lương tính toán. Một người chạy, phê duyệt và đóng bảng lương, nộp hồ sơ cho EPF, PERKESO và LHDN, và ghi nhận từng biên nhận.

## Cài đặt

[Cài đặt chu kỳ lương](/control-tower/loops/payroll-cycle/settings) lưu cho từng công ty tần suất kiểm tra của vòng lặp trước kỳ lương (hằng giờ, hai lần mỗi ngày hoặc hằng ngày) và ngưỡng biến động lương thực nhận (15% cho đến khi được thay đổi), cùng các khoản lương được loại trừ khỏi ngưỡng. Khi các cờ đã ghi nhận cho thấy ngưỡng bắt quá nhiều, trang sẽ đề xuất thay đổi kèm bằng chứng. Không có gì thay đổi cho đến khi quản trị viên phê duyệt, và mọi thay đổi đều được lưu thành một phiên bản mới.

## Hỏi Trung tâm AI

Quản trị viên có thể hỏi Trung tâm AI trong trò chuyện xem bảng lương tháng này có đúng tiến độ không, tệp ngân hàng có khớp không, ngưỡng biến động lương thực nhận là bao nhiêu, hoặc các tệp theo luật định đã được nộp chưa. Câu trả lời cho biết trạng thái và số lượng của các công ty bạn quản lý, không bao giờ cho biết ai bị gắn cờ, chênh lệch bao nhiêu hay bất kỳ con số lương nào, và Trung tâm AI không bao giờ chạy, phê duyệt hay nộp bất cứ thứ gì.

## Học từ lịch sử lương

Khi quản trị viên lương bật việc học cho một công ty, Trung tâm AI học mức lương thường của từng người từ các kỳ lương đã đóng của công ty, kể cả lịch sử đã nhập: lương thực nhận thường của họ trong một tháng thường, trong cả tháng và trong một kỳ thưởng. Nó chỉ học từ các kỳ lương đã đóng và chỉ từ các tháng trước tháng đang được kiểm tra, và bỏ qua các tháng có cảnh báo biến động lương thực nhận được xác định là vấn đề thật, ngoại lệ đã được sửa tại nguồn, điều chỉnh sau kỳ lương, số liệu theo luật được nhập tay, và các tháng trước khi đổi lương. Dịch vụ lương tính mọi khoảng; Trung tâm AI không bao giờ tự làm phép tính.

Từ 3 kỳ lương sạch đã đóng, mỗi cảnh báo biến động lương thực nhận trên trang [Vòng lặp trả lương](/control-tower/loops/payroll-cycle/salary) và mỗi người bị đánh dấu trong các ngoại lệ của một kỳ lương sẽ hiện một dòng như "Mức thường của người này: cao hơn khoảng, từ 7 kỳ lương", kèm khoảng thường. Dòng này giải thích cảnh báo và không thay đổi gì: không con số, phép kiểm tra hay cảnh báo nào. "Đã học trong kỳ này" trên trang [Chu kỳ lương](/control-tower/loops/payroll-cycle) đếm số người có mức lương thường đã ổn định (6 kỳ trở lên), tạm thời (3 đến 5), chưa học, đang học lại sau khi đổi lương, hoặc đã thay đổi. Trong trò chuyện, quản trị viên có thể hỏi cùng các số đếm này; số đếm dưới 5 không bao giờ được đưa ra, và không bao giờ có tên người hay số tiền.

Việc học tắt cho đến khi được bật, mỗi lần thay đổi được lưu thành một phiên bản mới, và khoảng đã học của người nghỉ việc bị xóa 3 tháng sau khi kỳ lương cuối cùng của họ đóng. Phiếu lương của họ vẫn được giữ.
