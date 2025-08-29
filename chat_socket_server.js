const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mysql = require('mysql2/promise');
const cors = require('cors');
const axios = require('axios'); // axios eklendi

const app = express();
app.use(express.json()); // POST body'lerini parse etmek için
const server = http.createServer(app);

// CORS ayarı daha spesifik hale getirildi
const io = socketIo(server, {
    cors: {
        origin: "https://askivatan.com", // Sadece ana siteye izin ver
        methods: ["GET", "POST"],
        credentials: true
    }
});

// MySQL bağlantı bilgileri için yer tutucular
const dbConfig = {
    host: process.env.DB_HOST || '152.89.92.51',
    user: process.env.DB_USER || 'u552787900_QEd6i', // BURAYI DEĞİŞTİRİN
    password: process.env.DB_PASSWORD || '0a68670eA/*-', // BURAYI DEĞİŞTİRİN
    database: process.env.DB_DATABASE || 'u552787900_t1AQ5' // BURAYI DEĞİŞTİRİN
};

let dbConnection;
const connectDB = async () => {
    try {
        dbConnection = await mysql.createConnection(dbConfig);
        console.log('✅ MySQL bağlantısı kuruldu');
    } catch (error) {
        console.error('❌ MySQL bağlantı hatası:', error);
        // Hata durumunda 5 saniye sonra tekrar dene
        setTimeout(connectDB, 5000);
    }
};

// Kullanıcı durumu takibi
const onlineUsers = new Map(); // socket.id -> user info
const roomUsers = new Map(); // room_id -> Set of socket.ids

// Socket.IO bağlantı yönetimi
io.on('connection', (socket) => {
    console.log('🔌 Yeni bağlantı:', socket.id);

    // ... (user_login, change_room, update_status olayları aynı kalabilir) ...

    // Mesaj gönderme
    socket.on('send_message', async (messageData) => {
        try {
            const { message, room_id, user_id, user_name, user_avatar, user_color } = messageData;
            
            if (!message || !room_id || !user_id) {
                return;
            }

            const currentTime = Math.floor(Date.now() / 1000);
            const postTime = new Date().toLocaleTimeString('tr-TR', { 
                hour: '2-digit', 
                minute: '2-digit' 
            });

            // Veritabanına mesajı kaydet
            if (dbConnection) {
                const [result] = await dbConnection.execute(
                    'INSERT INTO chat (post_date, post_time, user_id, post_user, post_message, post_roomid, post_color, type, avatar) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [currentTime, postTime, user_id, user_name, message, room_id, user_color, 'public', user_avatar]
                );

                // Mesaj verisi
                const messageObj = {
                    post_id: result.insertId,
                    post_date: currentTime,
                    post_time: postTime,
                    user_id: user_id,
                    post_user: user_name,
                    post_message: message,
                    post_roomid: room_id,
                    post_color: user_color,
                    type: 'public',
                    avatar: user_avatar
                };

                // Odadaki tüm kullanıcılara mesajı gönder
                io.to(`room_${room_id}`).emit('new_message', messageObj);

                console.log(`💬 ${user_name}: ${message} (Oda: ${room_id})`);
            }
        } catch (error) {
            console.error('❌ Mesaj gönderme hatası:', error);
            socket.emit('message_error', { error: 'Mesaj gönderilemedi' });
        }
    });

    // ... (diğer olaylar) ...

    // Bağlantı koptuğunda
    socket.on('disconnect', async () => {
        try {
            const userInfo = onlineUsers.get(socket.id);
            if (userInfo) {
                const { user_id, user_name, user_roomid } = userInfo;

                onlineUsers.delete(socket.id);
                if (roomUsers.has(user_roomid)) {
                    roomUsers.get(user_roomid).delete(socket.id);
                }

                if (dbConnection) {
                    await dbConnection.execute(
                        'UPDATE users SET user_status = 3, last_action = ? WHERE user_id = ?',
                        [Math.floor(Date.now() / 1000), user_id]
                    );
                }

                socket.to(`room_${user_roomid}`).emit('user_left', { user_id, user_name });

                console.log(`👋 ${user_name} ayrıldı (Oda: ${user_roomid})`);
            }
        } catch (error) {
            console.error('❌ Bağlantı kopma hatası:', error);
        }
    });
});

// PHP'den gelen mesajları broadcast etmek için endpoint
app.post('/broadcast', (req, res) => {
    try {
        const { room_id, message_data } = req.body;
        
        if (!room_id || !message_data) {
            return res.status(400).json({ error: 'Eksik parametre: room_id veya message_data' });
        }
        
        // Odadaki tüm kullanıcılara mesajı gönder
        io.to(`room_${room_id}`).emit('new_message', message_data);
        
        console.log(`📡 PHP Broadcast: ${message_data.post_user}: ${message_data.post_message} (Oda: ${room_id})`);
        
        res.json({ success: true, message: 'Mesaj yayınlandı' });
    } catch (error) {
        console.error('❌ Broadcast hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// Server başlatma
const PORT = process.env.PORT || 3000;

const startServer = async () => {
    await connectDB();
    
    server.listen(PORT, () => {
        console.log(`🚀 Socket.IO Chat Server çalışıyor: http://dj.askivatan.com:${PORT}`);
    });
};

startServer(); 