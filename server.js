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
// Tăng limit cho JSON body để xử lý ảnh base64 lớn
app.use(express.json({ limit: '10mb' })); // <-- Tăng limit lên 10MB

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const NOTIFY_SECRET = 'viegrand_super_secret_key_for_php_2025'; // <-- Secret key để PHP gọi

// Lưu trữ map giữa user phone và DANH SÁCH socket id (đa thiết bị/đa kết nối)
// Map<string, Set<string>>
const userSockets = new Map();

function addUserSocket(phone, socketId) {
  if (!phone || !socketId) return;
  const key = String(phone);
  if (!userSockets.has(key)) userSockets.set(key, new Set());
  userSockets.get(key).add(socketId);
  debugSocket(`➕ Mapped phone ${key} -> socket ${socketId}. Total sockets: ${userSockets.get(key).size}`);
}

function removeUserSocketById(socketId) {
  for (const [phone, socketSet] of userSockets.entries()) {
    if (socketSet.has(socketId)) {
      socketSet.delete(socketId);
      debugSocket(`➖ Removed socket ${socketId} from phone ${phone}. Remaining: ${socketSet.size}`);
      if (socketSet.size === 0) {
        userSockets.delete(phone);
        debugSocket(`🗑️ No sockets left for ${phone}, deleted mapping`);
      }
      return phone;
    }
  }
  return null;
}

function getSocketIdsForPhone(phone) {
  const set = userSockets.get(String(phone));
  return set ? Array.from(set) : [];
}

function dumpUserSockets() {
  const obj = {};
  for (const [phone, set] of userSockets.entries()) obj[phone] = Array.from(set);
  return obj;
}

// Ensure uploads directories exist
const fs = require('fs');
const uploadsRoot = path.join(__dirname, 'uploads');
const chatUploadsDir = path.join(uploadsRoot, 'chat');
try {
  if (!fs.existsSync(uploadsRoot)) fs.mkdirSync(uploadsRoot, { recursive: true });
  if (!fs.existsSync(chatUploadsDir)) fs.mkdirSync(chatUploadsDir, { recursive: true });
} catch (e) {
  debugServer('Failed to ensure upload directories:', e);
}

// Serve static uploads
app.use('/uploads', express.static(uploadsRoot));

// Multer for uploads
const multer = require('multer');
const chatStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, chatUploadsDir);
  },
  filename: function (req, file, cb) {
    const ext = (file.mimetype && file.mimetype.split('/')[1]) || 'jpg';
    const safeExt = ext.split('?')[0].split(';')[0];
    const random = Math.random().toString(36).slice(2, 10);
    cb(null, `chat_${Date.now()}_${random}.${safeExt}`);
  }
});

function imageFileFilter(req, file, cb) {
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (allowed.includes(file.mimetype)) cb(null, true);
  else cb(new Error('Unsupported file type'), false);
}

const chatUpload = multer({
  storage: chatStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: imageFileFilter,
});

// 3. Lắng nghe các sự kiện của Socket.IO
io.on('connection', (socket) => {
  debugSocket(`Một người dùng đã kết nối: ${socket.id}`);

  // Auto-register qua handshake auth hoặc query (?phone=...)
  try {
    const phoneFromAuth = socket.handshake?.auth?.phone;
    const phoneFromQuery = socket.handshake?.query?.phone;
    const initialPhone = phoneFromAuth || phoneFromQuery;
    if (initialPhone) {
      addUserSocket(initialPhone, socket.id);
      console.log('📋 Current userSockets:', dumpUserSockets());
    }
  } catch (e) {
    debugSocket('Handshake parse error:', e);
  }

  // Sự kiện đăng ký user với SĐT (backward compatibility)
  socket.on('register', (phone) => {
    console.log('🔍 Server received register:', phone, typeof phone);
    const phoneNumber = typeof phone === 'object' ? phone?.phone : phone;
    if (phoneNumber) {
      addUserSocket(phoneNumber, socket.id);
      console.log('📋 Current userSockets:', dumpUserSockets());
    }
  });
  
  socket.on('disconnect', () => {
    const phone = removeUserSocketById(socket.id);
    debugSocket(`Người dùng ngắt kết nối: ${socket.id}${phone ? ` (phone ${phone})` : ''}`);
  });

  // Event cũ - giữ lại để tương thích
  socket.on('chat message', (msg) => {
    console.log('🔍 Server received chat message:', msg);
    if (typeof msg === 'string') {
      debugSocket(`Tin nhắn từ ${socket.id}: ${msg}`);
      io.emit('chat message', msg);
    } else {
      const { sender, message, timestamp, message_type, file_url } = msg;
      debugSocket(`Tin nhắn từ ${sender}: ${message}`);
      const appSocketIds = getSocketIdsForPhone('0000000001');
      if (appSocketIds.length > 0) {
        const messageData = {
          conversationId: 'conv_1fd7e09c6c647f98a9aaabed96b60327',
          sender: sender,
          receiver: '0000000001',
          message: message,
          message_type: message_type || 'text',
          file_url: file_url || null,
          timestamp: timestamp
        };
        appSocketIds.forEach(id => io.to(id).emit('chat message', messageData));
      }
    }
  });

  // Event mới - Join conversation room
  socket.on('join conversation', (data) => {
    const { conversation_id } = data || {};
    if (conversation_id) {
      socket.join(conversation_id);
      debugSocket(`User ${socket.id} joined conversation: ${conversation_id}`);
    }
  });

  // Event mới - Send message trong conversation
  socket.on('send message', (data) => {
    console.log('🔍 Server received send message data:', data);
    const { conversationId, senderPhone, receiverPhone, messageText, timestamp, messageType, fileUrl } = data || {};
    const messageData = {
      conversationId,
      sender: senderPhone,
      receiver: receiverPhone,
      message: messageText,
      message_type: messageType || 'text',
      file_url: fileUrl || null,
      timestamp: timestamp || new Date().toISOString()
    };

    const receiverSocketIds = getSocketIdsForPhone(receiverPhone);
    console.log('🔍 Looking for receiver:', receiverPhone, '->', receiverSocketIds);
    if (receiverSocketIds.length > 0) {
      receiverSocketIds.forEach(id => io.to(id).emit('chat message', messageData));
      debugSocket(`Message sent to ${receiverPhone} (sockets: ${receiverSocketIds.join(',')})`);
    } else {
      debugSocket(`Receiver ${receiverPhone} not found in userSockets`);
    }
  });

  // Event mới - Mark message as read
  socket.on('mark message read', (data) => {
    const { conversation_id, message_id, user_phone } = data || {};
    debugSocket(`Mark message as read:`, { conversation_id, message_id, user_phone });
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
  if (secret !== NOTIFY_SECRET) return res.status(403).json({ success: false, error: 'Forbidden' });
  if (!to_phone || !payload) return res.status(400).json({ success: false, error: 'Missing to_phone or payload' });
  const socketIds = getSocketIdsForPhone(to_phone);
  if (socketIds.length > 0) {
    socketIds.forEach(id => io.to(id).emit('notification', payload));
    debugServer(`📱 Thông báo đã gửi cho ${to_phone} (sockets: ${socketIds.join(',')})`);
    res.json({ success: true, delivered: true });
  } else {
    debugServer(`💾 User ${to_phone} offline, stored`);
    res.json({ success: true, delivered: false });
  }
});

// 5. Endpoint upload ảnh chat (multipart)
app.post('/upload/chat-image', chatUpload.single('image'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No image uploaded' });
    const fileUrl = `${req.protocol}://${req.get('host')}/uploads/chat/${req.file.filename}`;
    return res.json({ success: true, data: { url: fileUrl, filename: req.file.originalname, size: req.file.size, mimeType: req.file.mimetype }});
  } catch (err) {
    console.error('❌ Upload chat image error:', err);
    return res.status(500).json({ success: false, message: 'Upload failed' });
  }
});

// 5. Endpoint để PHP gửi tin nhắn đến socket server
app.post('/send-message', (req, res) => {
  const { sender_phone, receiver_phone, message_text, conversation_id, message_id, timestamp, secret, message_type, file_url } = req.body || {};
  debugServer('Nhận được yêu cầu gửi tin nhắn:', req.body);
  if (secret !== NOTIFY_SECRET) return res.status(403).json({ success: false, error: 'Forbidden' });
  if (!sender_phone || !receiver_phone || (!message_text && !file_url)) return res.status(400).json({ success: false, error: 'Missing message information' });

  const messageData = {
    conversationId: conversation_id,
    sender: sender_phone,
    receiver: receiver_phone,
    message: message_text || '',
    message_type: message_type || (file_url ? 'image' : 'text'),
    file_url: file_url || null,
    messageId: message_id,
    timestamp: timestamp || new Date().toISOString()
  };

  const receiverSocketIds = getSocketIdsForPhone(receiver_phone);
  if (receiverSocketIds.length > 0) {
    receiverSocketIds.forEach(id => io.to(id).emit('chat message', messageData));
    debugServer(`📱 Tin nhắn real-time đã gửi cho ${receiver_phone} (sockets: ${receiverSocketIds.join(',')})`);
    res.json({ success: true, delivered: true });
  } else {
    debugServer(`💾 User ${receiver_phone} offline, stored`);
    res.json({ success: true, delivered: false });
  }
});

// 5. Phục vụ file index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 7. Serve Groq image+prompt chat page
app.get('/groq-image-chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'groq-image-chat.html'));
});

// 8. API endpoint for Groq image+prompt chat (FormData for web)
const upload = multer({ 
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 }
});
const fsGroq = require('fs');
const Groq = require('groq-sdk');

app.post('/api/groq-image-chat', upload.single('image'), async (req, res) => {
  try {
    console.log('🔍 Received Groq image chat request (FormData)');
    console.log('📋 Request body:', req.body);
    console.log('📁 Uploaded file:', req.file);
    
    const prompt = req.body.prompt;
    const imageFile = req.file;
    const apiKey = req.body.apiKey;
    
    console.log('✅ Prompt:', prompt);
    console.log('✅ API Key length:', apiKey ? apiKey.length : 0);
    console.log('✅ Image file:', imageFile ? 'Present' : 'Missing');
    
    if (!imageFile || !apiKey) {
      console.log('❌ Validation failed - missing required fields');
      return res.status(400).json({ error: 'Missing image or API key' });
    }
    
    // Validate API key format
    if (!apiKey.startsWith('gsk_')) {
      console.log('❌ Invalid API key format - should start with gsk_');
      return res.status(400).json({ error: 'Invalid API key format. Should start with gsk_' });
    }
    
    console.log('🔄 Converting image to base64...');
    // Convert image to base64 URL
    const imageBuffer = fsGroq.readFileSync(imageFile.path);
    const base64 = imageBuffer.toString('base64');
    const mimeType = imageFile.mimetype;
    const imageUrl = `data:${mimeType};base64,${base64}`;
    console.log('✅ Image converted, size:', imageBuffer.length, 'bytes');

    console.log('🔑 Creating Groq client...');
    // Create Groq client with user's API key
    const groq = new Groq({ apiKey: apiKey });
    console.log('✅ Groq client created');

    console.log('🚀 Calling Groq API...');
    // Call Groq API
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Liệt kê các chỉ số trong máy đo huyết áp/nhịp tim. Trả về kết quả dưới dạng JSON với format chính xác như sau:\n{\n  "huyet_ap_tam_thu": "số lượng mmHg",\n  "huyet_ap_tam_truong": "số lượng mmHg",\n  "nhip_tim": "số lượng bpm"\n}\n\nChỉ trả về JSON, không có text khác.' },
            { type: 'image_url', image_url: { url: imageUrl } }
          ]
        }
      ],
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      temperature: 0.1,
      max_completion_tokens: 1024,
      top_p: 1,
      stream: false,
      stop: null
    });
    console.log('✅ Groq API response received');
    
    // Clean up uploaded file
    fsGroq.unlinkSync(imageFile.path);
    console.log('✅ File cleaned up');
    
    // Parse JSON response
    try {
      const jsonResponse = JSON.parse(chatCompletion.choices[0].message.content);
      console.log('✅ Parsed JSON response:', jsonResponse);
      res.json({ 
        success: true,
        data: jsonResponse,
        raw: chatCompletion.choices[0].message.content 
      });
    } catch (parseError) {
      console.log('⚠️ Failed to parse JSON, returning raw response');
      res.json({ 
        success: false,
        raw: chatCompletion.choices[0].message.content,
        error: 'Could not parse JSON response'
      });
    }
  } catch (err) {
    console.error('❌ Groq image chat error:', err);
    console.error('❌ Error stack:', err.stack);
    
    // Handle specific Groq API errors
    if (err.status === 401) {
      return res.status(401).json({ 
        error: 'Invalid API key. Please check your Groq API key.',
        details: 'Make sure your API key is correct and has sufficient credits.'
      });
    } else if (err.status === 429) {
      return res.status(429).json({ 
        error: 'Rate limit exceeded. Please try again later.',
        details: 'You have exceeded the API rate limit.'
      });
    } else if (err.status === 400) {
      return res.status(400).json({ 
        error: 'Bad request to Groq API.',
        details: err.message
      });
    }
    
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// 9. API endpoint for React Native app (JSON with base64)
app.post('/api/groq-image-chat-json', async (req, res) => {
  try {
    console.log('🔍 Received Groq image chat request (JSON)');
    console.log('📋 Request body keys:', Object.keys(req.body));
    
    const { apiKey, image: base64Image } = req.body;
    
    console.log('✅ API Key length:', apiKey ? apiKey.length : 0);
    console.log('✅ Base64 image length:', base64Image ? base64Image.length : 0);
    
    if (!base64Image || !apiKey) {
      console.log('❌ Validation failed - missing required fields');
      return res.status(400).json({ error: 'Missing image or API key' });
    }
    
    // Validate API key format
    if (!apiKey.startsWith('gsk_')) {
      console.log('❌ Invalid API key format - should start with gsk_');
      return res.status(400).json({ error: 'Invalid API key format. Should start with gsk_' });
    }
    
    console.log('🔄 Using base64 image directly...');
    const imageUrl = `data:image/jpeg;base64,${base64Image}`;
    console.log('✅ Image URL created, size:', base64Image.length, 'bytes');

    console.log('🔑 Creating Groq client...');
    // Create Groq client with user's API key
    const groq = new Groq({ apiKey: apiKey });
    console.log('✅ Groq client created');

    console.log('🚀 Calling Groq API...');
    // Call Groq API
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Liệt kê các chỉ số trong máy đo huyết áp/nhịp tim. Trả về kết quả dưới dạng JSON với format chính xác như sau:\n{\n  "huyet_ap_tam_thu": "số lượng mmHg",\n  "huyet_ap_tam_truong": "số lượng mmHg",\n  "nhip_tim": "số lượng bpm"\n}\n\nChỉ trả về JSON, không có text khác.' },
            { type: 'image_url', image_url: { url: imageUrl } }
          ]
        }
      ],
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      temperature: 0.1,
      max_completion_tokens: 1024,
      top_p: 1,
      stream: false,
      stop: null
    });
    console.log('✅ Groq API response received');
    
    // Parse JSON response
    try {
      const jsonResponse = JSON.parse(chatCompletion.choices[0].message.content);
      console.log('✅ Parsed JSON response:', jsonResponse);
      res.json({ 
        success: true,
        data: jsonResponse,
        raw: chatCompletion.choices[0].message.content 
      });
    } catch (parseError) {
      console.log('⚠️ Failed to parse JSON, returning raw response');
      res.json({ 
        success: false,
        raw: chatCompletion.choices[0].message.content,
        error: 'Could not parse JSON response'
      });
    }
  } catch (err) {
    console.error('❌ Groq image chat error:', err);
    console.error('❌ Error stack:', err.stack);
    
    // Handle specific Groq API errors
    if (err.status === 401) {
      return res.status(401).json({ 
        error: 'Invalid API key. Please check your Groq API key.',
        details: 'Make sure your API key is correct and has sufficient credits.'
      });
    } else if (err.status === 429) {
      return res.status(429).json({ 
        error: 'Rate limit exceeded. Please try again later.',
        details: 'You have exceeded the API rate limit.'
      });
    } else if (err.status === 400) {
      return res.status(400).json({ 
        error: 'Bad request to Groq API.',
        details: err.message
      });
    }
    
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// 9. GPT-OSS Ollama Integration
app.post('/api/gpt-oss-chat', async (req, res) => {
  try {
    console.log('🔍 Received GPT-OSS chat request');
    const { message, system_prompt } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Missing message' });
    }
    
    console.log('💬 Message:', message);
    console.log('🎯 System prompt:', system_prompt || 'Default');
    
    // Call GPT-OSS Ollama server
    const response = await fetch('http://localhost:8888/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: message,
        system_prompt: system_prompt || "Bạn là trợ lý AI thông minh, trả lời bằng tiếng Việt."
      })
    });
    
    if (!response.ok) {
      throw new Error(`GPT-OSS server error: ${response.status}`);
    }
    
    const result = await response.json();
    console.log('✅ GPT-OSS response received');
    
    res.json({
      success: true,
      response: result.response,
      model: result.model || 'gpt-oss:20b',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ GPT-OSS chat error:', error);
    res.status(500).json({
      error: 'Failed to get response from GPT-OSS',
      details: error.message
    });
  }
});

// 6. Khởi động server
server.listen(PORT, '0.0.0.0', () => {
  debugServer(`Server đang lắng nghe trên http://0.0.0.0:${PORT}`);
  debugServer('Bạn có thể truy cập từ các thiết bị khác trong cùng mạng!');
});



// tốt rồi nó đã hoạt động, bây giờ chỉ trao đổi thôi, không code, hãy cho tôi biết tôi muốn theo kiểu nhắn qua, cho dù người kia đang không online thì khi họ mở lên họ vẫn xem được thì làm như nào, tức là bổ sung thêm chứ không phải thayu thế chức năng nha