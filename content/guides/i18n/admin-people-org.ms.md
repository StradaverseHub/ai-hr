Panduan ini adalah untuk pentadbir HR (`hr_admin` dan `super_admin`) yang menguruskan rekod kakitangan dan struktur organisasi dalam AI HR. Selepas ini, anda akan dapat menyediakan syarikat, jabatan, jawatan dan pusat kos; mengambil dan mengimport pekerja; menyelenggara pampasan, profil berkanun Malaysia dan talian pelaporan setiap individu; menjalankan pemindahan bertarikh berkuat kuasa; dan menamatkan pekerjaan — semuanya daripada skrin **People** dan **Admin → Organization**.

## Sebelum anda mula: syarikat, jabatan, jawatan, pusat kos

Setiap pekerja diambil bekerja *ke dalam* sebuah syarikat dan ditugaskan ke salah satu jabatan syarikat tersebut, jadi bina struktur itu terlebih dahulu.

1. Dalam bar sisi kiri, buka **Admin → Organization**. Anda akan tiba di halaman bertajuk **Organization** dengan tiga bahagian: **Group structure** (pepohon baca-sahaja bagi semua entiti undang-undang), **Companies**, dan borang tambah syarikat di bahagian bawah.
2. Senarai **Companies** memaparkan satu panel boleh-kembang bagi setiap entiti undang-undang. Setiap tajuk panel menunjukkan nombor pendaftaran, lencana negara (cth. `MY`), ringkasan kiraan seperti `2 dept · 3 pos · 1 cc`, dan — bagi syarikat Malaysia — lencana `Statutory complete` (hijau) atau `Statutory partial` (ambar).

### Tambah syarikat

Di bahagian bawah kad **Companies**, isikan **Legal name**, **Country** (kod dua huruf, lalai kepada `MY`) dan **Currency** (tiga huruf, lalai kepada `MYR`), kemudian klik **Add company**.

### Sunting syarikat dan identiti berkanunnya

Klik panel syarikat untuk mengembangkannya. Di dalamnya anda akan menemui:

- **Details** — sunting **Legal name**, **Reg. no**, **Country**, **Currency**, kemudian **Save details**.
- **Group parent** — pilih **Parent company** (atau `None (group root)`) untuk menyusun entiti ini di bawah entiti lain, kemudian **Set parent**. Inilah yang melukis pepohon **Group structure**.
- **Statutory identity (MY)** — bagi syarikat Malaysia, rekodkan **EPF employer no.**, **SOCSO employer code**, **LHDN E-number**, **MyInvois TIN** dan **SSM registration no.**, kemudian **Save statutory identity**.

> **Note** Lencana kesediaan hijau/ambar bergantung pada tiga pengecam: **EPF employer no.**, **SOCSO employer code** dan **LHDN E-number**. Pemfailan dan laporan gaji bergantung pada ini, jadi isikannya sebelum larian gaji pertama anda.

### Jabatan, jawatan dan pusat kos

Setiap panel syarikat yang dikembangkan mempunyai tiga lajur di bahagian bawah:

- **Departments** — taip nama dan klik **Add**.
- **Positions** — taip tajuk dan klik **Add**.
- **Cost centres** — masukkan **Code** dan **Name**, kemudian **Add**.

Untuk menukar entri sedia ada, gunakan penyunting sebaris pada barisnya. Pembuangan adalah dua peringkat:

| Keadaan | Kawalan dipaparkan | Maksud |
| --- | --- | --- |
| Tidak dirujuk di mana-mana | **Delete** | Padam kekal — selamat kerana tiada apa yang menunjuk kepadanya. |
| Sedang digunakan (ditugaskan kepada kakitangan) | **Archive** | Sembunyi lembut; penugasan dan sejarah sedia ada kekal utuh. |

Logik yang sama terpakai pada peringkat syarikat: syarikat yang **sedang digunakan** menawarkan **Archive company**; syarikat yang tidak dirujuk menawarkan **Delete company** (dengan dialog pengesahan). Baris yang diarkibkan dipaparkan malap dan boleh dipulihkan dengan **Unarchive**.

## Mengambil pekerja

1. Dalam bar sisi, klik **People**. Anda akan melihat jadual pekerja (Name, Department, Company, Status, Hired) dengan kotak carian dan kiraan pekerja.
2. Tatal ke panel **Hire an employee** di bahagian bawah dan kembangkannya.
3. Isikan **Full name**, **Email**, **Company**, **Department**, **Employment type** (`Full-time`, `Part-time`, `Contract` atau `Intern`) dan **Hire date** (lalai kepada hari ini).
4. Klik **Hire**. Individu baharu itu muncul dalam jadual dan diberikan kod pekerja secara automatik. Semasa pengambilan, kelayakan cuti tetap (tahunan, sakit, kemasukan hospital) diberikan mengikut pek negara syarikat — cuti tahunan dikira secara pro rata bagi baki bulan dalam tahun pengambilan.

> **Tip** Kedua-dua menu lungsur **Company** dan **Department** diisi daripada **Admin → Organization**. Jika sesuatu jabatan tiada, tambahkannya di sana dahulu.

## Halaman butiran pekerja

Klik mana-mana nama dalam jadual **People** untuk membuka rekod individu tersebut. Tajuk menunjukkan kod pekerja, e-mel, syarikat, tarikh pengambilan dan lencana status mereka. Sebagai pentadbir, anda boleh menyunting bahagian-bahagian berikut.

### Butiran peribadi

Sunting **Full name**, **Email** dan **Phone** (gunakan format `+60…`), kemudian **Save details**. Satu rekod individu dikongsi merentas semua pekerjaan individu tersebut, jadi ini mengemas kini identiti kanonikal mereka di mana-mana.

### Pampasan — "Update pay"

Kad **Compensation** menunjukkan gaji pokok semasa, elaun dan tarikh ia berkuat kuasa. Untuk menukarnya, masukkan **Basic salary (MYR)** dan **Allowance** baharu dan klik **Update pay**. Sejarah gaji dikekalkan — satu rekod bertarikh berkuat kuasa baharu dicipta dan bukannya menulis ganti angka lama.

> **Note** Borang **Update pay** disembunyikan sebaik sahaja pekerja ditamatkan.

### Berkanun (Malaysia)

Selenggara medan yang menjadi sandaran gaji dan pemfailan:

- **IC number**, **EPF number**, **SOCSO number**, **Tax number** (LHDN).
- **PCB category** — `1` Bujang, `2` Berkahwin/pasangan tidak bekerja, `3` Berkahwin/pasangan bekerja.
- Kiraan **Children (PCB relief)**.
- **Bank** dan **Bank account** untuk pembayaran.
- Kotak semak **EIS eligible** dan **Tax resident**.

Di bawah itu, bahagian **TP3** menangkap angka majikan terdahulu bagi penyertaan pertengahan tahun — **Applies to year**, **Net remuneration**, **EPF claimed** dan **PCB paid** — supaya MTD dikira dengan betul. Klik **Save statutory** apabila selesai.

### Sejarah penugasan dan sejarah perubahan

**Assignment history** menyenaraikan setiap tempoh jabatan/jawatan dengan tarikh valid-from → valid-to (baris semasa diserlahkan dan berakhir pada `Present`). **Change history** ialah jejak audit suntingan pada rekod ini. Bersama-sama, ia membolehkan anda membina semula dengan tepat apa yang benar pada mana-mana tarikh lampau — tiada apa yang ditulis ganti di tempatnya.

## Talian pelaporan (pentadbiran, fungsi, projek, putus-putus)

Kad **Reporting lines** mempunyai dua lajur: **Reports to** (pengurus individu ini) dan **Direct reports**.

1. Untuk menambah talian, gunakan borang di bahagian bawah: pilih **Manager** dan **Line type**, kemudian **Add reporting line**.
2. Pilihan **Line type**:

| Jenis | Digunakan untuk |
| --- | --- |
| `Administrative` | Pengurus utama, garisan padat. |
| `Functional` | Ketua fungsi/disiplin. |
| `Project` | Projek atau penugasan sementara. |
| `Dotted` | Hubungan sekunder, nasihat. |

3. Untuk menamatkan hubungan, klik **×** di sebelah pengurus dalam **Reports to**.

> **Note** Talian pentadbiran disemak kitaran: jika pengurus sudah melapor (secara langsung atau tidak langsung) kepada individu ini, talian itu ditolak untuk mengelakkan gelung. Jenis talian lain membenarkan pertindihan matriks.

## Pemindahan bertarikh berkuat kuasa

Gunakan kad **Transfer** untuk memindahkan seseorang ke jabatan baharu daripada tarikh yang dipilih.

1. Pilih **New department** dan **Effective date** (lalai kepada hari ini).
2. Klik **Transfer**.

Penugasan semasa ditutup pada tarikh itu dan satu yang baharu dibuka — jadi jadual **Assignment history** menunjukkan garis masa yang kemas dan tidak bertindih. Pelaporan dan gaji kemudiannya membaca penugasan yang berkuat kuasa pada mana-mana hari tertentu.

## Menamatkan pekerjaan

Dalam kad **Terminate**, pilih **Termination date** (lalai kepada hari ini) dan klik **Terminate employment**. Dialog pengesahan meminta anda mengesahkan mengikut nama. Semasa penamatan, penugasan yang terbuka ditutup pada tarikh itu, dan borang **Update pay**, **Transfer**, **Terminate** serta tambah-talian-pelaporan hilang bagi rekod tersebut. Lencana status individu itu bertukar kepada `terminated`.

> **Tip** Penamatan tidak memadam apa-apa — slip gaji, sejarah cuti dan borang EA kekal tersedia untuk tujuan berkanun dan gaji akhir.

## Import CSV (larian percubaan, kemudian komit)

Untuk mengambil ramai orang sekali gus — contohnya migrasi hari pertama — gunakan pengimport.

1. Pada halaman **People**, klik **Import CSV** (kanan atas; pentadbir sahaja). Halaman **Import employees** dibuka.
2. Pilih **Target company** (ia lalai kepada syarikat aktif anda, atau entiti dengan jabatan terbanyak).
3. Tampal baris anda ke dalam **CSV data**, atau klik **Load sample** untuk memasukkan templat yang boleh anda sunting.
4. Kembangkan **Column reference** untuk melihat apa yang dikenali:
   - **Required:** `full_name`, `email`, `department`, `hired_on`, `ic_number`, `basic_salary`
   - **Optional:** `phone`, `position`, `cost_center`, `employment_type`, `monthly_allowance`, `bank_name`, `bank_account_no`, `epf_number`, `socso_number`, `tax_number`, `tax_category`, `num_children`, `eis_eligible`, `is_resident`
5. Klik **Validate**. Ini ialah larian percubaan — tiada apa yang ditulis lagi. Jadual **Preview** menunjukkan setiap baris sebagai `Ready` (hijau, kadangkala dengan amaran ambar) atau dengan ralatnya berwarna merah, ditambah kiraan tajuk bagi baris sedia berbanding baris bermasalah. Lajur yang hilang ditandakan di bahagian atas.
6. Betulkan sebarang isu dalam CSV anda dan **Validate** sekali lagi (sebarang suntingan mengosongkan pratonton sebelumnya, jadi anda sentiasa mengimport tepat seperti yang terakhir anda semak).
7. Apabila anda berpuas hati, klik **Import N valid** untuk komit. Hanya baris sah yang ditulis; yang tidak sah dilangkau. Sepanduk hasil melaporkan kiraan diimport / dilangkau / gagal dan menyenaraikan sebarang kegagalan mengikut baris.
8. Klik **View people** untuk melihat penyertaan baharu, atau **Import another** untuk mengosongkan dan bermula semula.

> **Note** Nilai jabatan, jawatan dan pusat kos dalam CSV dipadankan dengan katalog **Target company** mengikut nama/kod, jadi pastikan ia wujud dalam **Admin → Organization** dahulu. `bank_name` dan `bank_account_no` perlu dibekalkan bersama.

## Masalah lazim

- **"Add company" / menu lungsur kosong.** Bina syarikat dan jabatan dalam **Admin → Organization** sebelum mengambil atau mengimport.
- **Lencana ambar "Statutory partial".** Sebuah syarikat Malaysia kehilangan salah satu pengecam majikan EPF / SOCSO / LHDN — kembangkan panel dan lengkapkan **Statutory identity (MY)** sebelum gaji.
- **Tidak dapat memadam jabatan/jawatan/syarikat.** Ia dirujuk oleh kakitangan atau sejarah, jadi hanya **Archive** ditawarkan. Arkibkan dan bukannya memaksa pemadaman.
- **Talian pelaporan ditolak.** Anda mencipta kitaran pentadbiran — pilih jenis talian yang berbeza atau pengurus yang belum berada di bawah individu ini.
- **Baris import dilangkau.** Semak senarai kegagalan dalam sepanduk hasil; punca lazim ialah lajur diperlukan yang hilang, nama jabatan yang tidak diketahui, atau nilai `ic_number` / `hired_on` yang tidak elok.
- **Suntingan tidak berkuat kuasa pada pekerja yang ditamatkan.** Kawalan gaji, pemindahan dan talian pelaporan sengaja disembunyikan selepas penamatan.
