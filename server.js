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

// Lưu trữ map giữa user phone và socket id
const userSockets = {};

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
    console.log('🔍 Server received chat message (legacy):', msg);
    
    // Ngăn chặn broadcast toàn hệ thống để tránh rò tin nhắn giữa các hội thoại/người dùng
    // Chỉ chấp nhận kênh chính thức qua REST POST /send-message (đã có định tuyến người nhận)
    if (typeof msg === 'string') {
      // Trước đây: io.emit('chat message', msg)
      console.log('⏭️ Ignored legacy string message to avoid global broadcast');
      return;
    }

    // Nếu là object từ web test, cũng bỏ qua để không gửi nhầm
    // (kênh chính thức là /send-message từ PHP để đảm bảo có receiver_phone)
    console.log('⏭️ Ignored legacy object message; use /send-message instead');
    return;
  });

  // Event mới - Join conversation room
  socket.on('join conversation', (data) => {
    const { conversation_id } = data;
    if (conversation_id) {
      socket.join(conversation_id);
      debugSocket(`User ${socket.id} joined conversation: ${conversation_id}`);
      console.log('🔗 User joined conversation room:', conversation_id);
    }
  });

  // Event mới - Send message trong conversation
  socket.on('send message', (data) => {
    console.log('🔍 Server received send message data:', data);
    
    const { conversationId, senderPhone, receiverPhone, messageText, timestamp, messageType, fileUrl } = data;
    
    debugSocket(`Send message from ${senderPhone} to ${receiverPhone}:`, {
      conversationId,
      sender: senderPhone,
      receiver: receiverPhone,
      message: messageText,
      messageType,
      fileUrl
    });

    // Tạo tin nhắn để gửi
    const messageData = {
      conversationId,
      sender: senderPhone,
      receiver: receiverPhone,
      message: messageText,
      message_type: messageType || 'text',
      file_url: fileUrl || null,
      timestamp: timestamp || new Date().toISOString()
    };

    // Gửi tin nhắn trực tiếp đến receiver
    const receiverSocketId = userSockets[receiverPhone];
    console.log('🔍 Looking for receiver:', receiverPhone);
    console.log('📋 Available users:', Object.keys(userSockets));
    
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('chat message', messageData);
      debugSocket(`Message sent to ${receiverPhone} (socket: ${receiverSocketId})`);
      console.log('✅ Message sent to receiver');
    } else {
      debugSocket(`Receiver ${receiverPhone} not found in userSockets`);
      console.log('❌ Receiver not found in userSockets');
    }

    // Không emit cho conversation room để tránh duplicate
    // Chỉ gửi trực tiếp đến receiver
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

// 5. Endpoint upload ảnh chat (multipart)
app.post('/upload/chat-image', chatUpload.single('image'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image uploaded' });
    }

    // Build public URL
    const fileUrl = `${req.protocol}://${req.get('host')}/uploads/chat/${req.file.filename}`;

    return res.json({
      success: true,
      data: {
        url: fileUrl,
        filename: req.file.originalname,
        size: req.file.size,
        mimeType: req.file.mimetype,
      }
    });
  } catch (err) {
    console.error('❌ Upload chat image error:', err);
    return res.status(500).json({ success: false, message: 'Upload failed' });
  }
});

// 5. Endpoint để PHP gửi tin nhắn đến socket server
app.post('/send-message', (req, res) => {
  const { sender_phone, receiver_phone, message_text, conversation_id, message_id, timestamp, secret, message_type, file_url } = req.body;

  debugServer('Nhận được yêu cầu gửi tin nhắn:', req.body);

  // Bảo mật cơ bản
  if (secret !== NOTIFY_SECRET) {
    debugServer('Lỗi: Sai secret key.');
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }

  if (!sender_phone || !receiver_phone || (!message_text && !file_url)) {
    debugServer('Lỗi: Thiếu thông tin tin nhắn.');
    return res.status(400).json({ success: false, error: 'Missing message information' });
  }

  // Tạo tin nhắn để gửi qua socket
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

  // Gửi tin nhắn đến receiver qua socket
  const receiverSocketId = userSockets[receiver_phone];
  if (receiverSocketId) {
    io.to(receiverSocketId).emit('chat message', messageData);
    debugServer(`📱 Tin nhắn real-time đã gửi cho ${receiver_phone} (socket: ${receiverSocketId})`);
    res.json({ success: true, message: `Message sent to ${receiver_phone}`, delivered: true });
  } else {
    debugServer(`💾 User ${receiver_phone} offline, tin nhắn đã lưu DB để xem sau`);
    res.json({ success: true, message: `User ${receiver_phone} offline, message stored`, delivered: false });
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
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
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