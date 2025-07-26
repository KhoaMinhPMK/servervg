// 1. Import các thư viện cần thiết
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require("socket.io");
const cors = require('cors'); // *** THÊM DÒNG NÀY ***

// 2. Khởi tạo
const app = express();

// *** SỬ DỤNG CORS CHO EXPRESS ***
// Cho phép tất cả các request HTTP từ mọi nguồn
app.use(cors());

const server = http.createServer(app);

// *** CẤU HÌNH CORS CHO SOCKET.IO ***
const io = new Server(server, {
  cors: {
    origin: "*", // Cho phép kết nối từ mọi nguồn
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// 3. Phục vụ file index.html
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

// 5. Khởi động server
// *** LẮNG NGHE TRÊN 0.0.0.0 ***
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server đang lắng nghe trên http://0.0.0.0:${PORT}`);
  console.log('Bạn có thể truy cập từ các thiết bị khác trong cùng mạng!');
});