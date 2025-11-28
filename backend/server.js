const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// Store client sessions
const sessions = new Map();

// Posture analysis logic
class PostureAnalyzer {
  static calculateAngle(point1, point2, point3) {
    const vector1 = { x: point1.x - point2.x, y: point1.y - point2.y };
    const vector2 = { x: point3.x - point2.x, y: point3.y - point2.y };
    
    const dotProduct = vector1.x * vector2.x + vector1.y * vector2.y;
    const magnitude1 = Math.sqrt(vector1.x ** 2 + vector1.y ** 2);
    const magnitude2 = Math.sqrt(vector2.x ** 2 + vector2.y ** 2);
    
    const cosine = dotProduct / (magnitude1 * magnitude2);
    return Math.acos(Math.max(-1, Math.min(1, cosine))) * (180 / Math.PI);
  }

  static analyzePosture(keypoints) {
    const results = {
      forwardHead: false,
      roundedShoulders: false,
      torsoLean: false,
      overallScore: 100
    };

    try {
      // Get keypoints
      const nose = keypoints.find(k => k.name === 'nose');
      const leftEar = keypoints.find(k => k.name === 'left_ear');
      const rightEar = keypoints.find(k => k.name === 'right_ear');
      const leftShoulder = keypoints.find(k => k.name === 'left_shoulder');
      const rightShoulder = keypoints.find(k => k.name === 'right_shoulder');
      const leftHip = keypoints.find(k => k.name === 'left_hip');
      const rightHip = keypoints.find(k => k.name === 'right_hip');

      if (!nose || !leftShoulder || !rightShoulder) {
        return results;
      }

      // Forward Head Detection
      const earAvg = leftEar && rightEar ? {
        x: (leftEar.x + rightEar.x) / 2,
        y: (leftEar.y + rightEar.y) / 2
      } : { x: nose.x, y: nose.y };

      const shoulderAvg = {
        x: (leftShoulder.x + rightShoulder.x) / 2,
        y: (leftShoulder.y + rightShoulder.y) / 2
      };

      const headPosition = earAvg.x - shoulderAvg.x;
      results.forwardHead = headPosition > 0.15; // Threshold

      // Rounded Shoulders Detection
      if (leftShoulder && rightShoulder && leftHip && rightHip) {
        const shoulderWidth = Math.abs(leftShoulder.x - rightShoulder.x);
        const hipWidth = Math.abs(leftHip.x - rightHip.x);
        const shoulderRoundness = shoulderWidth / hipWidth;
        results.roundedShoulders = shoulderRoundness < 0.8; // Threshold
      }

      // Torso Lean Detection
      if (leftShoulder && rightShoulder && leftHip && rightHip) {
        const shoulderAvgY = (leftShoulder.y + rightShoulder.y) / 2;
        const hipAvgY = (leftHip.y + rightHip.y) / 2;
        const verticalAlignment = Math.abs(shoulderAvgY - hipAvgY);
        results.torsoLean = verticalAlignment > 0.2; // Threshold
      }

      // Calculate overall score
      let deductions = 0;
      if (results.forwardHead) deductions += 30;
      if (results.roundedShoulders) deductions += 25;
      if (results.torsoLean) deductions += 25;
      results.overallScore = Math.max(0, 100 - deductions);

    } catch (error) {
      console.error('Posture analysis error:', error);
    }

    return results;
  }
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  sessions.set(socket.id, {
    id: socket.id,
    connectedAt: new Date(),
    postureHistory: []
  });

  socket.on('posture-data', (data) => {
    const session = sessions.get(socket.id);
    if (!session) return;

    try {
      // Analyze posture
      const analysis = PostureAnalyzer.analyzePosture(data.keypoints);
      
      // Store in history (keep last 100 readings)
      session.postureHistory.push({
        timestamp: new Date(),
        analysis: analysis
      });
      
      if (session.postureHistory.length > 100) {
        session.postureHistory.shift();
      }

      // Send analysis back to frontend
      socket.emit('posture-analysis', analysis);

      // Check if alert should be triggered
      const poorPostureCount = session.postureHistory
        .slice(-10) // Last 10 readings
        .filter(reading => reading.analysis.overallScore < 60)
        .length;

      if (poorPostureCount >= 8) { // 80% of recent readings are poor
        socket.emit('posture-alert', {
          message: 'Poor posture detected! Please adjust your sitting position.',
          severity: 'high',
          timestamp: new Date()
        });
      }

    } catch (error) {
      console.error('Error processing posture data:', error);
      socket.emit('error', { message: 'Error analyzing posture' });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    sessions.delete(socket.id);
  });
});

// REST API endpoints
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    activeConnections: sessions.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/sessions', (req, res) => {
  const sessionData = Array.from(sessions.values()).map(session => ({
    id: session.id,
    connectedAt: session.connectedAt,
    postureHistoryCount: session.postureHistory.length
  }));
  res.json(sessionData);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Posture Monitor Backend running on port ${PORT}`);
});