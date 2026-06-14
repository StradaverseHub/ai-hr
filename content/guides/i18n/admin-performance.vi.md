Hướng dẫn này dành cho quản trị viên HR (`hr_admin` và `super_admin`) thực hiện việc đánh giá hiệu suất trong AI HR. Đến cuối hướng dẫn, bạn sẽ biết cách tạo một chu kỳ đánh giá, đưa nó đi qua trọn vòng đời (`draft` → `open` → `calibration` → `closed`), hiểu cách các bản tự đánh giá và đánh giá của quản lý hợp lại thành một xếp hạng tổng thể duy nhất, kiểm soát chính xác thời điểm nhân viên có thể thấy xếp hạng của họ, và biến đề xuất tăng lương theo năng lực/thưởng của quản lý thành một thay đổi lương thực sự — mà không cần mô-đun Hiệu suất chạm trực tiếp vào bảng lương.

## Tìm nó ở đâu

Trong thanh bên trái, nhấp **Performance**. Tiêu đề trang ghi **Performance** với phụ đề *Review cycles, appraisals, and merit recommendations*.

- **Quản trị viên** thấy bảng **Review cycles** đầy đủ cùng với bảng điều khiển **+ New review cycle**.
- **Quản lý** thấy thẻ **Reviews awaiting you** liệt kê các bản đánh giá mà họ vẫn cần hoàn tất.

Nếu bạn cũng quản lý nhân sự, cả hai chế độ xem sẽ xuất hiện cùng nhau trên trang duy nhất này.

## Tạo một chu kỳ đánh giá

Một *chu kỳ* là vật chứa cho một vòng đánh giá trên một nhóm nhân viên.

1. Trên trang **Performance**, nhấp **+ New review cycle** để mở rộng biểu mẫu.
2. Điền vào các trường:

| Trường | Nó làm gì |
|---|---|
| **Name** | Văn bản tự do, ví dụ `2026 Annual`. |
| **Scope** | `Group-wide (all companies)` hoặc một công ty đơn lẻ. Xác định ai được chụp ảnh nhanh đưa vào. |
| **Period start** / **Period end** | Khung thời gian đánh giá. Mặc định là năm dương lịch hiện tại (1 Jan → 31 Dec). Ngày kết thúc không được trước ngày bắt đầu. |
| **Merit pool (optional)** | Để là `No pool`, hoặc đặt một ngân sách mềm — `% of payroll` hoặc `RM (monthly)` — với một giá trị (ví dụ `3.5`). |
| **Only include staff hired before (optional)** | Loại trừ nhân viên mới tuyển muộn khỏi vòng này. |
| **Exclude employees on probation** | Được tích chọn theo mặc định. |

3. Nhấp **Create cycle (draft)**.

Chu kỳ được tạo ở trạng thái `draft`. Chưa ai được đánh giá — việc mở nó (bước tiếp theo) mới là thứ tạo ra các bản đánh giá thực sự.

**Lưu ý — thang xếp hạng.** Mỗi chu kỳ sử dụng một xếp hạng tổng thể duy nhất trên thang 1–5 có nhãn: `1 · Below`, `2 · Meets`, `3 · Strong`, `4 · Exceeds`, `5 · Outstanding`. Có một điểm tổng thể cho mỗi nhân viên, không phải một rổ năng lực.

**Lưu ý — quỹ tăng lương theo năng lực là một mức trần mềm.** Đó là một hướng dẫn cho việc hiệu chỉnh, không phải một giới hạn cứng. Các đề xuất được phép vượt quá nó; thanh ngân sách chỉ đơn giản chuyển sang màu đỏ để bạn có thể thấy khi nào bạn đã vượt.

## Vòng đời: draft → open → calibration → closed

Mở một chu kỳ bằng cách nhấp vào tên của nó trong bảng **Review cycles**. Trạng thái nằm ở tiêu đề trang dưới dạng huy hiệu, và các nút vòng đời xuất hiện cạnh nó tùy theo trạng thái hiện tại.

### 1. Draft

Một bản nháp hiển thị một thẻ gợi ý giải thích việc mở sẽ làm gì. Nhấp **Open cycle** để bắt đầu.

**"Open cycle" làm gì:** nó chụp ảnh nhanh mỗi nhân viên đang hoạt động và trong phạm vi (trừ thời gian thử việc và tuyển dụng muộn, theo cài đặt của bạn) thành mỗi người một bản đánh giá, đặt **quản lý tuyến hành chính** của mỗi người làm người đánh giá, và bắt đầu giai đoạn tự đánh giá. Chu kỳ chuyển sang `open`. Những nhân viên đã chấm dứt hợp đồng trước thời điểm này không được bao gồm.

**Mẹo:** Sắp xếp đúng các tuyến báo cáo của bạn trong **Org chart** *trước khi* mở — đó là thứ xác định ai đánh giá ai. Nếu một quản lý thay đổi giữa chu kỳ, bạn có thể trỏ lại một bản đánh giá cá nhân (xem *Phân công lại người đánh giá*).

### 2. Open

Đây là giai đoạn đánh giá đang hoạt động. Các bản tự đánh giá và đánh giá của quản lý chỉ có thể được chỉnh sửa khi chu kỳ ở trạng thái `open`. Từ đây tiêu đề cung cấp:

- **Move to calibration** — đóng băng việc chỉnh sửa để thực hiện rà soát hiệu chỉnh.
- **Release ratings** — mở cổng hiển thị (xem bên dưới).
- **Close** — kết thúc chu kỳ.

### 3. Calibration

Sử dụng giai đoạn này để rà soát sự phân bố trước khi bất cứ thứ gì được phát hành. Trên trang chu kỳ bạn sẽ thấy hai thẻ:

- **Rating distribution** — một thanh cho mỗi điểm thang đo hiển thị có bao nhiêu xếp hạng tổng thể *đã hoàn tất* rơi vào đó. Một phân bố lành mạnh thường không phải toàn `4` và `5`.
- **Merit budget** — đã dùng so với quỹ (hằng tháng), cùng với **Recommended bonuses (one-off)** bên cạnh. Thanh có màu xanh lá khi trong quỹ, màu đỏ khi **over by** một khoản nào đó.

Bạn vẫn có thể **Release ratings** hoặc **Close** từ giai đoạn hiệu chỉnh.

### 4. Closed

Một trạng thái cuối cùng. Nhấp **Close** từ `open` hoặc `calibration`.

## Cách các bản tự đánh giá và đánh giá của quản lý luân chuyển

Bản đánh giá của mỗi nhân viên đi qua các trạng thái này (hiển thị trong cột **Status** của bảng **Reviews** của chu kỳ):

`self_review` → `manager_review` → `submitted` → `acknowledged`

1. **Self-review** — nhân viên mở bản đánh giá của họ (từ **My workspace** / `/me`) và gửi một bản tự xếp hạng cùng nhận xét. Điều này chuyển nó sang `manager_review`.
2. **Manager review** — người đánh giá điền một xếp hạng của quản lý, **xếp hạng tổng thể duy nhất**, nhận xét, và (tùy chọn) một % tăng lương theo năng lực và/hoặc đề xuất thưởng. Việc gửi đi chuyển nó sang `submitted`.
3. **Acknowledged** — sau khi bạn phát hành xếp hạng, nhân viên xác nhận họ đã xem nó, chuyển nó sang `acknowledged`.

**Lưu ý — không bị đình trệ.** Một quản lý có thể hoàn tất ngay cả khi nhân viên không bao giờ tự đánh giá. Các bản đánh giá vẫn còn nằm ở `self_review` xuất hiện trong danh sách **Reviews awaiting you** của quản lý nên không có gì bị kẹt lại.

Trên trang chu kỳ, cột tiến độ **Review cycles** ghi `ack / done / total` (đã xác nhận / quản lý đã hoàn tất / tổng số).

### Phân công lại người đánh giá

Nếu sai người được đặt làm người đánh giá (ví dụ một thay đổi tổ chức), hãy mở bản đánh giá cá nhân và phân công lại. Bạn không thể phân công lại trên một chu kỳ đã đóng hoặc trên một bản đánh giá đã ở trạng thái `submitted`/`acknowledged`, và một nhân viên không bao giờ có thể được đặt làm người đánh giá của chính mình.

## Cổng phát hành

Đây là sự kiểm soát quan trọng nhất cần hiểu: **nhân viên không thể thấy xếp hạng của quản lý hoặc điểm tổng thể của họ cho đến khi bạn phát hành chu kỳ.** Cho đến lúc đó, đối tượng chỉ thấy bản tự đánh giá của chính mình. Đề xuất lương thưởng *không bao giờ* hiển thị cho nhân viên.

Để phát hành:

1. Trên trang chu kỳ (trạng thái `open` hoặc `calibration`), nhấp **Release ratings**.
2. Một xác nhận xuất hiện: *"Release ratings to employees? Every employee will be able to see their manager rating and overall score. This cannot be undone."*
3. Xác nhận bằng **Release ratings**.

Sau khi phát hành, tiêu đề hiển thị `ratings released` và chỉ khi đó nhân viên mới có thể **acknowledge** bản đánh giá của họ.

**Mẹo:** Hiệu chỉnh trước, phát hành sau. Một khi đã phát hành thì không thể hoàn tác, vì vậy hãy kiểm tra các thẻ phân bố và ngân sách trước khi bóp cò.

## Hành động lương thưởng — quản lý đề xuất, bạn thực thi

Mô-đun Hiệu suất **không bao giờ ghi lương trực tiếp**. Quản lý *đề xuất* tăng lương theo năng lực và thưởng trên một bản đánh giá; một quản trị viên *thực thi* đề xuất đó thông qua các engine bảng lương hiện có, đã được kiểm thử. Sự tách biệt này là có chủ đích.

Trên trang chu kỳ, khi có các đề xuất đang chờ xử lý, một thẻ **Pay recommendations to enact** xuất hiện. Phần giải thích của nó ghi: *"Enacting applies the change through payroll: a merit % becomes an effective-dated salary increase; a bonus is staged into a draft batch and taxed as additional remuneration. Performance never writes pay directly."*

Đối với mỗi dòng, bạn sẽ thấy nhân viên, `merit X% (on RM …)` và/hoặc `bonus RM …` được đề xuất, và các đầu vào để thực thi:

- **Merit** — chọn một ngày **effective** (mặc định là ngày sau khi kỳ chu kỳ kết thúc). Khi thực thi, hệ thống tạo một đợt tăng lương có ngày hiệu lực thông qua lương thưởng; lương cơ bản mới = lương cơ bản hiện tại × (1 + merit%).
- **Bonus** — chọn một **bonus batch** (một đợt bảng lương nháp cho công ty của nhân viên). Khoản thưởng được đưa vào đợt đó và bị tính thuế dưới dạng **additional remuneration (MTD)**.

Sau đó:

1. Nhấp **Enact**.
2. Xác nhận: *"Enact pay for {employee}? This applies a real pay change through payroll — an effective-dated raise and/or a taxed bonus. It cannot be undone here."*

Để từ chối một đề xuất thay vì vậy, hãy nhấp **Decline**.

**Những cạm bẫy thường gặp**

- **"Bonus needs a draft batch."** Nếu không có đợt bảng lương nháp đang mở nào cho công ty của nhân viên, dòng đó hiển thị điều này với một liên kết **create one in Payroll**. Hãy vào **Payroll**, tạo một đợt nháp, rồi quay lại và thực thi.
- **Sai đợt của công ty.** Đợt thưởng phải thuộc về cùng công ty với nhân viên, nếu không việc thực thi sẽ bị chặn.
- **Ngày hiệu lực quá sớm.** Ngày hiệu lực của một đợt tăng lương theo năng lực phải rơi *sau* khi bản ghi lương hiện tại của nhân viên bắt đầu, nếu không nó bị từ chối.
- **Không có lương hiện tại.** Bạn không thể áp dụng đợt tăng lương theo năng lực cho người không có lương thưởng hiện tại trong hồ sơ.
- **Nhân viên đã chấm dứt hợp đồng.** Không thể thực thi lương cho một nhân viên đã rời đi.

**Lưu ý — quỹ tăng lương theo năng lực vẫn mang tính tham khảo.** Việc thực thi không cưỡng chế quỹ. Thẻ ngân sách khôi phục cơ sở lương trước khi tăng cho các dòng đã thực thi nên con số *đã dùng so với quỹ* vẫn ổn định khi các đợt tăng lương được áp dụng.

## Khắc phục sự cố

- **Không thể mở một chu kỳ hai lần.** Việc mở chỉ hoạt động từ `draft`; một chu kỳ đã ở `open`/`calibration`/`closed` sẽ không chụp ảnh nhanh lại.
- **Một bản đánh giá không cho tôi chỉnh sửa.** Các bản tự đánh giá và đánh giá của quản lý chỉ có thể chỉnh sửa khi chu kỳ ở `open`. Việc đưa nó ra khỏi giai đoạn hiệu chỉnh là không thể — hãy hoàn tất trước khi hiệu chỉnh.
- **Một nhân viên nói họ không thể thấy xếp hạng của mình.** Hãy xác nhận chu kỳ đã được **phát hành** (tiêu đề hiển thị `ratings released`). Trước khi phát hành, đó là theo thiết kế.
- **Mọi hành động đều được ghi lại.** Các chuyển đổi chu kỳ và bản đánh giá, các lần phát hành, và các lần thực thi đều ghi vào nhật ký kiểm toán — xem **Admin → Audit trail** (`/admin/audit`) nếu bạn cần xác nhận ai đã làm gì và khi nào.
