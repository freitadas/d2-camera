const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  socket.on('join-room', async ({ roomId, username }) => {
    const safeRoomId = String(roomId || '').trim().toUpperCase().slice(0, 24);
    const safeUsername = String(username || 'Usuário').trim().slice(0, 30) || 'Usuário';

    if (!safeRoomId) {
      socket.emit('room-error', 'Código da sala inválido.');
      return;
    }

    const existingSockets = await io.in(safeRoomId).fetchSockets();
    const participants = existingSockets.map((s) => ({
      id: s.id,
      username: s.data.username || 'Usuário'
    }));

    socket.data.roomId = safeRoomId;
    socket.data.username = safeUsername;
    socket.join(safeRoomId);

    socket.emit('room-participants', participants);
    socket.to(safeRoomId).emit('user-joined', {
      id: socket.id,
      username: safeUsername
    });
  });

  socket.on('offer', ({ target, sdp }) => {
    io.to(target).emit('offer', {
      from: socket.id,
      sdp,
      username: socket.data.username || 'Usuário'
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
  console.log(`Discord 2 Camera rodando em http://localhost:${PORT}`);
});
