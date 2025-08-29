const http = require('http').createServer();
const io = require('socket.io')(http, {
  cors: {
    origin: [
      "https://askivatan.com",
      "https://www.askivatan.com",
      "https://okey.askivatan.com"
    ],
    methods: ["GET", "POST"],
    credentials: true
  }
});

// MySQL bağlantısı
const mysql = require('mysql2/promise');

// MySQL bağlantı konfigürasyonu
const dbConfig = {
  host: 'localhost:3306',
  user: 'u552787900_QEd6i', // Veritabanı kullanıcı adınız
  password: '0a68670eA/*-', // Veritabanı şifreniz
  database: 'u552787900_t1AQ5', // Veritabanı adınız
  charset: 'utf8mb4'

};

// MySQL bağlantısını oluştur
let dbConnection;

async function connectDB() {
  try {
    dbConnection = await mysql.createConnection(dbConfig);
    console.log('MySQL bağlantısı başarılı');
  } catch (error) {
    console.error('MySQL bağlantı hatası:', error);
    // MySQL bağlantısı başarısız olsa bile server çalışmaya devam etsin
    console.log('Server MySQL olmadan çalışmaya devam ediyor...');
  }
}

// Veritabanına bağlan (async olarak)
connectDB().catch(error => {
  console.error('MySQL bağlantısı başarısız, server devam ediyor:', error);
});

// Key: username, Value: last typing timestamp
let typingUsers = {}; 

// Key: username, Value: socket.id (yalnızca tek bir aktif bağlantıyı tutarız)
let connectedUsersSockets = {}; 

// Mesaj geçmişi
let messages = [];
let messageIdCounter = 1;

/**
 * Belirli bir süredir (5 saniye) yeni bir "typing" sinyali göndermemiş kullanıcıları
 * 'typingUsers' listesinden temizler.
 */
function clearOldTypingUsers() {
  const now = Date.now();
  const timeout = 5000; // 5 saniye içinde yeniden yazmamış olanlar silinir

  for (const user in typingUsers) {
    if (now - typingUsers[user] > timeout) {
      delete typingUsers[user];
      console.log(`clearOldTypingUsers: ${user} removed due to timeout.`);
    }
  }
}

// Her 2 saniyede bir 'typingUsers' listesini temizler ve güncel listeyi tüm istemcilere gönderir.
setInterval(() => {
  clearOldTypingUsers();
  io.emit('typing_users', Object.keys(typingUsers));
}, 2000);

// ===== MESAJ YÖNETİMİ =====

// Yeni mesaj ekleme
function addMessage(username, message, type = 'text') {
  const newMessage = {
    id: messageIdCounter++,
    username: username,
    message: message,
    type: type,
    timestamp: Date.now()
  };
  
  messages.push(newMessage);
  
  // Mesaj sayısını 1000 ile sınırla (performans için)
  if (messages.length > 1000) {
    messages = messages.slice(-500);
  }
  
  return newMessage;
}

// Mesaj listesi alma
function getMessages(limit = 50) {
  return messages.slice(-limit);
}

io.on('connection', (socket) => {
  let username = null; // Bağlanan her socket için kullanıcı adı

  // İstemciden kullanıcı adı alındığında
  socket.on('set_username', (name) => {
    if (!name) {
      console.warn('set_username: Gelen kullanıcı adı boş.');
      return;
    }
    username = name;
    console.log(`set_username: ${username} (Socket ID: ${socket.id})`);

    // Eğer bu kullanıcı adıyla zaten başka bir aktif bağlantı varsa, eski bağlantıyı zorla kes
    if (connectedUsersSockets[username] && connectedUsersSockets[username] !== socket.id) {
        const oldSocketId = connectedUsersSockets[username];
        const oldSocket = io.sockets.sockets.get(oldSocketId);
        if (oldSocket) {
            // Eski sekmeye bilgilendirme mesajı gönder ve bağlantısını kes
            oldSocket.emit('force_disconnect', 'Bu hesap başka bir sekmede/cihazda açıldığı için bağlantınız sonlandırıldı.');
            oldSocket.disconnect(true); 
            console.log(`User ${username} connected from new socket ${socket.id}. Old socket ${oldSocketId} disconnected.`);
        }
    }
    // Yeni aktif bağlantıyı kaydet
    connectedUsersSockets[username] = socket.id;

    // Kullanıcı adı belirlendiğinde, tüm istemcilere güncel yazma listesini gönder
    // Bu, yeni bağlanan kullanıcının kendi durumunu doğru görmesini sağlar.
    io.emit('typing_users', Object.keys(typingUsers));
  });

  // Kullanıcı yazmaya başladığında veya devam ettiğinde
  socket.on('typing', () => {
    if (username) {
      typingUsers[username] = Date.now(); // Kullanıcının son yazma zamanını güncelle
      io.emit('typing_users', Object.keys(typingUsers)); // Güncel listeyi tüm istemcilere gönder
      // console.log(`typing: ${username}, typingUsers: ${Object.keys(typingUsers)}`); // Gürültülü olabilir
    }
  });

  // Kullanıcı yazmayı durdurduğunda
  socket.on('stop_typing', () => {
    if (username) {
      delete typingUsers[username]; // Kullanıcıyı listeden sil
      io.emit('typing_users', Object.keys(typingUsers)); // Güncel listeyi tüm istemcilere gönder
      // console.log(`stop_typing: ${username}, typingUsers: ${Object.keys(typingUsers)}`); // Gürültülü olabilir
    }
  });

  // ===== MESAJ EVENT'LERİ =====

  // Mesaj gönderme
  socket.on('send_message', async (data) => {
    if (!username) {
      console.warn('send_message: Kullanıcı adı belirlenmemiş.');
      return;
    }

    const { message, type = 'text' } = data;
    
    if (!message || !message.trim()) {
      console.warn('send_message: Boş mesaj gönderilmeye çalışıldı.');
      return;
    }

    console.log(`send_message: ${username} -> ${message}`);

    try {
      // MySQL bağlantısı kontrol et
      if (!dbConnection) {
        console.log('MySQL bağlantısı yok, mesaj sadece memory\'de saklanıyor');
        // Memory'de mesaj sakla
        const newMessage = addMessage(username, message.trim());
        io.emit('new_message', newMessage);
        return;
      }

      // Kullanıcı bilgilerini al
      const [userRows] = await dbConnection.execute(
        'SELECT user_id, user_rank, user_color, user_avatar, user_tumb FROM users WHERE user_name = ?',
        [username]
      );

      if (userRows.length === 0) {
        console.warn('Kullanıcı bulunamadı:', username);
        return;
      }

      const user = userRows[0];
      const currentTime = Math.floor(Date.now() / 1000);
      const postTime = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
      const roomId = 1; // Varsayılan oda

      // Mesajı veritabanına kaydet
      const [result] = await dbConnection.execute(
        'INSERT INTO chat (post_date, post_time, user_id, post_user, post_message, post_roomid, post_color, type, avatar) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [currentTime, postTime, user.user_id, username, message.trim(), roomId, user.user_color || 'user', 'public', user.user_tumb || 'default_avatar_tumb.png']
      );

      // Socket.IO mesajını oluştur
      const newMessage = {
        id: result.insertId,
        username: username,
        message: message.trim(),
        type: 'public',
        timestamp: currentTime * 1000,
        user_rank: user.user_rank,
        user_color: user.user_color,
        avatar: user.user_tumb
      };

      // Tüm kullanıcılara yeni mesajı gönder
      io.emit('new_message', newMessage);

      // Kullanıcının son aktivite zamanını güncelle
      await dbConnection.execute(
        'UPDATE users SET last_action = ?, last_message = ?, user_status = 1 WHERE user_name = ?',
        [currentTime, message.trim(), username]
      );

    } catch (error) {
      console.error('Mesaj gönderme hatası:', error);
      socket.emit('message_error', { message: 'Mesaj gönderilemedi' });
    }
  });

  // Mesaj listesi alma
  socket.on('get_messages', async (data) => {
    const { limit = 50 } = data;
    
    try {
      // MySQL bağlantısı kontrol et
      if (!dbConnection) {
        console.log('MySQL bağlantısı yok, memory\'den mesajlar alınıyor');
        const messageList = getMessages(limit);
        socket.emit('message_list', {
          messages: messageList,
          count: messageList.length
        });
        return;
      }

      // Veritabanından son mesajları al
      const [rows] = await dbConnection.execute(
        'SELECT c.*, u.user_rank, u.user_color FROM chat c LEFT JOIN users u ON c.user_id = u.user_id WHERE c.post_roomid = 1 ORDER BY c.post_date DESC LIMIT ?',
        [limit]
      );

      // Mesajları doğru sıraya çevir (en eski önce)
      const messageList = rows.reverse().map(row => ({
        id: row.id,
        username: row.post_user,
        message: row.post_message,
        type: row.type,
        timestamp: row.post_date * 1000,
        user_rank: row.user_rank,
        user_color: row.user_color,
        avatar: row.avatar
      }));

      socket.emit('message_list', {
        messages: messageList,
        count: messageList.length
      });

    } catch (error) {
      console.error('Mesaj listesi alma hatası:', error);
      socket.emit('message_error', { message: 'Mesajlar yüklenemedi' });
    }
  });

  // Bağlantı koptuğunda (tarayıcı kapanması, sayfa yenilenmesi, internet kesintisi vb.)
  socket.on('disconnect', (reason) => {
    console.log(`Socket ${socket.id} disconnected. Reason: ${reason}`);
    if (username) {
      // Eğer disconnect olan socket, o kullanıcı adının en son aktif bağlantısı ise,
      // 'connectedUsersSockets' listesinden kaldır.
      if (connectedUsersSockets[username] === socket.id) {
        delete connectedUsersSockets[username];
        console.log(`User ${username}'s primary connection (${socket.id}) disconnected.`);
      } else {
        // Bu durum, aynı kullanıcının eski bir bağlantısının koptuğunu gösterebilir.
        console.log(`User ${username}'s secondary connection (${socket.id}) disconnected.`);
      } 

      // Kullanıcıyı 'typingUsers' listesinden sil ve güncel listeyi yayınla.
      // disconnected kullanıcıların "yazıyor" olarak kalmaması için bu kritik.
      if (typingUsers[username]) {
          delete typingUsers[username];
          io.emit('typing_users', Object.keys(typingUsers));
          console.log(`disconnect: ${username} removed from typingUsers. Current: ${Object.keys(typingUsers)}`);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log('Socket.io server running on port ' + PORT);
}); 