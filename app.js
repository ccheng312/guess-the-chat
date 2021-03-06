const redis = require('redis');
const redisClient = redis.createClient({
  host: process.env.REDIS_HOST || null,
});
const express_session = require('express-session');
const RedisStore = require('connect-redis')(express_session);
const session = express_session({
  secret: 'answering machine',
  resave: false,
  saveUninitialized: false,
  store: new RedisStore({ client: redisClient }),
});
const rooms_lib = require('./lib/rooms');

redisClient.on('error', console.error);

// Express
const express = require('express');
const helmet = require('helmet');
const app = express();

app.set('view engine', 'pug');
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session);

// Routes
app.get('/healthy', (req, res) => res.sendStatus(200));
app.get('/', (req, res) => {
  res.render('index', {
    username: req.session.username || '',
    roomId: req.session.roomId || '',
    action: 'Enter',
  });
});

app.get('/create', (req, res) => {
  res.render('index', {
    username: req.session.username || '',
    action: 'Create',
  });
});

app.post('/create', (req, res) => {
  const username = req.body.username;
  const roomId = rooms_lib.createRoom(username);
  req.session.username = username;
  req.session.roomId = roomId;
  res.render('admin', { roomId: roomId });
});

app.post('/enter/:roomId', (req, res) => {
  const roomId = req.params.roomId;
  const username = req.body.username;
  const room = rooms_lib.getRoom(roomId);
  if (room == null) {
    res.status(404).send({ error: `Room ${roomId} doesn't exist.`});
  } else if (checkRoomForUser(roomId, username)) {
    res.status(400).send({ error: `Username ${username} is taken.`});
  } else {
    req.session.username = username;
    req.session.roomId = roomId;
    if (room.getAdmin() === username) {
      res.render('admin', { roomId: roomId });
    } else {
      res.send('');
    }
  }
});

app.get('/api/rooms', (req, res) => {
  res.send(rooms_lib.listRooms());
});

app.post('/api/rooms', (req, res) => {
  const username = req.body.username;
  const roomId = rooms_lib.createRoom();
  res.send({'roomId': roomId});
});

app.get('/api/rooms/:roomId', (req, res) => {
  res.send(rooms_lib.getRoom(req.params.roomId));
});

app.delete('/api/rooms/:roomId', (req, res) => {
  res.send(rooms_lib.deleteRoom(roomId));
});

// Server
const server = require('http').createServer(app);
const port = process.env.PORT || 3000;
server.listen(port, () => console.log('listening on *:' + port));

// Socket.IO
const io = require('socket.io')(server);

io.use((socket, next) => session(socket.request, socket.request.res || {}, next));

io.on('connection', socket => {
  const username = socket.request.session.username;
  const roomId = socket.request.session.roomId;
  if (!username || !roomId) {
    return;
  }
  const room = rooms_lib.getRoom(roomId);
  if (!room) {
    return;
  }
  socket.join(roomId, () => {
    room.addUser(username);
    io.to(roomId).emit('message', `${username} has entered the chat.`, 'announcement');
    io.to(roomId).emit('scores', room.getScores());
  });

  socket.on('chat message', msg => {
    if (room.matchesAnswer(msg)) {
      room.userFinished(username);
      io.to(roomId).emit('user finished', username);
    } else {
      io.to(roomId).emit('message', `${username}: ${msg}`);
    }
  });
  socket.on('start round', (answer, user) => {
    if (room.startRound(answer, user)) {
      io.to(roomId).emit('message',
                         '============= Round has started! =============',
                         'announcement');
    }
  });
  socket.on('end round', () => {
    const scores = room.endRound();
    if (scores) {
      io.to(roomId).emit('message',
                         '============== Round has ended! ==============',
                         'announcement');
      scores.forEach(pair => {
        const [user, score] = pair;
        io.to(roomId).emit('message', `${user}: +${score}`, 'announcement');
      });
      io.to(roomId).emit('message',
                         '==============================================',
                         'announcement');
      io.to(roomId).emit('scores', room.getScores());
    }
  });
  socket.on('disconnect', () => {
    room.removeUser(username);
    if (!io.sockets.adapter.rooms[roomId]) {
      setTimeout(() => {
        if (!io.sockets.adapter.rooms[roomId]) {
          rooms_lib.deleteRoom(roomId);
        }
      }, 60000);
    } else {
      io.to(roomId).emit('message', `${username} has left the chat.`, 'announcement');
      io.to(roomId).emit('scores', room.getScores());
    }
  });
});

function checkRoomForUser(roomId, user) {
  const room = io.sockets.adapter.rooms[roomId];
  if (!room) {
    return false;
  }
  for (let id in room.sockets) {
    const socket = io.sockets.connected[id];
    if (socket && user === socket.request.session.username) {
      return true;
    }
  }
  return false;
}
