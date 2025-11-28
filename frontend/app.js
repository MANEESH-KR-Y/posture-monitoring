class PostureMonitor {
  constructor() {
    this.detector = null;
    this.isMonitoring = false;
    this.socket = null;
    this.animationId = null;

    this.stats = {
      totalFrames: 0,
      alerts: 0,
      lastAlertTime: 0
    };

    // Accuracy improvements
    this.postureHistory = [];
    this.calibrationData = null;
    this.confidenceThreshold = 0.5;
    this.smoothingAlpha = 0.7;

    this.initializeElements();
    this.initializeEventListeners();
  }

  initializeElements() {
    this.elements = {
      webcam: document.getElementById('webcam'),
      outputCanvas: document.getElementById('outputCanvas'),
      statusPanel: document.getElementById('statusPanel'),
      statusText: document.getElementById('statusText'),
      statusDescription: document.getElementById('statusDescription'),
      toggleMonitor: document.getElementById('toggleMonitor'),
      resetStats: document.getElementById('resetStats'),
      enableNotifications: document.getElementById('enableNotifications'),
      alertBanner: document.getElementById('alertBanner'),
      alertMessage: document.getElementById('alertMessage'),
      dismissAlert: document.getElementById('dismissAlert'),
      postureScore: document.getElementById('postureScore'),
      forwardHeadIndicator: document.getElementById('forwardHeadIndicator'),
      shouldersIndicator: document.getElementById('shouldersIndicator'),
      torsoIndicator: document.getElementById('torsoIndicator'),
      videoBadge: document.getElementById('videoBadge')
    };

    this.ctx = this.elements.outputCanvas.getContext('2d');
  }

  initializeEventListeners() {
    this.elements.toggleMonitor.addEventListener('click', () =>
      this.toggleMonitoring()
    );
    this.elements.resetStats.addEventListener('click', () =>
      this.resetStatistics()
    );
    this.elements.dismissAlert.addEventListener('click', () => this.hideAlert());
    this.elements.enableNotifications.addEventListener('click', () =>
      this.requestNotificationPermission(true)
    );

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.isMonitoring) {
        this.logStatus('Running in background – system alerts will fire.');
      }
    });
  }

  // Notifications

  async requestNotificationPermission(fromButton = false) {
    if (!('Notification' in window)) {
      this.logStatus('Notifications not supported in this browser.');
      return;
    }
    if (Notification.permission === 'granted') {
      if (fromButton) this.logStatus('Notifications already enabled.');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      this.logStatus('System notifications enabled.');
      this.elements.enableNotifications.textContent = '🔔 Alerts Enabled';
    } else {
      this.logStatus('Notification permission denied.');
    }
  }

  showSystemNotification(title, body, options = {}) {
    if (Notification.permission !== 'granted') return;

    const notificationOptions = {
      body,
      icon:
        'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTYiIGZpbGw9IiMwMEZGODgiLz4KPHBhdGggZD0iTTEyIDExSDIwVjIxSDEyVi9dIGZpbGw9IndoaXRlIi8+CjxwYXRoIGQ9Ik0xMiAxMUgxNlYyMFYxMUgxMloiIGZpbGw9IndoaXRlIi8+Cjwvc3ZnPgo=',
      badge:
        'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTIiIGZpbGw9IiNGRjAwMDAiLz4KPC9zdmc+Cg==',
      vibrate: [200, 100, 200],
      tag: 'posture-alert',
      renotify: true,
      ...options
    };

    const n = new Notification(title, notificationOptions);
    setTimeout(() => n.close(), 8000);
    n.onclick = () => {
      window.focus();
      this.elements.alertBanner.scrollIntoView({ behavior: 'smooth' });
    };
  }

  canShowAlert() {
    const now = Date.now();
    return now - this.stats.lastAlertTime > 120000; // 2 min
  }

  // Pose helpers

  getKeypoint(keypoints, name) {
    return keypoints.find(
      (kp) => kp.name === name && kp.score > this.confidenceThreshold
    );
  }

  calculateNeckAngle(nose, leftShoulder, rightShoulder) {
    if (!nose || !leftShoulder || !rightShoulder) return 0;
    const shoulderMidX = (leftShoulder.x + rightShoulder.x) / 2;
    const shoulderMidY = (leftShoulder.y + rightShoulder.y) / 2;
    const dx = nose.x - shoulderMidX;
    const dy = nose.y - shoulderMidY;
    return Math.abs((Math.atan2(dx, dy) * 180) / Math.PI);
  }

  calculateShoulderSlope(leftShoulder, rightShoulder) {
    if (!leftShoulder || !rightShoulder) return 0;
    const dx = rightShoulder.x - leftShoulder.x;
    const dy = rightShoulder.y - leftShoulder.y;
    return Math.abs((Math.atan2(dy, dx) * 180) / Math.PI);
  }

  calculateTorsoAngle(leftShoulder, leftHip, rightShoulder, rightHip) {
    if (!leftShoulder || !leftHip || !rightShoulder || !rightHip) return 0;
    const lv = { x: leftHip.x - leftShoulder.x, y: leftHip.y - leftShoulder.y };
    const rv = {
      x: rightHip.x - rightShoulder.x,
      y: rightHip.y - rightShoulder.y
    };
    const avg =
      ((Math.atan2(lv.y, lv.x) + Math.atan2(rv.y, rv.x)) / 2 / Math.PI) * 180;
    return Math.abs(avg);
  }

  calibratePosture(poses) {
    if (poses.length === 0 || this.calibrationData) return;

    const pose = poses[0];
    const k = pose.keypoints;
    const nose = this.getKeypoint(k, 'nose');
    const ls = this.getKeypoint(k, 'left_shoulder');
    const rs = this.getKeypoint(k, 'right_shoulder');
    const lh = this.getKeypoint(k, 'left_hip');
    const rh = this.getKeypoint(k, 'right_hip');

    if (nose && ls && rs && lh && rh) {
      this.calibrationData = {
        neckAngle: this.calculateNeckAngle(nose, ls, rs),
        shoulderSlope: this.calculateShoulderSlope(ls, rs),
        torsoAngle: this.calculateTorsoAngle(ls, lh, rs, rh)
      };
      this.updateStatus(
        'calibrating',
        'Calibration complete. Sit normally; AI has learned your baseline.'
      );
    }
  }

  analyzePosture(pose) {
    const k = pose.keypoints;
    const nose = this.getKeypoint(k, 'nose');
    const ls = this.getKeypoint(k, 'left_shoulder');
    const rs = this.getKeypoint(k, 'right_shoulder');
    const lh = this.getKeypoint(k, 'left_hip');
    const rh = this.getKeypoint(k, 'right_hip');

    if (!nose || !ls || !rs || !lh || !rh) {
      return { overallScore: 0, confidence: 0, valid: false };
    }

    const neckAngle = this.calculateNeckAngle(nose, ls, rs);
    const shoulderSlope = this.calculateShoulderSlope(ls, rs);
    const torsoAngle = this.calculateTorsoAngle(ls, lh, rs, rh);

    const neckBase = this.calibrationData?.neckAngle ?? 10;
    const shoulderBase = this.calibrationData?.shoulderSlope ?? 5;
    const torsoBase = this.calibrationData?.torsoAngle ?? 15;

    const neckScore = Math.max(0, 100 - Math.max(0, neckAngle - neckBase) * 8);
    const shoulderScore = Math.max(0, 100 - shoulderSlope * 10);
    const torsoScore = Math.max(0, 100 - torsoAngle * 5);

    const rawScore =
      neckScore * 0.4 + shoulderScore * 0.3 + torsoScore * 0.3;
    const confidence = Math.min(1, (nose.score + ls.score + rs.score) / 3);

    return {
      overallScore: Math.round(rawScore * confidence),
      confidence,
      valid: true,
      metrics: {
        forwardHead: neckAngle > neckBase + 5,
        roundedShoulders: shoulderSlope > shoulderBase + 3,
        torsoLean: torsoAngle > torsoBase + 8,
        neckAngle: +neckAngle.toFixed(1),
        shoulderSlope: +shoulderSlope.toFixed(1),
        torsoAngle: +torsoAngle.toFixed(1)
      }
    };
  }

  addToHistory(a) {
    this.postureHistory.push(a);
    if (this.postureHistory.length > 10) this.postureHistory.shift();
  }

  getSmoothedAnalysis(current) {
    if (!current.valid) return current;
    if (this.postureHistory.length < 3) {
      this.addToHistory(current);
      return current;
    }
    const avg =
      this.postureHistory.reduce((s, x) => s + x.overallScore, 0) /
      this.postureHistory.length;
    const smoothed = {
      ...current,
      overallScore:
        this.smoothingAlpha * current.overallScore +
        (1 - this.smoothingAlpha) * avg
    };
    this.addToHistory(smoothed);
    return smoothed;
  }

  // Camera + MoveNet

  async initializeCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: 640,
        height: 480,
        facingMode: 'user',
        frameRate: { ideal: 30, max: 60 }
      }
    });
    this.elements.webcam.srcObject = stream;

    return new Promise((resolve) => {
      this.elements.webcam.onloadedmetadata = () => {
        this.elements.outputCanvas.width = this.elements.webcam.videoWidth;
        this.elements.outputCanvas.height = this.elements.webcam.videoHeight;
        resolve();
      };
    });
  }

  async initializeMoveNet() {
    await tf.ready();
    await tf.setBackend('webgl');
    const model = poseDetection.SupportedModels.MoveNet;
    this.detector = await poseDetection.createDetector(model, {
      modelType: poseDetection.movenet.modelType.SINGLEPOSE_THUNDER,
      enableSmoothing: true
    });
  }

  async initializeSocket() {
    this.socket = io();
    this.socket.on('connect', () => {
      this.updateStatus('connected', 'Connected to posture backend.');
    });
    this.socket.on('disconnect', () => {
      this.updateStatus('error', 'Disconnected from backend.');
    });
    // backend may still send alerts if you keep that logic there
    this.socket.on('posture-alert', (alert) => {
      this.showAlert(alert.message);
      this.stats.alerts++;
    });
  }

  async startMonitoring() {
    try {
      this.updateStatus(
        'initializing',
        'Starting camera and AI model (3s calibration)…'
      );

      await this.initializeCamera();
      await this.initializeMoveNet();
      await this.initializeSocket();

      this.isMonitoring = true;
      this.elements.toggleMonitor.textContent = '⏹ Stop Monitoring';
      this.elements.videoBadge.textContent = 'Calibrating…';

      setTimeout(() => {
        if (!this.calibrationData) {
          this.updateStatus(
            'calibrating',
            'Keep normal posture; AI is learning your baseline.'
          );
        }
      }, 1000);

      this.detectPose();
    } catch (err) {
      console.error(err);
      this.updateStatus('error', `Error: ${err.message}`);
    }
  }

  stopMonitoring() {
    this.isMonitoring = false;
    this.elements.toggleMonitor.textContent = '▶️ Start Monitoring';
    this.elements.videoBadge.textContent = 'Idle';

    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    if (this.elements.webcam.srcObject) {
      this.elements.webcam.srcObject
        .getTracks()
        .forEach((t) => t.stop && t.stop());
    }
    this.updateStatus('stopped', 'Monitoring stopped.');
  }

  toggleMonitoring() {
    if (this.isMonitoring) this.stopMonitoring();
    else this.startMonitoring();
  }

  async detectPose() {
    if (!this.isMonitoring) return;

    try {
      const poses = await this.detector.estimatePoses(this.elements.webcam);
      this.ctx.clearRect(
        0,
        0,
        this.elements.outputCanvas.width,
        this.elements.outputCanvas.height
      );

      if (poses.length > 0) {
        const pose = poses[0];

        if (!this.calibrationData) {
          this.calibratePosture(poses);
        } else {
          this.elements.videoBadge.textContent = 'LIVE';
        }

        const raw = this.analyzePosture(pose);
        const smoothed = this.getSmoothedAnalysis(raw);

        // REAL-TIME: draw + UI every frame
        this.drawSkeleton(pose.keypoints, smoothed);
        this.updateUI(smoothed);

        // Optional: send to backend for logging/extra alerts
        if (this.socket && this.socket.connected) {
          this.socket.emit('posture-data', {
            overallScore: smoothed.overallScore,
            metrics: smoothed.metrics
          });
        }

        // Front-end alert logic also real-time
        if (smoothed.overallScore < 60 && this.canShowAlert()) {
          this.showAlert(
            `Posture Score: ${Math.round(
              smoothed.overallScore
            )}% — adjust your posture.`
          );
        }
      }

      this.stats.totalFrames++;
    } catch (e) {
      console.error('Pose detection error:', e);
    }

    this.animationId = requestAnimationFrame(() => this.detectPose());
  }

  drawSkeleton(keypoints, analysis) {
    const connections = [
      ['left_shoulder', 'right_shoulder'],
      ['left_shoulder', 'left_elbow'],
      ['left_elbow', 'left_wrist'],
      ['right_shoulder', 'right_elbow'],
      ['right_elbow', 'right_wrist'],
      ['left_shoulder', 'left_hip'],
      ['right_shoulder', 'right_hip'],
      ['left_hip', 'right_hip'],
      ['left_hip', 'left_knee'],
      ['left_knee', 'left_ankle'],
      ['right_hip', 'right_knee'],
      ['right_knee', 'right_ankle'],
      ['left_ear', 'left_shoulder'],
      ['right_ear', 'right_shoulder'],
      ['nose', 'left_ear'],
      ['nose', 'right_ear']
    ];

    const score = analysis?.overallScore || 100;
    const color = score > 80 ? '#00ff88' : score > 60 ? '#ffaa00' : '#ff4444';

    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 4;
    this.ctx.lineCap = 'round';

    connections.forEach(([a, b]) => {
      const p1 = keypoints.find((kp) => kp.name === a);
      const p2 = keypoints.find((kp) => kp.name === b);
      if (p1 && p2 && p1.score > 0.5 && p2.score > 0.5) {
        this.ctx.beginPath();
        this.ctx.moveTo(p1.x, p1.y);
        this.ctx.lineTo(p2.x, p2.y);
        this.ctx.stroke();
      }
    });
  }

  updateUI(analysis) {
    const score = Math.round(analysis.overallScore);
    this.elements.postureScore.textContent = isNaN(score) ? '--' : score;
    this.elements.postureScore.className =
      'score ' +
      (score >= 80 ? 'good' : score >= 60 ? 'warning' : 'poor');

    this.updateIndicator(
      this.elements.forwardHeadIndicator,
      analysis.metrics?.forwardHead ? 'Poor' : 'Good',
      analysis.metrics?.forwardHead ? 'poor' : 'good'
    );
    this.updateIndicator(
      this.elements.shouldersIndicator,
      analysis.metrics?.roundedShoulders ? 'Rounded' : 'Good',
      analysis.metrics?.roundedShoulders ? 'poor' : 'good'
    );
    this.updateIndicator(
      this.elements.torsoIndicator,
      analysis.metrics?.torsoLean ? 'Leaning' : 'Good',
      analysis.metrics?.torsoLean ? 'poor' : 'good'
    );

    let status = 'good';
    let desc = `Confidence: ${(analysis.confidence * 100).toFixed(0)}%`;

    if (score < 60) {
      status = 'poor';
      desc = `Critical: ${score}% — fix posture now.`;
    } else if (score < 80) {
      status = 'warning';
      desc = `Warning: ${score}% — minor adjustment recommended.`;
    }

    this.elements.statusPanel.className = `status-panel ${status}`;
    this.elements.statusText.textContent =
      status.charAt(0).toUpperCase() + status.slice(1);
    this.elements.statusDescription.textContent = desc;
  }

  updateIndicator(el, text, status) {
    el.textContent = text;
    el.className = `indicator ${status}`;
  }

  showAlert(message) {
    if (!this.canShowAlert()) return;

    this.stats.lastAlertTime = Date.now();
    this.elements.alertMessage.textContent = message;
    this.elements.alertBanner.style.display = 'block';

    if (Notification.permission === 'granted') {
      this.showSystemNotification('Posture Alert', message, {
        vibrate: [300, 100, 300]
      });
    }

    this.playAlertSound();
    setTimeout(() => this.hideAlert(), 10000);
  }

  playAlertSound() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 900;
    gain.gain.value = 0.4;
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.6);
    osc.stop(ctx.currentTime + 0.6);
  }

  hideAlert() {
    this.elements.alertBanner.style.display = 'none';
  }

  resetStatistics() {
    this.stats = { totalFrames: 0, alerts: 0, lastAlertTime: 0 };
    this.postureHistory = [];
    this.calibrationData = null;
    this.updateStatus(
      'initializing',
      'Calibration and stats reset. Click Start to recalibrate.'
    );
    this.elements.postureScore.textContent = '--';
    this.elements.forwardHeadIndicator.textContent = '--';
    this.elements.shouldersIndicator.textContent = '--';
    this.elements.torsoIndicator.textContent = '--';
  }

  updateStatus(status, description) {
    const map = {
      initializing: { text: 'Initializing', class: '' },
      calibrating: { text: 'Calibrating', class: 'good' },
      monitoring: { text: 'Monitoring', class: 'good' },
      connected: { text: 'Connected', class: 'good' },
      stopped: { text: 'Stopped', class: 'warning' },
      error: { text: 'Error', class: 'poor' }
    };
    const info = map[status] || map.error;
    this.elements.statusPanel.className = `status-panel ${info.class}`;
    this.elements.statusText.textContent = info.text;
    this.elements.statusDescription.textContent = description;
  }

  logStatus(msg) {
    console.log('[PostureMonitor]', msg);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.postureMonitor = new PostureMonitor();
});
