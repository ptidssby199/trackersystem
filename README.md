# IDS Tracker System

Aplikasi pencatat titik lokasi GPS field/gudang petani. Berjalan sepenuhnya
di browser (offline-first) dengan **IndexedDB** sebagai database lokal, dan
opsi sinkronisasi dua arah ke **Firebase Firestore**. Tidak butuh backend
server — cocok di-hosting statis lewat GitHub Pages.

## Fitur

1. **Login** — ID Pegawai (kode NIK) + password, divalidasi ke Master Employee.
2. **Master Petani** — kode petani, nama petani, source, petani conversion, kode FT.
3. **Type** — daftar type lokasi (default: Field, Warehouse), bisa ditambah/diubah.
4. **Master Employee** — kode NIK, nama, posisi, password login.
5. **Catat Lokasi** — form record: tanggal & waktu kunjungan, kode+nama
   petani, type, dan titik GPS yang diambil langsung dari perangkat
   (`navigator.geolocation`), ditampilkan di minimap Leaflet dan bisa
   digeser manual bila perlu. Setiap titik otomatis mendapat **transID**
   (integer 32-bit, bisa negatif — mengikuti kolom `int` di SQL Server),
   **rowguid** (GUID unik), **altitude** dari GPS, **Crop Year** (ikut
   menu Pengaturan), plus **Remark** opsional (default `-` jika kosong).
   Field lain — Source, `dtRecord`/`dtModified` (format
   `YYYY-MM-DD HH:MM:SS.mmm`), `UserModified`/`Username` (default
   `sync`), dan `userlogin` — diisi otomatis di balik layar, meniru
   struktur tabel `T_GPS` di SQL Server.
6. **Pengaturan** — set nilai **Source** dan **Crop Year** yang berlaku
   global: Source jadi default saat menambah Master Petani baru, dan
   Crop Year otomatis dipakai di setiap titik lokasi baru — tidak perlu
   diisi ulang setiap saat.
7. **Laporan** — daftar & peta semua titik tersimpan, difilter per petani
   dan per source, dengan marker 🚩/🔴 di peta (🔴 saat peta di-zoom
   jauh supaya titik berdekatan tidak tumpang tindih). Tabel menampilkan
   tanggal, kode & nama petani, type, koordinat lengkap (lat/long/alt),
   dan Crop Year. Bisa diekspor ke **Excel** dengan kolom yang persis
   sama seperti tabel `T_GPS` (`transID`, `SupplierID`, `Lat`, `Long`,
   `Alt`, `Dates`, `CropYear`, `Source`, `dtRecord`, `dtModified`,
   `UserModified`, `Username`, `rowguid`, `Remark`, `status`,
   `userlogin`) — siap diimpor langsung ke SQL Server — atau ke
   **gambar JPEG** peta.
8. **Sinkronisasi Firebase** — push data lokal ke Firestore dan pull data
   dari Firestore, dengan config Firebase disimpan di IndexedDB (tidak
   di-hardcode di kode sumber). Config bisa diisi manual atau diimpor
   langsung dari file JSON.
9. **Backup / Restore JSON** — ekspor seluruh database ke satu file `.json`,
   dan impor kembali (upsert berdasarkan kunci masing-masing tabel).
10. **PWA (Progressive Web App)** — bisa "Add to Home Screen" / dipasang
   sebagai aplikasi di HP maupun desktop, punya app-shell yang tetap bisa
   dibuka offline (lewat service worker), dan navigasi utama berupa
   **bottom icon nav** (mirip aplikasi mobile) supaya tinggal tap ikon
   menu yang dituju.
11. **Notifikasi custom** — ikon lonceng di pojok kanan atas menyimpan
    riwayat notifikasi dalam aplikasi (berhasil/gagal), dan bisa
    mengaktifkan notifikasi asli perangkat (Notification API) yang akan
    muncul saat aplikasi berjalan di background.

## Struktur folder

```
ids-tracker-system/
├── index.html            # shell login + layout aplikasi + bottom nav
├── manifest.json          # metadata PWA (nama, ikon, warna tema)
├── service-worker.js       # cache app-shell untuk mode offline
├── icons/                   # ikon PWA (192/512/maskable/apple-touch/favicon)
├── css/style.css             # tema visual
├── js/db.js                   # wrapper IndexedDB (schema + CRUD)
├── js/sync.js                  # sinkronisasi Firebase Firestore
├── js/app.js                    # routing, halaman, form, GPS, map, notifikasi
└── README.md
```

## Menjalankan secara lokal

Karena `sync.js`/`app.js` dimuat sebagai ES module, buka lewat server lokal
(bukan `file://`), misalnya:

```bash
npx serve .
# atau
python3 -m http.server 8080
```

Lalu buka `http://localhost:8080`.

## Login pertama kali

Saat pertama kali dibuka, aplikasi otomatis membuat satu akun admin:

- **ID Pegawai:** `admin`
- **Password:** `admin123`

Segera buat akun pegawai lain lewat menu **Master Employee**, lalu ganti
atau hapus akun admin default sesuai kebutuhan.

## Deploy ke GitHub Pages

1. Push seluruh isi folder ini ke repo GitHub (root repo, bukan subfolder,
   atau atur folder root Pages sesuai lokasi `index.html`).
2. Buka **Settings → Pages**, pilih branch (`main`) dan folder root `/`.
3. Tunggu beberapa menit, aplikasi bisa diakses di
   `https://<username>.github.io/<repo>/`.
4. Untuk fitur GPS, browser mewajibkan koneksi **HTTPS** — GitHub Pages
   sudah HTTPS secara default, jadi aman digunakan di lapangan. Service
   worker (mode offline PWA) juga hanya aktif di HTTPS atau `localhost`.

## Menghubungkan ke Firebase (opsional)

1. Buat project di [Firebase Console](https://console.firebase.google.com),
   aktifkan **Firestore Database** (mode production/test sesuai kebutuhan).
2. Ambil kredensial web app dari **Project Settings → General → Your apps → Web app**.
3. Di aplikasi, buka menu **Sinkronisasi**. Ada dua cara mengisi konfigurasi:
   - **Import dari File JSON** — pilih file yang berisi objek `firebaseConfig`.
     Bisa JSON murni atau ditempel apa adanya dari Firebase Console
     (termasuk `const firebaseConfig = { ... };`), field akan terisi otomatis.
   - Atau isi manual `apiKey`, `authDomain`, `projectId`, `storageBucket`,
     `messagingSenderId`, `appId`.
   Setelah terisi, klik **Simpan Konfigurasi**.
4. Gunakan tombol **Push ke Firebase** untuk mengunggah data lokal, dan
   **Pull dari Firebase** untuk menarik data terbaru dari cloud ke
   perangkat ini.
5. Atur Firestore Security Rules sesuai kebutuhan keamanan sebelum dipakai
   di produksi — konfigurasi default Firestore bersifat terkunci penuh.

## Catatan teknis

- Database lokal (`idsTrackerDB`) memiliki 5 object store: `employees`,
  `petani`, `types`, `records`, `config`. Semua tetap tersimpan di
  perangkat meski offline atau belum pernah sinkron ke Firebase.
- Password pegawai saat ini disimpan sebagai teks biasa di IndexedDB untuk
  kesederhanaan (khas aplikasi internal/offline). Jika akan dipakai lebih
  luas, pertimbangkan hashing password atau memindahkan autentikasi ke
  Firebase Authentication.
- Minimap menggunakan [Leaflet](https://leafletjs.com/) + tile
  OpenStreetMap, dimuat lewat CDN sehingga butuh koneksi internet saat
  peta ditampilkan (titik GPS & data tetap tersimpan offline).
