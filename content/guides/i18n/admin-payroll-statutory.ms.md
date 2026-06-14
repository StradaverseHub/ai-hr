Panduan ini untuk pentadbir HR dan pegawai gaji yang menjalankan gaji bulanan Malaysia dalam AI HR. Menjelang akhirnya anda akan tahu cara menyediakan profil statutori pekerja, mencipta dan memproses kelompok (batch) gaji, memahami cara EPF/KWSP, SOCSO/PERKESO, EIS/SIP dan PCB/MTD dikira, mengendalikan bonus, kerja lebih masa, cuti tanpa gaji dan proration, menutup kelompok supaya ia menjadi tidak boleh diubah, serta bertindak atas nasihat gaji akhir untuk pekerja yang berhenti. Anda memerlukan peranan **hr_admin** atau **super_admin** untuk mencapai modul Payroll.

## Sebelum anda menjalankan gaji: profil statutori

Setiap angka pada slip gaji dipacu oleh profil statutori pekerja. Sediakannya dahulu, kerana sesiapa yang tiada data wajib akan tetap muncul dalam kelompok tetapi dengan potongan yang tidak lengkap.

1. Pada bar sisi kiri, klik **People**, kemudian klik nama pekerja untuk membuka halaman butirannya.
2. Cari kad **Statutory (Malaysia)** (lajur kanan, di sebelah **Compensation**).
3. Isikan medan-medannya, kemudian klik **Save statutory**.

### Medan pada kad Statutory (Malaysia)

| Medan | Nota |
| --- | --- |
| **IC number** | Wajib. 12 digit (cth. `900101011234`). Disahkan dan unik bagi setiap penyewa (tenant) — ruang kosong dan sengkang dibuang secara automatik. |
| **EPF number** | Nombor keahlian KWSP. |
| **SOCSO number** | Nombor PERKESO. |
| **Tax number** | Nombor cukai pendapatan (PCB) LHDN. |
| **PCB category** | `1 — Single`, `2 — Married, spouse not working`, atau `3 — Married, spouse working`. Memacu pelepasan MTD. Lalai kepada `1`. |
| **Children (PCB relief)** | Bilangan anak yang layak untuk pelepasan PCB. |
| **Bank** / **Bank account** | Digunakan oleh eksport ringkasan pembayaran. |
| **EIS eligible** | Kotak semak. Nyahtanda bagi pekerja di luar perlindungan SIP (cth. caruman pertama selepas umur 57 tanpa sejarah terdahulu). |
| **Tax resident** | Kotak semak. Nyahtanda bagi bukan pemastautin — mereka membayar **30% MTD** rata tanpa sebarang pelepasan. |

### TP3 / baki pembukaan (penerima pertengahan tahun sahaja)

Bahagian **Previous employment this year (TP3 / opening balances)** menyemai akumulator PCB supaya MTD betul apabila anda mengguna pakai AI HR di pertengahan tahun atau mengambil seseorang yang sudah bekerja di tempat lain dalam tahun kalendar ini. Ambil angka daripada **Form TP3** pekerja (atau sistem gaji pra-migrasi anda):

- **Applies to year** — tahun kalendar yang baki ini tergolong (cth. `2026`). Baki hanya digunakan apabila ia sepadan dengan tahun gaji kelompok.
- **Accumulated net remuneration (Y−K)**
- **EPF claimed toward relief (K)**
- **PCB already deducted (X)**

**Nota:** Angka TP3 tidak pernah dicetak pada slip gaji atau borang EA. Ia hanya menyuap pengiraan PCB terkumpul.

**Petua:** Gaji itu sendiri terletak pada kad **Compensation** di sebelah. Guna **Update pay** di sana untuk menetapkan **Basic salary (MYR)** dan **Allowance** sebelum menjalankan gaji — proration dan semua asas statutori membaca rekod pampasan semasa.

## Mencipta kelompok gaji

1. Pada bar sisi kiri, klik **Payroll**. Anda mendarat pada tab **Batches**, yang menyenaraikan setiap kelompok dengan **Period**, **Company**, **Employees**, **Net pay** dan **Status**.
2. Di bahagian bawah jadual kelompok, guna borang cipta:
   - **Company** — pilih syarikat untuk dijalankan.
   - **Pay period** — taip `YYYY-MM` (cth. `2026-05`). Ia lalai kepada bulan semasa.
3. Klik **Create batch**.

Kelompok baharu dibuka dalam status `Draft`. **Nota:** hanya satu kelompok boleh wujud bagi setiap syarikat bagi setiap tempoh gaji — percubaan kedua bagi tempoh yang sama akan ditolak.

## Kelompok draf: input, kerja lebih masa, bonus

Buka kelompok daripada senarai. Semasa ia `Draft`, anda akan melihat penafian pematuhan berwarna ambar, **nasihat pekerja berhenti** (jika ada), dan **penyunting input** yang menyenaraikan setiap pekerja yang aktif dalam tempoh tersebut.

### Kerja lebih masa, bonus, TP1 dan zakat (setiap pekerja)

Setiap baris dalam jadual input mempunyai empat medan berangka serta **Save**:

- **OT** — jumlah kerja lebih masa manual (RM).
- **Bonus** — saraan tambahan (RM) seperti bonus kontrak atau, bagi pekerja yang berhenti, cuti tahunan yang ditunaikan.
- **TP1** — potongan TP1 pekerja (pelepasan cukai yang diluluskan yang mengurangkan PCB).
- **Zakat** — zakat yang dibayar, yang mengimbangi PCB.

Masukkan nilai dan klik **Save** pada baris itu. Lajur **unpaid days** paling kanan adalah baca-sahaja.

**Petua — praisi kerja lebih masa daripada kehadiran:** daripada menaip OT, klik **Prefill OT** di atas jadual. AI HR membaca kehadiran yang diklasifikasikan bagi tempoh itu dan memonetisasikannya pada kadar gaji biasa Akta Kerja (ORP = gaji bulanan ÷ 26): 1.5× pada hari bekerja, peraturan separuh-/sepenuh-hari hari rehat campur 2×, dan peraturan cuti umum campur 3×. Pekerja yang berpendapatan melebihi **RM4,000** tidak layak menerima OT dari segi statutori dan dilangkau — bayar sebarang OT ex-gratia untuk mereka dengan menaipkannya ke dalam medan **OT** secara manual. Nilai **Bonus** sedia ada dikekalkan oleh praisi; anda masih boleh menindih sebarang angka selepas itu.

### Cuti tanpa gaji dan proration (automatik)

Anda tidak memasukkan ini:

- **Cuti tanpa gaji** diterbitkan secara automatik daripada permohonan `approved` pada jenis cuti tanpa gaji yang **bermula** dalam tempoh tersebut. Ia dipotong pada kadar biasa (gaji asas bulanan ÷ bilangan hari dalam bulan). Inilah satu-satunya sumber kebenaran yang dikongsi dengan modul Leave — tiada kemasukan berganda.
- **Proration** bagi pekerja yang menyertai dan berhenti pada pertengahan bulan adalah automatik: gaji asas dan elaun diskalakan mengikut hari kalendar bekerja dalam bulan itu (asas bulan tidak lengkap EA 1955 s.18A). Slip gaji menonjolkan **hari bekerja** berbanding jumlah bulan tersebut.

## Menjana slip gaji

1. Dengan kelompok dalam `Draft`, klik **Generate payslips** (kanan-atas halaman kelompok).
2. Kelompok beralih kepada `Processed`, jadual slip gaji setiap pekerja diisi, dan empat jumlah muncul: **Total gross**, **Total deductions**, **Total net**, **Total employer cost**.

Jadual slip gaji menunjukkan **Gross**, **Bonus**, **EPF**, **SOCSO**, **EIS**, **PCB** dan **Net** bagi setiap pekerja. Pekerja yang diprorationkan ditanda secara sebaris dengan angka hari bekerja mereka.

### Cara setiap baris statutori dikira

| Caruman | Asas | Nota |
| --- | --- | --- |
| **EPF / KWSP** | Asas + elaun + **bonus**, **tidak termasuk** kerja lebih masa | Bahagian pekerja dan majikan kedua-duanya ditunjukkan. |
| **SOCSO / PERKESO** | Termasuk kerja lebih masa, **tidak termasuk** bonus | Pekerja berumur **60+** beralih ke Kategori Kedua (majikan sahaja). |
| **EIS / SIP** | Termasuk kerja lebih masa, **tidak termasuk** bonus | Perlindungan terpakai untuk umur 18–60; tamat pada 60 atau apabila **EIS eligible** dinyahtanda. |
| **PCB / MTD** | Termasuk kerja lebih masa dan **bonus** (kaedah perbezaan saraan tambahan) | Menggunakan kaedah terkumpul LHDN: kategori PCB, anak, TP1, zakat dan akumulator tahun-hingga-kini (disemai oleh TP3). Bukan pemastautin: 30% rata. |

**Nota:** Akumulator PCB tahun-hingga-kini dibina semula dengan memainkan semula slip gaji terdahulu bagi tahun cukai ini mengikut tertib, jadi sentiasa proses bulan **dalam urutan** dalam tahun kalendar untuk MTD yang betul.

## Menutup kelompok (ketidakbolehubahan)

1. Dengan kelompok `Processed`, semak jumlah dan slip gaji.
2. Klik **Close batch**.
3. Status menjadi `Closed`.

**Kelompok yang ditutup tidak boleh diubah** — slip gaji dan jumlah dibekukan untuk audit. Anda tidak lagi boleh menyunting input, praisi OT, atau menjana semula. Jika anda menemui ralat selepas menutup, betulkannya dalam tempoh seterusnya.

**Petua:** eksport fail bank daripada kelompok `Processed` atau `Closed` — muat turun **Payment summary** (kanan-atas, sebaik melepasi `Draft`) menghasilkan CSV neutral berisi pekerja, IC, bank, akaun dan gaji bersih untuk muat naik manual ke portal bank anda. Baris yang tiada butiran bank ditanda dalam eksport.

## Nasihat gaji akhir untuk pekerja yang berhenti

Apabila anda menamatkan seseorang (pada halaman butiran **People** mereka, kad **Terminate**) dan hari terakhir mereka jatuh dalam tempoh sesuatu kelompok, kelompok draf menunjukkan nasihat **pekerja berhenti** yang menyenaraikan **cuti tahunan tidak digunakan**, **ORP setiap hari** (asas ÷ 26), dan jumlah bayaran ganti **dicadangkan** (EA 1955 s.60E).

**Ini adalah nasihat sahaja — tiada bayaran automatik.** Jika anda memilih untuk membayarnya, taip jumlah itu ke dalam medan **Bonus** pekerja tersebut dalam penyunting input sebelum menjana slip gaji. AI HR sengaja membiarkan keputusan kepada anda kerana layanan EPF/PCB bagi penunaian cuti bergantung pada polisi anda.

## Perangkap biasa

- **IC number hilang** — `Save statutori` ditolak jika IC bukan 12 digit. Betulkan sebelum menjalankan gaji.
- **Tiada pampasan ditetapkan** — pekerja tanpa gaji asas semasa tidak boleh dimonetisasikan; tetapkannya melalui **Update pay** dahulu.
- **Menjalankan bulan tidak mengikut tertib** — merosakkan PCB terkumpul. Proses Januari → Disember mengikut urutan.
- **Berpendapatan tinggi dan OT** — sesiapa melebihi RM4,000 dilangkau oleh **Prefill OT**; masukkan sebarang OT budi bicara secara manual.
- **Menyunting selepas menutup** — tidak mungkin. Sahkan jumlah sebelum mengklik **Close batch**.
- **Kelompok pendua** — satu kelompok bagi setiap syarikat bagi setiap `YYYY-MM`; semak senarai sebelum mencipta.
