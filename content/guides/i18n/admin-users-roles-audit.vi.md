Hướng dẫn này dành cho các quản trị viên HR quản lý **ai được làm gì** bên trong AI HR và những người cần trả lời câu hỏi *"ai đã thay đổi điều này, và khi nào?"*. Đến cuối hướng dẫn, bạn sẽ biết cách đọc và cấp bốn vai trò, sự khác biệt giữa cấp quyền toàn nhóm và cấp quyền giới hạn theo công ty, cách một quản trị viên công ty có thể ủy thác an toàn trong phần thuộc nhóm của mình, cách thu hồi quyền truy cập, và cách sử dụng cả **Audit trail** toàn cục lẫn **History** theo từng bản ghi — cả hai đều đọc từ nhật ký sự kiện chỉ-ghi-thêm (append-only).

> **Lưu ý** Các trang được mô tả ở đây nằm dưới mục **Admin** trong thanh bên trái. Nếu bạn không thấy chúng, tài khoản của bạn không mang vai trò quản trị — chỉ `hr_admin` và `super_admin` mới có thể mở `/admin/users` và `/admin/audit`. Tất cả những người khác sẽ được chuyển hướng về bảng điều khiển.

## Bốn vai trò

AI HR có đúng bốn vai trò. Chúng xếp chồng lên nhau — một người có thể giữ nhiều hơn một vai trò.

| Vai trò | Ý nghĩa | Người giữ điển hình |
| --- | --- | --- |
| `employee` | Chỉ tự phục vụ: hồ sơ của mình, phiếu lương, nghỉ phép, chấm công | Mọi nhân viên |
| `manager` | Thêm hộp thư **Approvals** cho cấp dưới của họ | Trưởng nhóm, quản lý trực tiếp |
| `hr_admin` | Thêm toàn bộ bộ công cụ **Admin** (Organization, cấu hình Leave, Payroll, Users & roles, Audit trail) | HR/vận hành |
| `super_admin` | Mọi thứ mà `hr_admin` có, **luôn luôn trên toàn bộ nhóm** | Chủ sở hữu nền tảng |

Các vai trò hiển thị dưới dạng các thẻ bo tròn nhỏ (**RoleTag**), nên trên trang Users bạn sẽ thấy chúng được viết là `employee`, `manager`, `hr admin`, và `super admin`.

## Cấp quyền toàn nhóm so với cấp quyền giới hạn theo công ty

Đây là khái niệm quan trọng nhất trên trang này, vì AI HR là **đa công ty**: một tenant có thể chứa nhiều công ty trong một cây cha/con.

- Một quyền **toàn nhóm** không gắn với công ty nào. Nó áp dụng cho mọi công ty. `super_admin` *vốn dĩ* là toàn nhóm — hệ thống không bao giờ giới hạn nó vào một công ty đơn lẻ.
- Một quyền **giới hạn theo công ty** gắn một `hr_admin` vào một công ty cụ thể (và, theo cây nhóm, cả cây con của nó). Trên trang Users, một vai trò giới hạn sẽ hiển thị tên công ty bên cạnh thẻ, như `hr admin · Acme Sdn Bhd`.

> **Lưu ý** Hiện nay chỉ có `hr_admin` thực sự sử dụng phạm vi công ty. Nếu bạn chọn một công ty cho `employee` hoặc `manager`, hệ thống dù sao cũng lưu quyền đó ở cấp nhóm — nên đừng dựa vào việc giới hạn theo công ty cho hai vai trò đó.

## Cấp một vai trò

1. Trong thanh bên trái, mở **Admin → Users & roles** (`/admin/users`).
2. Bạn sẽ thấy danh sách mọi người dùng. Mỗi hàng hiển thị ảnh đại diện, tên, email, và các thẻ vai trò mà họ đã giữ. Phần tiêu đề hiển thị tổng số người dùng.
3. Tìm người đó, rồi sử dụng biểu mẫu nội tuyến ở bên phải hàng của họ:
   - Trong danh sách thả xuống đầu tiên, chọn **vai trò**.
   - Trong danh sách thả xuống thứ hai, chọn một **công ty** (phạm vi) — hoặc để ở **Group-wide**.
   - Nhấp **Add role**.
4. Thẻ mới xuất hiện trên hàng của họ ngay lập tức.

**Những gì bạn thấy phụ thuộc vào quyền truy cập của chính bạn.** Trang này tự điều chỉnh:

- Một **quản trị viên nhóm** (một `super_admin`, hoặc một `hr_admin` toàn nhóm) có thể cấp *bất kỳ* vai trò nào trong bốn vai trò, cho bất kỳ công ty nào hoặc toàn nhóm. Danh sách thả xuống công ty bao gồm tùy chọn **Group-wide** ở trên cùng.
- Một **quản trị viên được ủy thác (giới hạn theo công ty)** thấy một biểu mẫu thu gọn: danh sách thả xuống vai trò chỉ cung cấp `hr_admin`, và danh sách thả xuống công ty chỉ liệt kê những công ty họ quản trị. Nói cách khác, một quản trị viên công ty có thể bổ nhiệm các quản trị viên HR khác, nhưng chỉ trong cây con của chính mình.

> **Mẹo** Việc cấp phát các tài khoản người dùng cơ bản diễn ra thông qua nhà cung cấp danh tính của bạn (WorkOS). Ghi chú màu xám ở đầu trang Users giải thích điều này. AI HR là nơi bạn gán *vai trò* cho những người đã tồn tại — nó không phải nơi bạn tạo tài khoản đăng nhập từ đầu.

## Ủy thác cấp dưới: một quản trị viên công ty gán quyền trong cây con của mình

AI HR được xây dựng để bạn có thể bàn giao việc quản trị HR một cách an toàn mà không trao chìa khóa cho toàn bộ nhóm.

- Một quản trị viên nhóm giới hạn một `hr_admin` vào, chẳng hạn, **Acme Sdn Bhd**.
- Người đó giờ có thể mở **Users & roles** và bổ nhiệm thêm các quyền `hr_admin` — nhưng biểu mẫu chỉ cho phép họ chọn `hr_admin`, và chỉ cho **Acme** cùng bất kỳ công ty nào nằm dưới nó trong cây nhóm.
- Họ không thể nâng quyền. Họ không thể tạo ra một `super_admin`, và họ không thể vươn tới một công ty ngang hàng bên ngoài cây con của mình.

Ranh giới này được thực thi bằng bảo mật cấp hàng (row-level security) trong cơ sở dữ liệu, không chỉ bằng cách ẩn các nút bấm — nên ngay cả một yêu cầu được dàn dựng cũng không thể vượt qua giới hạn.

## Thu hồi một vai trò

1. Trên **Users & roles**, định vị thẻ vai trò bạn muốn xóa.
2. Nhấp vào dấu **×** nhỏ ở bên phải thẻ (chú giải công cụ của nó ghi **Revoke role**). Nó chuyển sang màu đỏ khi di chuột.
3. Quyền bị xóa và thẻ biến mất.

**Ai có thể thu hồi cái gì:**

- Một **quản trị viên nhóm** có thể thu hồi bất kỳ thẻ vai trò nào.
- Một **quản trị viên được ủy thác** chỉ thấy dấu **×** trên các quyền **`hr_admin` giới hạn theo công ty** — những quyền nằm trong cây con của họ. Các quyền toàn nhóm và các vai trò khác không có nút điều khiển xóa đối với họ.

> **Lưu ý** Việc thu hồi thực sự được kiểm tra quyền. Nếu một quản trị viên được ủy thác bằng cách nào đó nhắm vào một quyền bên ngoài cây con của mình, hành động sẽ thất bại với thông báo *"Not permitted to revoke this role assignment"* và không có gì bị thay đổi hay ghi nhật ký — hệ thống không bao giờ ghi lại một lần thu hồi cho một hàng vẫn còn tồn tại.

## Nhật ký kiểm toán (`/admin/audit`)

Mọi thay đổi trạng thái trong AI HR đều thêm một mục vào **nhật ký sự kiện chỉ-ghi-thêm** — không có gì từng được chỉnh sửa hay xóa tại chỗ. Audit trail là cửa sổ của bạn nhìn vào sổ cái đó.

1. Trong thanh bên, mở **Admin → Audit trail** (`/admin/audit`).
2. Ở trên cùng là một thanh bộ lọc với bốn điều khiển và một nút **Filter**:
   - **Record type** — thu hẹp về một loại bản ghi, ví dụ `Role assignment`, `Employee`, `Leave request`, `Payroll batch`. Để ở **All** để xem tất cả.
   - **Search event** — khớp văn bản tự do trên tên sự kiện.
   - **From** / **To** — một khoảng ngày.
   - Nhấp **Filter** để áp dụng, hoặc **Reset** để xóa.
3. Bên dưới, các sự kiện xuất hiện mới nhất trước, 100 mục mỗi trang. Dùng **Older →** và **← Newer** ở dưới cùng để di chuyển giữa các trang; chỉ báo hiển thị số trang hiện tại.

**Đọc một hàng.** Mỗi hàng là một sự kiện. Từ trái sang phải bạn sẽ thấy:

- Một **chấm màu** nhỏ cho biết loại tác nhân — một người (`USER`), `System`, `Agent`, hoặc `External`.
- **Tên sự kiện đã được nhân hóa** (ví dụ `Role assigned`, `Role revoked`, `Company updated`) và **ai** đã thực hiện nó.
- **Bản ghi** mà nó tác động đến (thường là một liên kết có thể nhấp, ví dụ một nhân viên hoặc một lô bảng lương).
- Một **dấu thời gian tương đối** (`just now`, `5m ago`, `3h ago`, `2d ago`). Di chuột để xem ngày và giờ chính xác.

Nhấp vào bất kỳ hàng nào để mở rộng nó. Một khối chi tiết nhỏ hiển thị những gì đã thay đổi — đối với các chỉnh sửa, một khác biệt `from → to` cho mỗi trường; đối với các sự kiện khác, các trường liên quan. Một số thứ tự nằm ở dưới cùng của phần chi tiết.

> **Lưu ý** Các giá trị nhạy cảm được che trong chế độ xem audit. Số tài khoản ngân hàng, số IC, mã số thuế, và các con số lương/thù lao hiển thị dưới dạng `•••• 1234` (hoặc `••••`) để dấu vết vẫn hữu ích mà không lộ PII hay dữ liệu tài chính.

## History theo từng bản ghi

Bạn không phải lội qua nhật ký toàn cục để điều tra một người. Mở bất kỳ nhân viên nào từ **People**, cuộn đến phần **Change history** gần cuối trang chi tiết của họ. Nó sử dụng cùng các hàng có thể mở rộng như Audit trail, nhưng được lọc sẵn chỉ còn các sự kiện của riêng nhân viên đó — cấp vai trò, thay đổi hồ sơ và ngân hàng, thù lao, chỉnh sửa theo luật định, và nhiều hơn nữa.

> **Mẹo** Khối **Change history** chỉ dành cho quản trị viên. Các quản lý và nhân viên xem một hồ sơ sẽ không thấy nó.

## Khắc phục sự cố & những cạm bẫy thường gặp

- **Tôi chỉ có thể cấp `hr_admin`.** Bạn là một quản trị viên giới hạn theo công ty (được ủy thác). Đó là theo thiết kế — bạn có thể bổ nhiệm các quản trị viên HR trong cây con của mình nhưng không có gì cao hơn.
- **Danh sách thả xuống công ty thiếu công ty tôi cần.** Bạn chỉ thấy những công ty bạn quản trị. Hãy nhờ một quản trị viên nhóm mở rộng phạm vi của bạn, hoặc thực hiện việc cấp quyền giúp bạn.
- **Không có dấu `×` để thu hồi.** Bạn chỉ có thể thu hồi các quyền `hr_admin` giới hạn theo công ty trong cây con của mình. Các quyền toàn nhóm hoặc cao hơn cần một quản trị viên nhóm.
- **Tôi đã giới hạn một `manager` vào một công ty nhưng nó hiển thị là toàn nhóm.** Đúng như dự kiến — chỉ `hr_admin` mới mang phạm vi công ty. Các quyền của manager và employee luôn ở cấp nhóm.
- **Một sự kiện dường như bị thiếu.** Hãy kiểm tra các bộ lọc của bạn trước (Record type và khoảng ngày được giữ cố định qua các trang). Hãy nhớ rằng nhật ký là chỉ-ghi-thêm — các mục không bao giờ bị xóa, nên hãy mở rộng khoảng thời gian thay vì cho rằng nó đã bị xóa.
