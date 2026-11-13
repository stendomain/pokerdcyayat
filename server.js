// Poker DC Lite - cukup nama + kode room. Chip virtual, tanpa akun, tanpa database.
const express = require('express'), http = require('http'), crypto = require('crypto');
const { Server } = require('socket.io');
const app = express(), server = http.createServer(app), io = new Server(server);
app.use(express.static(__dirname + '/public'));

const PORT = process.env.PORT || 3000, START = +process.env.START_CHIPS || 2000; // chip awal tiap pemain
const SB = 10, BB = 20, TURN_MS = 30000, MAX_SEATS = 8;

// ---------- evaluator kartu ----------
const NAMES = ['High Card', 'One Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];
function score5(c) {
  const r = c.map(x => x.r).sort((a, b) => b - a), flush = c.every(x => x.s === c[0].s);
  let straight = false, hi = r[0];
  if (new Set(r).size === 5) { if (r[0] - r[4] === 4) straight = true; else if (r.join() === '14,5,4,3,2') { straight = true; hi = 5; } }
  const cnt = {}; r.forEach(x => cnt[x] = (cnt[x] || 0) + 1);
  const g = Object.entries(cnt).map(([k, v]) => [v, +k]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const cat = straight && flush ? 8 : g[0][0] === 4 ? 7 : g[0][0] === 3 && g[1][0] === 2 ? 6 : flush ? 5 : straight ? 4 : g[0][0] === 3 ? 3 : g[0][0] === 2 && g[1][0] === 2 ? 2 : g[0][0] === 2 ? 1 : 0;
  const k = straight ? [hi] : g.map(x => x[1]); while (k.length < 5) k.push(0);
  return [cat, ...k].reduce((a, x) => a * 15 + x, 0);
}
function best(cs) {
  let b = -1;
  for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) b = Math.max(b, score5(cs.filter((_, k) => k !== i && k !== j)));
  return b;
}
const handName = sc => NAMES[Math.floor(sc / 15 ** 5)];
function newDeck() {
  const d = []; for (let r = 2; r <= 14; r++) for (let s = 0; s < 4; s++) d.push({ r, s });
  for (let i = d.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}

// ---------- logika meja ----------
const rooms = new Map();
const inPlay = r => ['preflop', 'flop', 'turn', 'river'].includes(r.phase);
const live = r => r.seats.filter(s => s.inHand && !s.folded);
const nxt = (r, i, f) => { const n = r.seats.length; for (let k = 1; k <= n; k++) { const j = (((i + k) % n) + n) % n; if (f(r.seats[j])) return j; } return -1; };
const log = (r, m) => { r.log.push(m); if (r.log.length > 8) r.log.shift(); };

function post(s, amt) { const a = Math.min(amt, s.stack); s.stack -= a; s.bet += a; s.total += a; if (!s.stack) s.allin = true; return a; }

function view(r, me) {
  const show = r.phase === 'showdown';
  return {
    code: r.code, phase: r.phase, board: r.board, pot: r.pot, currentBet: r.currentBet, minRaise: r.minRaise,
    turn: r.turn >= 0 && inPlay(r) ? r.seats[r.turn].name : null, ms: Math.max(0, r.deadline - Date.now()),
    dealer: r.dealer >= 0 && r.seats[r.dealer] ? r.seats[r.dealer].name : null, you: me.name, result: r.result, log: r.log, BB,
    seats: r.seats.map(s => ({
      name: s.name, stack: s.stack, bet: s.bet, folded: s.folded, allin: s.allin, inHand: s.inHand, away: !s.sid,
      cards: !s.cards.length ? [] : (s === me || (show && s.show)) ? s.cards : [null, null]
    }))
  };
}
function broadcast(r) { r.seats.forEach(s => s.sid && io.to(s.sid).emit('state', view(r, s))); }

function startHand(r) {
  if (!r.seats.some(s => s.sid)) r.seats.forEach(s => s.leaving = true); // semua pemain sudah pergi
  removeLeavers(r); if (!rooms.has(r.code)) return;
  const ps = r.seats.filter(s => s.stack > 0);
  if (ps.length < 2) { r.phase = 'waiting'; r.turn = -1; return broadcast(r); }
  r.seats.forEach(s => Object.assign(s, { cards: [], bet: 0, total: 0, allin: false, acted: false, show: false, inHand: s.stack > 0, folded: s.stack <= 0 }));
  r.deck = newDeck(); r.board = []; r.pot = 0; r.result = null; r.log = [];
  r.dealer = nxt(r, r.dealer, s => s.inHand);
  const inH = s => s.inHand, sb = ps.length === 2 ? r.dealer : nxt(r, r.dealer, inH), bb = nxt(r, sb, inH);
  post(r.seats[sb], SB); post(r.seats[bb], BB);
  for (let k = 0; k < 2; k++) r.seats.forEach(s => s.inHand && s.cards.push(r.deck.pop()));
  r.currentBet = BB; r.minRaise = BB; r.phase = 'preflop';
  log(r, `Tangan baru — blind ${SB}/${BB}`);
  setTurn(r, nxt(r, bb, s => s.inHand && !s.folded && !s.allin));
  broadcast(r);
}
function setTurn(r, i) {
  clearTimeout(r.timer); r.turn = i; const s = r.seats[i]; r.deadline = Date.now() + TURN_MS;
  r.timer = setTimeout(() => { if (r.seats[r.turn] === s && inPlay(r)) act(r, s, r.currentBet > s.bet ? 'fold' : 'check'); }, s.sid ? TURN_MS : 1500);
}
function act(r, s, type, amt) {
  if (!inPlay(r) || r.seats[r.turn] !== s) return;
  const toCall = r.currentBet - s.bet;
  if (type === 'fold') { s.folded = true; log(r, `${s.name} fold`); }
  else if (type === 'check') { if (toCall > 0) return; log(r, `${s.name} check`); }
  else if (type === 'call') { if (toCall <= 0) return; post(s, toCall); log(r, `${s.name} call${s.allin ? ' (all-in)' : ''}`); }
  else if (type === 'raise') {
    const max = s.bet + s.stack; amt = Math.min(Math.floor(+amt) || 0, max);
    if (amt <= r.currentBet) return;
    if (amt < r.currentBet + r.minRaise && amt < max) return;
    const by = amt - r.currentBet; post(s, amt - s.bet);
    if (by >= r.minRaise) r.minRaise = by;
    r.currentBet = amt; r.seats.forEach(o => { if (o !== s) o.acted = false; });
    log(r, `${s.name} raise ke ${amt}${s.allin ? ' (all-in)' : ''}`);
  } else return;
  s.acted = true; advance(r); broadcast(r);
}
function advance(r) {
  const lv = live(r);
  if (lv.length === 1) return endHand(r);
  const pending = lv.filter(s => !s.allin && (!s.acted || s.bet !== r.currentBet));
  if (!pending.length) return nextStreet(r);
  setTurn(r, nxt(r, r.turn, s => s.inHand && !s.folded && !s.allin && (!s.acted || s.bet !== r.currentBet)));
}
function nextStreet(r) {
  r.seats.forEach(s => { r.pot += s.bet; s.bet = 0; s.acted = false; });
  r.currentBet = 0; r.minRaise = BB;
  if (r.phase === 'river') return endHand(r);
  const o = { preflop: 'flop', flop: 'turn', turn: 'river' }; r.phase = o[r.phase];
  for (let k = 0; k < (r.phase === 'flop' ? 3 : 1); k++) r.board.push(r.deck.pop());
  if (live(r).filter(s => !s.allin).length < 2) return nextStreet(r); // semua all-in: buka kartu sampai habis
  setTurn(r, nxt(r, r.dealer, s => s.inHand && !s.folded && !s.allin));
}
function endHand(r) {
  clearTimeout(r.timer); r.seats.forEach(s => { r.pot += s.bet; s.bet = 0; });
  const lv = live(r), won = {}, showdown = lv.length > 1;
  r.turn = -1;
  if (!showdown) won[lv[0].name] = { amt: r.pot, hand: '' };
  else {
    lv.forEach(s => { s.sc = best([...s.cards, ...r.board]); s.show = true; });
    const levels = [...new Set(lv.map(s => s.total))].sort((a, b) => a - b); let prev = 0;
    levels.forEach((L, idx) => {
      const cap = idx === levels.length - 1 ? Infinity : L;
      const pot = r.seats.reduce((a, s) => a + Math.max(0, Math.min(s.total, cap) - prev), 0);
      const el = lv.filter(s => s.total >= L), top = Math.max(...el.map(s => s.sc)), w = el.filter(s => s.sc === top);
      const part = Math.floor(pot / w.length);
      w.forEach((s, i) => { const a = part + (i === 0 ? pot - part * w.length : 0); won[s.name] = { amt: (won[s.name]?.amt || 0) + a, hand: handName(s.sc) }; });
      prev = L;
    });
  }
  r.seats.forEach(s => { if (won[s.name]) s.stack += won[s.name].amt; });
  r.result = Object.entries(won).map(([name, v]) => ({ name, amt: v.amt, hand: v.hand }));
  r.result.forEach(w => log(r, `${w.name} menang ${w.amt}${w.hand ? ' — ' + w.hand : ''}`));
  r.phase = 'showdown';
  r.next = setTimeout(() => startHand(r), +process.env.NEXT_MS || 6500);
  broadcast(r);
}
function removeLeavers(r) {
  let nd = -1; r.seats.forEach((s, i) => { if (!s.leaving && i <= r.dealer) nd++; });
  r.seats = r.seats.filter(s => !s.leaving); r.dealer = nd;
  if (!r.seats.length) { clearTimeout(r.timer); clearTimeout(r.next); rooms.delete(r.code); }
}
function leaveSeat(r, s) {
  s.leaving = true;
  if (inPlay(r) && s.inHand && !s.folded) {
    s.folded = true;
    if (r.seats[r.turn] === s) advance(r); else if (live(r).length === 1) endHand(r);
  }
  if (!inPlay(r) && r.phase !== 'showdown') removeLeavers(r);
  if (rooms.has(r.code)) broadcast(r);
}
const findSeat = pid => { for (const r of rooms.values()) { const s = r.seats.find(x => x.pid === pid); if (s) return [r, s]; } return []; };

// ---------- socket ----------
io.on('connection', sock => {
  const err = m => sock.emit('err', m);
  const guard = f => (...a) => { try { f(...a); } catch (e) { console.error(e); } };

  sock.on('join', guard(({ pid, name, code }) => {
    name = String(name || '').trim().slice(0, 14);
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    pid = String(pid || '').slice(0, 64);
    if (!pid) return;
    if (!name) return err('Isi nama dulu');
    if (code.length < 3) return err('Kode room minimal 3 huruf/angka');
    sock.pid = pid;
    const [or] = findSeat(pid);
    if (or && or.code !== code) return err('Kamu masih duduk di room ' + or.code + '. Keluar dulu.');
    let r = rooms.get(code);
    if (!r) { r = { code, seats: [], phase: 'waiting', board: [], pot: 0, currentBet: 0, minRaise: BB, turn: -1, dealer: -1, deadline: 0, log: [], result: null }; rooms.set(code, r); }
    const s = r.seats.find(x => x.pid === pid);
    if (s) { s.sid = sock.id; s.leaving = false; }
    else {
      if (r.seats.some(x => x.name.toLowerCase() === name.toLowerCase())) return err('Nama itu sudah dipakai di room ini');
      if (r.seats.length >= MAX_SEATS) return err('Meja penuh (max 8)');
      r.seats.push({ pid, name, sid: sock.id, stack: START, cards: [], bet: 0, total: 0, folded: true, allin: false, acted: false, inHand: false, show: false, leaving: false });
    }
    sock.emit('joined', code); broadcast(r);
  }));
  sock.on('start', guard(() => { const [r] = findSeat(sock.pid); if (r && r.phase === 'waiting') startHand(r); }));
  sock.on('rebuy', guard(() => {
    const [r, s] = findSeat(sock.pid); if (!r || s.stack > 0 || (s.inHand && inPlay(r))) return;
    s.stack = START; broadcast(r);
  }));
  sock.on('action', guard(({ type, amount }) => { const [r, s] = findSeat(sock.pid); if (r) act(r, s, type, amount); }));
  sock.on('leave', guard(() => { const [r, s] = findSeat(sock.pid); sock.emit('left'); if (r) { s.sid = null; leaveSeat(r, s); } }));
  sock.on('disconnect', guard(() => {
    const [r, s] = findSeat(sock.pid); if (!r || s.sid !== sock.id) return;
    s.sid = null; s.leaving = true;          // kalau balik (refresh) sebelum tangan habis, kursi tetap miliknya
    if (!inPlay(r) && r.phase !== 'showdown') removeLeavers(r);
    if (rooms.has(r.code)) broadcast(r);
  }));
});

server.listen(PORT, () => console.log(`Poker DC Lite jalan di http://localhost:${PORT}`));
