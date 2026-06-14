Panduan ini adalah untuk pentadbir HR yang menguruskan **siapa boleh buat apa** di dalam AI HR dan yang perlu menjawab soalan *"siapa yang mengubah ini, dan bila?"*. Menjelang akhir panduan, anda akan tahu cara membaca dan memberikan empat peranan, perbezaan antara pemberian seluruh kumpulan dan pemberian berskop syarikat, cara pentadbir syarikat boleh mewakilkan dengan selamat dalam bahagian kumpulan mereka sendiri, cara menarik balik akses, serta cara menggunakan kedua-dua **Audit trail** global dan **History** setiap rekod yang membaca daripada log peristiwa tambah-sahaja (append-only).

> **Nota** Halaman yang diterangkan di sini terletak di bawah **Admin** dalam bar sisi kiri. Jika anda tidak nampak halaman tersebut, akaun anda tidak membawa peranan pentadbir — hanya `hr_admin` dan `super_admin` boleh membuka `/admin/users` dan `/admin/audit`. Semua orang lain dialihkan ke papan pemuka.

## Empat peranan

AI HR mempunyai tepat empat peranan. Peranan ini boleh bertindan — seseorang boleh memegang lebih daripada satu.

| Peranan | Maksudnya | Pemegang lazim |
| --- | --- | --- |
| `employee` | Layan diri sahaja: profil sendiri, slip gaji, cuti, kehadiran | Setiap kakitangan |
| `manager` | Menambah peti masuk **Approvals** untuk staf bawahan mereka | Ketua pasukan, pengurus barisan |
| `hr_admin` | Menambah keseluruhan suite **Admin** (Organisasi, konfigurasi Cuti, Gaji, Pengguna & peranan, Audit trail) | HR/operasi |
| `super_admin` | Segala yang ada pada `hr_admin`, **sentiasa merentas seluruh kumpulan** | Pemilik platform |

Peranan dipaparkan sebagai tag bulat kecil (**RoleTag**), jadi pada halaman Pengguna anda akan melihatnya ditulis sebagai `employee`, `manager`, `hr admin`, dan `super admin`.

## Pemberian seluruh kumpulan vs berskop syarikat

Ini ialah konsep paling penting pada halaman ini, kerana AI HR bersifat **berbilang syarikat**: satu penyewa boleh memegang beberapa syarikat dalam pokok induk/anak.

- Pemberian **seluruh kumpulan** tidak terikat kepada mana-mana syarikat. Ia terpakai merentas setiap syarikat. `super_admin` *pada dasarnya* adalah seluruh kumpulan — sistem tidak pernah menskopkannya kepada satu syarikat sahaja.
- Pemberian **berskop syarikat** mengikat seorang `hr_admin` kepada satu syarikat tertentu (dan, mengikut pokok kumpulan, subpokoknya). Pada halaman Pengguna, peranan berskop memaparkan nama syarikat di sebelah tag, seperti `hr admin · Acme Sdn Bhd`.

> **Nota** Hanya `hr_admin` yang sebenarnya menggunakan skop syarikat pada hari ini. Jika anda memilih syarikat untuk `employee` atau `manager`, sistem tetap menyimpan pemberian itu pada peringkat kumpulan — jadi jangan bergantung pada skop syarikat untuk dua peranan tersebut.

## Memberikan peranan

1. Dalam bar sisi kiri, buka **Admin → Users & roles** (`/admin/users`).
2. Anda akan melihat senarai setiap pengguna. Setiap baris memaparkan avatar, nama, e-mel, dan tag peranan yang sudah mereka pegang. Pengepala memaparkan jumlah keseluruhan pengguna.
3. Cari orang tersebut, kemudian gunakan borang sebaris di sebelah kanan baris mereka:
   - Dalam menu juntai bawah pertama, pilih **peranan**.
   - Dalam menu juntai bawah kedua, pilih satu **syarikat** (skop) — atau biarkan pada **Group-wide**.
   - Klik **Add role**.
4. Tag baharu muncul pada baris mereka dengan serta-merta.

**Apa yang anda lihat bergantung pada akses anda sendiri.** Halaman ini menyesuaikan dirinya:

- Seorang **pentadbir kumpulan** (seorang `super_admin`, atau `hr_admin` seluruh kumpulan) boleh memberikan *mana-mana* daripada empat peranan, untuk mana-mana syarikat atau seluruh kumpulan. Menu juntai bawah syarikat mengandungi pilihan **Group-wide** di bahagian atas.
- Seorang **pentadbir terwakil (berskop syarikat)** melihat borang yang dikurangkan: menu juntai bawah peranan menawarkan hanya `hr_admin`, dan menu juntai bawah syarikat menyenaraikan hanya syarikat yang mereka tadbir. Dengan kata lain, seorang pentadbir syarikat boleh melantik pentadbir HR lain, tetapi hanya dalam subpokok mereka sendiri.

> **Petua** Penyediaan akaun pengguna asas berlaku melalui pembekal identiti anda (WorkOS). Nota kelabu di bahagian atas halaman Pengguna menjelaskan perkara ini. AI HR ialah tempat anda memberikan *peranan* kepada orang yang sudah wujud — ia bukan tempat anda mencipta akaun log masuk dari awal.

## Sub-perwakilan: pentadbir syarikat memberikan dalam subpokok mereka

AI HR dibina supaya anda boleh menyerahkan pentadbiran HR dengan selamat tanpa memberikan kunci kepada seluruh kumpulan.

- Seorang pentadbir kumpulan menskopkan seorang `hr_admin` kepada, katakan, **Acme Sdn Bhd**.
- Orang itu kini boleh membuka **Users & roles** dan melantik lagi pemberian `hr_admin` — tetapi borang hanya membenarkan mereka memilih `hr_admin`, dan hanya untuk **Acme** serta mana-mana syarikat di bawahnya dalam pokok kumpulan.
- Mereka tidak boleh menaikkan keistimewaan. Mereka tidak boleh mencipta `super_admin`, dan mereka tidak boleh mencapai syarikat seiring di luar subpokok mereka.

Sempadan ini dikuatkuasakan oleh keselamatan peringkat baris (row-level security) dalam pangkalan data, bukan sekadar dengan menyembunyikan butang — jadi walaupun permintaan yang direka khas tidak boleh melepasi garisan.

## Menarik balik peranan

1. Pada **Users & roles**, cari tag peranan yang anda mahu buang.
2. Klik **×** kecil di sebelah kanan tag (tooltipnya berbunyi **Revoke role**). Ia bertukar merah apabila dituding.
3. Pemberian itu dibuang dan tag itu hilang.

**Siapa boleh menarik balik apa:**

- Seorang **pentadbir kumpulan** boleh menarik balik mana-mana tag peranan.
- Seorang **pentadbir terwakil** hanya melihat **×** pada pemberian **`hr_admin` berskop syarikat** — yang berada dalam subpokok mereka. Pemberian seluruh kumpulan dan peranan lain tiada kawalan buang untuk mereka.

> **Nota** Penarikan balik benar-benar diperiksa kebenarannya. Jika seorang pentadbir terwakil entah bagaimana menyasarkan pemberian di luar subpokok mereka, tindakan itu gagal dengan *"Not permitted to revoke this role assignment"* dan tiada apa-apa diubah atau dilog — sistem tidak pernah merekodkan penarikan balik untuk baris yang masih wujud.

## Audit trail (`/admin/audit`)

Setiap perubahan keadaan dalam AI HR menambah satu entri pada **log peristiwa tambah-sahaja** — tiada apa-apa pernah disunting atau dipadam di tempatnya. Audit trail ialah tingkap anda kepada lejar itu.

1. Dalam bar sisi, buka **Admin → Audit trail** (`/admin/audit`).
2. Di bahagian atas terdapat bar penapis dengan empat kawalan dan butang **Filter**:
   - **Record type** — sempitkan kepada satu jenis rekod, cth. `Role assignment`, `Employee`, `Leave request`, `Payroll batch`. Biarkan pada **All** untuk melihat segala-galanya.
   - **Search event** — padanan teks bebas pada nama peristiwa.
   - **From** / **To** — tetingkap tarikh.
   - Klik **Filter** untuk menggunakan, atau **Reset** untuk membersihkan.
3. Di bawah, peristiwa muncul terbaharu-dahulu, 100 setiap halaman. Gunakan **Older →** dan **← Newer** di bahagian bawah untuk berpindah antara halaman; penunjuk memaparkan nombor halaman semasa.

**Membaca satu baris.** Setiap baris ialah satu peristiwa. Dari kiri ke kanan anda akan melihat:

- Satu **bintik berwarna** kecil yang menandakan jenis pelaku — seorang individu (`USER`), `System`, `Agent`, atau `External`.
- **Nama peristiwa yang dimanusiakan** (cth. `Role assigned`, `Role revoked`, `Company updated`) dan **siapa** yang melakukannya.
- **Rekod** yang disentuhnya (selalunya pautan boleh diklik, cth. seorang pekerja atau kelompok gaji).
- Satu **cap masa relatif** (`just now`, `5m ago`, `3h ago`, `2d ago`). Tuding untuk melihat tarikh dan masa tepat.

Klik mana-mana baris untuk mengembangkannya. Satu blok butiran kecil memaparkan apa yang berubah — untuk suntingan, perbezaan `from → to` setiap medan; untuk peristiwa lain, medan yang berkaitan. Satu nombor jujukan terletak di bahagian bawah butiran.

> **Nota** Nilai sensitif ditutup dalam paparan audit. Nombor akaun bank, nombor IC, nombor cukai, dan angka gaji/bayaran dipaparkan sebagai `•••• 1234` (atau `••••`) supaya jejak itu kekal berguna tanpa mendedahkan PII atau data kewangan.

## History setiap rekod

Anda tidak perlu menyelongkar log global untuk menyiasat seorang sahaja. Buka mana-mana pekerja daripada **People**, tatal ke bahagian **Change history** berhampiran bahagian bawah halaman butiran mereka. Ia menggunakan baris boleh kembang yang sama seperti Audit trail, tetapi ditapis terlebih dahulu kepada peristiwa pekerja itu sahaja — pemberian peranan, perubahan profil dan bank, pampasan, suntingan berkanun, dan banyak lagi.

> **Petua** Blok **Change history** adalah untuk pentadbir sahaja. Pengurus dan pekerja yang melihat profil tidak akan melihatnya.

## Penyelesaian masalah & jerangkap lazim

- **Saya hanya boleh memberikan `hr_admin`.** Anda seorang pentadbir berskop syarikat (terwakil). Itu memang reka bentuknya — anda boleh melantik pentadbir HR dalam subpokok anda tetapi tiada apa-apa yang lebih tinggi.
- **Menu juntai bawah syarikat tiada syarikat yang saya perlukan.** Anda hanya melihat syarikat yang anda tadbir. Minta pentadbir kumpulan meluaskan skop anda, atau membuat pemberian itu untuk anda.
- **`×` untuk menarik balik tiada di situ.** Anda hanya boleh menarik balik pemberian `hr_admin` berskop syarikat dalam subpokok anda. Pemberian seluruh kumpulan atau lebih tinggi memerlukan pentadbir kumpulan.
- **Saya menskopkan seorang `manager` kepada satu syarikat tetapi ia memaparkan seluruh kumpulan.** Dijangka — hanya `hr_admin` membawa skop syarikat. Pemberian pengurus dan pekerja sentiasa pada peringkat kumpulan.
- **Satu peristiwa nampaknya hilang.** Periksa penapis anda dahulu (Record type dan tetingkap tarikh adalah melekat merentas halaman). Ingat log itu tambah-sahaja — entri tidak pernah dibuang, jadi luaskan tetingkap dan bukan mengandaikan ia telah dipadam.
