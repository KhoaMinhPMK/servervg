// 1. Import các thư viện cần thiết
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

// 2. Khởi tạo các biến
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000; // Sử dụng cổng 3000

// 3. Thiết lập một route cơ bản để kiểm tra server có hoạt động không
app.get('/', (req, res) => {
  res.send('<h1>Chat Server is running!</h1>');
});

// 4. Lắng nghe các sự kiện của Socket.IO
io.on('connection', (socket) => {
  console.log('Một người dùng đã kết nối:', socket.id);

  // Lắng nghe sự kiện khi người dùng ngắt kết nối
  socket.on('disconnect', () => {
    console.log('Người dùng đã ngắt kết nối:', socket.id);
  });

  // Lắng nghe sự kiện "chat message" từ client
  socket.on('chat message', (msg) => {
    console.log('Tin nhắn từ ' + socket.id + ': ' + msg);
    
    // Gửi tin nhắn đó đến tất cả các client khác (bao gồm cả người gửi)
    io.emit('chat message', msg);
  });
});

// 5. Khởi động server
server.listen(PORT, () => {
  console.log(`Server đang lắng nghe tại http://localhost:${PORT}`);
});