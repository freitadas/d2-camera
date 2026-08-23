const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, username }) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    const participants = [];

    if (room) {
      for (const id of room) {
        const user = io.sockets.sockets.get(id);
        if (user) {
          participants.push({
            id,
            username: user.data.username || 'Usuário'
          });
        }
      }
    }

    socket.data.roomId = roomId;
    socket.data.username = username;
    socket.join(roomId);

    socket.emit('room-participants', participants);

    socket.to(roomId).emit('user-joined', {
      id: socket.id,
      username
    });
  });

  socket.on('chat-message', ({ roomId, username, text }) => {
    const safeRoom = String(roomId || '').slice(0, 24);
    const safeName = String(username || 'Usuário').slice(0, 30);
    const safeText = String(text || '').trim().slice(0, 500);

    if (!safeRoom || !safeText) return;
    if (socket.data.roomId !== safeRoom) return;

    socket.to(safeRoom).emit('chat-message', {
      username: safeName,
      text: safeText
    });
  });

  socket.on('offer', ({ target, sdp }) => {
    io.to(target).emit('offer', {
      from: socket.id,
      sdp,
      username: socket.data.username
    });
  });

  socket.on('answer', ({ target, sdp }) => {
    io.to(target).emit('answer', {
      from: socket.id,
      sdp
    });
  });

  socket.on('ice-candidate', ({ target, candidate }) => {
    io.to(target).emit('ice-candidate', {
      from: socket.id,
      candidate
    });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (roomId) {
      socket.to(roomId).emit('user-left', { id: socket.id });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`e-cord rodando na porta ${PORT}`);
});
