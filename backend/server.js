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
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../frontend')));

// Store client sessions with efficient data structure
const sessions = new Map();
const POSTURE_HISTORY_MAX = 50; // Reduced from 100
const ALERT_THRESHOLD = 6; // Reduced from 8

// Efficient posture analysis with caching
class PostureAnalyzer {
  static calculateDistance(point1, point2) {
    return Math.sqrt((point1.x - point2.x) ** 2 + (point1.y - point2.y) ** 2);
  }

  static calculateAngle(point1, point2, point3) {
    const vector1 = { x: point1.x - point2.x, y: point1.y - point2.y };
    const vector2 = { x: point3.x - point2.x, y: point3.y - point2.y };
    
    const dotProduct = vector1.x * vector2.x + vector1.y * vector2.y;
    const magnitude1 = Math.sqrt(vector1.x ** 2 + vector1.y ** 2);
    const magnitude2 = Math.sqrt(vector2.x ** 2 + vector2.y ** 2);
    
    // Prevent division by zero
    if (magnitude1 < 0.001 || magnitude2 < 0.001) return 180;
    
    const cosine = dotProduct / (magnitude1 * magnitude2);
    return Math.acos(Math.max(-1, Math.min(1, cosine))) * (180 / Math.PI);
  }

  static analyzePosture(keypoints, previousAnalysis = null) {
    // Cache keypoints for quick access
    const keypointMap = {};
    keypoints.forEach(kp => {
      if (kp.score > 0.2) keypointMap[kp.name] = kp;
    });

    const results = {
      forwardHead: false,
      roundedShoulders: false,
      torsoLean: false,
      overallScore: 100,
      confidence: 0
    };

    try {
      const requiredPoints = ['nose', 'left_shoulder', 'right_shoulder'];
      const hasRequiredPoints = requiredPoints.every(point => keypointMap[point]);
      
      if (!hasRequiredPoints) {
        results.confidence = 0;
        return results;
      }

      const nose = keypointMap['nose'];
      const leftShoulder = keypointMap['left_shoulder'];
      const rightShoulder = keypointMap['right_shoulder'];
      const leftHip = keypointMap['left_hip'];
      const rightHip = keypointMap['right_hip'];
      const leftEar = keypointMap['left_ear'];
      const rightEar = keypointMap['right_ear'];

      // Calculate confidence based on keypoint scores
      results.confidence = (nose.score + leftShoulder.score + rightShoulder.score) / 3;

      // 1. Forward Head Detection (Improved)
      const headPoint = (leftEar && rightEar) ? {
        x: (leftEar.x + rightEar.x) / 2,
        y: (leftEar.y + rightEar.y) / 2
      } : { x: nose.x, y: nose.y };

      const shoulderCenter = {
        x: (leftShoulder.x + rightShoulder.x) / 2,
        y: (leftShoulder.y + rightShoulder.y) / 2
      };

      // Use horizontal distance relative to shoulder width
      const shoulderWidth = Math.abs(leftShoulder.x - rightShoulder.x);
      const headForwardDistance = (headPoint.x - shoulderCenter.x) / shoulderWidth;
      
      // Adaptive threshold based on confidence
      const forwardHeadThreshold = 0.12 + (0.1 * (1 - results.confidence));
      results.forwardHead = headForwardDistance > forwardHeadThreshold;

      // 2. Rounded Shoulders Detection (Improved)
      if (leftHip && rightHip) {
        const hipWidth = Math.abs(leftHip.x - rightHip.x);
        if (hipWidth > 0.05) { // Minimum hip width threshold
          const shoulderHipRatio = shoulderWidth / hipWidth;
          // Normal ratio is ~0.9-1.1, rounded is < 0.8
          results.roundedShoulders = shoulderHipRatio < 0.75;
        }
      }

      // 3. Torso Lean Detection (Improved)
      if (leftHip && rightHip) {
        const shoulderAvgY = (leftShoulder.y + rightShoulder.y) / 2;
        const hipAvgY = (leftHip.y + rightHip.y) / 2;
        
        // Calculate lean angle
        const torsoVector = {
          x: shoulderCenter.x - (leftHip.x + rightHip.x) / 2,
          y: shoulderAvgY - hipAvgY
        };
        
        const verticalVector = { x: 0, y: -1 }; // Straight up
        const leanAngle = this.calculateAngle(
          { x: shoulderCenter.x + torsoVector.x, y: shoulderAvgY + torsoVector.y },
          shoulderCenter,
          { x: shoulderCenter.x, y: shoulderAvgY - 1 }
        );
        
        results.torsoLean = leanAngle > 15; // Degrees from vertical
      }

      // 4. Calculate overall score with weights
      let deductions = 0;
      if (results.forwardHead) deductions += 35;
      if (results.roundedShoulders) deductions += 30;
      if (results.torsoLean) deductions += 25;
      
      // Apply confidence penalty
      const confidencePenalty = (1 - results.confidence) * 20;
      results.overallScore = Math.max(0, 100 - deductions - confidencePenalty);

      // Smoothing with previous analysis if available
      if (previousAnalysis && results.confidence > 0.6) {
        const smoothingFactor = 0.3;
        results.overallScore = previousAnalysis.overallScore * smoothingFactor + 
                              results.overallScore * (1 - smoothingFactor);
      }

    } catch (error) {
      console.error('Posture analysis error:', error);
    }

    return results;
  }
}

// Efficient session management
const cleanupSessions = () => {
  const now = Date.now();
  const MAX_SESSION_AGE = 30 * 60 * 1000; // 30 minutes
  
  for (const [socketId, session] of sessions.entries()) {
    if (now - session.lastActivity > MAX_SESSION_AGE) {
      sessions.delete(socketId);
      console.log(`Cleaned up stale session: ${socketId}`);
    }
  }
};

// Clean up every 5 minutes
setInterval(cleanupSessions, 5 * 60 * 1000);

// Socket.io connection handling with rate limiting
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  const session = {
    id: socket.id,
    connectedAt: Date.now(),
    lastActivity: Date.now(),
    postureHistory: [],
    lastAnalysis: null,
    frameCount: 0
  };
  
  sessions.set(socket.id, session);

  // Rate limiting for posture data
  let lastProcessTime = 0;
  const MIN_PROCESS_INTERVAL = 100; // Process max 10 frames per second

  socket.on('posture-data', (data) => {
    const now = Date.now();
    if (now - lastProcessTime < MIN_PROCESS_INTERVAL) {
      return; // Skip frame due to rate limiting
    }
    lastProcessTime = now;

    const session = sessions.get(socket.id);
    if (!session) return;

    session.lastActivity = now;
    session.frameCount++;

    try {
      // Analyze posture with previous result for smoothing
      const analysis = PostureAnalyzer.analyzePosture(data.keypoints, session.lastAnalysis);
      session.lastAnalysis = analysis;

      // Store in history (circular buffer approach)
      if (session.postureHistory.length >= POSTURE_HISTORY_MAX) {
        session.postureHistory.shift();
      }
      session.postureHistory.push({
        timestamp: now,
        analysis: analysis
      });

      // Send analysis back to frontend
      socket.emit('posture-analysis', analysis);

      // Efficient alert checking (only check every 10 frames)
      if (session.frameCount % 10 === 0 && session.postureHistory.length >= 10) {
        const recentReadings = session.postureHistory.slice(-10);
        const poorPostureCount = recentReadings.filter(
          reading => reading.analysis.overallScore < 60 && reading.analysis.confidence > 0.5
        ).length;

        if (poorPostureCount >= ALERT_THRESHOLD) {
          socket.emit('posture-alert', {
            message: 'Poor posture detected! Please sit up straight.',
            severity: 'high',
            timestamp: new Date(),
            issues: {
              forwardHead: analysis.forwardHead,
              roundedShoulders: analysis.roundedShoulders,
              torsoLean: analysis.torsoLean
            }
          });
        }
      }

    } catch (error) {
      console.error('Error processing posture data:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    sessions.delete(socket.id);
  });

  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

// REST API endpoints
app.get('/api/health', (req, res) => {
  const memoryUsage = process.memoryUsage();
  res.json({ 
    status: 'healthy', 
    activeConnections: sessions.size,
    memory: {
      used: Math.round(memoryUsage.heapUsed / 1024 / 1024) + 'MB',
      total: Math.round(memoryUsage.heapTotal / 1024 / 1024) + 'MB'
    },
    uptime: Math.round(process.uptime()) + 's'
  });
});

app.get('/api/sessions', (req, res) => {
  const sessionData = Array.from(sessions.values()).map(session => ({
    id: session.id,
    connectedAt: new Date(session.connectedAt).toISOString(),
    postureHistoryCount: session.postureHistory.length,
    frameCount: session.frameCount,
    lastActivity: new Date(session.lastActivity).toISOString()
  }));
  res.json(sessionData);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Posture Monitor Backend running on port ${PORT}`);
  console.log(`📊 Frontend: http://localhost:${PORT}`);
  console.log(`🔍 Health check: http://localhost:${PORT}/api/health`);
});