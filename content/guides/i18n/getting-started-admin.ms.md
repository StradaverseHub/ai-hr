Panduan ini ditujukan untuk pentadbir HR yang menyediakan AI HR buat kali pertama. Ia membawa anda daripada pangkalan data kosong kepada operasi HR Malaysia yang berfungsi — struktur syarikat, kakitangan, profil berkanun, peraturan cuti, peranan, dan jana gaji pertama anda — mengikut susunan yang benar-benar berkesan. Bekerja dari atas ke bawah: langkah kemudian bergantung pada langkah terdahulu (anda tidak boleh mengambil pekerja ke dalam syarikat yang tidak wujud, dan anda tidak boleh menjana gaji untuk pekerja tanpa nombor IC).

## 1. Log masuk pertama dan konsep identiti / peranan

Apabila anda membuka aplikasi, anda akan tiba di **Dashboard**. Bar sisi kiri ialah peta anda: Dashboard, My workspace, People, Org chart, Leave, Attendance, Approvals, Performance, dan — untuk pentadbir — kumpulan **Admin** (Organization, Leave config, Users & roles, Audit trail) serta **Payroll**.

**Cara identiti berfungsi.** Log masuk pengeluaran diperuntukkan melalui **WorkOS** (SSO atau jemputan). Dalam persekitaran tempatan/pembangunan anda akan melihat menu lungsur kecil **Dev as** di bar atas — ia membenarkan anda "bertindak sebagai" mana-mana principal yang telah diseed (sebagai contoh *HR Admin · hr_admin*) untuk menguji apa yang dilihat oleh setiap peranan. Pilih identiti `hr_admin` (atau `super_admin`) sebelum anda mula; bahagian Admin dan Payroll hanya muncul untuk peranan tersebut.

**Empat peranan**, dengan kuasa yang semakin meningkat: `employee` → `manager` → `hr_admin` → `super_admin`. Anda akan menetapkannya dalam langkah 7.

**Nota.** Setiap perubahan direkodkan bersama identiti anda dalam **Audit trail** (`Admin → Audit trail`). Tiada apa yang bersifat tanpa nama — memang begitu reka bentuknya.

## 2. Cipta struktur syarikat anda

Dalam bar sisi, buka **Admin → Organization**. Anda akan melihat **Group structure** (pokok setiap syarikat) dan senarai **Companies** di bawahnya.

Kumpulan Malaysia yang tipikal mempunyai sebuah syarikat induk di atas sebuah entiti undang-undang yang beroperasi. Bina mengikut susunan itu:

1. Tatal ke borang **Add company** di bahagian bawah kad Companies.
2. Masukkan syarikat induk dalam **Legal name** (cth. `Demo Group Holdings Bhd`). Biarkan **Country** sebagai `MY` dan **Currency** sebagai `MYR`.
3. Klik **Add company**.
4. Ulang untuk entiti operasi anda (cth. `Demo Sdn Bhd`).
5. Klik baris syarikat untuk **mengembangkannya**. Di bawah **Group parent**, tetapkan **Parent company** entiti operasi kepada syarikat induk dan klik **Set parent**. Pokok Group structure kini menyusunnya secara bersarang.

**Di dalam setiap panel syarikat yang dikembangkan** anda juga menguruskan blok binaannya — ini berada *di dalam* syarikat, bukan secara global:

- **Departments** — taip nama (cth. `Finance`, `Engineering`) dan klik **Add**.
- **Positions** — gelaran jawatan (cth. `Executive`) dan klik **Add**.
- **Cost centres** — **Code** ringkas (cth. `HQ`) dan **Name** (cth. `Headquarters`), kemudian **Add**.

**Identiti berkanun (MY).** Masih di dalam panel, isi bahagian **Statutory identity (MY)** untuk entiti yang benar-benar menggaji kakitangan: **EPF employer no**, **SOCSO employer code**, **LHDN E-number**, **MyInvois TIN**, **SSM registration no**. Klik **Save statutory identity**. Pengepala panel akan menunjukkan lencana `statutory ✓` sebaik sahaja tiga pengecam pemfailan (EPF, SOCSO, LHDN) hadir — ini menyumbang kepada setiap laporan bulanan dan tahunan.

**Petua.** Bina jabatan dan jawatan pada syarikat *operasi*, bukan cengkerang induk — di situlah kakitangan diambil bekerja.

**Nota tentang memadam berbanding mengarkib.** Rekod yang dirujuk (jabatan dengan kakitangan, syarikat dengan sub-syarikat) tidak boleh dipadam — aplikasi menawarkan **Archive** sebaliknya supaya sejarah kekal utuh. Hanya rekod yang tidak digunakan menunjukkan pilihan **Delete**.

## 3. Tambah kakitangan

Buka **People** dalam bar sisi. Anda mempunyai dua cara untuk membawa masuk kakitangan.

### Ambil seorang demi seorang

1. Pada halaman People, kembangkan **Hire an employee** di bahagian bawah.
2. Isi **Full name**, **Email**, pilih **Company** dan **Department**, tetapkan **Employment type** (`Full time`, `Part time`, `Contract`, atau `Intern`), dan **Hire date**.
3. Klik **Hire**. Cuti tetap (tahunan, sakit, kemasukan hospital) diberikan secara automatik berdasarkan dasar syarikat dan had minimum berkanun Malaysia.

### Import CSV pukal (migrasi hari pertama)

Untuk pengambilan seluruh syarikat sekaligus, klik **Import CSV** (kanan atas People), atau pergi ke `/people/import`.

1. Pilih **Target company**.
2. Tampal CSV anda ke dalam **CSV data**, atau klik **Load sample** untuk melihat format yang tepat. Kembangkan **Column reference** untuk melihat lajur yang diperlukan berbanding pilihan.
   - **Diperlukan:** `full_name`, `email`, `department`, `hired_on`, `ic_number`, `basic_salary`.
   - **Pilihan:** `phone`, `position`, `cost_center`, `employment_type`, `monthly_allowance`, `bank_name`, `bank_account_no`, `epf_number`, `socso_number`, `tax_number`, `tax_category`, `num_children`, `eis_eligible`, `is_resident`.
3. Klik **Validate**. Jadual pratonton menunjukkan setiap baris sebagai `ready` (hijau) atau dengan ralat (merah). Nama jabatan diselesaikan terhadap syarikat sasaran.
4. Apabila pratonton kelihatan betul, klik **Import N valid** untuk melaksanakannya. Ringkasan hijau menunjukkan berapa banyak yang diimport, dilangkau, atau gagal.

**Kesilapan biasa.**

- `department` mesti sepadan dengan jabatan yang sudah wujud dalam syarikat sasaran (tidak sensitif huruf besar/kecil) — cipta jabatan anda dalam langkah 2 dahulu.
- `hired_on` sepatutnya `YYYY-MM-DD`.
- `bank_name` dan `bank_account_no` ialah kedua-duanya-atau-tiada — bekalkan kedua-duanya atau biarkan kedua-duanya kosong.

## 4. Tetapkan profil berkanun Malaysia setiap pekerja

Import CSV sudah pun menangkap asas berkanun. Untuk menyemak atau mengisinya bagi pekerja yang diambil secara manual, buka **People**, klik nama orang itu, dan gunakan kad **Statutory (Malaysia)**:

| Medan | Kegunaannya |
|---|---|
| **IC number** | NRIC — diperlukan untuk sebarang pemfailan berkanun |
| **EPF / KWSP number** | Nombor ahli EPF |
| **SOCSO number** | Nombor penyumbang PERKESO |
| **Tax number** | Nombor fail cukai LHDN |
| **PCB category** | `1 — Single`, `2 — Married, spouse not working`, `3 — Married, spouse working` |
| **Children** | Bilangan anak yang layak (mempengaruhi pelepasan PCB) |
| **Bank name / account no** | Untuk ringkasan pembayaran |
| **EIS eligible / Resident** | Kotak semak; mempengaruhi layanan EIS dan PCB |

Tetapkan gaji pada halaman yang sama di bawah **Update pay**: masukkan **Basic salary (MYR)** dan sebarang **monthly allowance**, kemudian simpan.

**Nota.** Jana gaji tidak akan bersedia sepenuhnya untuk pekerja yang kehilangan IC, nombor cukai, nombor EPF atau SOCSO mereka — semakan **Readiness** laporan (langkah 8/9) akan menandakan dengan tepat siapa dan apa yang hilang.

## 5. Konfigurasikan cuti

Buka **Admin → Leave config**. Halaman ini mempunyai kad **Leave types** dan kad **Leave year**.

**Jenis cuti dan kelayakan.** Pakej Malaysia menyeed jenis standard (tahunan, sakit, kemasukan hospital) dengan had minimum berkanun sudah pun disambungkan.

1. Kembangkan jenis cuti untuk melihat **Statutory minimum (MY)**nya (baca sahaja — had minimum EA 1955 mengikut jalur perkhidmatan: bawah 2 / 2–5 / 5+ tahun) dan garis masa **Company entitlements**nya.
2. Untuk menawarkan *lebih* daripada had minimum, klik **+ Add entitlement**, tetapkan **Days per year** (dan, untuk cuti tahunan, **Carry-cap**), pilih **Effective from**, dan **Add**. Pemberian sentiasa menggunakan nilai yang **lebih besar** antara had minimum dan dasar anda — nilai di bawah minimum direkodkan tetapi tidak pernah digunakan (anda akan melihat lencana `below minimum`).
3. Untuk menambah jenis tersuai, gunakan borang di bahagian bawah: **Code** (huruf besar, cth. `ANNUAL`), **Name**, kotak semak **Paid**, kemudian **Add type**.

**Buka tahun cuti.** Dalam kad **Leave year**, tetapkan **Year** (lalai kepada tahun depan) dan klik **Open leave year**. Ini mencatatkan kelayakan baharu setiap pekerja aktif pada jalur perkhidmatan semasa mereka, membawa ke hadapan cuti tahunan yang tidak digunakan sehingga had (selebihnya dilucutkan), dan menetapkan semula cuti sakit/kemasukan hospital. Ia idempoten — menjalankannya semula melangkau sesiapa yang sudah dibuka.

## 6. Dasar kehadiran

Setiap syarikat operasi mendapat dasar kehadiran lalai apabila ia dicipta, jadi daftar masuk/daftar keluar dan kerja lebih masa berfungsi terus daripada kotak. Buka **Attendance** dalam bar sisi untuk melihat ketukan hari ini, status (`present`, `late`, `half day`, `absent`) dan kerja lebih masa. Pengecualian ditangani melalui **correction requests**: pekerja yang terlupa mendaftar masuk menghantar pembetulan, dan anda atau pengurus mereka meluluskan atau menolaknya daripada halaman **Attendance** atau peti masuk **Approvals** bersepadu.

## 7. Tetapkan peranan pengguna

Buka **Admin → Users & roles**. Anda akan melihat setiap pengguna sedia ada dengan tag peranan semasa mereka.

1. Cari pengguna.
2. Dalam baris mereka, pilih **role** daripada menu lungsur (`employee`, `manager`, `hr_admin`, `super_admin`).
3. Untuk pemberian **HR Admin**, pilih juga **company scope** — syarikat itu *dan sub-syarikatnya* — atau **Group-wide**. Peranan lain sentiasa seluruh kumpulan.
4. Klik **Add role**. Untuk membuang pemberian, klik **×** di sebelah tagnya.

**Nota.** Log masuk baharu itu sendiri diperuntukkan melalui WorkOS kemudian; di sini anda menguruskan peranan untuk pengguna yang sudah wujud. Pentadbir HR berskop (diwakilkan) hanya boleh melantik `hr_admin` lain dalam subpokok mereka sendiri.

## 8. Jalankan kelompok gaji pertama anda

Buka **Payroll** dalam bar sisi (tab **Payroll Process**).

1. Dalam borang **Create payroll process**, pilih **Company** dan **Pay period** dalam `YYYY-MM` (lalai kepada bulan semasa). Klik **Create payroll process**.
2. Buka kelompok baharu daripada senarai. Semasa ia `draft`, anda akan melihat **Inputs** bagi setiap pekerja — masukkan **OT**, **Bonus**, **TP1**, **Zakat** mengikut keperluan dan **Save** (atau klik **Prefill OT** untuk menarik kerja lebih masa daripada kehadiran yang diluluskan). **Leaver advisory** muncul untuk sesiapa yang ditamatkan dalam tempoh itu.
3. Klik **Generate payslips**. Kelompok beralih ke `processed` dan jadual **Payslips** menunjukkan **Gross**, **Bonus**, **EPF**, **SOCSO**, **EIS**, **PCB**, dan **Net** setiap orang, serta jumlah utama (gross, potongan, net, kos majikan).
4. Semak potongan berkanun. Apabila anda berpuas hati, klik **Close batch** (status `closed`) untuk menguncinya. Kelompok yang ditutup tidak boleh diubah.

**Petua.** Selepas pemprosesan anda boleh memuat turun **Payment summary** untuk muat naik bank secara manual daripada pengepala kelompok.

## 9. Laporan berkanun

Buka **Payroll → Reports** (tab **Reports**). Pilih **Company**, **Report**, dan **Period** (atau **Year** untuk borang tahunan), kemudian klik **Preview**:

| Laporan | Kekerapan | Meliputi |
|---|---|---|
| **CP39 — MTD / PCB (LHDN)** | Bulanan | Penyata potongan cukai bulanan |
| **EPF contributions (KWSP)** | Bulanan | EPF pekerja + majikan |
| **SOCSO + EIS (PERKESO)** | Bulanan | Caruman SOCSO dan EIS |
| **Form E / CP8D — annual (LHDN)** | Tahunan | Penyata majikan hujung tahun |
| **Monthly statutory contributions (overview)** | Bulanan | Gambaran gabungan |

Setiap pratonton menunjukkan jumlah, panel **Readiness** yang menyenaraikan mana-mana pekerja dengan data berkanun yang hilang, dan jadual baris. Gunakan **Download CSV** untuk mengeksport, dan **Record generation** untuk mencatatkan jalanan itu dalam audit trail. Daripada baris laporan anda boleh membuka **EA form** seseorang pekerja untuk tahun itu. **Compliance worklist · CP22 / CP22A** di bahagian atas halaman menampilkan pemfailan pengambilan baharu dan pemberhentian yang dipacu oleh log peristiwa.

**Nota.** Ini ialah laporan Lapisan-A — ringkasan boleh dibaca manusia untuk diremit atau diserahkan kepada akauntan anda. Draf CP39 `.txt` tersedia untuk CP39 tetapi ditanda *DRAFT, not for submission*; fail agensi yang tepat byte demi byte akan tiba dalam keluaran kemudian.

## Anda telah aktif — senarai semak

- [ ] Telah log masuk sebagai `hr_admin` / `super_admin`
- [ ] Syarikat induk + operasi dicipta, induk ditetapkan
- [ ] Jabatan, jawatan, pusat kos ditambah pada entiti operasi
- [ ] Identiti berkanun (EPF / SOCSO / LHDN) disimpan → lencana `statutory ✓`
- [ ] Kakitangan ditambah (diambil bekerja atau diimport CSV)
- [ ] IC, EPF, SOCSO, no. cukai, kategori PCB, anak, bank setiap pekerja ditetapkan
- [ ] Gaji ditetapkan melalui **Update pay**
- [ ] Jenis cuti disemak, kelayakan ditetapkan, **tahun cuti dibuka**
- [ ] Peranan ditetapkan dalam **Users & roles**
- [ ] Kelompok gaji pertama dijana, disemak, dan **ditutup**
- [ ] Laporan berkanun dipratonton dengan semakan **Readiness** yang bersih
