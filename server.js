// 1. Import các thư viện cần thiết
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require("socket.io");
const cors = require('cors');

// *** THÊM CÁC TRÌNH DEBUG ***
const debugServer = require('debug')('app:server');
const debugSocket = require('debug')('app:socket');

// 2. Khởi tạo
const app = express();
app.use(cors());
app.use(express.json()); // <-- Thêm middleware để parse JSON body từ PHP

// Thêm route để test server
app.get('/', (req, res) => {
  res.send('Viegrand Chat Server is running!');
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    connectedUsers: Object.keys(userSockets).length
  });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  allowEIO3: true,
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;
const NOTIFY_SECRET = 'viegrand_super_secret_key_for_php_2025'; // <-- Secret key để PHP gọi

// Lưu trữ map giữa user phone và socket id
const userSockets = {};

// 3. Lắng nghe các sự kiện của Socket.IO
io.on('connection', (socket) => {
  debugSocket(`Một người dùng đã kết nối: ${socket.id}`);

  // Sự kiện đăng ký user với SĐT
  socket.on('register', (phone) => {
    console.log('🔍 Server received register:', phone, typeof phone);
    
    if (phone) {
      // Xử lý cả object và string
      const phoneNumber = typeof phone === 'object' ? phone.phone : phone;
      
      if (phoneNumber) {
        userSockets[phoneNumber] = socket.id;
        debugSocket(`Người dùng với SĐT ${phoneNumber} đã đăng ký với socket id ${socket.id}`);
        console.log('📋 Current userSockets:', userSockets);
      }
    }
  });

  socket.on('disconnect', () => {
    // Xóa user khỏi map khi họ ngắt kết nối
    for (const phone in userSockets) {
      if (userSockets[phone] === socket.id) {
        delete userSockets[phone];
        debugSocket(`Người dùng với SĐT ${phone} đã ngắt kết nối: ${socket.id}`);
        break;
      }
    }
  });

  // Event cũ - giữ lại để tương thích
  socket.on('chat message', (msg) => {
    console.log('🔍 Server received chat message:', msg);
    
    if (typeof msg === 'string') {
      // Tin nhắn đơn giản
      debugSocket(`Tin nhắn từ ${socket.id}: ${msg}`);
      io.emit('chat message', msg);
    } else {
      // Tin nhắn có cấu trúc từ web
      const { sender, message, timestamp } = msg;
      debugSocket(`Tin nhắn từ ${sender}: ${message}`);
      
      // Gửi tin nhắn đến app (0000000001)
      const appSocketId = userSockets['0000000001'];
      if (appSocketId) {
        const messageData = {
          conversationId: 'conv_1fd7e09c6c647f98a9aaabed96b60327',
          sender: sender,
          receiver: '0000000001',
          message: message,
          messageText: message, // Thêm field này cho app
          timestamp: timestamp
        };
        
        io.to(appSocketId).emit('chat message', messageData);
        console.log('✅ Message sent from web to app with format:', messageData);
      }
    }
  });

  // Event mới - Join conversation room
  socket.on('join conversation', (data) => {
    const { conversation_id } = data;
    if (conversation_id) {
      socket.join(conversation_id);
      debugSocket(`User ${socket.id} joined conversation: ${conversation_id}`);
    }
  });

  // Heartbeat để giữ kết nối
  socket.on('heartbeat', (data) => {
    const { phone } = data;
    if (phone && userSockets[phone] === socket.id) {
      console.log(`💓 Heartbeat from ${phone}`);
      socket.emit('heartbeat_ack', { timestamp: Date.now() });
    }
  });

  // Event mới - Send message trong conversation
  socket.on('send message', (data) => {
    console.log('🔍 Server received send message data:', data);
    
    const { conversationId, senderPhone, receiverPhone, messageText, timestamp } = data;
    
    debugSocket(`Send message from ${senderPhone} to ${receiverPhone}:`, {
      conversationId,
      sender: senderPhone,
      receiver: receiverPhone,
      message: messageText
    });

    // Tạo tin nhắn để gửi
    const messageData = {
      conversationId,
      sender: senderPhone,
      receiver: receiverPhone,
      message: messageText,
      timestamp: timestamp || new Date().toISOString()
    };

    // Gửi tin nhắn trực tiếp đến receiver
    const receiverSocketId = userSockets[receiverPhone];
    console.log('🔍 Looking for receiver:', receiverPhone);
    console.log('📋 Available users:', Object.keys(userSockets));
    
    if (receiverSocketId) {
      // Gửi với format đơn giản cho web
      const simpleMessage = {
        sender: senderPhone,
        message: messageText,
        timestamp: timestamp || new Date().toISOString()
      };
      
      io.to(receiverSocketId).emit('chat message', simpleMessage);
      debugSocket(`Message sent to ${receiverPhone} (socket: ${receiverSocketId})`);
      console.log('✅ Message sent to receiver with format:', simpleMessage);
    } else {
      debugSocket(`Receiver ${receiverPhone} not found in userSockets`);
      console.log('❌ Receiver not found in userSockets');
    }

    // Cũng emit cho conversation room nếu có
    if (conversationId) {
      socket.to(conversationId).emit('chat message', messageData);
      debugSocket(`Message also sent to conversation room: ${conversationId}`);
    }
  });

  // Event mới - Mark message as read
  socket.on('mark message read', (data) => {
    const { conversation_id, message_id, user_phone } = data;
    
    debugSocket(`Mark message as read:`, {
      conversation_id,
      message_id,
      user_phone
    });

    // Emit cho tất cả người trong conversation
    socket.to(conversation_id).emit('message read', {
      conversation_id,
      message_id,
      read_by: user_phone,
      read_at: new Date().toISOString()
    });
  });
});

// 4. Endpoint để PHP gọi đến và kích hoạt thông báo
app.post('/notify', (req, res) => {
  const { to_phone, payload, secret } = req.body;

  debugServer('Nhận được yêu cầu thông báo:', req.body);

  // Bảo mật cơ bản
  if (secret !== NOTIFY_SECRET) {
    debugServer('Lỗi: Sai secret key.');
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }

  if (!to_phone || !payload) {
    debugServer('Lỗi: Thiếu to_phone hoặc payload.');
    return res.status(400).json({ success: false, error: 'Missing to_phone or payload' });
  }

  const socketId = userSockets[to_phone];
  if (socketId) {
    io.to(socketId).emit('notification', payload);
    debugServer(`📱 Thông báo real-time đã gửi cho ${to_phone} (socket: ${socketId})`);
    res.json({ success: true, message: `Notification sent to ${to_phone}`, delivered: true });
  } else {
    debugServer(`💾 User ${to_phone} offline, thông báo đã lưu DB để xem sau`);
    res.json({ success: true, message: `User ${to_phone} offline, notification stored`, delivered: false });
  }
});

// 5. Phục vụ file index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 6. Khởi động server
server.listen(PORT, '0.0.0.0', () => {
  debugServer(`Server đang lắng nghe trên http://0.0.0.0:${PORT}`);
  debugServer('Bạn có thể truy cập từ các thiết bị khác trong cùng mạng!');
});