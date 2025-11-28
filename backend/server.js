const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const sessions = new Map();

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  sessions.set(socket.id, {
    id: socket.id,
    connectedAt: new Date(),
    history: []
  });

  socket.on('posture-data', (data) => {
    const session = sessions.get(socket.id);
    if (!session) return;

    const score = data.overallScore ?? 100;
    session.history.push({ ts: new Date(), score });
    if (session.history.length > 100) session.history.shift();

    // Use recent 10 readings for alert logic
    const last10 = session.history.slice(-10);
    const poorCount = last10.filter((h) => h.score < 60).length;

    if (poorCount >= 8) {
      socket.emit('posture-alert', {
        message: 'Poor posture for last few seconds. Sit upright and align your head & shoulders.',
        severity: 'high',
        timestamp: new Date()
      });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    sessions.delete(socket.id);
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    activeConnections: sessions.size,
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Posture Monitor backend running on http://localhost:${PORT}`);
});
