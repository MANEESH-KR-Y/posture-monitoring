class PostureMonitor {
    constructor() {
        this.detector = null;
        this.isMonitoring = false;
        this.socket = null;
        this.animationId = null;
        this.stats = {
            totalFrames: 0,
            poorPostureFrames: 0,
            alerts: 0
        };

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
            alertBanner: document.getElementById('alertBanner'),
            alertMessage: document.getElementById('alertMessage'),
            dismissAlert: document.getElementById('dismissAlert'),
            postureScore: document.getElementById('postureScore'),
            forwardHeadIndicator: document.getElementById('forwardHeadIndicator'),
            shouldersIndicator: document.getElementById('shouldersIndicator'),
            torsoIndicator: document.getElementById('torsoIndicator')
        };

        this.ctx = this.elements.outputCanvas.getContext('2d');
    }

    initializeEventListeners() {
        this.elements.toggleMonitor.addEventListener('click', () => this.toggleMonitoring());
        this.elements.resetStats.addEventListener('click', () => this.resetStatistics());
        this.elements.dismissAlert.addEventListener('click', () => this.hideAlert());
    }

    async initializeCamera() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { width: 640, height: 480 }
            });
            this.elements.webcam.srcObject = stream;
            
            return new Promise((resolve) => {
                this.elements.webcam.onloadedmetadata = () => {
                    this.elements.outputCanvas.width = this.elements.webcam.videoWidth;
                    this.elements.outputCanvas.height = this.elements.webcam.videoHeight;
                    resolve();
                };
            });
        } catch (error) {
            throw new Error(`Camera access denied: ${error.message}`);
        }
    }

    async initializeMoveNet() {
        await tf.ready();
        
        const model = poseDetection.SupportedModels.MoveNet;
        this.detector = await poseDetection.createDetector(model, {
            modelType: poseDetection.movenet.modelType.SINGLEPOSE_THUNDER,
            enableSmoothing: true
        });
    }

    async initializeSocket() {
        this.socket = io();
        
        this.socket.on('connect', () => {
            this.updateStatus('connected', 'Connected to posture analysis server');
        });

        this.socket.on('posture-analysis', (analysis) => {
            this.updateUI(analysis);
        });

        this.socket.on('posture-alert', (alert) => {
            this.showAlert(alert.message);
            this.stats.alerts++;
        });

        this.socket.on('disconnect', () => {
            this.updateStatus('error', 'Disconnected from server');
        });
    }

    async startMonitoring() {
        try {
            this.updateStatus('initializing', 'Starting camera and pose detection...');
            
            await this.initializeCamera();
            await this.initializeMoveNet();
            await this.initializeSocket();

            this.isMonitoring = true;
            this.elements.toggleMonitor.textContent = 'Stop Monitoring';
            this.updateStatus('monitoring', 'Monitoring posture...');

            this.detectPose();

        } catch (error) {
            this.updateStatus('error', `Error: ${error.message}`);
            console.error('Monitoring error:', error);
        }
    }

    stopMonitoring() {
        this.isMonitoring = false;
        this.elements.toggleMonitor.textContent = 'Start Monitoring';
        
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }

        if (this.elements.webcam.srcObject) {
            this.elements.webcam.srcObject.getTracks().forEach(track => track.stop());
        }

        this.updateStatus('stopped', 'Monitoring stopped');
    }

    toggleMonitoring() {
        if (this.isMonitoring) {
            this.stopMonitoring();
        } else {
            this.startMonitoring();
        }
    }

    async detectPose() {
        if (!this.isMonitoring) return;

        try {
            const poses = await this.detector.estimatePoses(this.elements.webcam);
            
            this.ctx.clearRect(0, 0, this.elements.outputCanvas.width, this.elements.outputCanvas.height);
            
            if (poses.length > 0) {
                const pose = poses[0];
                this.drawSkeleton(pose.keypoints);
                
                // Send keypoints to backend for analysis
                if (this.socket && this.socket.connected) {
                    this.socket.emit('posture-data', {
                        keypoints: pose.keypoints.map(kp => ({
                            name: kp.name,
                            x: kp.x / this.elements.outputCanvas.width,
                            y: kp.y / this.elements.outputCanvas.height,
                            score: kp.score
                        }))
                    });
                }
            }

            this.stats.totalFrames++;
        } catch (error) {
            console.error('Pose detection error:', error);
        }

        this.animationId = requestAnimationFrame(() => this.detectPose());
    }

    drawSkeleton(keypoints) {
        // Define connections between keypoints
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

        // Draw connections
        this.ctx.strokeStyle = '#00ff00';
        this.ctx.lineWidth = 2;

        connections.forEach(([start, end]) => {
            const startPoint = keypoints.find(kp => kp.name === start);
            const endPoint = keypoints.find(kp => kp.name === end);

            if (startPoint && endPoint && startPoint.score > 0.3 && endPoint.score > 0.3) {
                this.ctx.beginPath();
                this.ctx.moveTo(startPoint.x, startPoint.y);
                this.ctx.lineTo(endPoint.x, endPoint.y);
                this.ctx.stroke();
            }
        });

        // Draw keypoints
        keypoints.forEach(keypoint => {
            if (keypoint.score > 0.3) {
                this.ctx.fillStyle = '#ff0000';
                this.ctx.beginPath();
                this.ctx.arc(keypoint.x, keypoint.y, 4, 0, 2 * Math.PI);
                this.ctx.fill();
            }
        });
    }

    updateUI(analysis) {
        // Update posture score
        this.elements.postureScore.textContent = analysis.overallScore;
        this.elements.postureScore.className = 'score ' + 
            (analysis.overallScore >= 80 ? 'good' : 
             analysis.overallScore >= 60 ? 'warning' : 'poor');

        // Update indicators
        this.updateIndicator(this.elements.forwardHeadIndicator, 
                           analysis.forwardHead ? 'Poor' : 'Good', 
                           analysis.forwardHead ? 'poor' : 'good');
        
        this.updateIndicator(this.elements.shouldersIndicator, 
                           analysis.roundedShoulders ? 'Rounded' : 'Good', 
                           analysis.roundedShoulders ? 'poor' : 'good');
        
        this.updateIndicator(this.elements.torsoIndicator, 
                           analysis.torsoLean ? 'Leaning' : 'Good', 
                           analysis.torsoLean ? 'poor' : 'good');

        // Update status panel
        let status = 'good';
        let description = 'Good posture maintained';

        if (analysis.overallScore < 60) {
            status = 'poor';
            description = 'Poor posture detected - please adjust your position';
        } else if (analysis.overallScore < 80) {
            status = 'warning';
            description = 'Fair posture - minor adjustments recommended';
        }

        this.elements.statusPanel.className = `status-panel ${status}`;
        this.elements.statusText.textContent = 
            status.charAt(0).toUpperCase() + status.slice(1);
        this.elements.statusDescription.textContent = description;
    }

    updateIndicator(element, text, status) {
        element.textContent = text;
        element.className = `indicator ${status}`;
    }

    updateStatus(status, description) {
        const statusMap = {
            initializing: { text: 'Initializing', class: '' },
            monitoring: { text: 'Monitoring', class: 'good' },
            connected: { text: 'Connected', class: 'good' },
            stopped: { text: 'Stopped', class: 'warning' },
            error: { text: 'Error', class: 'poor' }
        };

        const statusInfo = statusMap[status] || statusMap.error;
        
        this.elements.statusPanel.className = `status-panel ${statusInfo.class}`;
        this.elements.statusText.textContent = statusInfo.text;
        this.elements.statusDescription.textContent = description;
    }

    showAlert(message) {
        this.elements.alertMessage.textContent = message;
        this.elements.alertBanner.style.display = 'block';
        
        // Auto-hide after 10 seconds
        setTimeout(() => this.hideAlert(), 10000);
    }

    hideAlert() {
        this.elements.alertBanner.style.display = 'none';
    }

    resetStatistics() {
        this.stats = {
            totalFrames: 0,
            poorPostureFrames: 0,
            alerts: 0
        };
        this.updateUI({ overallScore: 100, forwardHead: false, roundedShoulders: false, torsoLean: false });
    }
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.postureMonitor = new PostureMonitor();
});