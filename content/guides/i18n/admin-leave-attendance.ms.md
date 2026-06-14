Panduan ini untuk pentadbir HR (`hr_admin` dan `super_admin`) yang menyediakan dan menyelenggara peraturan cuti serta kehadiran bagi syarikat mereka dalam AI HR. Menjelang akhir panduan, anda akan tahu cara menentukan jenis cuti, menindih dasar kelayakan syarikat di atas paras minimum statutori Malaysia, membetulkan atau membuang sesuatu dasar, membuka tahun cuti baharu dengan bawa ke hadapan, dan memahami cara jenis-hari kehadiran serta permintaan pembetulan berfungsi. Semua skrin ini memerlukan peranan pentadbir — pekerja dan pengurus langsung tidak akan melihat konfigurasi Cuti.

## Konfigurasi cuti

Pada bar sisi kiri, di bawah **Admin**, klik **Leave config**. Anda akan tiba di halaman **Konfigurasi cuti**, yang disusun dalam dua kad: **Jenis cuti & kelayakan** di bahagian atas dan **Tahun cuti** di bahagian bawah.

### Cara paras minimum statutori berfungsi

AI HR disertakan dengan pek negara Malaysia (Akta Kerja 1955) yang terbina dalam. Minimum statutori **tidak boleh dikonfigurasi** — ia datang daripada pek tersebut dan dijaluri mengikut tahun perkhidmatan yang lengkap (`<2` / `2–5` / `5+` tahun). Dasar syarikat anda ditindih *di atas* paras minimum ini.

Peraturan utama, yang diulang di seluruh UI: **pemberian menggunakan nilai yang lebih besar antara paras minimum statutori dan dasar syarikat anda.** Dasar yang di bawah minimum direkodkan dan dipaparkan dengan lencana `below minimum`, tetapi ia tidak pernah benar-benar digunakan — pekerja masih menerima jumlah statutori.

Jaluran pek ialah:

| Jenis cuti | `<2 yrs` | `2–5 yrs` | `5+ yrs` | Pengiraan |
| --- | --- | --- | --- | --- |
| `ANNUAL` | 8 | 12 | 16 | Hari bekerja |
| `SICK` (pesakit luar) | 14 | 18 | 22 | Hari kalendar |
| `HOSPITALIZATION` | 60 | 60 | 60 | Hari kalendar |
| `MATERNITY` | 98 | 98 | 98 | Hari kalendar |
| `PATERNITY` | 7 | 7 | 7 | Hari kalendar |

**Nota:** Cuti tahunan **dikadarkan secara prorata** dalam tahun pengambilan; cuti sakit dan kemasukan hospital diberikan **sepenuhnya** (ia kelayakan setiap tahun kalendar, tidak diprorata untuk yang menyertai pertengahan tahun).

### Menambah jenis cuti

1. Tatal ke borang di bahagian bawah kad **Jenis cuti & kelayakan**.
2. Masukkan **Code** — huruf, digit atau garis bawah, disimpan dalam huruf besar (cth. `SICK`). Kod ialah kunci semantik yang dipadankan oleh paras minimum, pemberian tetap dan bawa ke hadapan, jadi ia penting: taipkan `annual` dan ia dinormalkan kepada `ANNUAL` supaya ia tidak akan terlepas paras minimum EA secara senyap.
3. Masukkan **Name** (cth. `Sick Leave`).
4. Biarkan **Paid** ditanda kecuali ini jenis tidak bergaji.
5. Klik **Add type**.

Jenis baharu muncul dalam senarai di atas sebagai baris terlipat yang menunjukkan nama, kod, dan hari/tahun berkesannya.

### Membaca baris jenis-cuti

Setiap jenis cuti ialah **baris boleh kembang**. Klik untuk mengembangkannya. Di sebelah kanan baris terlipat anda akan nampak **kelayakan berkesan** (`days/yr`) dan salah satu daripada dua lencana:

- `policy` (zamrud) — dasar syarikat anda **melebihi** paras minimum dan itulah yang digunakan.
- `below minimum` (ambar) — dasar aktif anda *di bawah* paras minimum, jadi paras minimum digunakan sebaliknya.

Mengembangkan baris mendedahkan: kawalan peringkat-jenis (**Rename**, serta **Archive**/**Unarchive**/**Delete**), baris baca-sahaja **Statutory minimum (MY)**, dan garis masa **Company entitlements**.

**Petua:** Jenis yang sedang digunakan hanya boleh **Archived** (ia kekal dirujuk oleh permintaan lepas dan entri lejar); jenis yang tidak dirujuk di mana-mana menunjukkan **Delete** sebaliknya. Jenis yang diarkibkan muncul malap dengan lencana `archived`.

### Editor kelayakan dalam baris

Dasar kelayakan **bertarikh berkuat kuasa** dan disunting dalam baris jenis tersebut — tiada borang dasar yang berasingan dan terputus. Model mental:

- **Add** kelayakan bertarikh baharu untuk mengubah perkara **ke hadapan**.
- **Edit** kelayakan sedia ada untuk **membetulkan** nilai yang tersalah taip (tarikh berkuat kuasa yang sama).
- **Remove** kelayakan untuk menghentikannya daripada memacu pemberian masa hadapan.

Untuk menambah kelayakan:

1. Kembangkan jenis cuti.
2. Klik **+ Add entitlement**.
3. Isi **Days / year**.
4. Untuk cuti tahunan sahaja, tetapkan **Carry cap** — bilangan maksimum hari tidak digunakan yang dibawa ke tahun cuti seterusnya (lalai `0`). Jenis bukan tahunan tidak memaparkan medan ini; bawaan mereka sentiasa sifar.
5. Tetapkan **Effective from** (satu tarikh). Dasar aktif yang terbaharu ialah yang digunakan hari ini.
6. Klik **Add**.

Untuk membetulkan satu, klik **Edit** pada baris dasar, ubah **Days / year** (atau **Carry cap** / **Effective from**), dan klik **Save**. Untuk menghentikan satu daripada memacu pemberian masa hadapan, klik **Remove** dan sahkan.

**Nota:** Membuang kelayakan adalah selamat — pemberian lepas kekal kerana lejar cuti merujuk *jenis* cuti, bukan dasar. Pembuangan hanya menghentikan baris itu daripada menyuap pemberian masa hadapan.

Baris dasar aktif membawa lencana `active`; dasar yang telah digantikan menunjukkan julat `from … to …`-nya. Mesej `none` / "No company policy — the statutory floor applies" bermaksud hanya jumlah statutori sahaja yang berkuat kuasa untuk jenis itu.

## Cuti umum

Cuti umum datang daripada pek negara Malaysia dan memacu dua perkara secara automatik — tiada editor cuti umum berasingan untuk diselenggara:

- **Cuti hari bekerja** (cuti tahunan) **mengecualikan** hujung minggu dan cuti umum daripada kiraan hari, jadi memohon cuti yang merentasi cuti umum tidak membakar satu hari cuti tahunan.
- Pada halaman **Attendance**, hari tanpa rekod ketukan pada cuti umum menunjukkan pil konteks `Holiday` dan bukannya dikira sebagai tidak hadir, dan sebarang kerja yang dilog pada hari itu dianggap kerja lebih masa cuti umum.

## Membuka tahun cuti baharu

Pada permulaan setiap tahun kalendar anda mesti **membuka tahun cuti** untuk memberikan kelayakan baharu semua orang. Dalam kad **Leave year** pada halaman Leave config:

1. Medan **Year** dilalaikan kepada tahun hadapan. Laraskan jika perlu.
2. Klik **Open leave year**.

Apa yang berlaku:

- Setiap pekerja **aktif** yang diambil sebelum 1 Jan tahun tersebut menerima kelayakan tetap baharu mereka (`ANNUAL`, `SICK`, `HOSPITALIZATION`) pada **jaluran perkhidmatan semasa** mereka — jadi naik taraf jaluran 2-tahun dan 5-tahun berlaku di sini secara automatik, diselesaikan sebagai `max(statutory floor, policy)`.
- **Bawa ke hadapan:** cuti tahunan tidak digunakan dibawa sehingga **Carry cap** dasar; apa-apa yang melebihi dilucutkan (s.60E menjangka cuti diambil dalam tahun itu). Cuti sakit dan kemasukan hospital **ditetap semula** — ia tidak dibawa.
- Operasi ini **idempoten** dan selamat untuk dijalankan semula: pekerja yang sudah dibuka untuk tahun itu dilangkau, dan sesiapa yang diambil *semasa* tahun itu diliputi oleh pemberian pengambilan prorata mereka, jadi mereka juga dilangkau di sini.

**Petua:** Jalankan ini sekali berhampiran permulaan tahun. Jika anda menambah kelayakan bertarikh ke belakang selepas itu, anda boleh membuka semula tahun itu dengan selamat — pekerja yang sudah diberi tidak akan dikira dua kali.

## Kehadiran

Pada bar sisi, klik **Attendance**. Halaman ini mempunyai tiga bahagian: grid hari (dilalaikan kepada **Today**, navigasi dengan pemilih tarikh), **Correction requests** (hanya apabila ada yang menunggu tindakan), dan **Month summary**.

### Dasar kehadiran dan pengelasan jenis-hari

Setiap syarikat mempunyai dasar kehadiran yang menentukan jadual kerja: **work start** / **work end**, **break minutes**, ambang lewat (`Late after`), pemotongan separuh hari, dan **working days** (lalai Isnin–Jumaat). Di mana syarikat belum menyesuaikannya, nilai lalai yang munasabah digunakan (09:00–18:00, rehat 60 minit, lewat selepas 09:15, separuh hari sebelum 13:00).

Apabila seseorang mendaftar masuk, hari itu **dikelaskan dan dibekukan** pada rekod sebagai salah satu daripada tiga jenis-hari:

- `workday` — hari bekerja berjadual. Hanya di sini daftar masuk boleh **lewat** (selepas ambang) atau hari pendek dikira sebagai **separuh hari**.
- `rest_day` — hari kerja/hujung minggu bukan bekerja mengikut jadual. Sebarang kerja ialah lebih masa *sepenuhnya*.
- `holiday` — tarikh cuti umum. Sebarang kerja ialah lebih masa *sepenuhnya*.

Dalam grid hari, pekerja tanpa rekod pada konteks bukan bekerja menunjukkan pil konteks — `On leave`, `Holiday`, atau `Rest day` — supaya hari yang kosong secara sah tidak dibaca sebagai tidak hadir. Lebih masa pada hari rehat dan cuti umum ditandai `RD` / `PH`.

**Month summary** menggulung ini setiap pekerja: kiraan **Present / Late / Half day / Leave / Absent**, jumlah **Hours** dan **Overtime** (dipecahkan mengikut jenis-hari dalam petua alat), serta **Flags** pematuhan: `OT > 104h` (had lebih masa bulanan statutori) dan `45h+ week` (penunjuk). Tidak hadir mengira hari bekerja yang telah berlalu sahaja — ia tidak pernah menandai hari masa hadapan atau hari sebelum pengambilan sebagai tidak hadir.

### Permintaan pembetulan kehadiran

Jika ketukan salah atau hilang, pekerja (atau pengurus mereka) menimbulkan **permintaan pembetulan** yang mencadangkan masa daftar masuk yang betul dan daftar keluar pilihan. Sebagai pentadbir anda mengambil tindakan ke atasnya dalam kad **Correction requests**, yang muncul apabila ada permintaan yang menunggu tindakan.

1. Setiap baris menunjukkan **Employee**, **Date**, masa **Proposed**, dan **Reason**.
2. Klik **Approve** untuk meminda hari itu, atau **Reject** untuk menolak.

**Meluluskan menerbitkan semula seluruh hari melalui enjin masa** — status, minit bekerja dan lebih masa dikira semula daripada ketukan yang dicadangkan dan jadual syarikat, jadi lebih masa yang dibetulkan mengalir ke gaji. Rekod itu dicap `Corrected`.

**Nota:** Anda **tidak boleh meluluskan permintaan pembetulan anda sendiri** — baris anda sendiri menunjukkan `your request` dan bukannya butang tindakan. Minta pentadbir lain atau pengurus pekerja itu mengambil tindakan. Sistem turut menguatkuasakan ini di sebelah pelayan.

## Perangkap biasa

- **Dasar di bawah paras minimum tidak melakukan apa-apa.** Menetapkan cuti tahunan kepada 5 hari sedangkan paras minimum EA ialah 8 merekodkan dasar `below minimum` yang tidak pernah digunakan. Gunakan angka paras minimum di atas sebagai garis asas anda.
- **Terlupa carry cap.** Kelayakan cuti tahunan baharu melalaikan carry cap-nya kepada `0` — hari yang tidak digunakan akan dilucutkan pada pembukaan tahun seterusnya melainkan anda menetapkan cap.
- **"Edit" lwn "Add" kelayakan.** Edit hanya *membetulkan* satu nilai pada tarikh berkuat kuasa yang sama. Untuk mengubah kelayakan *ke hadapan* (cth. kenaikan kepada 18 hari mulai Januari hadapan), **Add** kelayakan bertarikh baharu sebaliknya.
- **Membuka tahun terlalu awal.** Naik taraf jaluran diselesaikan pada perkhidmatan pekerja setakat 1 Jan, jadi buka tahun itu *untuk* tahun tersebut — menjalankan semula kemudian adalah selamat.
- **Hari kehadiran kosong ditanda sebagai tidak hadir.** Periksa pil konteks: `On leave` memerlukan permintaan cuti yang **diluluskan** meliputi tarikh itu; cuti yang menunggu tidak akan menyekat ketidakhadiran.
