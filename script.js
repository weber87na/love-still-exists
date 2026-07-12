// 取得 DOM 元素
const videoElement = document.getElementById('input_video');
const canvasContainer = document.getElementById('three-canvas-container');
const crosshair = document.getElementById('crosshair');
const instructions = document.getElementById('instructions');

// 遊戲狀態
let isGameStarted = false;
let lastShootTime = 0;
const SHOOT_COOLDOWN = 300; // 開火冷卻時間 (毫秒)
let isThumbCocked = false; // 判斷板機是否已就位 (大拇指翹起)

// Three.js 變數
let scene, camera, renderer, raycaster;
const particles = [];
const petalTextures = [];

// 最新的人臉位置
let latestFaceCenter = null;

// 初始化 Three.js
function initThreeJS() {
    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 5;

    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    canvasContainer.appendChild(renderer.domElement);

    raycaster = new THREE.Raycaster();

    const light = new THREE.DirectionalLight(0xffffff, 1.0);
    light.position.set(0, 1, 1).normalize();
    scene.add(light);
    
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    window.addEventListener('resize', onWindowResize, false);
    
    loadPetalTextures();
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// 載入花瓣材質
function loadPetalTextures() {
    const textureLoader = new THREE.TextureLoader();
    const petalFiles = [
        'petal/red-petal-01-01.png', 'petal/red-petal-01-05.png', 'petal/red-petal-01-10.png',
        'petal/red-petal-02-01.png', 'petal/red-petal-02-10.png', 'petal/red-petal-02-20.png',
        'petal/red-petal-03-01.png', 'petal/red-petal-03-10.png', 'petal/red-petal-03-20.png',
        'petal/red-petal-04-01.png', 'petal/red-petal-04-10.png', 'petal/red-petal-04-20.png',
        'petal/red-petal-05-01.png', 'petal/red-petal-05-10.png', 'petal/red-petal-05-20.png'
    ];
    
    petalFiles.forEach(file => {
        petalTextures.push(textureLoader.load(file));
    });
}

// 輔助函式：計算兩點距離
function getDistance(p1, p2) {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    const dz = p1.z - p2.z;
    return Math.sqrt(dx*dx + dy*dy + dz*dz);
}

// 輔助函式：判斷手指是否伸直 (比較指尖與根部 MCP 到手腕的距離，這樣判定比較寬鬆)
function isFingerExtended(landmarks, tipIdx, mcpIdx) {
    const wrist = landmarks[0];
    const tip = landmarks[tipIdx];
    const mcp = landmarks[mcpIdx];
    return getDistance(wrist, tip) > getDistance(wrist, mcp);
}

// 初始化 MediaPipe
function initMediaPipe() {
    // 1. 初始化人臉偵測
    const faceDetection = new FaceDetection({locateFile: (file) => {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/${file}`;
    }});
    faceDetection.setOptions({
        model: 'short',
        minDetectionConfidence: 0.5
    });
    faceDetection.onResults((results) => {
        if (results.detections.length > 0) {
            const bbox = results.detections[0].boundingBox;
            // 計算臉部中心 (注意鏡像翻轉 1 - x)
            latestFaceCenter = {
                x: 1 - (bbox.xCenter),
                y: bbox.yCenter
            };
        } else {
            latestFaceCenter = null;
        }
    });

    // 2. 初始化手部追蹤
    const hands = new Hands({locateFile: (file) => {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
    }});
    hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.7,
        minTrackingConfidence: 0.7
    });

    hands.onResults((results) => {
        if (!isGameStarted && results.multiHandLandmarks.length > 0) {
            isGameStarted = true;
            instructions.style.opacity = '0';
            setTimeout(() => instructions.style.display = 'none', 500);
            startGameLoop();
        }

        if (results.multiHandLandmarks.length > 0) {
            const landmarks = results.multiHandLandmarks[0];
            
            // 判斷是否為「手槍」手勢：只要食指與中指有伸直的趨勢就算數，不嚴格檢查其他手指
            const indexExtended = isFingerExtended(landmarks, 8, 5);
            const middleExtended = isFingerExtended(landmarks, 12, 9);
            
            const isGun = indexExtended && middleExtended;
            
            // 抓取食指與中指的根部 (MCP) 作為槍管基準位置
            const indexMcp = landmarks[5];
            const middleMcp = landmarks[9];
            
            // 抓取大拇指指尖，用來判斷是否扣板機
            const thumbTip = landmarks[4];
            const thumbDistance = getDistance(thumbTip, indexMcp);

            // 準星位置 (鏡像翻轉 X 軸)
            const targetX = 1 - ((indexMcp.x + middleMcp.x) / 2);
            const targetY = (indexMcp.y + middleMcp.y) / 2;
            
            crosshair.style.display = 'block';
            crosshair.style.left = `${targetX * 100}vw`;
            crosshair.style.top = `${targetY * 100}vh`;

            // 狀態機：判斷是否上膛 (大拇指翹起，稍微放寬閾值讓使用者比較好按)
            const THUMB_COCKED_THRESHOLD = 0.10; // 原本 0.12，改小一點比較容易觸發上膛
            const THUMB_FIRE_THRESHOLD = 0.08; 

            if (isGun && thumbDistance > THUMB_COCKED_THRESHOLD) {
                isThumbCocked = true; 
            }

            // 如果手勢不再是手槍，取消上膛狀態以防誤觸
            if (!isGun) {
                isThumbCocked = false;
            }

            const now = Date.now();
            if (isGun && isThumbCocked && thumbDistance < THUMB_FIRE_THRESHOLD && (now - lastShootTime) > SHOOT_COOLDOWN) {
                
                // 決定花瓣噴發起點
                let spawnX = targetX;
                let spawnY = targetY;
                let sprayDirX = 0;
                
                if (latestFaceCenter) {
                    if (targetX < latestFaceCenter.x) {
                        spawnX = latestFaceCenter.x + 0.15;
                        sprayDirX = 1;
                    } else {
                        spawnX = latestFaceCenter.x - 0.15;
                        sprayDirX = -1;
                    }
                    spawnY = latestFaceCenter.y;
                }

                shoot(spawnX, spawnY, sprayDirX);
                lastShootTime = now;
                isThumbCocked = false; 
            }
        } else {
            crosshair.style.display = 'none';
        }
    });

    const cameraInstance = new Camera(videoElement, {
        onFrame: async () => {
            await faceDetection.send({image: videoElement});
            await hands.send({image: videoElement});
        },
        width: 640,
        height: 480
    });
    cameraInstance.start();
}

function shoot(screenX, screenY, sprayDirX) {
    // 轉換為 3D 空間座標
    const mouseVector = new THREE.Vector3(
        (screenX * 2) - 1,
        -(screenY * 2) + 1,
        0.5
    );
    mouseVector.unproject(camera);
    const dir = mouseVector.sub(camera.position).normalize();
    const distance = -camera.position.z / dir.z;
    const pos = camera.position.clone().add(dir.multiplyScalar(distance));

    // 產生花瓣
    const count = 50 + Math.random() * 30;
    for(let i=0; i<count; i++) {
        const tex = petalTextures[Math.floor(Math.random() * petalTextures.length)];
        const material = new THREE.MeshBasicMaterial({ 
            map: tex, 
            transparent: true, 
            side: THREE.DoubleSide,
            depthWrite: false
        });
        const geometry = new THREE.PlaneGeometry(0.3, 0.3); // 將花瓣基礎尺寸調大一點
        const petal = new THREE.Mesh(geometry, material);
        
        const scale = 0.6 + Math.random() * 1.0; // 放大比例範圍
        petal.scale.set(scale, scale, 1);
        
        petal.position.copy(pos);
        
        // 如果有臉部判定，依據方向向外噴
        let vx, vy, vz;
        if (sprayDirX !== 0) {
            const speedMultiplier = 0.15 + Math.random() * 0.1;
            vx = sprayDirX * speedMultiplier + (Math.random() - 0.5) * 0.1;
            vy = (Math.random() - 0.5) * 0.15 + 0.05;
            vz = (Math.random() - 0.5) * 0.1;
        } else {
            vx = (Math.random() - 0.5) * 0.3;
            vy = (Math.random() - 0.5) * 0.3;
            vz = (Math.random() - 0.5) * 0.3;
        }
        
        petal.userData = {
            velocity: new THREE.Vector3(vx, vy, vz),
            rotSpeed: new THREE.Vector3((Math.random()-0.5)*0.2, (Math.random()-0.5)*0.2, (Math.random()-0.5)*0.2),
            life: 1.0
        };
        
        scene.add(petal);
        particles.push(petal);
    }
}

// 遊戲主迴圈
function startGameLoop() {
    const clock = new THREE.Clock();
    
    function animate() {
        requestAnimationFrame(animate);

        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            
            p.position.add(p.userData.velocity);
            
            // 受到重力與空氣阻力影響，讓花瓣更優雅地飄落
            p.userData.velocity.y -= 0.003; 
            p.userData.velocity.x *= 0.98; // 水平空氣阻力
            p.userData.velocity.y *= 0.99; // 垂直空氣阻力，避免掉落太快
            p.userData.velocity.z *= 0.98;
            
            p.rotation.x += p.userData.rotSpeed.x;
            p.rotation.y += p.userData.rotSpeed.y;
            p.rotation.z += p.userData.rotSpeed.z;
            
            p.material.opacity = p.userData.life;
            p.userData.life -= 0.004; // 消失速度變慢，延長停留時間
            
            if (p.userData.life <= 0) {
                scene.remove(p);
                p.material.dispose();
                p.geometry.dispose();
                particles.splice(i, 1);
            }
        }

        renderer.render(scene, camera);
    }
    animate();
}

// 啟動
window.onload = () => {
    initThreeJS();
    initMediaPipe();
};
