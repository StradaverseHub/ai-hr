Panduan ini untuk **pengurus orang** — sesiapa sahaja yang mempunyai peranan `manager` dengan kakitangan yang melapor terus kepadanya. Ia membimbing anda menerusi peti masuk **Approvals** yang bersatu, tempat setiap permohonan daripada barisan pelaporan anda menunggu satu keputusan: permohonan cuti, permohonan pembetulan kehadiran, dan (untuk pentadbir) perubahan profil. Menjelang akhirnya, anda akan tahu cara meluluskan atau menolak setiap jenis, memahami dengan tepat permohonan siapa yang boleh anda lihat, mengapa anda tidak boleh memutuskan permohonan anda sendiri, dan apa yang dilakukan oleh setiap klik di hilir — seperti mendebit baki cuti atau meminda rekod kehadiran.

## Membuka peti masuk Approvals anda

Di bar sisi kiri, klik **Approvals**. Halaman ini hanya kelihatan kepada pengurus dan pentadbir; jika anda tidak mempunyai pelapor atau peranan pentadbir, anda tidak akan nampak item menu ini.

Di bahagian atas, anda akan nampak satu **PageHeader** bertajuk **Approvals**. Di bawah tajuk itu terdapat kiraan langsung:

- Jika tiada apa-apa untuk dilakukan, ia tertera **"Nothing waiting on you"**.
- Jika tidak, ia tertera **"3 items awaiting a decision"** (atau **"1 item awaiting a decision"** untuk satu sahaja) — jumlah keseluruhan merentas semua bahagian.

Peti masuk ialah satu skrin dengan kad bertindan. Setiap pengepala kad menunjukkan nama bahagian dan lencana kiraan supaya anda boleh nampak sepintas lalu di mana kerja itu berada:

| Bahagian | Apa yang dikandungnya |
| --- | --- |
| **Leave requests** | Permohonan cuti yang belum diputuskan daripada pelapor anda |
| **Attendance corrections** | Permohonan untuk membetulkan masa daftar masuk / daftar keluar bagi sesuatu hari |
| **Profile changes (bank / tax)** | Suntingan butiran bank dan cukai — **pentadbir sahaja** (anda tidak akan nampak kad ini sebagai pengurus biasa) |

**Nota:** Hanya item yang **belum diputuskan** muncul di sini. Setelah anda memutuskan sesuatu permohonan, ia akan jatuh keluar dari peti masuk — tiada tab "telah diputuskan" pada halaman ini. Untuk menyemak keputusan lepas, gunakan **Audit trail** (pentadbir) atau paparan **History** bagi setiap rekod.

## Permohonan siapa yang boleh anda lihat (skop barisan pelaporan)

Anda hanya boleh nampak permohonan daripada **barisan pelaporan anda sendiri** — orang yang melapor kepada anda secara pentadbiran. Sistem menguatkuasakan ini dalam dua lapisan, jadi anda tidak perlu menapis secara manual:

- **Keterlihatan** dipangkas oleh keselamatan peringkat baris: seorang pengurus membaca baris pelapornya, seorang pekerja membaca hanya barisnya sendiri, seorang pentadbir melihat segala-galanya dalam skop. Senarai pada halaman ini sudah pun ditapis sebelum sampai kepada anda.
- **Kuasa untuk memutuskan** ialah semakan kedua yang lebih ketat (lihat di bawah).

**Petua:** Jika permohonan rakan sepasukan tidak muncul, sebab paling lazim ialah anda bukan **pengurus pentadbiran aktif** mereka. Barisan pelaporan mesti berkesan *hari ini* — barisan yang bertarikh masa depan, sudah tamat, atau telah digantikan tidak akan memasukkan permohonan mereka ke peti masuk anda. Minta pentadbir HR anda mengesahkan barisan pelaporan pada **Org chart** atau di **Admin → Organization**.

## Peraturan tiada-kelulusan-diri

Anda **tidak boleh memutuskan permohonan anda sendiri**. Jika salah satu permohonan anda sendiri muncul dalam senarai — sebagai contoh, anda memfailkan pembetulan kehadiran untuk diri sendiri — lajur tindakan tidak akan menunjukkan butang. Sebaliknya, anda akan nampak label malap **"your request"** di tempat **Approve** / **Reject** biasanya berada.

Pengawal ini terletak pada lapisan perkhidmatan, bukan sekadar UI, jadi ia tidak boleh dipintas. Cuti dan pembetulan anda sendiri mesti diputuskan oleh pengurus *anda* atau pentadbir HR.

**Nota:** Terdapat satu pengecualian yang disengajakan: `super_admin` mengekalkan laluan keluar pentadbir tunggal dan *boleh* meluluskan permohonan sendiri, supaya pasukan pentadbir seorang sahaja dalam firma kecil tidak terhalang secara kekal. Pengurus biasa dan pengguna `hr_admin` tidak sekali-kali boleh.

## Meluluskan atau menolak permohonan cuti

Kad **Leave requests** menunjukkan jadual dengan lajur ini: **Employee**, **Type**, **Dates**, **Days**, dan **Action**.

1. Baca baris itu: lajur **Dates** menunjukkan julat sebagai `start → end`, dan **Days** menunjukkan jumlah yang dikira (jenis cuti hari bekerja sudah mengecualikan hujung minggu dan cuti umum).
2. Dalam lajur **Action**, klik **Approve** atau **Reject**.
3. Keputusan diserahkan serta-merta dan baris itu hilang daripada peti masuk.

**Apa yang Approve lakukan di hilir:** meluluskan permohonan cuti melakukan tiga perkara secara atom dalam satu transaksi:

- Ia menyemak **baki unjuran** pekerja itu bagi jenis cuti tersebut. Jika kelulusan akan menolak baki ke bawah sifar, keputusan itu disekat dengan **"Leave rejected: insufficient balance"** dan tiada apa-apa berubah.
- Jika baki mencukupi, ia mencatatkan **debit** ke lejar cuti tambah-sahaja bagi bilangan hari yang dimohon (berkuat kuasa pada tarikh mula cuti), supaya baki turun dengan jumlah yang tepat itu.
- Ia menukar status permohonan kepada `approved`, mencap siapa yang memutuskan dan bila, serta merekodkan keputusan itu dalam log peristiwa.

Sebaik diluluskan, hari-hari itu turut dikira sebagai **on leave** pada paparan **Attendance** untuk tarikh yang dilindungi — jadi pekerja itu tidak akan ditanda tidak hadir.

**Apa yang Reject lakukan:** status bertukar kepada `rejected` dan keputusan itu dilog. **Tiada baki disentuh** — penolakan tidak sekali-kali mendebit atau mengkredit hari.

**Perangkap lazim — "insufficient balance":** jika Approve gagal pada baki, ia biasanya bermakna kelayakan pekerja itu belum diberikan, atau mereka sudah menggunakannya. Anda tidak boleh memintas baki dari skrin ini; salurkannya kepada pentadbir HR anda, yang boleh mencatatkan pelarasan cuti.

## Meluluskan atau menolak pembetulan kehadiran

Apabila masa punch pekerja salah (terlupa daftar masuk, daftar keluar lewat, dll.), mereka membangkitkan satu pembetulan dari ruang kerja mereka. Ia mendarat di kad **Attendance corrections** anda.

Lajur jadual ialah: **Employee**, **Date**, **Proposed**, **Reason**, dan **Action**.

1. Semak lajur **Proposed** — ia menunjukkan masa yang dimohon sebagai `HH:MM` (dan `HH:MM → HH:MM` apabila daftar keluar disertakan).
2. Baca **Reason** yang diberikan pekerja itu (ia menunjukkan `—` jika mereka membiarkannya kosong).
3. Klik **Approve** atau **Reject**.

**Apa yang Approve lakukan di hilir:** kelulusan bukan sekadar mengecap masa itu — ia **membina semula rekod kehadiran menerusi enjin masa**. Daftar masuk/daftar keluar yang dicadangkan diklasifikasikan semula mengikut jenis hari (hari bekerja, hari rehat, atau cuti umum) dan diterbitkan semula menjadi satu status (`present`, `late`, atau `half_day`) serta **minit bekerja dan minit kerja lebih masa**. Rekod terbetul itu ditulis ke hari berkenaan (menggantikan mana-mana baris sedia ada bagi tarikh itu) dan ditanda **"Corrected"**. Oleh sebab kerja lebih masa dikira semula di sini, satu pembetulan yang diluluskan mengalir terus ke gaji — jadi mendapatkan masa yang betul itu penting.

**Apa yang Reject lakukan:** pembetulan itu ditanda `rejected` dan dilog; rekod kehadiran asal dibiarkan tidak tersentuh.

**Petua:** Pengelasan kerja lebih masa mengikut peraturan EA 1955 Malaysia — kerja pada hari rehat atau cuti umum dikira sebagai kerja lebih masa sepenuhnya dan kemudian dimonetkan pada kadar premium dalam gaji. Jadi meluluskan pembetulan hari rehat boleh menaikkan gaji seseorang secara sah. Periksa kewarasan masa **Proposed** berbanding **Reason** sebelum meluluskan.

## Perubahan profil (pentadbir sahaja)

Jika anda juga memegang peranan pentadbir, satu kad ketiga — **Profile changes (bank / tax)** — muncul. Ia menyenaraikan suntingan layan diri yang belum diputuskan bagi medan sensitif, menunjukkan nama pekerja dan setiap perubahan yang dicadangkan sebagai `field → new value`. Klik **Approve** atau **Reject** dengan cara yang sama. Pengurus biasa tidak nampak kad ini; perubahan bank dan cukai dikhaskan untuk pentadbir HR kerana ia menyuap potongan berkanun dan fail pembayaran.

## Rujukan pantas: apa yang dilakukan oleh setiap keputusan

| Jenis permohonan | Approve | Reject |
| --- | --- | --- |
| **Leave** | Menyemak baki → mendebit lejar → menanda `approved`; hari kini dikira sebagai on-leave pada Attendance | Menanda `rejected`; **tiada** perubahan baki |
| **Attendance correction** | Menerbitkan semula hari menerusi enjin masa, menulis rekod terbetul (dengan OT untuk gaji), menanda `approved` | Menanda `rejected`; rekod asal tidak tersentuh |
| **Profile change** (pentadbir) | Menggunakan nilai bank/cukai baharu, menanda `approved` | Menanda `rejected`; tiada perubahan digunakan |

## Penyelesaian masalah

- **"You cannot decide your own ..."** — anda cuba bertindak ke atas permohonan anda sendiri. Ini dijangka; ia mesti pergi kepada pengurus anda atau pentadbir HR. (Hanya `super_admin` boleh meluluskan permohonan sendiri.)
- **"Only an admin or the administrative manager can decide this ..."** — anda bukan pengurus pentadbiran *aktif* bagi subjek itu. Sahkan barisan pelaporan berkesan hari ini dan tidak digantikan.
- **"... is already approved / rejected"** — seseorang (selalunya pentadbir, atau anda dalam tab lain) sudah pun memutuskannya. Muat semula halaman; ia sepatutnya sudah jatuh keluar dari peti masuk.
- **Satu permohonan tidak pernah sampai kepada saya** — semak barisan pelaporan pada **Org chart**. Jika ia bertarikh masa depan atau sudah tamat, minta pentadbir HR anda membetulkannya di **Admin → Organization**.

**Nota:** Setiap keputusan yang anda buat direkodkan dalam log audit/peristiwa dengan anda sebagai pelaku sebenar — kelulusan di sini boleh dipertanggungjawabkan, bukan tanpa nama. Jika anda perlu menyemak semula siapa yang memutuskan apa, di situlah tempat untuk melihat.
