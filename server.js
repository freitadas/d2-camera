const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const rootDir = __dirname;
const publicDir = path.join(__dirname, 'public');

app.use(express.static(rootDir));

if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

app.get('/', (req, res) => {
  const indexRaiz = path.join(rootDir, 'index.html');
  const indexPublic = path.join(publicDir, 'index.html');

  if (fs.existsSync(indexRaiz)) {
    return res.sendFile(indexRaiz);
  }

  if (fs.existsSync(indexPublic)) {
    return res.sendFile(indexPublic);
  }

  res.status(500).send('index.html não encontrado');
});

io.on('connection', (socket) => {

  socket.on('join-room', ({ roomId, username }) => {
    socket.data.roomId = roomId;
    socket.data.username = username;

    socket.join(roomId);

    socket.to(roomId).emit('user-joined', {
      id: socket.id,
      username
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
      socket.to(roomId).emit('user-left', {
        id: socket.id
      });
    }
  });

});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`e-cord rodando na porta ${PORT}`);
});
