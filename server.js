// 1. Import các thư viện cần thiết
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require("socket.io");
const cors = require('cors');
const mysql = require('mysql2/promise');

// *** THÊM CÁC TRÌNH DEBUG ***
const debugServer = require('debug')('app:server');
const debugSocket = require('debug')('app:socket');
const debugDB = require('debug')('app:database');

// Database Configuration
const DB_CONFIG = {
  host: 'localhost',
  user: 'root', 
  password: '', // Thay đổi password nếu cần
  database: 'viegrand_app',
  port: 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

// Tạo connection pool
const dbPool = mysql.createPool(DB_CONFIG);

// 2. Khởi tạo
const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});
const PORT = process.env.PORT || 3000;

// 3. Phục vụ file index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Store connected users và rooms
const connectedUsers = new Map(); // socket.id -> {phone, name}
const userSockets = new Map(); // phone -> socket.id

// Helper Functions
async function searchUserByPhone(phone) {
  try {
    const [rows] = await dbPool.execute(
      'SELECT phone, userName as name, email FROM user WHERE phone LIKE ? LIMIT 10',
      [`%${phone}%`]
    );
    return rows;
  } catch (error) {
    debugDB('Error searching user:', error);
    return [];
  }
}

async function getConversationId(phone1, phone2) {
  const phones = [phone1, phone2].sort();
  return `${phones[0]}_${phones[1]}`;
}

async function saveMessage(fromPhone, toPhone, messageText, messageType = 'text') {
  try {
    const conversationId = await getConversationId(fromPhone, toPhone);
    
    const [result] = await dbPool.execute(
      'INSERT INTO messages (conversation_id, sender_phone, receiver_phone, message_text, message_type) VALUES (?, ?, ?, ?, ?)',
      [conversationId, fromPhone, toPhone, messageText, messageType]
    );
    
    // Update conversation
    await dbPool.execute(
      `INSERT INTO conversations (id, participant1_phone, participant2_phone, last_message_id, last_activity) 
       VALUES (?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE 
       last_message_id = VALUES(last_message_id),
       last_activity = VALUES(last_activity)`,
      [conversationId, fromPhone, toPhone, result.insertId]
    );
    
    return {
      id: result.insertId,
      conversation_id: conversationId,
      sender_phone: fromPhone,
      receiver_phone: toPhone,
      message_text: messageText,
      message_type: messageType,
      sent_at: new Date(),
      is_read: false
    };
  } catch (error) {
    debugDB('Error saving message:', error);
    throw error;
  }
}

async function getMessages(conversationId, limit = 50, offset = 0) {
  try {
    const [rows] = await dbPool.execute(
      `SELECT m.*, u.userName as sender_name 
       FROM messages m 
       LEFT JOIN user u ON m.sender_phone = u.phone 
       WHERE m.conversation_id = ? 
       ORDER BY m.sent_at DESC 
       LIMIT ? OFFSET ?`,
      [conversationId, limit, offset]
    );
    return rows.reverse(); // Reverse để tin nhắn cũ nhất ở trên
  } catch (error) {
    debugDB('Error getting messages:', error);
    return [];
  }
}

// 4. Lắng nghe các sự kiện của Socket.IO
io.on('connection', (socket) => {
  debugSocket(`Một người dùng đã kết nối: ${socket.id}`);

  // User join với phone number
  socket.on('user:join', async (data) => {
    const { phone, name } = data;
    debugSocket(`User join: ${phone} - ${name}`);
    
    // Lưu thông tin user
    connectedUsers.set(socket.id, { phone, name });
    userSockets.set(phone, socket.id);
    
    // Join personal room để nhận notifications
    socket.join(`user:${phone}`);
    
    socket.emit('user:joined', { success: true, phone, name });
  });

  // Search user by phone
  socket.on('user:search', async (data) => {
    const { query } = data;
    debugSocket(`Search query: ${query}`);
    
    try {
      const users = await searchUserByPhone(query);
      socket.emit('user:search_results', { success: true, users });
    } catch (error) {
      socket.emit('user:search_results', { success: false, error: error.message });
    }
  });

  // Join conversation room
  socket.on('room:join', async (data) => {
    const { otherPhone } = data;
    const currentUser = connectedUsers.get(socket.id);
    
    if (!currentUser) {
      socket.emit('room:error', { error: 'User not authenticated' });
      return;
    }

    const conversationId = await getConversationId(currentUser.phone, otherPhone);
    
    // Join room
    socket.join(conversationId);
    debugSocket(`${currentUser.phone} joined room: ${conversationId}`);
    
    // Load recent messages
    try {
      const messages = await getMessages(conversationId);
      socket.emit('room:joined', { 
        success: true, 
        conversationId, 
        messages,
        otherPhone 
      });
    } catch (error) {
      socket.emit('room:error', { error: error.message });
    }
  });

  // Leave room
  socket.on('room:leave', async (data) => {
    const { conversationId } = data;
    socket.leave(conversationId);
    debugSocket(`${socket.id} left room: ${conversationId}`);
  });

  // Send message
  socket.on('message:send', async (data) => {
    const { toPhone, messageText, messageType = 'text' } = data;
    const currentUser = connectedUsers.get(socket.id);
    
    if (!currentUser) {
      socket.emit('message:error', { error: 'User not authenticated' });
      return;
    }

    try {
      // Save message to database
      const savedMessage = await saveMessage(
        currentUser.phone, 
        toPhone, 
        messageText, 
        messageType
      );

      const conversationId = savedMessage.conversation_id;
      
      // Emit to conversation room
      io.to(conversationId).emit('message:received', {
        ...savedMessage,
        sender_name: currentUser.name
      });

      // Emit notification to receiver's personal room
      io.to(`user:${toPhone}`).emit('message:notification', {
        from: currentUser.phone,
        fromName: currentUser.name,
        messageText,
        conversationId
      });

      debugSocket(`Message sent from ${currentUser.phone} to ${toPhone}: ${messageText}`);
      
    } catch (error) {
      debugSocket('Error sending message:', error);
      socket.emit('message:error', { error: error.message });
    }
  });

  // Typing indicator
  socket.on('message:typing', (data) => {
    const { conversationId, isTyping } = data;
    const currentUser = connectedUsers.get(socket.id);
    
    if (currentUser) {
      socket.to(conversationId).emit('message:typing', {
        phone: currentUser.phone,
        name: currentUser.name,
        isTyping
      });
    }
  });

  // Mark messages as read
  socket.on('message:mark_read', async (data) => {
    const { conversationId } = data;
    const currentUser = connectedUsers.get(socket.id);
    
    if (!currentUser) return;

    try {
      await dbPool.execute(
        'UPDATE messages SET is_read = TRUE, read_at = NOW() WHERE conversation_id = ? AND receiver_phone = ? AND is_read = FALSE',
        [conversationId, currentUser.phone]
      );
      
      // Notify sender về read status
      socket.to(conversationId).emit('message:read', {
        conversationId,
        readBy: currentUser.phone
      });
      
    } catch (error) {
      debugDB('Error marking messages as read:', error);
    }
  });

  // Get conversation list
  socket.on('conversations:get', async () => {
    const currentUser = connectedUsers.get(socket.id);
    
    if (!currentUser) {
      socket.emit('conversations:error', { error: 'User not authenticated' });
      return;
    }

    try {
      const [conversations] = await dbPool.execute(
        `SELECT DISTINCT
           CASE 
             WHEN m.sender_phone = ? THEN m.receiver_phone 
             ELSE m.sender_phone 
           END as other_phone,
           u.userName as name,
           last_msg.message_text as last_message,
           last_msg.sent_at as last_message_time,
           COALESCE(unread.unread_count, 0) as unread_count
         FROM messages m
         LEFT JOIN user u ON (
           CASE 
             WHEN m.sender_phone = ? THEN m.receiver_phone 
             ELSE m.sender_phone 
           END = u.phone
         )
         LEFT JOIN (
           SELECT 
             conversation_id,
             message_text,
             sent_at,
             ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY sent_at DESC) as rn
           FROM messages
         ) last_msg ON m.conversation_id = last_msg.conversation_id AND last_msg.rn = 1
         LEFT JOIN (
           SELECT 
             conversation_id,
             COUNT(*) as unread_count
           FROM messages 
           WHERE receiver_phone = ? AND is_read = FALSE
           GROUP BY conversation_id
         ) unread ON m.conversation_id = unread.conversation_id
         WHERE (m.sender_phone = ? OR m.receiver_phone = ?)
         GROUP BY other_phone
         ORDER BY last_msg.sent_at DESC`,
        [currentUser.phone, currentUser.phone, currentUser.phone, currentUser.phone, currentUser.phone]
      );
      
      socket.emit('conversations:list', { success: true, conversations });
      
    } catch (error) {
      debugDB('Error getting conversations:', error);
      socket.emit('conversations:error', { error: error.message });
    }
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    const user = connectedUsers.get(socket.id);
    if (user) {
      userSockets.delete(user.phone);
      connectedUsers.delete(socket.id);
      debugSocket(`Người dùng đã ngắt kết nối: ${socket.id} (${user.phone})`);
    } else {
      debugSocket(`Người dùng đã ngắt kết nối: ${socket.id}`);
    }
  });
});

// 5. Khởi động server
server.listen(PORT, '0.0.0.0', () => {
  debugServer(`Server đang lắng nghe trên http://0.0.0.0:${PORT}`);
  debugServer('Bạn có thể truy cập từ các thiết bị khác trong cùng mạng!');
});