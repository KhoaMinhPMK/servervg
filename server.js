// 1. Import các thư viện cần thiết
const express = require('express');
const http = require('http');
const path = require('path'); // Thêm thư viện path
const { Server } = require("socket.io");

// 2. Khởi tạo các biến
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// 3. CẬP NHẬT: Phục vụ file index.html khi truy cập vào route gốc
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 4. Lắng nghe các sự kiện của Socket.IO (giữ nguyên)
io.on('connection', (socket) => {
  console.log('Một người dùng đã kết nối:', socket.id);

  socket.on('disconnect', () => {
    console.log('Người dùng đã ngắt kết nối:', socket.id);
  });

  socket.on('chat message', (msg) => {
    console.log('Tin nhắn từ ' + socket.id + ': ' + msg);
    io.emit('chat message', msg);
  });
});

// 5. Khởi động server (giữ nguyên)
server.listen(PORT, () => {
  console.log(`Server đang lắng nghe tại http://localhost:${PORT}`);
});