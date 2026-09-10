/**
 * server-fix-reference.js
 * ------------------------------------------------------------------
 * Đây là bản THAM KHẢO, không phải bản patch trực tiếp vào server thật
 * của bạn — vì mình chưa có source code của server / trang web chính
 * (nơi tạo mã QR). File này minh hoạ đúng 2 lỗi bạn mô tả (mục 1 và 2)
 * và cách sửa, khớp với các sự kiện Socket.io mà file client điện thoại
 * đang dùng (join-room, stroke, shape, text, clear, request-snapshot,
 * snapshot-response/snapshot).
 *
 * Nếu gửi mình file server thật (server.js/app.js) + đoạn code tạo QR
 * trên trang chính, mình có thể sửa trực tiếp thay vì đưa bản mẫu này.
 * ------------------------------------------------------------------
 */

const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

/* ============================================================
 * FIX #1 — Lấy địa chỉ IP LAN thật của máy tính
 * ============================================================
 * Trình duyệt (JS phía desktop) KHÔNG thể tự đọc IP LAN của máy vì lý
 * do bảo mật, nên việc này phải làm ở phía server bằng module `os`.
 *
 * Lưu ý quan trọng: nếu máy có nhiều card mạng ảo (VPN, VirtualBox,
 * Hyper-V, Docker...), os.networkInterfaces() có thể trả về nhiều địa
 * chỉ — và địa chỉ được chọn đầu tiên chưa chắc là card Wi-Fi/LAN thật
 * đang cùng mạng với điện thoại. Hàm dưới đây liệt kê TẤT CẢ ứng viên
 * và log ra console để bạn kiểm tra/tự chọn đúng cái nếu cần.
 */
function listLanIPv4Candidates() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      const isIPv4 = net.family === 'IPv4' || net.family === 4;
      if (isIPv4 && !net.internal) {
        candidates.push({ interface: name, address: net.address });
      }
    }
  }
  return candidates;
}

function pickLanIP() {
  const candidates = listLanIPv4Candidates();
  if (candidates.length === 0) return '127.0.0.1'; // fallback, sẽ không hoạt động qua LAN
  // Ưu tiên các adapter Wi-Fi/Ethernet phổ biến, tránh adapter ảo có tên gợi ý virtual/vpn.
  const preferred = candidates.find(c => !/vethernet|virtualbox|vmware|docker|tailscale|zerotier/i.test(c.interface));
  return (preferred || candidates[0]).address;
}

const LAN_IP = pickLanIP();

console.log('--- Các địa chỉ IP LAN tìm thấy trên máy này ---');
listLanIPv4Candidates().forEach(c => console.log(`  [${c.interface}] ${c.address}`));
console.log(`--- Đã chọn để tạo QR: ${LAN_IP} ---`);
console.log('Nếu đây KHÔNG phải card Wi-Fi/LAN thật đang cùng mạng với điện thoại,');
console.log('hãy đặt biến môi trường LAN_IP_OVERRIDE=<ip đúng> khi chạy server.');

const EFFECTIVE_LAN_IP = process.env.LAN_IP_OVERRIDE || LAN_IP;

/* ============================================================
 * FIX #2 — API cho trang desktop lấy đúng URL để tạo mã QR
 * ============================================================
 * Thay vì để JS phía trình duyệt tự ghép link bằng `location.host`
 * (sẽ bị sai thành "localhost:3000" nếu người dùng đang mở trang bằng
 * localhost), trang desktop nên GỌI API NÀY để lấy URL đúng rồi mới
 * vẽ mã QR từ URL đó.
 */
app.get('/api/phone-link', (req, res) => {
  const room = req.query.room || Math.random().toString(36).slice(2, 8);
  const url = `http://${EFFECTIVE_LAN_IP}:${PORT}/phone?room=${room}`;
  res.json({ room, url, lanIp: EFFECTIVE_LAN_IP, port: PORT });
});

// Phục vụ file tĩnh (trang desktop, trang phone, CSS/JS...)
app.use(express.static(path.join(__dirname, 'public')));

// Route phone client (đổi path cho khớp với cấu trúc thật của bạn)
app.get('/phone', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'writenote-phone-fixed.html'));
});

/* ============================================================
 * Socket.io — khớp với các sự kiện mà client điện thoại đã dùng
 * ============================================================ */
io.on('connection', (socket) => {
  socket.on('join-room', ({ room }) => {
    if (!room) return;
    socket.join(room);
    socket.data.room = room;
    // Xin snapshot hiện tại từ các client khác trong phòng để đồng bộ người mới vào
    socket.to(room).emit('request-snapshot', { forId: socket.id });
  });

  socket.on('snapshot-response', ({ forId, dataUrl }) => {
    io.to(forId).emit('snapshot', { dataUrl });
  });

  socket.on('stroke', (payload) => {
    if (!payload || !payload.room) return;
    socket.to(payload.room).emit('stroke', payload);
  });
  socket.on('shape', (payload) => {
    if (!payload || !payload.room) return;
    socket.to(payload.room).emit('shape', payload);
  });
  socket.on('text', (payload) => {
    if (!payload || !payload.room) return;
    socket.to(payload.room).emit('text', payload);
  });
  socket.on('clear', (payload) => {
    if (!payload || !payload.room) return;
    socket.to(payload.room).emit('clear', payload);
  });
});

/* ============================================================
 * FIX #1 (tiếp) — Bind ở 0.0.0.0, KHÔNG bind localhost/127.0.0.1
 * ============================================================
 * Đây là nguyên nhân phổ biến nhất khiến điện thoại không kết nối
 * được: nếu chỉ gọi server.listen(PORT) hoặc listen(PORT, 'localhost'),
 * trên một số hệ điều hành server sẽ CHỈ nhận kết nối từ chính máy đó,
 * chặn hết mọi request đến từ điện thoại trong cùng mạng LAN.
 */
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server đang chạy: http://${EFFECTIVE_LAN_IP}:${PORT}`);
  console.log(`(Trên máy tính có thể mở bằng http://localhost:${PORT} — nhưng mã QR PHẢI dùng IP LAN ở trên)`);
});

/**
 * Checklist debug nhanh nếu điện thoại vẫn không vào được:
 * 1. Firewall: Windows Firewall / macOS Firewall có thể chặn cổng PORT
 *    cho kết nối đến từ thiết bị khác — cần cho phép Node.js qua firewall.
 * 2. Cùng mạng: laptop và điện thoại phải cùng một Wi-Fi/LAN (không phải
 *    mạng "Guest" bị cô lập thiết bị, không phải điện thoại đang dùng 4G/5G).
 * 3. VPN: nếu máy tính đang bật VPN, os.networkInterfaces() có thể trả
 *    ưu tiên IP ảo của VPN thay vì IP Wi-Fi thật -> dùng LAN_IP_OVERRIDE.
 * 4. Mở thẳng URL trong biến EFFECTIVE_LAN_IP từ trình duyệt điện thoại
 *    (gõ tay) để tách biệt lỗi "QR sai" khỏi lỗi "server/mạng".
 */
