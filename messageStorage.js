const fs = require('fs');
const path = require('path');

const MESSAGES_FILE = path.join(__dirname, 'messages.json');
const CONVERSATIONS_FILE = path.join(__dirname, 'conversations.json');

// Khởi tạo file nếu chưa có
function initializeFiles() {
  if (!fs.existsSync(MESSAGES_FILE)) {
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify([], null, 2));
  }
  if (!fs.existsSync(CONVERSATIONS_FILE)) {
    fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify([], null, 2));
  }
}

// Đọc tin nhắn từ file
function readMessages() {
  try {
    const data = fs.readFileSync(MESSAGES_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('❌ Error reading messages file:', error);
    return [];
  }
}

// Đọc conversations từ file
function readConversations() {
  try {
    const data = fs.readFileSync(CONVERSATIONS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('❌ Error reading conversations file:', error);
    return [];
  }
}

// Lưu tin nhắn mới
function saveMessage(messageData) {
  try {
    const messages = readMessages();
    const newMessage = {
      id: Date.now().toString(),
      conversationId: messageData.conversationId,
      senderPhone: messageData.senderPhone,
      receiverPhone: messageData.receiverPhone,
      messageText: messageData.messageText,
      timestamp: messageData.timestamp || new Date().toISOString(),
      isRead: false,
      readAt: null
    };
    
    messages.push(newMessage);
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));
    
    console.log('💾 Message saved to JSON:', newMessage);
    return newMessage;
  } catch (error) {
    console.error('❌ Error saving message:', error);
    return null;
  }
}

// Lưu conversation mới
function saveConversation(conversationData) {
  try {
    const conversations = readConversations();
    const existingConversation = conversations.find(
      conv => conv.conversationId === conversationData.conversationId
    );
    
    if (!existingConversation) {
      const newConversation = {
        conversationId: conversationData.conversationId,
        participants: [conversationData.senderPhone, conversationData.receiverPhone],
        createdAt: new Date().toISOString(),
        lastMessage: conversationData.messageText,
        lastMessageAt: conversationData.timestamp || new Date().toISOString()
      };
      
      conversations.push(newConversation);
      fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(conversations, null, 2));
      
      console.log('💾 Conversation saved to JSON:', newConversation);
      return newConversation;
    } else {
      // Cập nhật conversation hiện có
      existingConversation.lastMessage = conversationData.messageText;
      existingConversation.lastMessageAt = conversationData.timestamp || new Date().toISOString();
      fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(conversations, null, 2));
      
      console.log('💾 Conversation updated in JSON:', existingConversation);
      return existingConversation;
    }
  } catch (error) {
    console.error('❌ Error saving conversation:', error);
    return null;
  }
}

// Lấy tin nhắn theo conversation
function getMessagesByConversation(conversationId) {
  const messages = readMessages();
  return messages.filter(msg => msg.conversationId === conversationId);
}

// Lấy conversations của user
function getConversationsByUser(userPhone) {
  const conversations = readConversations();
  return conversations.filter(conv => 
    conv.participants.includes(userPhone)
  );
}

// Đánh dấu tin nhắn đã đọc
function markMessageAsRead(messageId) {
  try {
    const messages = readMessages();
    const message = messages.find(msg => msg.id === messageId);
    if (message) {
      message.isRead = true;
      message.readAt = new Date().toISOString();
      fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));
      console.log('✅ Message marked as read:', messageId);
      return true;
    }
    return false;
  } catch (error) {
    console.error('❌ Error marking message as read:', error);
    return false;
  }
}

// Debug: In ra tất cả tin nhắn
function debugAllMessages() {
  const messages = readMessages();
  console.log('📋 All messages in JSON:', messages);
  return messages;
}

// Debug: In ra tất cả conversations
function debugAllConversations() {
  const conversations = readConversations();
  console.log('📋 All conversations in JSON:', conversations);
  return conversations;
}

module.exports = {
  initializeFiles,
  saveMessage,
  saveConversation,
  getMessagesByConversation,
  getConversationsByUser,
  markMessageAsRead,
  debugAllMessages,
  debugAllConversations
}; 