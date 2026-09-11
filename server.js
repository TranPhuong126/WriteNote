const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Chỉ phục vụ công khai thư mục public/ — KHÔNG phục vụ __dirname (root), vì
// root còn chứa server.js/package.json/.env... để lộ mã nguồn/thiết lập server
// ra internet là không an toàn khi đã deploy lên domain công khai (Render).
app.use(express.static(path.join(__dirname, 'public')));

// Liệt kê tất cả IPv4 LAN khả dụng (loại bỏ địa chỉ nội bộ 127.0.0.1)
function listLanIPv4Candidates() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      const isIPv4 = net.family === 'IPv4' || net.family === 4;
      if (isIPv4 && !net.internal) {
        candidates.push({ interface: name, address: net.address });
      }
    }
  }
  return candidates;
}

// Chọn IP LAN "thật" (Wi-Fi/Ethernet), tránh card ảo (VPN/Docker/VirtualBox...)
// vì nếu chọn nhầm, điện thoại quét QR xong sẽ không kết nối được.
function pickLanIP() {
  if (process.env.LAN_IP_OVERRIDE) return process.env.LAN_IP_OVERRIDE;
  const candidates = listLanIPv4Candidates();
  if (candidates.length === 0) return null;
  const preferred = candidates.find(
    c => !/vethernet|virtualbox|vmware|docker|tailscale|zerotier|tun|tap/i.test(c.interface)
  );
  return (preferred || candidates[0]).address;
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'writenote.html'));
});

// Trang điện thoại: dùng chung 1 file cho cả /mobile và /mobile.html
// (QR trên writenote.html trỏ thẳng tới "/mobile.html?room=..."), để điện
// thoại luôn tải được đúng trang vẽ, không bị 404.
app.get(['/mobile', '/mobile.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'writenote-phone-fixed.html'));
});

app.get('/network-address', (req, res) => {
  const address = pickLanIP();
  res.json({ address: address || req.hostname, port: PORT });
});

// room -> Set of socket ids currently viewing/editing that note page
const roomMembers = new Map();

io.on('connection', (socket) => {
  let joinedRoom = null;

  socket.on('join-room', ({ room }) => {
    if (!room) return;
    joinedRoom = room;
    socket.join(room);

    if (!roomMembers.has(room)) roomMembers.set(room, new Set());
    const members = roomMembers.get(room);
    const existingPeer = [...members][0];
    members.add(socket.id);

    socket.to(room).emit('peer-joined', { id: socket.id, count: members.size });

    // Ask an existing member to send the newcomer a full snapshot of the page
    if (existingPeer) {
      io.to(existingPeer).emit('request-snapshot', { forId: socket.id });
    }
  });

  socket.on('snapshot-response', ({ forId, dataUrl }) => {
    if (forId) io.to(forId).emit('snapshot', { dataUrl });
  });

  socket.on('stroke', (payload) => {
    if (joinedRoom) socket.to(joinedRoom).emit('stroke', payload);
  });

  socket.on('shape', (payload) => {
    if (joinedRoom) socket.to(joinedRoom).emit('shape', payload);
  });

  socket.on('text', (payload) => {
    if (joinedRoom) socket.to(joinedRoom).emit('text', payload);
  });

  socket.on('clear', (payload) => {
    if (joinedRoom) socket.to(joinedRoom).emit('clear', payload);
  });

  socket.on('disconnect', () => {
    if (joinedRoom && roomMembers.has(joinedRoom)) {
      const members = roomMembers.get(joinedRoom);
      members.delete(socket.id);
      socket.to(joinedRoom).emit('peer-left', { id: socket.id, count: members.size });
      if (members.size === 0) roomMembers.delete(joinedRoom);
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  const lanAddress = pickLanIP() || 'localhost';
  console.log(`WriteNote realtime server dang chay tai cong ${PORT}`);
  console.log(`Mobile LAN: http://${lanAddress}:${PORT}/mobile.html?room=<room-id>`);
  if (!process.env.LAN_IP_OVERRIDE) {
    const candidates = listLanIPv4Candidates();
    if (candidates.length > 1) {
      console.log('Cac IP LAN khac tim thay (neu chon nham, dat bien moi truong LAN_IP_OVERRIDE=<ip dung>):');
      candidates.forEach(c => console.log(`  [${c.interface}] ${c.address}`));
    }
  }
});