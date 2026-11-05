Buka [Kitaran gaji](/control-tower/loops/payroll-cycle) dalam Pusat AI, di bawah Operasi › Gelung. Tiga gelung membawa gaji setiap syarikat daripada input hingga audit, sebulan demi sebulan: gelung pra-gaji, gelung penggajian dan gelung audit. Halaman ini menunjukkan keadaan setiap gelung bagi setiap syarikat yang anda tadbir, perbandingan tiga kitaran terakhir dan gelung pekerja.

## Tiga gelung

Gelung pra-gaji menyemak setiap input dari permulaan tempoh gaji hingga tarikh tutup syarikat: rekod masa, kerja lebih masa, cuti dan hari tanpa gaji, tuntutan, pekerja baharu dan yang berhenti, nombor bank, KWSP, PERKESO dan cukai, perubahan gaji, persediaan gaji, dan semakan yang menemui sesuatu oleh gelung audit dua bulan berturut-turut. Setiap semakan dipautkan ke halaman tempat butirannya dibetulkan.

Gelung penggajian bermula pada tarikh tutup dan menyemak setiap larian: perubahan gaji bersih setiap orang berbanding ambang perubahan gaji bersih syarikat, dijelaskan mengikut sebab; semakan anomali; sama ada KWSP, PERKESO, SIP dan PCB menggunakan peraturan semasa; dan sama ada jumlah fail bank sama dengan gaji bersih. Buka [Gelung penggajian](/control-tower/loops/payroll-cycle/salary) untuk melihat semakan setiap larian dan merekodkan sama ada bendera perubahan gaji bersih dijangka atau masalah sebenar. Rekod itu tidak mengubah gaji.

Gelung audit berjalan selepas hari gaji. Buka [Gelung audit](/control-tower/loops/loop_payroll_audit) untuk slip gaji yang dikeluarkan dan dibuka, setiap fail berkanun yang disediakan dan difailkan, fail bank, pembetulan selepas larian, dapatan kawalan, dan pek audit untuk juruaudit anda.

## Seorang manusia sentiasa membuat keputusan

Ketiga-tiga gelung kekal pada tahap Sediakan dalam setiap syarikat. Gaji dikira hanya oleh perkhidmatan gaji. Seorang manusia menjalankan, meluluskan dan menutup gaji, memfailkan dengan KWSP, PERKESO dan LHDN, dan merekodkan setiap resit.

## Tetapan

[Tetapan kitaran gaji](/control-tower/loops/payroll-cycle/settings) menyimpan, bagi setiap syarikat, kekerapan gelung pra-gaji menyemak (setiap jam, dua kali sehari atau setiap hari) dan ambang perubahan gaji bersih (15% sehingga diubah), bersama item gaji yang dikecualikan daripadanya. Apabila bendera yang direkodkan menunjukkan ambang itu menangkap terlalu banyak, halaman ini mencadangkan perubahan bersama buktinya. Tiada apa yang berubah sehingga pentadbir meluluskannya, dan setiap perubahan disimpan sebagai versi baharu.

## Bertanya kepada Pusat AI

Pentadbir boleh bertanya kepada Pusat AI dalam sembang sama ada gaji bulan ini berjalan lancar, sama ada fail bank sepadan, berapa ambang perubahan gaji bersih, atau sama ada fail berkanun telah difailkan. Jawapannya memberi keadaan dan kiraan bagi syarikat yang anda tadbir, tidak pernah siapa yang dibenderakan, berapa banyak, atau sebarang angka gaji, dan Pusat AI tidak pernah menjalankan, meluluskan atau memfailkan apa-apa.

## Belajar daripada sejarah gaji

Apabila pentadbir gaji menghidupkan pembelajaran bagi sesebuah syarikat, Pusat AI mempelajari gaji biasa setiap orang daripada larian gaji syarikat yang ditutup, termasuk sejarah yang diimport: gaji bersih biasa mereka bagi bulan biasa, bagi sebulan penuh dan bagi larian bonus. Ia belajar hanya daripada larian yang ditutup dan hanya daripada bulan sebelum bulan yang disemak, dan ia mengecualikan bulan yang bendera perubahan gaji bersihnya didapati masalah sebenar, pengecualian yang dibetulkan di sumber, pembetulan selepas larian, angka berkanun yang ditetapkan secara manual, dan bulan sebelum perubahan gaji. Perkhidmatan gaji mengira setiap julat; Pusat AI tidak pernah membuat pengiraan.

Mulai 3 larian bersih yang ditutup, setiap bendera perubahan gaji bersih pada halaman [Gelung penggajian](/control-tower/loops/payroll-cycle/salary) dan setiap orang yang dibenderakan dalam pengecualian sesuatu larian menunjukkan baris seperti "Biasa bagi orang ini: melebihi julat daripada 7 larian", berserta julat biasanya. Baris itu menerangkan bendera dan tidak mengubah apa-apa: tiada angka, semakan atau bendera. "Dipelajari kitaran ini" pada halaman [Kitaran gaji](/control-tower/loops/payroll-cycle) mengira berapa ramai orang yang gaji biasanya stabil (6 larian atau lebih), sementara (3 hingga 5), belum dipelajari, dipelajari semula selepas perubahan gaji, atau telah berubah. Dalam sembang, pentadbir boleh bertanya kiraan yang sama; kiraan di bawah 5 tidak pernah diberikan, dan tidak pernah seseorang atau sesuatu amaun.

Pembelajaran dimatikan sehingga ia dihidupkan, setiap perubahannya disimpan sebagai versi baharu, dan julat yang dipelajari bagi pekerja yang berhenti dipadam 3 bulan selepas gaji terakhir mereka ditutup. Slip gaji mereka disimpan.

Pentadbir kumpulan menghidupkannya bagi setiap syarikat dalam [Tetapan kitaran gaji](/control-tower/loops/payroll-cycle/settings), yang menunjukkan mod dan setiap perubahan; mana-mana pentadbir gaji boleh mematikannya, dan setiap perubahan direkodkan dalam pek gelung audit. Bulan pertama dan terakhir seseorang dengan syarikat, serta mana-mana bulan dengan cuti tanpa gaji, ketidakhadiran atau prorata, tidak pernah dipelajari. Semasa suis henti Pusat AI dihidupkan, tiada apa-apa dipelajari atau ditunjukkan.
