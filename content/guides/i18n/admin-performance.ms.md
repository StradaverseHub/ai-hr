Panduan ini untuk pentadbir HR (`hr_admin` dan `super_admin`) yang menjalankan penilaian prestasi dalam AI HR. Menjelang akhir panduan ini anda akan tahu cara mencipta satu kitaran penilaian, membawanya menerusi keseluruhan kitaran hayatnya (`draft` → `open` → `calibration` → `closed`), memahami cara penilaian kendiri dan penilaian pengurus mengalir menjadi satu penarafan keseluruhan, mengawal dengan tepat bila pekerja boleh melihat penarafan mereka, dan menukar cadangan kenaikan merit/bonus daripada pengurus menjadi perubahan gaji yang sebenar — tanpa modul Prestasi pernah menyentuh penggajian secara langsung.

## Di mana hendak mencarinya

Pada bar sisi kiri, klik **Performance**. Tajuk halaman tertera **Performance** dengan sari kata *Review cycles, appraisals, and merit recommendations*.

- **Pentadbir** melihat jadual penuh **Review cycles** serta panel **+ New review cycle**.
- **Pengurus** melihat kad **Reviews awaiting you** yang menyenaraikan penilaian yang masih perlu mereka muktamadkan.

Jika anda juga menguruskan kakitangan, kedua-dua paparan muncul bersama pada halaman tunggal ini.

## Mencipta kitaran penilaian

Satu *kitaran* ialah bekas untuk satu pusingan penilaian merentas sekumpulan pekerja.

1. Pada halaman **Performance**, klik **+ New review cycle** untuk mengembangkan borang.
2. Isikan medan-medan:

| Medan | Apa yang dilakukannya |
|---|---|
| **Name** | Teks bebas, cth. `2026 Annual`. |
| **Scope** | `Group-wide (all companies)` atau satu syarikat tunggal. Menentukan siapa yang disimpan sebagai cebisan masuk. |
| **Period start** / **Period end** | Tetingkap penilaian. Lalai kepada tahun kalendar semasa (1 Jan → 31 Dec). Tarikh tamat tidak boleh sebelum tarikh mula. |
| **Merit pool (optional)** | Biarkan sebagai `No pool`, atau tetapkan belanjawan lembut — `% of payroll` atau `RM (monthly)` — dengan satu nilai (cth. `3.5`). |
| **Only include staff hired before (optional)** | Mengecualikan pekerja yang baru diambil daripada pusingan ini. |
| **Exclude employees on probation** | Ditanda secara lalai. |

3. Klik **Create cycle (draft)**.

Kitaran dicipta dalam status `draft`. Belum ada sesiapa dinilai lagi — membukanya (langkah seterusnya) ialah yang menjana penilaian sebenar.

**Nota — skala penarafan.** Setiap kitaran menggunakan satu penarafan keseluruhan pada skala 1–5 berlabel: `1 · Below`, `2 · Meets`, `3 · Strong`, `4 · Exceeds`, `5 · Outstanding`. Terdapat satu skor keseluruhan bagi setiap pekerja, bukan satu bakul kompetensi.

**Nota — kumpulan merit ialah had lembut.** Ia satu garis panduan untuk penentukuran, bukan had yang keras. Cadangan dibenarkan melebihinya; bar belanjawan cuma bertukar merah supaya anda boleh nampak bila anda terlebih.

## Kitaran hayat: draft → open → calibration → closed

Buka satu kitaran dengan mengklik namanya dalam jadual **Review cycles**. Status berada di tajuk halaman sebagai lencana, dan butang kitaran hayat muncul di sebelahnya bergantung pada keadaan semasa.

### 1. Draft

Draf memaparkan kad petunjuk yang menerangkan apa yang akan dilakukan oleh pembukaan. Klik **Open cycle** untuk bermula.

**Apa yang dilakukan oleh "Open cycle":** ia mengambil cebisan setiap pekerja yang dalam skop dan aktif (tolak tempoh percubaan dan pengambilan lewat, mengikut tetapan anda) menjadi satu penilaian setiap seorang, menetapkan **pengurus barisan pentadbiran** setiap orang sebagai penilai, dan memulakan peringkat penilaian kendiri. Kitaran bergerak ke `open`. Pekerja yang ditamatkan sebelum titik ini tidak disertakan.

**Petua:** Betulkan barisan pelaporan anda dalam **Org chart** *sebelum* membuka — itulah yang menentukan siapa menilai siapa. Jika seorang pengurus bertukar di pertengahan kitaran, anda boleh menghala semula satu penilaian individu (lihat *Menugaskan semula penilai*).

### 2. Open

Inilah peringkat penilaian yang aktif. Penilaian kendiri dan penilaian pengurus hanya boleh disunting semasa kitaran `open`. Dari sini tajuk menawarkan:

- **Move to calibration** — membekukan penyuntingan untuk semakan penentukuran.
- **Release ratings** — membuka pintu keterlihatan (lihat di bawah).
- **Close** — menamatkan kitaran.

### 3. Calibration

Gunakan peringkat ini untuk menyemak taburan sebelum apa-apa dikeluarkan. Pada halaman kitaran anda akan melihat dua kad:

- **Rating distribution** — satu bar bagi setiap titik skala menunjukkan berapa banyak penarafan keseluruhan yang *dimuktamadkan* mendarat di situ. Taburan yang sihat biasanya bukan semuanya `4` dan `5`.
- **Merit budget** — yang digunakan berbanding kumpulan (bulanan), berserta **Recommended bonuses (one-off)** di sebelahnya. Bar berwarna hijau apabila dalam kumpulan, merah apabila **over by** sesuatu jumlah.

Anda masih boleh **Release ratings** atau **Close** daripada penentukuran.

### 4. Closed

Keadaan terminal. Klik **Close** daripada sama ada `open` atau `calibration`.

## Cara penilaian kendiri dan penilaian pengurus mengalir

Penilaian setiap pekerja menyusuri status-status ini (kelihatan dalam lajur **Status** pada jadual **Reviews** kitaran):

`self_review` → `manager_review` → `submitted` → `acknowledged`

1. **Self-review** — pekerja membuka penilaian mereka (daripada **My workspace** / `/me`) dan menyerahkan penarafan kendiri serta komen. Ini menggerakkannya ke `manager_review`.
2. **Manager review** — penilai mengisi penarafan pengurus, **penarafan keseluruhan tunggal**, komen, dan (secara pilihan) satu % merit dan/atau cadangan bonus. Menyerahkannya menggerakkannya ke `submitted`.
3. **Acknowledged** — selepas anda mengeluarkan penarafan, pekerja mengesahkan mereka telah melihatnya, menggerakkannya ke `acknowledged`.

**Nota — tiada tersekat.** Seorang pengurus boleh memuktamadkan walaupun pekerja tidak pernah menilai diri sendiri. Penilaian yang masih berada pada `self_review` muncul dalam senarai **Reviews awaiting you** pengurus supaya tiada apa-apa tersangkut.

Pada halaman kitaran, lajur kemajuan **Review cycles** terbaca `ack / done / total` (diakui / dimuktamadkan pengurus / jumlah).

### Menugaskan semula penilai

Jika orang yang salah ditetapkan sebagai penilai (cth. satu perubahan organisasi), buka penilaian individu itu dan tugaskan semula. Anda tidak boleh menugaskan semula pada kitaran yang ditutup atau pada penilaian yang sudah `submitted`/`acknowledged`, dan seorang pekerja tidak boleh sesekali ditetapkan sebagai penilai dirinya sendiri.

## Pintu pelepasan

Inilah kawalan terpenting untuk difahami: **pekerja tidak boleh melihat penarafan pengurus atau skor keseluruhan mereka sehingga anda mengeluarkan kitaran.** Sehingga itu, subjek hanya melihat penilaian kendiri mereka sendiri. Cadangan pampasan *tidak pernah* kelihatan kepada pekerja.

Untuk mengeluarkan:

1. Pada halaman kitaran (status `open` atau `calibration`), klik **Release ratings**.
2. Satu pengesahan muncul: *"Release ratings to employees? Every employee will be able to see their manager rating and overall score. This cannot be undone."*
3. Sahkan dengan **Release ratings**.

Selepas pengeluaran, tajuk memaparkan `ratings released` dan barulah pekerja boleh **acknowledge** penilaian mereka.

**Petua:** Tentukur dahulu, keluarkan kemudian. Sebaik dikeluarkan ia tidak boleh dibatalkan, jadi semak kad taburan dan belanjawan sebelum menarik picu.

## Tindakan pampasan — pengurus mencadang, anda melaksana

Modul Prestasi **tidak pernah menulis gaji secara langsung**. Pengurus *mencadangkan* merit dan bonus pada satu penilaian; seorang pentadbir *melaksanakan* cadangan itu menerusi enjin penggajian sedia ada yang telah diuji. Pemisahan ini disengajakan.

Pada halaman kitaran, apabila terdapat cadangan yang tertangguh, satu kad **Pay recommendations to enact** muncul. Penerangnya terbaca: *"Enacting applies the change through payroll: a merit % becomes an effective-dated salary increase; a bonus is staged into a draft batch and taxed as additional remuneration. Performance never writes pay directly."*

Bagi setiap baris anda akan melihat pekerja itu, `merit X% (on RM …)` dan/atau `bonus RM …` yang dicadangkan, serta input untuk melaksanakannya:

- **Merit** — pilih satu tarikh **effective** (lalai kepada hari selepas tempoh kitaran tamat). Pada laksana, sistem mencipta satu kenaikan gaji bertarikh kuat kuasa menerusi pampasan; gaji asas baharu = gaji asas semasa × (1 + merit%).
- **Bonus** — pilih satu **bonus batch** (satu kelompok penggajian draf bagi syarikat pekerja itu). Bonus itu dipentaskan ke dalam kelompok tersebut dan dicukai sebagai **additional remuneration (MTD)**.

Kemudian:

1. Klik **Enact**.
2. Sahkan: *"Enact pay for {employee}? This applies a real pay change through payroll — an effective-dated raise and/or a taxed bonus. It cannot be undone here."*

Untuk menolak satu cadangan sebaliknya, klik **Decline**.

**Lubang perangkap biasa**

- **"Bonus needs a draft batch."** Jika tiada kelompok penggajian draf yang terbuka bagi syarikat pekerja itu, baris itu memaparkan ini dengan pautan **create one in Payroll**. Pergi ke **Payroll**, cipta satu kelompok draf, kemudian kembali dan laksanakan.
- **Kelompok syarikat yang salah.** Kelompok bonus mesti tergolong dalam syarikat yang sama dengan pekerja itu, jika tidak pelaksanaan disekat.
- **Tarikh kuat kuasa terlalu awal.** Tarikh kuat kuasa satu merit mesti jatuh *selepas* rekod gaji semasa pekerja itu bermula, jika tidak ia ditolak.
- **Tiada gaji semasa.** Anda tidak boleh menggunakan kenaikan merit kepada seseorang yang tiada pampasan semasa dalam fail.
- **Kakitangan yang ditamatkan.** Gaji tidak boleh dilaksanakan untuk seorang pekerja yang telah pergi.

**Nota — kumpulan merit kekal bermaklumat.** Pelaksanaan tidak menguatkuasakan kumpulan. Kad belanjawan memulihkan asas gaji sebelum kenaikan bagi baris yang sudah dilaksanakan supaya angka *yang digunakan berbanding kumpulan* kekal stabil sewaktu kenaikan mendarat.

## Penyelesaian masalah

- **Tidak boleh membuka satu kitaran dua kali.** Membuka hanya berfungsi daripada `draft`; satu kitaran yang sudah `open`/`calibration`/`closed` tidak akan mengambil cebisan semula.
- **Satu penilaian tidak membenarkan saya menyunting.** Penilaian kendiri dan pengurus boleh disunting hanya semasa kitaran `open`. Menggerakkannya kembali keluar daripada penentukuran adalah mustahil — muktamadkan sebelum menentukur.
- **Seorang pekerja kata mereka tidak dapat melihat penarafan mereka.** Sahkan kitaran itu telah **dikeluarkan** (tajuk memaparkan `ratings released`). Sebelum pengeluaran, itu memang mengikut reka bentuk.
- **Setiap tindakan dilog.** Peralihan kitaran dan penilaian, pengeluaran, dan pelaksanaan kesemuanya menulis ke jejak audit — lihat **Admin → Audit trail** (`/admin/audit`) jika anda perlu mengesahkan siapa melakukan apa dan bila.
