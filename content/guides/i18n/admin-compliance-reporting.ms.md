Panduan ini adalah untuk pentadbir HR dan pegawai pematuhan yang bertanggungjawab ke atas pemfailan berkanun Malaysia. Ia membimbing anda melalui segala yang terdapat pada skrin **Payroll → Reports**: angka bulanan EPF/KWSP, SOCSO/PERKESO, EIS dan PCB; borang EA tahunan bagi setiap pekerja; penyata majikan Form E / CP8D; fail teks MTD bulanan CP39; senarai kerja pengambilan baharu dan pemberhentian CP22 / CP22A; serta eksport CSV dan pembayaran bank. Yang paling penting, ia menerangkan **apa yang merupakan fail sedia-hantar berbanding draf atau ringkasan nasihat** — supaya anda tahu dengan tepat apa yang boleh anda serahkan kepada LHDN, KWSP dan PERKESO, dan apa yang masih memerlukan semakan manusia terlebih dahulu.

Anda memerlukan peranan `hr_admin` atau `super_admin`. Laporan difailkan **mengikut entiti undang-undang (syarikat)**, jadi segala yang anda jana adalah terhad kepada syarikat yang anda pilih.

## Mencapai skrin Reports

1. Pada bar sisi kiri, buka **Payroll**.
2. Di sepanjang bahagian atas kawasan Payroll, klik tab **Reports**. Tajuk halaman berbunyi **Payroll · Statutory & compliance reports**.

Di bahagian atas anda akan nampak kad **Compliance worklist · CP22 / CP22A**, kemudian sepanduk ambar yang menerangkan lapisan laporan, kemudian borang **Generate report**, dan di paling bawah jadual audit **Recent generations**.

> **Nota — sepanduk Layer-A.** Kebanyakan laporan di sini ialah **Layer-A**: ringkasan yang boleh dibaca manusia yang anda kemukakan daripadanya atau serahkan kepada akauntan anda. Sepanduk itu menyatakannya dengan jelas: *"Byte-exact agency files (CP39 / KWSP / PERKESO / bank) come in a later slice, each sourced + verified."* Anggap jadual di skrin dan eksport CSV sebagai ringkasan kerja yang boleh dipercayai, bukan sebagai fail muat naik rasmi agensi — dengan dua pengecualian yang dinyatakan di bawah (CP39 .txt dan ringkasan pembayaran).

## Menjana laporan berkanun bulanan

Borang **Generate report** mempunyai empat kawalan: **Company**, **Report**, **Period (YYYY-MM)** (atau **Year (YYYY)** untuk laporan tahunan), dan butang **Preview**.

1. Pilih **Company** (entiti undang-undang yang anda failkan untuknya).
2. Pilih satu **Report**. Pilihan bulanan ialah:
   - `Monthly statutory contributions (overview)` — setiap caruman sepintas lalu: Gross, EPF (EE+ER), SOCSO (EE+ER), EIS (EE+ER) dan PCB.
   - `CP39 — MTD / PCB (LHDN)`
   - `EPF contributions (KWSP)` — asas Borang A, dibahagikan kepada Employee / Employer / Total.
   - `SOCSO + EIS (PERKESO)` — asas ASSIST, dengan lajur EE dan ER.
3. Masukkan **Period** sebagai `YYYY-MM`, cth. `2026-07`.
4. Klik **Preview**.

Halaman ini menyusun laporan daripada **kelompok gaji (payroll batch)** syarikat itu untuk tempoh berkenaan. Anda akan nampak jubin jumlah utama (satu bagi setiap lajur wang), kemudian jadual dengan satu baris bagi setiap pekerja.

> **Petua.** Jika anda nampak *"No payroll batch found for … Run payroll for this period first."*, ertinya memang tiada kelompok untuk syarikat dan bulan tersebut. Kembali ke skrin **Payroll** utama, jalankan dan proseskan kelompok itu, kemudian kembali ke sini.

### Membaca semakan kesediaan

Di atas jadual, satu kotak merah mungkin muncul: **"N employee(s) missing identifiers needed to file."** Ini menyenaraikan pekerja yang ID wajibnya kosong untuk laporan tersebut — contohnya `Tax no`, `EPF no`, atau `SOCSO no` yang tiada. Nilai yang tiada juga dipaparkan sebagai sel merah kosong dalam jadual. Betulkan ini sebelum anda memfailkan: buka individu berkenaan di bawah **People**, lengkapkan identiti berkanun mereka, jalankan semula pratonton. Laporan yang bersih tiada kotak merah.

## Mengeksport dan merekod laporan bulanan

Dalam baris pengepala laporan anda akan jumpai dua atau tiga tindakan:

- **Download CSV** — mengeksport tepat lajur dan baris yang ada di skrin, dinamakan seperti `my.cp39_2026-07.csv`. Ini ialah fail kerja untuk dihantar kepada akauntan anda atau diselaraskan dengan portal agensi.
- **Record generation** — menyimpan artefak `statutory report` yang hanya boleh ditambah (append-only) dan mencapnya dengan versi jadual berkanun. Gunakan ini apabila anda telah menyemak angka dan mahukan rekod audit bahawa "laporan ini telah dijana untuk syarikat dan tempoh ini." Ia **tidak** menghantar apa-apa kepada mana-mana agensi.
- **CP39 .txt — DRAFT, not for submission** — muncul hanya untuk laporan CP39 setelah kesediaan bersih (lihat di bawah).

Setiap penjanaan yang direkod akan masuk ke jadual **Recent generations** di bahagian bawah, memaparkan jenis laporan, tempoh, status (`draft`), bilangan baris dan **Tables ver.** yang digunakan — jejak kebolehulangan anda.

## Fail PCB bulanan CP39

CP39 ialah penyata MTD/PCB bulanan kepada LHDN. Skrin ini memberikan anda dua perkara:

1. **Jadual CP39 + CSV** (Layer-A) — Employee, Tax no, IC, MTD / PCB, dengan jumlah. Gunakan ini untuk menyemak dan menyelaras.
2. **Muat turun CP39 .txt** (Layer-B) — fail teks lebar-tetap dalam susun atur bait LHDN e-Data PCB (Exhibit 4), sesuai untuk dimuat naik ke portal e-PCB.

Untuk mendapatkan `.txt`: pilih laporan `CP39 — MTD / PCB (LHDN)`, pratonton satu tempoh, dan **pastikan tiada ralat kesediaan**. Apabila kesediaan bersih, satu butang ambar berlabel **CP39 .txt — DRAFT, not for submission** akan muncul dalam pengepala. Klik untuk memuat turun.

> **Penting — ini ialah DRAF.** Label butang, tip alat, dan pengepala fail itu sendiri semuanya menyatakannya: *"DRAFT until verified against e-PCB Plus."* Buka fail itu, semak kewarasan jumlah berbanding angka di skrin, dan sahkannya dalam portal **e-PCB Plus** secara langsung sebelum anda menganggapnya sebagai penghantaran. Setiap muat turun dilog sebagai artefak berkanun dan peristiwa domain tersendiri, jadi anda mempunyai rekod setiap draf yang ditarik.

## Borang EA tahunan (setiap pekerja · C.P.8A)

Borang EA ialah Penyata Saraan tahunan setiap pekerja.

1. Dalam **Generate report**, pilih `Form E / CP8D — annual (LHDN)`. Medan tempoh bertukar kepada **Year (YYYY)** — masukkan cth. `2026`.
2. Klik **Preview** untuk memuatkan jadual CP8D (satu baris bernombor bagi setiap pekerja).
3. Klik **nama seorang pekerja** dalam jadual untuk membuka penyata **EA (C.P.8A)** mereka.

Halaman EA memaparkan: **A · Employee particulars** (nama, TIN, IC, EPF no., SOCSO no., kategori MTD, anak, tempoh pekerjaan), **B · Employment income (cash)** (gaji kasar termasuk kerja lebih masa, bonus, elaun, jumlah saraan kasar), **D · Total deductions** (MTD/PCB), **E · Contributions** (EPF/KWSP, SOCSO, EIS — bahagian pekerja), dan **F · Tax-exempt allowances**. Gunakan butang **Print** (kanan atas) untuk menghasilkan salinan PDF atau bercetak untuk diserahkan kepada pekerja.

> **Nota — pekerja boleh layan diri.** Setiap pekerja boleh membuka EA mereka sendiri daripada **My workspace** (EA itu memaut ke `/payroll/reports/ea/…?year=2026`), jadi anda tidak perlu mencetak satu untuk semua orang.

> **Apa yang TIDAK termasuk dalam EA.** Penafian biru menjelaskannya. Angka-angka itu meliputi saraan tunai, EPF, SOCSO/EIS dan MTD sahaja. **Manfaat berupa barangan (Benefits-in-kind), nilai tempat tinggal, ESOS, gratuiti, elaun bebas cukai, zakat dan CP38 tidak dijejak dalam payroll** dan dipaparkan sebagai `not tracked`. Tambahkan mana-mana daripadanya sebelum memfailkan. Ini ialah penyata kerja yang dijana, bukan pengganti borang LHDN rasmi.

## Form E / CP8D (penyata majikan tahunan)

Pratonton `Form E / CP8D — annual (LHDN)` yang sama yang menyenaraikan pekerja turut memberikan anda penyata majikan:

- **Jubin ringkasan** di bahagian atas ialah **bilangan kepala Form E Part A**: Aktif pada 31 Dis, Tertakluk MTD, Pengambilan baharu, Diberhentikan.
- **Jadual CP8D** ialah jadual setiap pekerja: No., Employee, TIN, IC, Cat., Children, Gross remuneration, EPF, MTD/PCB, SOCSO — serta jumlah.
- **Download CSV** untuk diserahkan kepada ejen cukai anda, atau **Record generation** untuk jejak audit.

> **Penting — amaran skop yang sama.** Nota biru pada laporan ini memberi amaran bahawa ia meliputi angka terbitan-payroll sahaja. **Manfaat berupa barangan, tempat tinggal, ESOS, elaun bebas cukai, zakat dan CP38 tiada di sini** — tambahkannya dalam **MyTax / e-CP8D** sebelum memfailkan.

## Senarai kerja CP22 / CP22A (pengambilan baharu & pemberhentian)

Kad **Compliance worklist · CP22 / CP22A** di bahagian atas halaman dipacu oleh kitaran hayat pengambilan/penamatan dalam log peristiwa. Ia memunculkan pemberitahuan LHDN yang akan tiba tempoh, supaya tiada yang tergelincir:

| Lajur | Maksud |
| --- | --- |
| **Employee** | Untuk siapa pemberitahuan itu |
| **Form** | `CP22` (pengambilan baharu) atau `CP22A` (pemberhentian) |
| **Reason** | `New hire` (pengambilan baharu) atau `Cessation` (pemberhentian) |
| **Event date** | Tarikh ambil bekerja, atau tarikh pemberhentian |
| **Notify by** | Tarikh akhir (30 hari selepas pengambilan; ≥30 hari sebelum pemberhentian) |
| **Status** | `overdue` (merah), `due soon` (ambar, dalam 7 hari), atau `upcoming` (kelabu) |

Item disusun dengan yang lewat tempoh (overdue) dahulu. Apabila tiada yang belum selesai anda akan nampak **"Nothing due."**

> **Penting — ini bersifat nasihat sahaja.** Seperti yang dinyatakan oleh kad itu: *"File in MyTax; this surfaces what's outstanding."* Aplikasi ini **tidak pernah menghantar secara automatik** CP22/CP22A. Gunakan senarai kerja sebagai peringatan anda, kemudian failkan dalam MyTax sendiri. Belum ada "mark as filed" lagi, jadi sesuatu item hanya akan luput daripada tetingkap relevan selepas tarikh akhirnya.

## Ringkasan pembayaran bank (muat naik bank manual)

**payment summary** ialah CSV neutral pekerja / bank / akaun / gaji bersih untuk dimuat naik ke bank anda. Ia dijana daripada kelompok gaji yang **telah diproses atau ditutup** (muat turunkannya daripada kelompok itu pada skrin **Payroll** utama, bukan daripada borang Reports). Pentadbir sahaja; eksport itu dilog sebagai peristiwa domain pada kelompok berkenaan.

> **Nota — bukan fail giro.** Ini ialah CSV biasa, **bukan** fail giro khusus-bank yang tepat-bait. Jika sesuatu kelompok belum sedia, anda akan mendapat mesej "not ready" yang jelas memberitahu anda apa yang perlu dibuat; selesaikan pemprosesan kelompok dan cuba lagi.

## Rujukan pantas: sedia-hantar vs draf/nasihat

| Output | Apa ia | Status |
| --- | --- | --- |
| Jadual bulanan + **Download CSV** (caruman, CP39, EPF, SOCSO/EIS) | Ringkasan Layer-A boleh dibaca manusia | **Nasihat** — kemukakan daripada / serahkan kepada akauntan |
| **CP39 .txt** | Susun atur bait LHDN e-Data PCB (Exhibit 4) | **DRAF** — sahkan dalam e-PCB Plus dahulu |
| **EA (C.P.8A)** setiap pekerja | Penyata saraan, boleh dicetak | **Nasihat** — item tunai sahaja; tambah BIK dll. |
| Jadual **Form E / CP8D** + CSV | Penyata majikan tahunan | **Nasihat** — lengkapkan dalam MyTax / e-CP8D |
| Senarai kerja **CP22 / CP22A** | Peringatan pemfailan | **Nasihat** — failkan dalam MyTax; tidak pernah dihantar automatik |
| CSV **Payment summary** | Senarai muat naik bank | Sedia untuk muat naik bank **secara manual** (bukan fail giro) |
| **Record generation** | Artefak audit hanya-tambah | Rekod audit — **bukan** penghantaran |

## Penyelesaian masalah & jerangkap biasa

- **"No payroll batch found …"** — jalankan payroll untuk syarikat dan tempoh itu dahulu, kemudian pratonton semula.
- **Kotak merah "missing identifiers" / sel merah kosong** — lengkapkan IC, Tax no, EPF no atau SOCSO no pekerja itu di bawah **People** sebelum memfailkan.
- **Tiada butang CP39 .txt** — ia hanya muncul untuk laporan CP39 dengan **sifar** ralat kesediaan. Bersihkan kotak merah dahulu.
- **Jumlah EA / CP8D nampak rendah** — ingat manfaat berupa barangan, tempat tinggal, ESOS, gratuiti, elaun bebas cukai, zakat dan CP38 tidak dijejak; tambahkannya dalam MyTax sebelum memfailkan.
- **Memfailkan angka syarikat yang salah** — setiap laporan adalah mengikut entiti undang-undang. Semak semula pemilih **Company** sebelum anda mengeksport.
- **"Record generation" nampak tidak buat apa-apa** — ia ialah tindakan audit, bukan penghantaran. Sahkannya dalam **Recent generations** di bahagian bawah halaman.
