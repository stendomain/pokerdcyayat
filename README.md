# Poker DC Lite

Texas Hold'em multiplayer: cukup isi nama + kode room. Chip virtual, tanpa akun, tanpa database.

## Jalankan
    npm install
    node server.js

Buka http://localhost:3000, isi nama, masuk meja, klik "Salin link" dan kirim ke temen di DC.

## Online gratis (Render)
1. Upload isi folder ini ke GitHub (tanpa node_modules).
2. render.com -> New -> Web Service -> pilih repo.
3. Build: `npm install`   Start: `node server.js`   Instance: Free.

Server gratis tidur kalau 15 menit sepi; buka lagi sekitar 1 menit baru nyala.
Setting (env, opsional): START_CHIPS (default 2000), PORT.
